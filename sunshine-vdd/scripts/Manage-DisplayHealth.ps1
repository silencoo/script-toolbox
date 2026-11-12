[CmdletBinding()]
param(
    [ValidateSet('Install','Uninstall','Rollback')][string]$Operation='Install',
    [ValidateSet('Tray','Recovery','All')][string]$Component='All',
    [string]$ConfigurationPath,
    [string]$BuildDirectory,
    [string]$MonitorDirectory="$env:ProgramData\SunshineDisplayHealth\monitor",
    [string]$BackupId,
    [switch]$ApproveSunshineStartupDependency,
    [switch]$ConfirmSoleSunshineServiceLauncher,
    [switch]$ApproveFastStartupChange,
    [switch]$IndependentRecoveryConfirmed,
    [switch]$Apply
)
$ErrorActionPreference='Stop'
if(!$BuildDirectory){$BuildDirectory=Join-Path $PSScriptRoot '../native/bin'}
Import-Module (Join-Path $PSScriptRoot '../boot-recovery/BootRecovery.Core.psm1') -Force
$plan=Get-BootRecoveryInstallPlan -Operation $Operation -Component $Component -StartupCoordinationApproved $ApproveSunshineStartupDependency.IsPresent
$install=$plan.BinaryDirectory;$data=$plan.DataDirectory;$serviceName=$plan.ServiceName;$taskName=$plan.TrayTask
$files=@('SunshineDisplay.Core.dll','SunshineDisplay.Native.dll','SunshineDisplay.Recovery.exe','SunshineDisplay.Tray.exe','recovery.json','installation.json')
if($Component -eq 'Tray'){$files=@('SunshineDisplay.Core.dll','SunshineDisplay.Native.dll','SunshineDisplay.Tray.exe','installation.json')}
$config=$null
if($Operation -eq 'Install' -and $Component -ne 'Tray'){
    if($ConfigurationPath){
        $config=Get-Content -LiteralPath $ConfigurationPath -Raw|ConvertFrom-Json
        Import-Module (Join-Path $PSScriptRoot 'DisplayTopology.psm1') -Force
        $approved=@($config.PhysicalDisplays|ForEach-Object {$a=[SunshineVddSkill.ApprovedDisplay]::new();$a.InstanceId=$_.InstanceId;$a.Width=$_.Width;$a.Height=$_.Height;$a.X=$_.X;$a.Y=$_.Y;$a.RefreshRate=$_.RefreshRate;$a.Primary=$_.Primary;$a})
        [SunshineVddSkill.NativeDisplay]::ValidateApproval($approved)
        if($config.SchemaVersion -ne 1 -or $config.TimeoutSeconds -lt 10 -or $config.TimeoutSeconds -gt 90 -or $config.MaxAttempts -lt 1 -or $config.MaxAttempts -gt 3){throw 'Invalid bounded recovery configuration'}
    }
}
$plan | Add-Member Configuration $config
$plan | Add-Member MonitorDirectory $MonitorDirectory
$plan | Add-Member BackupId $BackupId
$plan | Add-Member FastStartupChangeApproved $ApproveFastStartupChange.IsPresent
$plan | Add-Member FullBootRequirement $(if($Component -eq 'Tray'){'None; Fast Startup is preserved'}else{'Current recovery implementation requires Fast Startup disabled. Hybrid startup is unsupported; changing the setting requires separate approval.'})
if(!$Apply){$plan;return}
# Refuse partial upgrades of an already deployed recovery runtime.
if($Component -eq 'Recovery'){throw 'Use All for recovery deployment because the native runtime is shared.'}
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if(!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Apply requires an elevated administrator. Preview does not.'}
if($Component -ne 'Tray' -and !$IndependentRecoveryConfirmed){throw 'Confirm usable independent recovery access before installing, removing or rolling back the boot dependency.'}
if($Component -ne 'Tray' -and (!$ApproveSunshineStartupDependency -or !$ConfirmSoleSunshineServiceLauncher)){throw 'Explicit startup dependency approval and confirmation of the sole SCM launcher are required; polling is not an interlock.'}
if($Operation -eq 'Install' -and $Component -ne 'Tray' -and !$config){throw 'Provide the reviewed physical-only configuration with -ConfigurationPath.'}
$powerKey='HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power'
$hiberboot=(Get-ItemProperty -LiteralPath $powerKey -ErrorAction Stop).HiberbootEnabled
if($hiberboot -notin @(0,1)){throw 'Fast Startup evidence is unknown; no installation changes permitted'}
if($Component -ne 'Tray' -and $Operation -eq 'Install' -and $hiberboot -ne 0 -and !$ApproveFastStartupChange){throw 'Fast Startup is enabled or unknown. Full-boot recovery needs separate approval to disable it.'}
if($MonitorDirectory.StartsWith('\\') -or ![IO.Path]::IsPathRooted($MonitorDirectory) -or $MonitorDirectory.Contains('"')){throw 'MonitorDirectory must be a local absolute path without quotes.'}
function Assert-NoReparse([string]$Path){
    for($p=[IO.Path]::GetFullPath($Path);$p;$p=[IO.Path]::GetDirectoryName($p)){if((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw "Reparse point refused: $p"}}
}
function Protect-Path([string]$Path){
    Assert-NoReparse $Path
    $isDirectory=(Get-Item -LiteralPath $Path).PSIsContainer
    $acl=if($isDirectory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
    $acl.SetAccessRuleProtection($true,$false)
    $admin=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544');$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18');$users=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    $acl.SetOwner($admin)
    $inherit=if($isDirectory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
    foreach($sid in @($admin,$system)){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$inherit,'None','Allow'))}
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users,'ReadAndExecute',$inherit,'None','Allow'))
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Invoke-Sc([string[]]$Arguments){& "$env:SystemRoot\System32\sc.exe" @Arguments | Out-Null;if($LASTEXITCODE -ne 0){throw "SCM command failed ($LASTEXITCODE): $($Arguments[0])"}}
function Set-Dependencies([string[]]$Values){Invoke-Sc @('config','SunshineService','depend=',$(if($Values.Count){$Values -join '/'}else{'/'}))}
function Get-Dependencies { $key=Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\SunshineService';if($key.PSObject.Properties.Name -contains 'DependOnService'){@($key.DependOnService)} }
function Assert-OwnedInstallation {
    $marker=Join-Path $install 'installation.json'
    if((Test-Path -LiteralPath $install) -and @(Get-ChildItem -LiteralPath $install -Force).Count -gt 0 -and !(Test-Path -LiteralPath $marker)){throw 'Existing installation directory has no ownership manifest; inspect it manually.'}
    if(Test-Path -LiteralPath $marker){$m=Get-Content -LiteralPath $marker -Raw|ConvertFrom-Json;if($m.Product -ne 'SunshineDisplayHealth'){throw 'Installation ownership mismatch'}}
    $service=Get-CimInstance Win32_Service -Filter "Name='SunshineBootRecovery'"
    if($Component -eq 'Tray' -and $service){throw 'Recovery already shares this runtime; tray-only mutation is refused. Use a reviewed All deployment.'}
    if($service -and $service.PathName -ne ('"'+(Join-Path $install 'SunshineDisplay.Recovery.exe')+'"')){throw 'Service name collision; refusing to touch another binary'}
    $task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if($task -and (@($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ne (Join-Path $install 'SunshineDisplay.Tray.exe'))){throw 'Tray task name collision'}
}
Assert-NoReparse $install;Assert-NoReparse $data
Assert-OwnedInstallation
# Never follow an existing child junction while backing up privileged files.
foreach($base in @($install,$data)){if(Test-Path -LiteralPath $base){foreach($item in Get-ChildItem -LiteralPath $base -Recurse -Force){Assert-NoReparse $item.FullName}}}
if($Operation -eq 'Install'){foreach($file in $files|Where-Object {$_ -match '\.(exe|dll)$'}){if(!(Test-Path -LiteralPath (Join-Path $BuildDirectory $file))){throw "Build first; missing $file"}}}
[void](New-Item -ItemType Directory -Path $install,$data -Force);Protect-Path $install;Protect-Path $data
$backupRoot=Join-Path $data 'backups';[void](New-Item -ItemType Directory -Path $backupRoot -Force);Protect-Path $backupRoot
$backup=Join-Path $backupRoot ((Get-Date -Format 'yyyyMMdd-HHmmss-fff')+'-'+[guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $backup);Protect-Path $backup
$existing=@($files|Where-Object {Test-Path -LiteralPath (Join-Path $install $_)})
foreach($file in $existing){Copy-Item -LiteralPath (Join-Path $install $file) -Destination $backup}
$oldService=Get-CimInstance Win32_Service -Filter "Name='SunshineBootRecovery'"
$oldTask=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($oldService -and $oldService.State -notin @('Running','Stopped')){throw 'Existing recovery service is transitioning; wait for it to finish before any deployment mutation'}
if($oldTask){Export-ScheduledTask -TaskName $taskName|Set-Content -LiteralPath (Join-Path $backup 'tray-task.xml') -Encoding Unicode}
$before=[pscustomobject]@{Product='SunshineDisplayHealth';Component=$Component;Files=$existing;SunshineDependencies=@(Get-Dependencies);HiberbootEnabled=$hiberboot;HadService=[bool]$oldService;HadTask=[bool]$oldTask;ServiceStartMode=$oldService.StartMode;ServiceWasRunning=($oldService -and $oldService.State -eq 'Running');TaskWasRunning=($oldTask -and $oldTask.State -eq 'Running')}
$before|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $backup 'before.json') -Encoding UTF8
function Restore-Backup([string]$Directory){
    Assert-NoReparse $Directory
    $saved=Get-Content -LiteralPath (Join-Path $Directory 'before.json') -Raw|ConvertFrom-Json
    if($saved.Product -ne 'SunshineDisplayHealth'){throw 'Invalid backup manifest'}
    if($saved.Component -ne $Component){throw 'Backup component does not match the requested rollback scope'}
    $currentPower=(Get-ItemProperty -LiteralPath $powerKey).HiberbootEnabled
    if($Component -ne 'Tray' -and $saved.HiberbootEnabled -ne $currentPower -and !$ApproveFastStartupChange){throw 'Rollback requires explicit approval to restore the previous Fast Startup setting'}
    foreach($f in $saved.Files){if($files -notcontains $f){throw 'Unexpected backup file name'}}
    if(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue){Stop-ScheduledTask -TaskName $taskName;Unregister-ScheduledTask -TaskName $taskName -Confirm:$false}
    if($Component -ne 'Tray'){
        if((Get-Service $serviceName -ErrorAction SilentlyContinue).Status -eq 'StartPending'){throw 'Recovery is in progress; rollback must wait for the helper to exit'}
        Set-Dependencies @(Get-Dependencies|Where-Object {$_ -ne $serviceName})
        $present=Get-CimInstance Win32_Service -Filter "Name='SunshineBootRecovery'"
        if($present){Stop-Service $serviceName -ErrorAction Stop;if(!$saved.HadService){Invoke-Sc @('delete',$serviceName)}}
    }
    foreach($f in $files){$dest=Join-Path $install $f;if($saved.Files -contains $f){Copy-Item -LiteralPath (Join-Path $Directory $f) -Destination $dest -Force;Protect-Path $dest}elseif(Test-Path -LiteralPath $dest){Remove-Item -LiteralPath $dest}}
    # Restore only our dependency membership; preserve unrelated changes made since the backup.
    if($Component -ne 'Tray'){
    $deps=@(Get-Dependencies|Where-Object {$_ -ne $serviceName});if($saved.SunshineDependencies -contains $serviceName){$deps+=$serviceName};Set-Dependencies $deps
    if($saved.HadService){Invoke-Sc @($(if($present){'config'}else{'create'}),$serviceName,'binPath=',('"'+(Join-Path $install 'SunshineDisplay.Recovery.exe')+'"'),'start=',$(if($saved.ServiceStartMode -eq 'Auto'){'auto'}elseif($saved.ServiceStartMode -eq 'Disabled'){'disabled'}else{'demand'}),'obj=','LocalSystem')}
    if($saved.HiberbootEnabled -ne $currentPower){Set-ItemProperty -LiteralPath $powerKey -Name HiberbootEnabled -Type DWord -Value $saved.HiberbootEnabled}
    }
    if($saved.HadTask){Register-ScheduledTask -TaskName $taskName -Xml (Get-Content -LiteralPath (Join-Path $Directory 'tray-task.xml') -Raw) -Force|Out-Null}
    # Recovery is deliberately not started now. Current-boot completion/claim and diagnostic data are retained.
}
try {
    if($Operation -eq 'Rollback'){
        if($BackupId -notmatch '^\d{8}-\d{6}-\d{3}-[a-f0-9]{32}$'){throw 'Supply one backup directory name from the protected backups directory'}
        Restore-Backup (Join-Path $backupRoot $BackupId)
    } elseif($Operation -eq 'Uninstall'){
        if($Component -ne 'Recovery' -and $oldTask){Stop-ScheduledTask -TaskName $taskName;Unregister-ScheduledTask -TaskName $taskName -Confirm:$false}
        if($Component -ne 'Tray'){
            if((Get-Service $serviceName -ErrorAction SilentlyContinue).Status -eq 'StartPending'){throw 'Recovery is in progress; uninstall must wait'}
            $manifest=Get-Content -LiteralPath (Join-Path $install 'installation.json') -Raw|ConvertFrom-Json
            if($manifest.OriginalHiberbootEnabled -ne $hiberboot -and !$ApproveFastStartupChange){throw 'Uninstall needs approval to restore the original Fast Startup setting'}
            Set-Dependencies @(Get-Dependencies|Where-Object {$_ -ne $serviceName})
            if($oldService){Stop-Service $serviceName -ErrorAction Stop;Invoke-Sc @('delete',$serviceName)}
            if($manifest.OriginalHiberbootEnabled -ne $hiberboot){Set-ItemProperty -LiteralPath $powerKey -Name HiberbootEnabled -Type DWord -Value $manifest.OriginalHiberbootEnabled}
        }
    } else {
        # Refuse to force-stop dependent Sunshine. If the installed recovery service cannot stop, abort the upgrade.
        if($oldService -and $oldService.State -eq 'Start Pending'){throw 'Recovery is in progress; wait before upgrading'}
        if($oldService -and $oldService.State -ne 'Stopped'){Set-Dependencies @(Get-Dependencies|Where-Object {$_ -ne $serviceName});Stop-Service $serviceName -ErrorAction Stop}
        if($oldTask){Stop-ScheduledTask -TaskName $taskName}
        foreach($file in $files|Where-Object {$_ -match '\.(exe|dll)$'}){Copy-Item -LiteralPath (Join-Path $BuildDirectory $file) -Destination (Join-Path $install $file) -Force;Protect-Path (Join-Path $install $file)}
        if($Component -ne 'Tray'){
            if($hiberboot -ne 0){Set-ItemProperty -LiteralPath $powerKey -Name HiberbootEnabled -Type DWord -Value 0}
            $regPath='HKLM:\SOFTWARE\SunshineDisplayHealth'
            if(!(Test-Path -LiteralPath $regPath)){New-Item -Path $regPath|Out-Null}
            $regAcl=[Security.AccessControl.RegistrySecurity]::new();$regAcl.SetAccessRuleProtection($true,$false)
            $regAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
            foreach($sid in @('S-1-5-18','S-1-5-32-544')){$regAcl.AddAccessRule([Security.AccessControl.RegistryAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit','None','Allow'))}
            $regAcl.AddAccessRule([Security.AccessControl.RegistryAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'ReadKey','ContainerInherit','None','Allow'))
            Set-Acl -LiteralPath $regPath -AclObject $regAcl
            $config.ScmStartupCoordinationApproved=$true;$config.SunshineServiceIsSoleLauncher=$true
            $config|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $install 'recovery.json') -Encoding UTF8;Protect-Path (Join-Path $install 'recovery.json')
            if(!$oldService){Invoke-Sc @('create',$serviceName,'binPath=',('"'+(Join-Path $install 'SunshineDisplay.Recovery.exe')+'"'),'start=','auto','obj=','LocalSystem')}
            Invoke-Sc @('config',$serviceName,'start=','auto')
            Invoke-Sc @('sdset',$serviceName,'D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;CCLCSWLOCRRC;;;BU)')
            Set-Dependencies @(@(Get-Dependencies)+$serviceName|Select-Object -Unique)
        }
        if($Component -ne 'Recovery'){
            $user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
            $action=New-ScheduledTaskAction -Execute (Join-Path $install 'SunshineDisplay.Tray.exe') -Argument ('--monitor-root "'+$MonitorDirectory+'"') -WorkingDirectory $install
            $trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
            $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
            $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([timespan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
            Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force|Out-Null
        }
        if($Component -eq 'Tray' -and $oldService){Set-Dependencies $before.SunshineDependencies}
        $originalHiberboot=$hiberboot
        if($existing -contains 'installation.json'){$originalHiberboot=(Get-Content -LiteralPath (Join-Path $backup 'installation.json') -Raw|ConvertFrom-Json).OriginalHiberbootEnabled}
        [pscustomobject]@{Product='SunshineDisplayHealth';OriginalHiberbootEnabled=$originalHiberboot;InstalledAtUtc=[datetime]::UtcNow.ToString('o');Backup=$backup;Hashes=@(Get-ChildItem -LiteralPath $install -File|Where-Object Extension -in @('.exe','.dll')|Get-FileHash)}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $install 'installation.json') -Encoding UTF8
        Protect-Path (Join-Path $install 'installation.json')
    }
} catch {
    $failure=$_
    try{Restore-Backup $backup}catch{throw "Operation failed: $failure. Automatic rollback also failed: $_. Preserve backup $backup and use independent recovery access."}
    throw "Operation failed and installation backup was restored: $failure. Backup: $backup"
}
[pscustomobject]@{Operation=$Operation;Component=$Component;Backup=$backup;RecoveryStartedNow=$false;MonitorUnchanged=$true;Next='Inspect preview/readiness and arrange an approved boot test. Completion state and logs were retained.'}
