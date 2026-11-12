using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;

namespace SunshineDisplay
{
    public static class Json
    {
        public static JavaScriptSerializer Serializer() { return new JavaScriptSerializer { MaxJsonLength=2*1024*1024, RecursionLimit=40 }; }
        public static T Read<T>(string path) {
            using(var f=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)) {
                if(f.Length==0 || f.Length>2*1024*1024) throw new InvalidDataException("Invalid status/configuration size: "+path);
                using(var r=new StreamReader(f,Encoding.UTF8,true)) return Serializer().Deserialize<T>(r.ReadToEnd());
            }
        }
        public static void Write(string path,object value) {
            string tmp=path+"."+Guid.NewGuid().ToString("N")+".tmp";
            try {
                var bytes=new UTF8Encoding(false).GetBytes(Serializer().Serialize(value));
                using(var f=new FileStream(tmp,FileMode.CreateNew,FileAccess.Write,FileShare.None,4096,FileOptions.WriteThrough)) {f.Write(bytes,0,bytes.Length);f.Flush(true);}
                if(File.Exists(path)) File.Replace(tmp,path,null); else File.Move(tmp,path);
            } finally {if(File.Exists(tmp)) File.Delete(tmp);}
        }
    }
    public static class Paths
    {
        public const string ServiceName="SunshineBootRecovery";
        public static readonly string Install=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"SunshineDisplayHealth");
        public static readonly string Data=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"SunshineDisplayHealth");
        public static string Config { get {return Path.Combine(Install,"recovery.json");} }
        public static string State { get {return Path.Combine(Data,"boot-state.json");} }
        public static string Status { get {return Path.Combine(Data,"recovery-status.json");} }
    }
    public static class Protection
    {
        public static void AssertNoReparse(string path) {
            for(var p=Path.GetFullPath(path);!String.IsNullOrEmpty(p);p=Path.GetDirectoryName(p))
                if((File.Exists(p)||Directory.Exists(p)) && (File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)
                    throw new InvalidDataException("Reparse point refused: "+p);
        }
        public static void AssertAcl(string path) {
            AssertNoReparse(path);
            FileSystemSecurity acl=Directory.Exists(path)?(FileSystemSecurity)Directory.GetAccessControl(path):File.GetAccessControl(path);
            var owner=(SecurityIdentifier)acl.GetOwner(typeof(SecurityIdentifier));
            if(owner.Value!="S-1-5-18" && owner.Value!="S-1-5-32-544") throw new UnauthorizedAccessException("Untrusted owner: "+path);
            const FileSystemRights writes=FileSystemRights.WriteData|FileSystemRights.AppendData|FileSystemRights.WriteExtendedAttributes|FileSystemRights.WriteAttributes|FileSystemRights.Delete|FileSystemRights.DeleteSubdirectoriesAndFiles|FileSystemRights.ChangePermissions|FileSystemRights.TakeOwnership;
            foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))
                if(rule.AccessControlType==AccessControlType.Allow && (((int)rule.FileSystemRights & (int)writes)!=0) &&
                    rule.IdentityReference.Value!="S-1-5-18" && rule.IdentityReference.Value!="S-1-5-32-544")
                    throw new UnauthorizedAccessException("Non-administrator write access: "+path);
        }
        public static void AssertRuntime() {
            foreach(string p in new[]{Paths.Install,Paths.Data,Paths.Config,Path.Combine(Paths.Install,"SunshineDisplay.Core.dll"),Path.Combine(Paths.Install,"SunshineDisplay.Native.dll"),Path.Combine(Paths.Install,"SunshineDisplay.Recovery.exe")}) AssertAcl(p);
            foreach(string p in new[]{Paths.State,Paths.Status}) if(File.Exists(p)) AssertAcl(p);
        }
    }
    public sealed class BootRecord
    {
        public int SchemaVersion=1;
        public string BootKey;
        public string Result;
        public string AtUtc;
        public string Detail;
        public string RunId;
    }
    public static class BootPolicy
    {
        public static bool IsTerminalForBoot(BootRecord previous,string boot) {
            if(String.IsNullOrWhiteSpace(boot)) throw new InvalidDataException("Boot identity unavailable");
            if(previous==null) return false;
            if(previous.SchemaVersion!=1 || String.IsNullOrEmpty(previous.BootKey) || !new[]{"Claimed","Succeeded","Cancelled","Fault"}.Contains(previous.Result))
                throw new InvalidDataException("Corrupt boot completion/claim; manual investigation required");
            // A crash after a durable claim is indeterminate, never permission to change displays again.
            return previous.BootKey==boot;
        }
        public static string Decision(bool processEvidenceKnown,bool sunshinePresent,bool coordinated,bool consoleReady) {
            if(!processEvidenceKnown) return "UnknownSafetyEvidence";
            if(sunshinePresent) return "CancelledSunshineStarted";
            if(!coordinated) return "ReconnectInterlockUnavailable";
            if(!consoleReady) return "WaitingForConsole";
            return "Recover";
        }
    }
    public sealed class HealthView
    {
        public string State;
        public string Detail;
        public double AgeSeconds;
    }
    public static class TrayHealth
    {
        public static object Get(Dictionary<string,object> d,string k) {object v;return d!=null && d.TryGetValue(k,out v)?v:null;}
        public static string Text(Dictionary<string,object> d,string k) {return Convert.ToString(Get(d,k));}
        public static HealthView Evaluate(Dictionary<string,object> d,DateTimeOffset now,string boot) {
            if(d==null) return new HealthView{State="Checking or Unknown",Detail="Monitor status missing or invalid"};
            DateTimeOffset at;
            if(!DateTimeOffset.TryParse(Text(d,"At"),out at)) return new HealthView{State="Checking or Unknown",Detail="Monitor timestamp invalid"};
            double age=(now-at).TotalSeconds;
            if(age < -5 || age>15 || Text(d,"BootKey")!=boot || Text(d,"SchemaVersion")!="2")
                return new HealthView{State="Checking or Unknown",Detail="Monitor heartbeat stale, from another boot, or legacy schema; inspect monitor task/logs",AgeSeconds=age};
            var h=Get(d,"Health") as Dictionary<string,object>; string status=Text(h,"Status"),reason=Text(h,"Reason");
            var guard=Get(d,"Protection") as Dictionary<string,object>;
            if(Convert.ToString(Get(guard,"Latched"))=="True" || status=="Degraded" || status=="Fault")
                return new HealthView{State="Fault",Detail=reason+"; inspect capture target, paths and protection notice",AgeSeconds=age};
            string state="Checking or Unknown";
            if(status=="Healthy" && reason=="CaptureGeometryMatchesExpectedMonitor" && Convert.ToInt32(Get(d,"Clients"))>0) state="Privacy streaming";
            if(status=="Idle" && reason=="PhysicalOnlyIdleTopologyVerified" && Convert.ToInt32(Get(d,"Clients"))==0) state="Physical ready";
            return new HealthView{State=state,Detail=reason+". Windows evidence does not prove a visible picture.",AgeSeconds=age};
        }
    }
    public sealed class Journal
    {
        private readonly string root;
        public Journal(string directory) {root=directory;}
        public void Write(string kind,object detail) {
            string path=Path.Combine(root,"recovery-"+DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fffffff")+"-"+Guid.NewGuid().ToString("N")+".json");
            Json.Write(path,new {AtUtc=DateTime.UtcNow.ToString("o"),Kind=kind,Detail=detail});
            var files=new DirectoryInfo(root).GetFiles("recovery-*.json").Where(f=>f.Name!="recovery-status.json").OrderByDescending(f=>f.LastWriteTimeUtc).ToArray();
            long bytes=0;
            for(int i=0;i<files.Length;i++) {bytes+=files[i].Length;if(i>=128 || bytes>16*1024*1024 || files[i].LastWriteTimeUtc<DateTime.UtcNow.AddDays(-14)) files[i].Delete();}
        }
    }
}
