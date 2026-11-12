[CmdletBinding()]
param(
    [string]$InstallDirectory="$env:ProgramData\SunshineDisplayHealth\monitor",
    [string]$PreviousDirectory="$env:LOCALAPPDATA\SunshineMonitor",
    [string]$TaskName='SunshineDisplayDiagnosticMonitor',
    [string]$StreamMonitorInstanceId,
    [string]$IdleMonitorInstanceId,
    [string]$OutputGuid,
    [switch]$Apply
)
$ErrorActionPreference='Stop'
$source=Join-Path (Split-Path $PSScriptRoot) 'monitor'
$settingsPath=Join-Path $InstallDirectory 'settings.json'
$previousSettings=Join-Path $PreviousDirectory 'settings.json'
$settingsSource=if(Test-Path -LiteralPath $settingsPath){$settingsPath}else{$previousSettings}
$settings=if(Test-Path -LiteralPath $settingsSource){Get-Content -LiteralPath $settingsSource -Raw|ConvertFrom-Json}else{
    [pscustomobject]@{LogPath="$env:ProgramFiles\Sunshine\config\sunshine.log";ConfigPath="$env:ProgramFiles\Sunshine\config\sunshine.conf";ExpectedMonitorInstanceId='';ExpectedOutputGuid='';PollSeconds=2;RetentionDays=14;MaxDataBytes=268435456;PrivacyMode=$true;IdleMonitorInstanceId='';ExpectedStreamResolution=$null;ExpectedStreamRefreshRate=$null}
}
if($StreamMonitorInstanceId){$settings.ExpectedMonitorInstanceId=$StreamMonitorInstanceId}
if($IdleMonitorInstanceId){$settings.IdleMonitorInstanceId=$IdleMonitorInstanceId}
if($OutputGuid){$settings.ExpectedOutputGuid=$OutputGuid}
if(!$settings.ExpectedMonitorInstanceId -or !$settings.IdleMonitorInstanceId -or $settings.ExpectedOutputGuid -notmatch '^\{[0-9a-fA-F-]{36}\}$'){throw 'Supply live stream/idle monitor instance IDs and the Sunshine output GUID.'}
$files=@('Watch-Sunshine.ps1','Monitor.Core.psm1','Guard.Core.psm1','Guard.Actions.psm1','Status.Core.psm1')
$task=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if(!$Apply){[pscustomobject]@{Mode='DryRun';InstallDirectory=$InstallDirectory;PreviousDirectory=$PreviousDirectory;TaskName=$TaskName;ExistingTask=[bool]$task;Settings=$settings;ProtectionMode='Observe';Files=$files;LegacyInstallationRetained=$true;Acl='SYSTEM/Administrators write; Users read and execute';ChangesSunshine=$false;ChangesFastStartup=$false};return}
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run this installer from elevated PowerShell; it updates the existing elevated task.'}
$protectedRoot=[IO.Path]::GetFullPath((Join-Path $env:ProgramData 'SunshineDisplayHealth'))
if([IO.Path]::GetFullPath($InstallDirectory) -ne (Join-Path $protectedRoot 'monitor')){throw 'Privileged monitor runtime must use the protected ProgramData SunshineDisplayHealth/monitor directory.'}
function Assert-NoReparse([string]$Path){
    for($p=[IO.Path]::GetFullPath($Path);$p;$p=[IO.Path]::GetDirectoryName($p)){if((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw "Reparse point refused: $p"}}
}
function Protect-MonitorPath([string]$Path){
    Assert-NoReparse $Path
    $directory=(Get-Item -LiteralPath $Path).PSIsContainer
    $acl=if($directory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
    $acl.SetAccessRuleProtection($true,$false);$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    $inherit=if($directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
    foreach($sid in @('S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl',$inherit,'None','Allow'))}
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'ReadAndExecute',$inherit,'None','Allow'))
    Set-Acl -LiteralPath $Path -AclObject $acl
}
foreach($base in @($protectedRoot,$PreviousDirectory)){
    Assert-NoReparse $base
    if(Test-Path -LiteralPath $base){foreach($item in Get-ChildItem -LiteralPath $base -Recurse -Force){Assert-NoReparse $item.FullName}}
}
[void](New-Item -ItemType Directory -Path $protectedRoot -Force);Protect-MonitorPath $protectedRoot
[void](New-Item -ItemType Directory -Path $InstallDirectory -Force);Protect-MonitorPath $InstallDirectory
$backup=Join-Path $InstallDirectory ('backups/'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
[void](New-Item -ItemType Directory -Path $backup -Force)
$existingFiles=@(Get-ChildItem -LiteralPath $InstallDirectory -File)
$existingFiles | Copy-Item -Destination $backup
$wasRunning=$task -and $task.State -eq 'Running'
if($task){Export-ScheduledTask -TaskName $TaskName | Set-Content -LiteralPath (Join-Path $backup 'task.xml') -Encoding Unicode;Stop-ScheduledTask -TaskName $TaskName
    $deadline=(Get-Date).AddSeconds(10)
    while((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running' -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 200}
    if((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running'){throw 'Old monitor did not stop; no runtime files changed.'}
}
try {
    # Keep the original installation intact for rollback and independent log access.
    if(!(Test-Path -LiteralPath (Join-Path $InstallDirectory 'data')) -and (Test-Path -LiteralPath (Join-Path $PreviousDirectory 'data'))){Copy-Item -LiteralPath (Join-Path $PreviousDirectory 'data') -Destination (Join-Path $InstallDirectory 'data') -Recurse}
    foreach($file in @('guard.json','settings.json')){if(!(Test-Path -LiteralPath (Join-Path $InstallDirectory $file)) -and (Test-Path -LiteralPath (Join-Path $PreviousDirectory $file))){Copy-Item -LiteralPath (Join-Path $PreviousDirectory $file) -Destination $InstallDirectory;Copy-Item -LiteralPath (Join-Path $PreviousDirectory $file) -Destination $backup}}
    foreach($file in $files){Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $InstallDirectory $file) -Force}
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'DisplayTopology.psm1') -Destination $InstallDirectory -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'DisplayRecovery.cs') -Destination $InstallDirectory -Force
    Copy-Item -LiteralPath (Join-Path $source 'README.md') -Destination (Join-Path $InstallDirectory 'README.md') -Force
    $settings | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $settingsPath -Encoding UTF8
    # Every upgrade starts in Observe. Enabling protection is separate and requires both baselines.
    $guardPath=Join-Path $InstallDirectory 'guard.json'
    $guard=Get-Content -LiteralPath $(if(Test-Path -LiteralPath $guardPath){$guardPath}else{Join-Path $source 'guard.example.json'}) -Raw|ConvertFrom-Json
    $guard.Mode='Observe';$guard|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $guardPath -Encoding UTF8
    foreach($item in Get-ChildItem -LiteralPath $InstallDirectory -Recurse -Force){Protect-MonitorPath $item.FullName}
    $action=New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+(Join-Path $InstallDirectory 'Watch-Sunshine.ps1')+'"') -WorkingDirectory $InstallDirectory
    if($task){Set-ScheduledTask -TaskName $TaskName -Action $action|Out-Null}
    else {
        $user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
        $trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
        $taskPrincipal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
        $taskSettings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([timespan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $taskSettings|Out-Null
    }
    Enable-ScheduledTask -TaskName $TaskName|Out-Null
    Start-ScheduledTask -TaskName $TaskName
    $deadline=(Get-Date).AddSeconds(35);$verified=$false
    do {
        Start-Sleep -Milliseconds 500
        try{$status=Get-Content -LiteralPath (Join-Path $InstallDirectory 'data/status.json') -Raw|ConvertFrom-Json;$verified=$status.SchemaVersion -eq 2 -and $status.Protection.Mode -eq 'Observe' -and ([datetime]::UtcNow-([datetime]$status.At).ToUniversalTime()).TotalSeconds -lt 10}catch{}
    }while(!$verified -and (Get-Date) -lt $deadline)
    if(!$verified){throw 'Monitor did not publish a fresh Observe heartbeat; restoring its previous task.'}
} catch {
    $failure=$_
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    foreach($file in $existingFiles){Copy-Item -LiteralPath (Join-Path $backup $file.Name) -Destination $file.FullName -Force}
    if($task){Register-ScheduledTask -TaskName $TaskName -Xml (Get-Content -LiteralPath (Join-Path $backup 'task.xml') -Raw) -Force|Out-Null;if($wasRunning){Start-ScheduledTask -TaskName $TaskName}}
    if(!$task){Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue}
    throw $failure
}
[pscustomobject]@{Mode='InstalledObserve';TaskName=$TaskName;BackupDirectory=$backup;InstallDirectory=$InstallDirectory;Next='Verify heartbeat; capture verified physical idle and virtual streaming baselines before enabling Protect.'}
