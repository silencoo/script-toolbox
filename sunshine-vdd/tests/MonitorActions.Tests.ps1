$ErrorActionPreference='Stop'
$module=Import-Module (Join-Path $PSScriptRoot '../monitor/Guard.Actions.psm1') -Force -PassThru
Import-Module (Join-Path $PSScriptRoot '../monitor/Guard.Core.psm1') -Force
$temp=Join-Path ([IO.Path]::GetTempPath()) ('sunshine-guard-tests-'+[guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path (Join-Path $temp 'data') -Force)
function Assert($value,[string]$message){if(!$value){throw $message};Write-Output "PASS $message"}
try {
    $corrupt=Join-Path $temp 'data/guard-state.json'
    [IO.File]::WriteAllBytes($corrupt,(New-Object byte[] 334))
    $rejected=$false
    try{Read-GuardRuntime -Path $corrupt -Mode Protect|Out-Null}catch{$rejected=$true}
    Assert $rejected 'Unreadable persisted state cannot start automatic protection'
    $recovered=Read-GuardRuntime -Path $corrupt -Mode Observe
    Assert ($recovered.Latched -and $recovered.FailureHandled -and $recovered.Notice -match 'unreadable') 'Observe diagnostics preserve an explicit fault when saved state is corrupt'
    Assert (([IO.File]::ReadAllBytes($corrupt)|Where-Object {$_ -ne 0}).Count -eq 0) 'Unreadable source evidence is preserved'
    Assert (@(Get-ChildItem -LiteralPath (Join-Path $temp 'data') -Filter '*.unreadable-*.json').Count -eq 1) 'Unreadable state is copied before any future status write'
    $expected=[pscustomobject]@{Trusted=$true;Phase='Streaming';SessionKey='test';ModeKey='1920x1080@60';MonitorId='virtual-test';ConfigMatches=$true}
    $idle=$expected.PSObject.Copy();$idle.Phase='Idle';$rejected=$false
    try{& $module {param($observation) Invoke-GuardRestore $null $observation {throw 'Refresh should not execute'}} $idle}catch{$rejected=$_.Exception.Message -match 'polling is not an interlock'}
    Assert $rejected 'Idle monitor cannot activate physical paths in the reconnect race'
    & $module {param($a) Assert-GuardFreshObservation $a $a} $expected
    foreach($change in @(@('Phase','Idle'),@('SessionKey','new-session'),@('ModeKey','2560x1440@120'),@('MonitorId','different-monitor'),@('Trusted',$false),@('ConfigMatches',$false))){
        $fresh=$expected.PSObject.Copy();$fresh.($change[0])=$change[1];$rejected=$false
        try { & $module {param($a,$b) Assert-GuardFreshObservation $a $b} $expected $fresh } catch {$rejected=$true}
        Assert $rejected ('Correction rejects a changed '+$change[0]+' before native apply')
    }
    & $module {
        $script:events=New-Object 'Collections.Generic.List[string]'
        $script:lockResult=$true
        function script:Get-GuardObservation {param($Context,$Snapshot,$CaptureState) [pscustomobject]@{Trusted=$true;Phase='Streaming';SessionKey='test';Healthy=$false;Grace=$false;Reason='ExpectedMonitorNotAttached';Stable=$true;BaselineAvailable=$false;ConfigMatches=$true}}
        function script:Save-GuardBaseline {param($Context,$Observation,$Snapshot)}
        function script:Confirm-GuardLock {
            $saved=Get-Content -LiteralPath $script:runtimePath -Raw|ConvertFrom-Json
            if(!$saved.Latched -or $saved.FailureHandled){throw 'Latch must be durable and pending before lock'}
            $script:events.Add('Lock');return $script:lockResult
        }
        function script:Stop-Service {param($Name,$ErrorAction) $script:events.Add('Stop:'+ $Name)}
        function script:Send-GuardNotice {param($Root,$Message) $script:events.Add('Notice')}
    }
    $policy=[pscustomobject]@{Mode='Protect';MaxAttempts=2;RetrySeconds=10;FaultSeconds=5;MaxUnstableSeconds=25;ServiceName='SunshineService'}
    $context=[pscustomobject]@{Root=$temp;Policy=$policy;Runtime=(New-GuardState);RuntimePath=(Join-Path $temp 'data/state.json');LastDecision=$null}
    & $module {param($path) $script:runtimePath=$path} $context.RuntimePath
    $snapshot=[pscustomobject]@{At=[datetime]'2025-01-03 00:00:00'}
    [void](Invoke-GuardTick $context $snapshot $null $null {})
    $snapshot.At=$snapshot.At.AddSeconds(6)
    [void](Invoke-GuardTick $context $snapshot $null $null {})
    $events=& $module {$script:events.ToArray()}
    Assert (($events -join ',') -eq 'Lock,Stop:SunshineService,Notice') 'Failure handling locks and confirms before stopping Sunshine'
    Assert ($context.Runtime.Latched -and $context.Runtime.FailureHandled) 'Completed failure handling remains latched'
    [void](Invoke-GuardTick $context $snapshot $null $null {})
    Assert ((& $module {$script:events.Count}) -eq 3) 'A completed failure is not repeated on every poll'
    $context.Runtime=New-GuardState
    & $module {$script:events.Clear();$script:lockResult=$false}
    [void](Invoke-GuardTick $context $snapshot $null $null {})
    $snapshot.At=$snapshot.At.AddSeconds(6)
    [void](Invoke-GuardTick $context $snapshot $null $null {})
    $events=& $module {$script:events.ToArray()}
    Assert (($events -join ',') -eq 'Lock,Notice') 'Unconfirmed lock never stops Sunshine or exposes physical recovery'
    $context.Runtime=New-GuardState;$context.Policy.Mode='Observe'
    & $module {$script:events.Clear()}
    [void](Invoke-GuardTick $context $snapshot $null $null {})
    Assert ((& $module {$script:events.Count}) -eq 0) 'Observe executes no lock, service stop or correction'
} finally {
    Remove-Module Guard.Actions -Force -ErrorAction SilentlyContinue
    # Remove only the known, unique test directory under the OS temp root.
    $resolved=[IO.Path]::GetFullPath($temp)
    if(!$resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notlike 'sunshine-guard-tests-*'){throw 'Unexpected test cleanup target'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
