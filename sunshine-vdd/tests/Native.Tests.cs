using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using SunshineDisplay;
using SunshineVddSkill;

static class NativeTests
{
    static int count;
    static void Check(bool value,string label) {if(!value)throw new Exception(label);count++;Console.WriteLine("PASS "+label);}
    static void Throws(Action action,string label) {bool failed=false;try{action();}catch{failed=true;}Check(failed,label);}
    static void TestPrivacyWarning(DateTimeOffset now) {
        var health=new Dictionary<string,object>{{"Status","Starting"},{"Reason","ConnectionGracePeriod"},{"Phase","Streaming"}};
        var panel=new Dictionary<string,object>{{"Active",true},{"PhysicalConnector",true},{"InstanceId","panel"},{"FriendlyName","Test panel"}};
        var vdd=new Dictionary<string,object>{{"Active",true},{"PhysicalConnector",false},{"InstanceId","virtual"}};
        var process=new Dictionary<string,object>{{"StartTime",now.UtcDateTime}};
        var data=new Dictionary<string,object>{
            {"At",now.ToString("o")},{"BootKey","boot"},{"SchemaVersion",2},{"LogEpoch",now.UtcDateTime},
            {"SunshineProcesses",new[]{process}},{"Clients",1},{"Health",health},{"ExpectedMonitor","virtual"},
            {"DisplayPaths",new[]{panel,vdd}}};
        Func<HealthView> read=()=>TrayHealth.Evaluate(data,now,"boot");
        var active=read();
        var history=new Dictionary<string,object>{{"Id",now.AddMinutes(-2).UtcTicks},{"Outcome","Late"},{"Seconds",34}};
        data["LastDisconnect"]=history;
        Check(read().StreamConnected && read().LastDisconnect.Warn && read().LastDisconnect.Summary.Contains("34 s"),"Late restore reports the duration on a trusted connection");
        foreach(var outcome in new[]{"Pending","Restored","Unverified","WaitingForMonitor"}) {
            history["Outcome"]=outcome;Check(!read().LastDisconnect.Warn,"Quiet disconnect outcome "+outcome);
        }
        history["Outcome"]="Failed";
        Check(read().LastDisconnect.Warn && read().State=="Fault","Historical failure coexists with a live privacy alert");
        Check(!TrayHealth.Evaluate(data,now.AddMinutes(1),"boot").StreamConnected,"Stale samples cannot deliver a history popup");
        history["Id"]=-1;Check(read().LastDisconnect==null,"Malformed disconnect record ignored");
        history["Id"]=now.AddMinutes(-2).UtcTicks;
        Check(active.State=="Fault" && active.Privacy==PrivacyObservation.PhysicalActive && active.PhysicalOutput=="Test panel","Alert during connection grace before capture succeeds");
        health["Status"]="Degraded";health["Reason"]="CaptureGeometryMatchesDifferentMonitor";
        Check(read().Privacy==PrivacyObservation.PhysicalActive,"Alert even when Sunshine captures the wrong output");
        Check(TrayHealth.Evaluate(data,now.AddMinutes(1),"boot").Privacy==PrivacyObservation.Unknown,"Stale heartbeat cannot trigger a popup");
        data["LogEpoch"]=now.AddMinutes(-1).UtcDateTime;
        Check(read().Privacy==PrivacyObservation.Unknown && !read().StreamConnected,"Old Sunshine client count cannot trigger a popup");
        data["LogEpoch"]=now.UtcDateTime;
        var incident=new PrivacyIncident(false);
        Check(incident.Observe(active.Privacy) && incident.Pending,"Confirmed exposure opens the warning and sounds once");
        Check(!incident.Observe(active.Privacy),"Repeated confirmed samples produce no extra sound");
        incident.Acknowledge();
        incident.Observe(PrivacyObservation.Unknown);
        Check(!incident.Observe(active.Privacy) && !incident.Pending && read().State=="Fault","Acknowledgment suppresses popup through uncertain samples and keeps live fault");
        panel["Active"]=false;
        health["Status"]="Healthy";health["Reason"]="CaptureGeometryMatchesExpectedMonitor";
        var recovered=read();
        Check(recovered.Privacy==PrivacyObservation.VerifiedPrivate,"Present but inactive panel is safe with a verified VDD-only stream");
        incident.Observe(recovered.Privacy);
        Check(incident.Observe(active.Privacy),"New exposure after verified restoration re-arms the alert");
        incident.Observe(recovered.Privacy);
        Check(incident.Pending,"Recovery before acknowledgment keeps the warning available");
        data["Clients"]=0;health["Phase"]="Idle";panel["Active"]=true;
        health["Status"]="Starting";health["Reason"]="WaitingForPhysicalMonitor";
        Check(read().State=="Waiting for physical monitor" && !read().StreamConnected,"Missing idle panel uses the quiet tray state");
        Check(read().Privacy==PrivacyObservation.Disconnected && !read().StreamConnected,"Physical monitor while disconnected does not trigger an alert");
        incident.Observe(read().Privacy);
        Check(incident.Pending && new PrivacyIncident(true).Pending,"Unacknowledged warning survives disconnect and can be reopened at startup");
        incident.Acknowledge();
        Check(!incident.Pending,"Acknowledgment clears a resolved warning");
    }
    sealed class EnvironmentFixture : IRecoveryEnvironment {
        public double ElapsedSeconds{get;private set;}
        public int Applies,Waits,Reads;
        public bool Matches,Changing,EnumerationFails,ApplyFails;
        public double CancelAt=double.MaxValue,UnknownAt=double.MaxValue;
        public void AssertSafe(){if(ElapsedSeconds>=CancelAt)throw new OperationCanceledException("Stream started");if(ElapsedSeconds>=UnknownAt)throw new InvalidOperationException("Unknown safety evidence");}
        public string Fingerprint(){Reads++;if(EnumerationFails)throw new IOException("GPU not ready");return Changing?Reads.ToString():"stable";}
        public bool PhysicalMatches(){return Matches;}
        public void BackupAndApply(){AssertSafe();Applies++;if(ApplyFails)throw new IOException("Driver failed");Matches=true;}
        public void Wait(){ElapsedSeconds+=2;Waits++;}
        public void Publish(string detail,int attempts){}
    }
    static ApprovedDisplay Physical() {return new ApprovedDisplay{InstanceId=@"DISPLAY\HKC0001\fixture",Width=3840,Height=2160,RefreshRate=120,Primary=true};}
    static int Main() {
        try {
            Check(!BootPolicy.IsTerminalForBoot(null,"boot1"),"First boot has no claim");
            foreach(var result in new[]{"Claimed","Succeeded","Cancelled","Fault"}) {
                var r=new BootRecord{BootKey="boot1",Result=result};
                Check(BootPolicy.IsTerminalForBoot(r,"boot1"),result+" blocks all service restart recovery this boot");
                Check(!BootPolicy.IsTerminalForBoot(r,"boot2"),result+" does not block next boot");
            }
            Throws(()=>BootPolicy.IsTerminalForBoot(new BootRecord{BootKey=""},"boot1"),"Corrupt completion is unsafe");
            Throws(()=>BootPolicy.IsTerminalForBoot(null,""),"Missing boot identity is unsafe");
            Check(BootPolicy.Decision(false,false,true,true)=="UnknownSafetyEvidence","Unknown process evidence never permits recovery");
            Check(BootPolicy.Decision(true,true,true,true)=="CancelledSunshineStarted","Existing Sunshine cancels even with an interlock");
            Check(BootPolicy.Decision(true,false,false,true)=="ReconnectInterlockUnavailable","No-clients polling is not an interlock");
            var e=new EnvironmentFixture();var o=RecoveryEngine.Run(e,30,3);
            Check(o.Result=="Succeeded" && e.Applies==1 && e.Reads>=6,"Stable enumeration, apply and later independent verification");
            e=new EnvironmentFixture{Matches=true};o=RecoveryEngine.Run(e,30,3);Check(o.Result=="Succeeded" && e.Applies==0,"Already correct topology does not apply");
            e=new EnvironmentFixture{CancelAt=4};o=RecoveryEngine.Run(e,30,3);Check(o.Result=="Cancelled" && e.Applies==0,"Stream before apply cancels without topology changes");
            e=new EnvironmentFixture{CancelAt=6};o=RecoveryEngine.Run(e,30,3);Check(o.Result=="Cancelled" && e.Applies==1,"Stream after apply prevents any later correction or rollback");
            e=new EnvironmentFixture{UnknownAt=4};o=RecoveryEngine.Run(e,30,3);Check(o.Result=="Fault" && e.Applies==0,"Unknown safety terminates immediately");
            e=new EnvironmentFixture{Changing=true};o=RecoveryEngine.Run(e,10,3);Check(o.Result=="Fault" && e.Applies==0 && e.ElapsedSeconds==10,"Unstable enumeration is bounded");
            e=new EnvironmentFixture{EnumerationFails=true};o=RecoveryEngine.Run(e,10,3);Check(o.Result=="Fault" && e.Applies==0 && e.ElapsedSeconds==10,"Missing GPU is bounded");
            e=new EnvironmentFixture{ApplyFails=true};o=RecoveryEngine.Run(e,90,2);Check(o.Result=="Fault" && e.Applies==2,"Native errors cannot exceed retry budget");
            Throws(()=>RecoveryEngine.Run(new EnvironmentFixture(),300,99),"Invalid retry/time budgets rejected");
            NativeDisplay.ValidateApproval(new[]{Physical()});Check(true,"Explicit physical-only layout accepted");
            Throws(()=>NativeDisplay.ValidateApproval(new ApprovedDisplay[0]),"Empty layout rejected");
            Throws(()=>NativeDisplay.ValidateApproval(new[]{Physical(),Physical()}),"Duplicate identities rejected");
            var bad=Physical();bad.X=10;Throws(()=>NativeDisplay.ValidateApproval(new[]{bad}),"Primary must be at origin");
            bad=Physical();bad.Width=0;Throws(()=>NativeDisplay.ValidateApproval(new[]{bad}),"Unknown dimensions rejected");
            Check(!NativeDisplay.IsPhysicalTarget(5,@"Root\MttVDD",@"DISPLAY\MTT1337\fixture"),"MTT HDMI is not a physical target");
            Check(!NativeDisplay.IsPhysicalTarget(5,null,@"DISPLAY\HKC0001\fixture"),"Unknown adapter is not physical");
            Check(NativeDisplay.IsPhysicalTarget(10,@"PCI\VEN_10DE",@"DISPLAY\HKC0001\fixture"),"Approved PCI DisplayPort physical evidence");
            Check(NativeDisplay.NormalizeMonitorId(@"\\?\DISPLAY#HKC0001#fixture#{guid}")==@"DISPLAY\HKC0001\FIXTURE","Fresh monitor interface normalizes to PnP identity");
            var native=typeof(NativeDisplay);
            foreach(var item in new[]{new{N="DISPLAYCONFIG_PATH_SOURCE_INFO",S=20},new{N="DISPLAYCONFIG_PATH_TARGET_INFO",S=48},new{N="DISPLAYCONFIG_PATH_INFO",S=72},new{N="DISPLAYCONFIG_MODE_INFO",S=64}})
                Check(Marshal.SizeOf(native.GetNestedType(item.N,BindingFlags.NonPublic))==item.S,"Native ABI "+item.N);
            Check((uint)native.GetField("QDC_VIRTUAL_MODE_AWARE",BindingFlags.NonPublic|BindingFlags.Static).GetRawConstantValue()==0x10,"QDC virtual mode flag is not SDC flag");
            Check((uint)native.GetField("QDC_VIRTUAL_REFRESH_RATE_AWARE",BindingFlags.NonPublic|BindingFlags.Static).GetRawConstantValue()==0x40,"QDC refresh flag is not SDC flag");
            var now=DateTimeOffset.UtcNow;
            TestPrivacyWarning(now);
            var status=new Dictionary<string,object>{{"SchemaVersion",2},{"At",now.ToString("o")},{"BootKey","boot1"},{"Clients",1},{"Health",new Dictionary<string,object>{{"Status","Healthy"},{"Reason","CaptureGeometryMatchesExpectedMonitor"}}}};
            var live=TrayHealth.Evaluate(status,now,"boot1");
            Check(live.State=="Privacy streaming" && live.GuardNotice==null,"Fresh monitor streaming health shown without a guard warning");
            var guard=new Dictionary<string,object>{{"Latched",true},{"Notice","Stored guard state was unreadable."}};
            status["Protection"]=guard;
            live=TrayHealth.Evaluate(status,now,"boot1");
            Check(live.State=="Privacy streaming" && live.GuardNotice==(string)guard["Notice"],"Saved guard warning shown separately during healthy streaming");
            Check(TrayHealth.Evaluate(status,now.AddSeconds(16),"boot1").State=="Checking or Unknown","Stale heartbeat cannot look healthy");
            Check(TrayHealth.Evaluate(status,now,"boot2").State=="Checking or Unknown","Previous-boot monitor status not trusted");
            Check(TrayHealth.Evaluate(status,now.AddSeconds(-10),"boot1").State=="Checking or Unknown","Future timestamp not trusted");
            status["Health"]=new Dictionary<string,object>{{"Status","Degraded"},{"Reason","PrivacyPhysicalDisplayStillAttached"}};
            live=TrayHealth.Evaluate(status,now,"boot1");
            Check(live.State=="Fault" && live.GuardNotice!=null,"Privacy loss remains a fault alongside a saved guard warning");
            status["Health"]=new Dictionary<string,object>{{"Status","Healthy"},{"Reason","CaptureGeometryMatchesExpectedMonitor"}};
            Check(TrayHealth.Evaluate(status,now,"boot1").State=="Privacy streaming","Icon recovers on the next healthy snapshot with guard still latched");
            status["Health"]=new Dictionary<string,object>{{"Status","Idle"},{"Reason","PhysicalOnlyIdleTopologyVerified"}};status["Clients"]=0;
            Check(TrayHealth.Evaluate(status,now,"boot1").State=="Physical ready","Fresh verified physical layout shown");
            guard.Remove("Notice");
            live=TrayHealth.Evaluate(status,now,"boot1");
            Check(live.State=="Physical ready" && !String.IsNullOrEmpty(live.GuardNotice),"Latched idle guard without notice text still has a review item");
            guard["Latched"]=false;
            Check(TrayHealth.Evaluate(status,now,"boot1").GuardNotice==null,"Clearing the latch removes the guard review item");
            Check(TrayHealth.Evaluate(null,now,"boot1").State=="Checking or Unknown","Missing/corrupt status cannot look healthy");
            string directory=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"fixture-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(directory);
            try {
                string p=Path.Combine(directory,"status.json");
                for(int i=0;i<20;i++){Json.Write(p,new BootRecord{BootKey="test",Result=i.ToString()});Check(Json.Read<BootRecord>(p).Result==i.ToString(),"Atomic JSON generation "+i);}
                File.WriteAllBytes(p,new byte[128]);Throws(()=>Json.Read<BootRecord>(p),"NUL-filled crash artifact rejected");
                Check(Directory.GetFiles(directory,"*.tmp").Length==0,"Atomic writer leaves no temp records");
            } finally {foreach(var f in Directory.GetFiles(directory))File.Delete(f);Directory.Delete(directory);}
            Console.WriteLine(count+" native fixture assertions passed; no display apply, service, registry or desktop operations executed.");return 0;
        }catch(Exception ex){Console.Error.WriteLine(ex);return 1;}
    }
}
