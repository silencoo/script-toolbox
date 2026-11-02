[CmdletBinding()]
param(
    [string]$InstallDirectory="$env:LOCALAPPDATA\SunshineMonitor",
    [string]$TaskName='SunshineDisplayDiagnosticMonitor',
    [string]$StreamMonitorInstanceId,
    [string]$IdleMonitorInstanceId,
    [string]$OutputGuid,
    [switch]$Apply
)
$ErrorActionPreference='Stop'
$source=Join-Path (Split-Path $PSScriptRoot) 'monitor'
$settingsPath=Join-Path $InstallDirectory 'settings.json'
$settings=if(Test-Path -LiteralPath $settingsPath){Get-Content -LiteralPath $settingsPath -Raw|ConvertFrom-Json}else{
    [pscustomobject]@{LogPath="$env:ProgramFiles\Sunshine\config\sunshine.log";ConfigPath="$env:ProgramFiles\Sunshine\config\sunshine.conf";ExpectedMonitorInstanceId='';ExpectedOutputGuid='';PollSeconds=2;RetentionDays=14;MaxDataBytes=268435456;PrivacyMode=$true;IdleMonitorInstanceId='';ExpectedStreamResolution=$null;ExpectedStreamRefreshRate=$null}
}
if($StreamMonitorInstanceId){$settings.ExpectedMonitorInstanceId=$StreamMonitorInstanceId}
if($IdleMonitorInstanceId){$settings.IdleMonitorInstanceId=$IdleMonitorInstanceId}
if($OutputGuid){$settings.ExpectedOutputGuid=$OutputGuid}
if(!$settings.ExpectedMonitorInstanceId -or !$settings.IdleMonitorInstanceId -or $settings.ExpectedOutputGuid -notmatch '^\{[0-9a-fA-F-]{36}\}$'){throw 'Supply live stream/idle monitor instance IDs and the Sunshine output GUID.'}
$files=@('Watch-Sunshine.ps1','Monitor.Core.psm1','Guard.Core.psm1','Guard.Actions.psm1')
$task=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if(!$Apply){[pscustomobject]@{Mode='DryRun';InstallDirectory=$InstallDirectory;TaskName=$TaskName;ExistingTask=[bool]$task;Settings=$settings;ProtectionMode='Observe';Files=$files};return}
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run this installer from elevated PowerShell; it updates the existing elevated task.'}
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
    foreach($file in $files){Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $InstallDirectory $file) -Force}
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'DisplayTopology.psm1') -Destination $InstallDirectory -Force
    Copy-Item -LiteralPath (Join-Path $source 'README.md') -Destination (Join-Path $InstallDirectory 'README.md') -Force
    $settings | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $settingsPath -Encoding UTF8
    # Every upgrade starts in Observe. Enabling protection is separate and requires both baselines.
    Copy-Item -LiteralPath (Join-Path $source 'guard.example.json') -Destination (Join-Path $InstallDirectory 'guard.json') -Force
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
} catch {
    $failure=$_
    foreach($file in $existingFiles){Copy-Item -LiteralPath (Join-Path $backup $file.Name) -Destination $file.FullName -Force}
    if($task){Register-ScheduledTask -TaskName $TaskName -Xml (Get-Content -LiteralPath (Join-Path $backup 'task.xml') -Raw) -Force|Out-Null;if($wasRunning){Start-ScheduledTask -TaskName $TaskName}}
    throw $failure
}
[pscustomobject]@{Mode='InstalledObserve';TaskName=$TaskName;BackupDirectory=$backup;InstallDirectory=$InstallDirectory;Next='Verify heartbeat; capture verified physical idle and virtual streaming baselines before enabling Protect.'}
