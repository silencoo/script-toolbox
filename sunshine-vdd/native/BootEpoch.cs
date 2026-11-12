using System;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32;

namespace SunshineDisplay
{
    public static class BootEpoch
    {
        public const string RegistryPath=@"SOFTWARE\SunshineDisplayHealth";
        static void Check(RegistryKey key) {
            var acl=key.GetAccessControl();var owner=(SecurityIdentifier)acl.GetOwner(typeof(SecurityIdentifier));
            if(owner.Value!="S-1-5-18" && owner.Value!="S-1-5-32-544")throw new UnauthorizedAccessException("Boot epoch owner is not trusted");
            foreach(RegistryAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))
                if(rule.AccessControlType==AccessControlType.Allow && (rule.RegistryRights&(RegistryRights.SetValue|RegistryRights.CreateSubKey|RegistryRights.Delete|RegistryRights.ChangePermissions|RegistryRights.TakeOwnership))!=0 && rule.IdentityReference.Value!="S-1-5-18" && rule.IdentityReference.Value!="S-1-5-32-544")
                    throw new UnauthorizedAccessException("Boot epoch is writable by an unprivileged identity");
        }
        public static string Current(bool create) {
            if(create && !WindowsIdentity.GetCurrent().IsSystem)throw new UnauthorizedAccessException("Only SYSTEM creates a boot epoch");
            using(var root=Registry.LocalMachine.OpenSubKey(RegistryPath,create)) {
                if(root==null)throw new InvalidOperationException("Boot recovery registry is not installed");Check(root);
                using(var key=create?root.CreateSubKey("CurrentBoot",true,RegistryOptions.Volatile):root.OpenSubKey("CurrentBoot",false)) {
                    if(key==null)throw new InvalidOperationException("Boot recovery has not run this boot");Check(key);
                    var value=key.GetValue("Epoch") as string;
                    if(value==null && create){value=Guid.NewGuid().ToString("D");key.SetValue("Epoch",value,RegistryValueKind.String);key.Flush();}
                    Guid id;if(!Guid.TryParse(value,out id) || id==Guid.Empty)throw new InvalidOperationException("Boot epoch missing/corrupt; no recovery allowed");return id.ToString("D");
                }
            }
        }
        public static bool FullBootsConfigured() {
            using(var key=Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Session Manager\Power"))
                return key!=null && Object.Equals(key.GetValue("HiberbootEnabled"),0);
        }
    }
}
