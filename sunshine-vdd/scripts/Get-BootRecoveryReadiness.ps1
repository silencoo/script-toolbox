[CmdletBinding()]
param([string]$MonitorDirectory,[switch]$AsObject)
$ErrorActionPreference='Stop'
if(!$MonitorDirectory){$MonitorDirectory=Join-Path $env:ProgramData 'SunshineDisplayHealth\monitor';if(!(Test-Path -LiteralPath $MonitorDirectory)){$MonitorDirectory=Join-Path $env:LOCALAPPDATA 'SunshineMonitor'}}
Import-Module (Join-Path $PSScriptRoot 'DisplayTopology.psm1') -Force
$issues=[Collections.Generic.List[string]]::new()
$boot=$null;$paths=@();$gdi=@();$console=$null
try{$paths=@([SunshineVddSkill.NativeDisplay]::EnumeratePaths($false));$gdi=@(Get-VddDisplayInventory);$boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')}catch{$issues.Add($_.Exception.Message)}
$service=$null;$tasks=@();$processes=@();$processKnown=$false
try{
    $service=Get-CimInstance Win32_Service -Filter "Name='SunshineService'" -ErrorAction Stop | Select-Object Name,State,StartMode,StartName,PathName
    $processes=@(Get-CimInstance Win32_Process -Filter "Name='sunshine.exe' OR Name='sunshinesvc.exe'" -ErrorAction Stop | Select-Object Name,ProcessId,SessionId,CreationDate)
    $processKnown=$true
    $tasks=@(Get-ScheduledTask -ErrorAction Stop | Where-Object TaskName -in @('SunshineDisplayDiagnosticMonitor','SunshineDisplayHealthTray') | ForEach-Object {$info=Get-ScheduledTaskInfo $_;[pscustomobject]@{Name=$_.TaskName;State=[string]$_.State;LastResult=$info.LastTaskResult;LastRun=$info.LastRunTime;Actions=$_.Actions|Select-Object Execute,Arguments}})
}catch{$issues.Add($_.Exception.Message)}
$monitor=$null
try{$monitor=Get-Content -LiteralPath (Join-Path $MonitorDirectory 'data/status.json') -Raw -ErrorAction Stop|ConvertFrom-Json -ErrorAction Stop;if(!$monitor){throw 'Empty monitor status'}}catch{$issues.Add('Monitor status missing or corrupt: '+$_.Exception.Message)}
$recovery=$null
try{$path=Join-Path $env:ProgramData 'SunshineDisplayHealth/recovery-status.json';if(Test-Path -LiteralPath $path){$recovery=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json}}catch{$issues.Add('Recovery status corrupt: '+$_.Exception.Message)}
$dependencies=@()
try{$dependencies=@((Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\SunshineService' -Name DependOnService -ErrorAction Stop).DependOnService)}catch{}
$config=$null
try{$config=Get-Content -LiteralPath (Join-Path $MonitorDirectory 'settings.json') -Raw|ConvertFrom-Json}catch{$issues.Add('Monitor settings unavailable')}
$result=[pscustomobject]@{
    AtUtc=[datetime]::UtcNow.ToString('o');BootKey=$boot;ProcessSessionId=(Get-Process -Id $PID).SessionId
    SunshineService=$service;SunshineProcesses=$processes;ProcessEvidenceKnown=$processKnown
    RecoveryPermitted=$false
    Reason=if(!$processKnown){'UnknownSafetyEvidence'}elseif($processes.Count){'SunshineExists: automatic physical recovery must cancel'}elseif($dependencies -notcontains 'SunshineBootRecovery'){'ReconnectInterlockUnavailable'}else{'Requires protected service START_PENDING ownership; readiness is not permission to apply'}
    StartupDependencies=$dependencies;ApprovedMonitorSettings=$config
    FastStartupEnabled=(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -ErrorAction SilentlyContinue).HiberbootEnabled
    FreshPaths=$paths;GdiDisplays=$gdi;Tasks=$tasks;MonitorStatus=$monitor;RecoveryStatus=$recovery
    PreLogin='Console SYSTEM helper implemented; pre-login host verification pending. Session 0 and SYSTEM DisplaySwitch are not substitutes.'
    IndependentRecoveryAccess='Not proven by this script. A running VPN is not proof of usable RDP/SSH/local recovery.'
    VisiblePicture='Unverified. Device presence, active paths and capture evidence cannot prove visible pixels.'
    Issues=@($issues)
}
if($AsObject){$result}else{$result|ConvertTo-Json -Depth 12}
