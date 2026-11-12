using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.ServiceProcess;
using System.Threading;
using Microsoft.Win32;
using SunshineVddSkill;

namespace SunshineDisplay
{
    public sealed class RecoveryConfig
    {
        public int SchemaVersion=1;
        public bool ScmStartupCoordinationApproved;
        public bool SunshineServiceIsSoleLauncher;
        public ApprovedDisplay[] PhysicalDisplays;
        public int TimeoutSeconds=90;
        public int MaxAttempts=3;
    }
    internal static class Safety
    {
        [DllImport("advapi32.dll",SetLastError=true)] static extern bool QueryServiceStatusEx(IntPtr handle,int info,ref ServiceStatus status,int size,out int needed);
        [StructLayout(LayoutKind.Sequential)] struct ServiceStatus {public uint type,state,controls,exit,specific,checkpoint,hint,pid,flags;}
        internal static void AssertSafe(RecoveryConfig config,int parentPid) {
            if(!config.ScmStartupCoordinationApproved || !config.SunshineServiceIsSoleLauncher) throw new InvalidOperationException("ReconnectInterlockUnavailable: approval and a sole SCM launcher are required");
            // Any Sunshine process (even idle/setup) cancels. No log absence, port check or polling proves atomic safety.
            if(Process.GetProcessesByName("sunshine").Length!=0 || Process.GetProcessesByName("sunshinesvc").Length!=0)
                throw new OperationCanceledException("CancelledSunshineStarted: leave topology unchanged; investigate alternate launcher");
            using(var sunshine=new ServiceController("SunshineService")) {
                if(sunshine.Status!=ServiceControllerStatus.Stopped) throw new OperationCanceledException("Sunshine service is not stopped");
                if(!sunshine.ServicesDependedOn.Any(s=>s.ServiceName==Paths.ServiceName)) throw new InvalidOperationException("SCM startup dependency missing");
            }
            using(var self=new ServiceController(Paths.ServiceName)) {
                var status=new ServiceStatus();int needed;
                if(!QueryServiceStatusEx(self.ServiceHandle.DangerousGetHandle(),0,ref status,Marshal.SizeOf(typeof(ServiceStatus)),out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
                if(status.state!=2 || status.pid!=parentPid) throw new OperationCanceledException("Recovery no longer owns the SCM START_PENDING gate");
            }
            uint console=ConsoleSession.WTSGetActiveConsoleSessionId();
            if(console==0 || console==uint.MaxValue || console!=(uint)Process.GetCurrentProcess().SessionId) throw new OperationCanceledException("Console session changed or inaccessible");
        }
    }
    internal sealed class RecoveryService : ServiceBase
    {
        internal RecoveryService() {ServiceName=Paths.ServiceName;CanStop=true;AutoLog=true;}
        protected override void OnStart(string[] ignored) {
            Protection.AssertRuntime();
            if(!BootEpoch.FullBootsConfigured()) throw new InvalidOperationException("Full boots are required; Fast Startup is enabled or unknown. No topology changes.");
            var log=new Journal(Paths.Data);string boot=BootEpoch.Current(true);
            var prior=File.Exists(Paths.State)?Json.Read<BootRecord>(Paths.State):null;
            if(File.Exists(Paths.State) && prior==null) throw new InvalidDataException("Existing boot state is null/corrupt; no automatic recovery");
            if(BootPolicy.IsTerminalForBoot(prior,boot)) {
                Json.Write(Paths.Status,new BootRecord{BootKey=boot,Result=prior.Result=="Claimed"?"InterruptedRequiresReview":prior.Result,AtUtc=DateTime.UtcNow.ToString("o"),Detail="No recovery repeated this boot. "+prior.Detail,RunId=prior.RunId});return;
            }
            var record=new BootRecord{BootKey=boot,RunId=Guid.NewGuid().ToString("D"),Result="Claimed",AtUtc=DateTime.UtcNow.ToString("o"),Detail="Durable once-per-boot claim written before launching helper"};
            Json.Write(Paths.State,record);Json.Write(Paths.Status,record);log.Write("Claimed",record);
            try {
                var config=Json.Read<RecoveryConfig>(Paths.Config); ValidateConfig(config);
                if(!config.ScmStartupCoordinationApproved || !config.SunshineServiceIsSoleLauncher) throw new InvalidOperationException("ReconnectInterlockUnavailable: no display changes; review startup coordination");
                var waiting=Stopwatch.StartNew();
                while(ConsoleSession.WTSGetActiveConsoleSessionId()==uint.MaxValue || ConsoleSession.WTSGetActiveConsoleSessionId()==0) {
                    if(waiting.Elapsed.TotalSeconds>=20) throw new System.TimeoutException("Console session unavailable");
                    RequestAdditionalTime(15000);Thread.Sleep(1000);
                }
                RequestAdditionalTime(15000);
                uint code=ConsoleSession.RunFixedHelper(record.RunId,()=>RequestAdditionalTime(15000));
                var final=Json.Read<BootRecord>(Paths.State);
                if(final.BootKey!=boot || final.RunId!=record.RunId || final.Result=="Claimed") throw new InvalidOperationException("Helper did not persist a terminal result (exit "+code+")");
            } catch(Exception e) {
                record.Result=e is OperationCanceledException?"Cancelled":"Fault";record.Detail=e.Message;record.AtUtc=DateTime.UtcNow.ToString("o");
                Json.Write(Paths.State,record);Json.Write(Paths.Status,record);log.Write(record.Result,record);
            }
            // Returning transitions to RUNNING, releasing an approved SCM dependency only AFTER the child exits.
            // Remain inert for the rest of this boot; no timer, reconnect or service restart starts a new recovery.
        }
        internal static void ValidateConfig(RecoveryConfig c) {
            if(c==null || c.SchemaVersion!=1 || c.TimeoutSeconds<10 || c.TimeoutSeconds>90 || c.MaxAttempts<1 || c.MaxAttempts>3) throw new InvalidDataException("Invalid bounded recovery policy");
            NativeDisplay.ValidateApproval(c.PhysicalDisplays);
        }
    }
    internal sealed class WindowsRecoveryEnvironment : IRecoveryEnvironment
    {
        readonly RecoveryConfig config;readonly int parent;readonly BootRecord record;readonly Journal log;
        readonly Stopwatch clock=Stopwatch.StartNew();
        internal WindowsRecoveryEnvironment(RecoveryConfig c,int pid,BootRecord r,Journal j) {config=c;parent=pid;record=r;log=j;}
        public double ElapsedSeconds {get{return clock.Elapsed.TotalSeconds;}}
        public void AssertSafe() {Protection.AssertRuntime();Safety.AssertSafe(config,parent);}
        public string Fingerprint() {return Json.Serializer().Serialize(NativeDisplay.EnumeratePaths(false));}
        public bool PhysicalMatches() {return NativeDisplay.VerifyPhysical(config.PhysicalDisplays);}
        public void BackupAndApply() {
            AssertSafe();
            log.Write("BeforeApply",new{BootKey=record.BootKey,Snapshot=NativeDisplay.CaptureTopology(),Paths=NativeDisplay.EnumeratePaths(false),Displays=NativeDisplay.Enumerate()});
            NativeDisplay.RecoverPhysical(config.PhysicalDisplays,AssertSafe);
        }
        public void Wait() {Thread.Sleep(2000);}
        public void Publish(string detail,int attempts) {
            record.Result="Checking";record.AtUtc=DateTime.UtcNow.ToString("o");record.Detail=detail;
            Json.Write(Paths.Status,record);log.Write("Observation",new{Detail=detail,Attempt=attempts});
        }
    }
    internal static class RecoveryProgram
    {
        static int Worker(int parent,string run) {
            if(!WindowsIdentity.GetCurrent().IsSystem) throw new UnauthorizedAccessException("Helper requires the service SYSTEM token");
            Protection.AssertRuntime();
            var c=Json.Read<RecoveryConfig>(Paths.Config);RecoveryService.ValidateConfig(c);
            string boot=BootEpoch.Current(false);var record=Json.Read<BootRecord>(Paths.State);
            if(record.BootKey!=boot || record.RunId!=run || record.Result!="Claimed") throw new InvalidOperationException("No matching current-boot service claim");
            var log=new Journal(Paths.Data);
            var environment=new WindowsRecoveryEnvironment(c,parent,record,log);
            var outcome=RecoveryEngine.Run(environment,c.TimeoutSeconds,c.MaxAttempts);
            record.Result=outcome.Result;record.Detail=outcome.Detail;
            record.AtUtc=DateTime.UtcNow.ToString("o");Json.Write(Paths.State,record);Json.Write(Paths.Status,record);log.Write("Terminal",record);
            return record.Result=="Succeeded"?0:2;
        }
        static int Main(string[] args) {
            try {
                if(args.Length==1 && args[0]=="--inventory") {
                    Console.WriteLine(Json.Serializer().Serialize(new{BootKey=ConsoleSession.BootKey(),ConsoleSessionId=ConsoleSession.WTSGetActiveConsoleSessionId(),ProcessSessionId=Process.GetCurrentProcess().SessionId,Paths=NativeDisplay.EnumeratePaths(false),GdiDisplays=NativeDisplay.Enumerate(),VisiblePicture="Unverified"}));return 0;
                }
                if(args.Length==3 && args[0]=="--worker") return Worker(Int32.Parse(args[1]),Guid.Parse(args[2]).ToString("D"));
                if(args.Length!=0 || Environment.UserInteractive) throw new ArgumentException("Use --inventory for read-only diagnostics; recovery runs only through the installed service");
                ServiceBase.Run(new RecoveryService());return 0;
            } catch(Exception e) {Console.Error.WriteLine(e);return 1;}
        }
    }
}
