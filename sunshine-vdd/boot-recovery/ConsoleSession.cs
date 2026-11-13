using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace SunshineDisplay
{
    public static class ConsoleSession
    {
        [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
        [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint access,out IntPtr token);
        [DllImport("advapi32.dll",SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr token,uint access,IntPtr sa,int level,int type,out IntPtr duplicate);
        [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int type,ref uint data,uint length);
        [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LookupPrivilegeValue(string system,string name,out long luid);
        [StructLayout(LayoutKind.Sequential)] struct TokenPrivilege {public uint count;public long luid;public uint attributes;}
        [DllImport("advapi32.dll",SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token,bool disable,ref TokenPrivilege value,uint length,IntPtr previous,IntPtr returned);
        [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
            public uint cb;public string reserved,desktop,title;public uint x,y,xSize,ySize,xCount,yCount,fill,flags;public ushort show,reserved2;public IntPtr reservedPointer,input,output,error;
        }
        [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr process,thread;public uint pid,tid;}
        [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUser(IntPtr token,string app,StringBuilder args,IntPtr psa,IntPtr tsa,bool inherit,uint flags,IntPtr env,string cwd,ref Startup si,out ProcessInfo pi);
        [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr sa,string name);
        [StructLayout(LayoutKind.Sequential)] struct BasicLimits {public long processTime,jobTime;public uint flags;public UIntPtr min,max;public uint count;public UIntPtr affinity;public uint priority,scheduling;}
        [StructLayout(LayoutKind.Sequential)] struct IoCounters {public ulong a,b,c,d,e,f;}
        [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {public BasicLimits basic;public IoCounters io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref ExtendedLimits limits,uint size);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
        [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
        [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
        [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h,uint code);
        public static string BootKey() {
            // Diagnostic age/boot correlation only. Privileged once-per-boot authorization uses BootEpoch.
            using(var query=new System.Management.ManagementObjectSearcher("SELECT LastBootUpTime FROM Win32_OperatingSystem"))
                foreach(System.Management.ManagementObject item in query.Get())
                    using(item) return System.Management.ManagementDateTimeConverter.ToDateTime((string)item["LastBootUpTime"]).ToUniversalTime().ToString("o");
            throw new InvalidOperationException("OS boot timestamp unavailable");
        }
        static void Enable(IntPtr token,string name) {
            long luid;Check(LookupPrivilegeValue(null,name,out luid),name);
            var value=new TokenPrivilege{count=1,luid=luid,attributes=2};
            Check(AdjustTokenPrivileges(token,false,ref value,0,IntPtr.Zero,IntPtr.Zero),name);
            if(Marshal.GetLastWin32Error()==1300) throw new UnauthorizedAccessException("Privilege unavailable: "+name);
        }
        static void Check(bool ok,string operation) {if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error(),operation);}
        public static uint RunFixedHelper(string runId,Action heartbeat) {
            if(!WindowsIdentity.GetCurrent().IsSystem || Process.GetCurrentProcess().SessionId!=0) throw new UnauthorizedAccessException("Only the LocalSystem Session 0 service can launch its helper");
            uint session=WTSGetActiveConsoleSessionId();
            if(session==0 || session==uint.MaxValue) throw new InvalidOperationException("Console session not ready");
            IntPtr token=IntPtr.Zero,duplicate=IntPtr.Zero,job=IntPtr.Zero;var pi=new ProcessInfo();
            try {
                Check(OpenProcessToken(Process.GetCurrentProcess().Handle,0x2b,out token),"Open service token");
                Enable(token,"SeTcbPrivilege");Enable(token,"SeAssignPrimaryTokenPrivilege");Enable(token,"SeIncreaseQuotaPrivilege");
                Check(DuplicateTokenEx(token,0xF01FF,IntPtr.Zero,2,1,out duplicate),"Duplicate service token");
                Check(SetTokenInformation(duplicate,12,ref session,4),"Set console TokenSessionId");
                job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero,"Create helper job");
                var limits=new ExtendedLimits();limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE
                Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))),"Bound helper lifetime");
                var si=new Startup{cb=(uint)Marshal.SizeOf(typeof(Startup)),desktop=@"winsta0\default"};
                string exe=System.IO.Path.Combine(Paths.Install,"SunshineDisplay.Recovery.exe");
                // Absolute fixed executable, fixed verb, numeric PID and internally generated GUID only.
                string args="\""+exe+"\" --worker "+Process.GetCurrentProcess().Id+" "+Guid.Parse(runId).ToString("D");
                Check(CreateProcessAsUser(duplicate,exe,new StringBuilder(args),IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,Paths.Install,ref si,out pi),"Create console helper");
                Check(AssignProcessToJobObject(job,pi.process),"Assign helper to kill-on-close job");
                if(ResumeThread(pi.thread)==uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(),"Resume helper");
                var deadline=Stopwatch.StartNew();
                while(WaitForSingleObject(pi.process,1000)==258) {
                    heartbeat();
                    if(deadline.Elapsed.TotalSeconds>125 || WTSGetActiveConsoleSessionId()!=session) {TerminateProcess(pi.process,4);WaitForSingleObject(pi.process,5000);throw new InvalidOperationException("Helper timeout or console session changed");}
                }
                uint code;Check(GetExitCodeProcess(pi.process,out code),"Helper exit code");return code;
            } finally {
                // Also kill a suspended child if assigning the job failed; never leave an orphan.
                if(pi.process!=IntPtr.Zero && WaitForSingleObject(pi.process,0)==258) TerminateProcess(pi.process,4);
                if(job!=IntPtr.Zero) CloseHandle(job);
                if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread);if(pi.process!=IntPtr.Zero) CloseHandle(pi.process);
                if(duplicate!=IntPtr.Zero) CloseHandle(duplicate);if(token!=IntPtr.Zero) CloseHandle(token);
            }
        }
    }
}
