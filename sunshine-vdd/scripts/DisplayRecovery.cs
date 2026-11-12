// Compiled together with the existing DisplayTopology.psm1 native definitions.
// No persisted adapter LUID, source ID, target ID or native mode is used to recover.
namespace SunshineVddSkill
{
    using System;
    using System.Collections.Generic;
    using System.ComponentModel;
    using System.Linq;
    using System.Runtime.InteropServices;

    public sealed class ApprovedDisplay
    {
        public string InstanceId { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public int X { get; set; }
        public int Y { get; set; }
        public int RefreshRate { get; set; }
        public bool Primary { get; set; }
    }
    public sealed class DisplayPathRecord
    {
        public string InstanceId { get; set; }
        public string DevicePath { get; set; }
        public string FriendlyName { get; set; }
        public string SourceName { get; set; }
        public bool Available { get; set; }
        public bool Active { get; set; }
        public bool PhysicalConnector { get; set; }
        public uint OutputTechnology { get; set; }
        public string Adapter { get; set; }
        public string AdapterDeviceId { get; set; }
        public uint SourceId { get; set; }
        public uint TargetId { get; set; }
    }
    public static partial class NativeDisplay
    {
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
        private struct TargetName
        {
            public DISPLAYCONFIG_DEVICE_INFO_HEADER header;
            public uint flags, outputTechnology;
            public ushort manufacturer, product;
            public uint connector;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string friendlyName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string devicePath;
        }
        [DllImport("user32.dll", EntryPoint="DisplayConfigGetDeviceInfo")]
        private static extern int GetTargetName(ref TargetName name);

        public static string NormalizeMonitorId(string path)
        {
            if (String.IsNullOrWhiteSpace(path)) return "";
            if (path.StartsWith(@"\\?\")) {
                var parts=path.Substring(4).Split('#');
                if(parts.Length >= 3) return (parts[0]+@"\"+parts[1]+@"\"+parts[2]).ToUpperInvariant();
            }
            return path.ToUpperInvariant();
        }
        private static void QueryFresh(uint flags, out DISPLAYCONFIG_PATH_INFO[] paths, out DISPLAYCONFIG_MODE_INFO[] modes)
        {
            // Legacy mode indices deliberately requested. Never confuse QDC and SDC flags.
            for(int attempt=0; attempt<5; attempt++) {
                uint pc,mc; int rc=GetDisplayConfigBufferSizes(flags,out pc,out mc);
                if(rc!=0) throw new Win32Exception(rc,"GetDisplayConfigBufferSizes");
                if(pc>4096 || mc>16384) throw new InvalidOperationException("Unbounded display enumeration");
                paths=new DISPLAYCONFIG_PATH_INFO[pc]; modes=new DISPLAYCONFIG_MODE_INFO[mc];
                rc=QueryDisplayConfig(flags,ref pc,paths,ref mc,modes,IntPtr.Zero);
                if(rc==122) continue;
                if(rc!=0) throw new Win32Exception(rc,"QueryDisplayConfig: console desktop access required");
                Array.Resize(ref paths,(int)pc); Array.Resize(ref modes,(int)mc); return;
            }
            throw new InvalidOperationException("Display enumeration did not stabilize");
        }
        private static DisplayPathRecord Describe(DISPLAYCONFIG_PATH_INFO p)
        {
            var n=new TargetName(); n.header.type=2; n.header.size=(uint)Marshal.SizeOf(typeof(TargetName));
            n.header.adapterId=p.targetInfo.adapterId; n.header.id=p.targetInfo.id;
            int rc=GetTargetName(ref n);
            if(rc!=0) throw new Win32Exception(rc,"DisplayConfigGetDeviceInfo(target)");
            uint t=(uint)p.targetInfo.outputTechnology;
            // Explicit physical connector allowlist; indirect/wireless/unknown is never physical.
            string source=GetSourceName(p);
            var adapter=Enumerate().SingleOrDefault(d=>d.DeviceName==source);
            // MTT reports HDMI on this host. Connector technology alone is NOT physical evidence.
            bool physical=adapter!=null && IsPhysicalTarget(t,adapter.DeviceId,NormalizeMonitorId(n.devicePath));
            return new DisplayPathRecord {InstanceId=NormalizeMonitorId(n.devicePath),DevicePath=n.devicePath,
                FriendlyName=n.friendlyName,SourceName=source,Available=p.targetInfo.targetAvailable,
                Active=(p.flags&1)!=0,PhysicalConnector=physical,OutputTechnology=t,
                Adapter=p.targetInfo.adapterId.HighPart+":"+p.targetInfo.adapterId.LowPart,AdapterDeviceId=adapter==null?null:adapter.DeviceId,SourceId=p.sourceInfo.id,TargetId=p.targetInfo.id};
        }
        public static bool IsPhysicalTarget(uint technology,string adapterId,string monitorId) {
            return !String.IsNullOrEmpty(adapterId) && adapterId.StartsWith(@"PCI\",StringComparison.OrdinalIgnoreCase) &&
                !String.IsNullOrEmpty(monitorId) && !monitorId.StartsWith(@"DISPLAY\MTT",StringComparison.OrdinalIgnoreCase) &&
                new uint[]{0,1,2,3,4,5,6,8,9,10,11,12,13,0x80000000}.Contains(technology);
        }
        public static DisplayPathRecord[] EnumeratePaths(bool activeOnly)
        {
            DISPLAYCONFIG_PATH_INFO[] paths; DISPLAYCONFIG_MODE_INFO[] modes;
            QueryFresh(activeOnly?2u:1u,out paths,out modes);
            return paths.Where(p=>p.targetInfo.targetAvailable || (p.flags&1)!=0).Select(Describe).ToArray();
        }
        public static void ValidateApproval(ApprovedDisplay[] approved)
        {
            if(approved==null || approved.Length==0 || approved.Length>8) throw new ArgumentException("Approve one to eight physical displays");
            if(approved.Select(a=>NormalizeMonitorId(a.InstanceId)).Distinct().Count()!=approved.Length) throw new ArgumentException("Duplicate physical identity");
            if(approved.Count(a=>a.Primary)!=1) throw new ArgumentException("Exactly one primary display required");
            foreach(var a in approved) {
                if(String.IsNullOrWhiteSpace(a.InstanceId) || !a.InstanceId.StartsWith(@"DISPLAY\",StringComparison.OrdinalIgnoreCase) ||
                    a.Width<640 || a.Width>16384 || a.Height<480 || a.Height>16384 || a.RefreshRate<24 || a.RefreshRate>500 ||
                    Math.Abs((long)a.X)>32768 || Math.Abs((long)a.Y)>32768 || (a.Primary && (a.X!=0 || a.Y!=0)))
                    throw new ArgumentException("Invalid approved physical identity, mode or primary origin");
                foreach(var b in approved.Where(other=>!Object.ReferenceEquals(a,other)))
                    if(a.X < b.X+b.Width && a.X+a.Width > b.X && a.Y < b.Y+b.Height && a.Y+a.Height > b.Y)
                        throw new ArgumentException("Approved displays overlap; clone layouts are not supported");
            }
        }
        public static bool VerifyPhysical(ApprovedDisplay[] approved)
        {
            ValidateApproval(approved);
            var paths=EnumeratePaths(true); var gdi=Enumerate().Where(d=>d.Attached).ToArray();
            if(paths.Length!=approved.Length || gdi.Length!=approved.Length || gdi.Count(d=>d.Primary)!=1) return false;
            foreach(var a in approved) {
                var p=paths.Where(candidate=>candidate.PhysicalConnector && candidate.Available && candidate.InstanceId==NormalizeMonitorId(a.InstanceId)).ToArray();
                if(p.Length!=1) return false;
                var d=gdi.Where(candidate=>candidate.DeviceName==p[0].SourceName).ToArray();
                if(d.Length!=1 || d[0].Primary!=a.Primary || d[0].Width!=a.Width || d[0].Height!=a.Height ||
                    d[0].PositionX!=a.X || d[0].PositionY!=a.Y || Math.Abs(d[0].RefreshRate-a.RefreshRate)>1) return false;
                // Independent GDI monitor identity, not merely an adapter/source name match.
                var child=new DISPLAY_DEVICE(); child.cb=Marshal.SizeOf(typeof(DISPLAY_DEVICE));
                if(!EnumDisplayDevices(d[0].DeviceName,0,ref child,1) || NormalizeMonitorId(child.DeviceID)!=NormalizeMonitorId(a.InstanceId)) return false;
            }
            return true; // Windows path/mode evidence only. Never proof of a visible panel image.
        }
        public static void RecoverPhysical(ApprovedDisplay[] approved, Action assertSafe)
        {
            ValidateApproval(approved); if(assertSafe==null) throw new ArgumentNullException("assertSafe");
            assertSafe();
            DISPLAYCONFIG_PATH_INFO[] all; DISPLAYCONFIG_MODE_INFO[] ignored;
            QueryFresh(1,out all,out ignored);
            var selected=new List<DISPLAYCONFIG_PATH_INFO>(); var modes=new List<DISPLAYCONFIG_MODE_INFO>();
            var usedSources=new HashSet<string>();
            foreach(var a in approved.OrderByDescending(a=>a.Primary)) {
                var candidates=all.Where(p=>p.targetInfo.targetAvailable).Where(p=>{
                    var d=Describe(p); return d.PhysicalConnector && d.InstanceId==NormalizeMonitorId(a.InstanceId);
                }).ToArray();
                // ALL_PATHS has multiple valid source routes for one target. Reject distinct targets sharing an identity.
                if(candidates.Length==0 || candidates.Select(p=>p.targetInfo.adapterId.HighPart+":"+p.targetInfo.adapterId.LowPart+":"+p.targetInfo.id).Distinct().Count()!=1)
                    throw new InvalidOperationException("Approved physical target missing or ambiguous: "+a.InstanceId);
                var eligible=candidates.Where(p=>!usedSources.Contains(p.sourceInfo.adapterId.HighPart+":"+p.sourceInfo.adapterId.LowPart+":"+p.sourceInfo.id)).ToArray();
                if(eligible.Length==0) throw new InvalidOperationException("No independent source route for physical display");
                var path=eligible.OrderByDescending(p=>(p.flags&1)!=0).First();
                usedSources.Add(path.sourceInfo.adapterId.HighPart+":"+path.sourceInfo.adapterId.LowPart+":"+path.sourceInfo.id);
                path.flags=1; path.sourceInfo.modeInfoIdx=(uint)modes.Count; path.targetInfo.modeInfoIdx=0xffffffff;
                path.targetInfo.rotation=DISPLAYCONFIG_ROTATION.Identity; path.targetInfo.scaling=DISPLAYCONFIG_SCALING.Identity;
                path.targetInfo.refreshRate=new DISPLAYCONFIG_RATIONAL{Numerator=(uint)a.RefreshRate,Denominator=1};
                path.targetInfo.scanLineOrdering=DISPLAYCONFIG_SCANLINE_ORDERING.Unspecified;
                var m=new DISPLAYCONFIG_MODE_INFO {infoType=DISPLAYCONFIG_MODE_INFO_TYPE.Source,id=path.sourceInfo.id,adapterId=path.sourceInfo.adapterId};
                m.modeInfo.sourceMode=new DISPLAYCONFIG_SOURCE_MODE {width=(uint)a.Width,height=(uint)a.Height,pixelFormat=4,position=new POINTL{x=a.X,y=a.Y}};
                modes.Add(m); selected.Add(path);
            }
            var pa=selected.ToArray(); var ma=modes.ToArray();
            int rc=SetDisplayConfig((uint)pa.Length,pa,(uint)ma.Length,ma,SDC_VALIDATE|SDC_USE_SUPPLIED_DISPLAY_CONFIG|SDC_ALLOW_CHANGES);
            if(rc!=0) throw new Win32Exception(rc,"Validate fresh physical topology");
            assertSafe(); // Defense in depth; the startup interlock, NOT this check, prevents managed reconnect.
            rc=SetDisplayConfig((uint)pa.Length,pa,(uint)ma.Length,ma,SDC_APPLY|SDC_USE_SUPPLIED_DISPLAY_CONFIG|SDC_ALLOW_CHANGES|SDC_SAVE_TO_DATABASE);
            if(rc!=0) throw new Win32Exception(rc,"Apply fresh physical topology");
        }
    }
}
