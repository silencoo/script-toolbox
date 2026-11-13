$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '../monitor/Guard.Core.psm1') -Force
Import-Module (Join-Path $PSScriptRoot '../monitor/Monitor.Core.psm1') -Force
function Assert($Condition,[string]$Message){if(!$Condition){throw $Message};Write-Output "PASS $Message"}
$policy=[pscustomobject]@{Mode='Protect';MaxAttempts=2;RetrySeconds=10;FaultSeconds=5;MaxUnstableSeconds=25}
$start=[datetime]'2026-11-02 21:43:15'
function Observation { [pscustomobject]@{Trusted=$true;Phase='Streaming';SessionKey='session1';Healthy=$false;Grace=$false;Reason='ExpectedMonitorNotAttached';Stable=$true;BaselineAvailable=$true;ConfigMatches=$true} }
$o=Observation;$s=New-GuardState
Assert ((Get-GuardDecision $s $o $policy $start).Action -eq 'None') 'Fault must persist before correction'
Assert ((Get-GuardDecision $s $o $policy $start.AddSeconds(5)).Action -eq 'RestoreStream') 'Verified stream snapshot can correct a persistent fault'
$s.Attempts=1;$s.LastAttempt=$start.AddSeconds(5)
Assert ((Get-GuardDecision $s $o $policy $start.AddSeconds(8)).Action -eq 'None') 'Wait for independent verification before another attempt'
Assert ((Get-GuardDecision $s $o $policy $start.AddSeconds(15)).Action -eq 'RestoreStream') 'Second bounded attempt allowed'
$s.Attempts=2;$s.LastAttempt=$start.AddSeconds(15)
Assert ((Get-GuardDecision $s $o $policy $start.AddSeconds(25)).Action -eq 'FailClosed') 'Budget exhaustion fails closed'
$o.Healthy=$true;[void](Get-GuardDecision $s $o $policy $start.AddSeconds(26));$o.Healthy=$false
[void](Get-GuardDecision $s $o $policy $start.AddSeconds(27))
Assert ((Get-GuardDecision $s $o $policy $start.AddSeconds(32)).Action -eq 'FailClosed') 'Healthy flicker does not reset the session attempt budget'
$s=New-GuardState;$o=Observation;$o.Trusted=$false
Assert ((Get-GuardDecision $s $o $policy $start).Action -eq 'None') 'Unknown log epoch never triggers topology changes'
$o=Observation;$o.Grace=$true
Assert ((Get-GuardDecision $s $o $policy $start).Action -eq 'None') 'Sunshine has time to perform its own display transition'
$o=Observation;$o.BaselineAvailable=$false;$s=New-GuardState
[void](Get-GuardDecision $s $o $policy $start)
Assert ((Get-GuardDecision $s $o $policy $start.AddSeconds(5)).Action -eq 'FailClosed') 'Missing verified stream baseline never activates a guessed display'
$o=Observation;$o.Stable=$false;$s=New-GuardState
[void](Get-GuardDecision $s $o $policy $start)
Assert ((Get-GuardDecision $s $o $policy $start.AddSeconds(10)).Action -eq 'None') 'Moving topology is not repeatedly chased'
Assert ((Get-GuardDecision $s $o $policy $start.AddSeconds(26)).Action -eq 'FailClosed') 'Moving topology cannot delay failure handling forever'
$o=Observation;$s=New-GuardState;$s.Latched=$true;$s.FailureHandled=$true
Assert ((Get-GuardDecision $s $o $policy $start).Action -eq 'None') 'Latched failure cannot resume streaming correction'
$o.Phase='Idle';$o.Grace=$true
Assert ((Get-GuardDecision $s $o $policy $start).Action -eq 'None') 'Latched recovery still respects disconnect grace'
$o.Grace=$false
Assert ((Get-GuardDecision $s $o $policy $start).Action -eq 'NotifyIdleFailure') 'Known idle baseline still requires a reconnect interlock before physical activation'
$s=New-GuardState;$o=Observation;$o.Phase='Idle';$o.BaselineAvailable=$false
[void](Get-GuardDecision $s $o $policy $start)
Assert ((Get-GuardDecision $s $o $policy $start.AddSeconds(5)).Action -eq 'NotifyIdleFailure') 'Missing idle baseline only notifies; no guessed recovery'
$policy.Mode='Observe';$s.Latched=$true;$s.FailureHandled=$false
Assert ((Get-GuardDecision $s $o $policy $start).Action -eq 'None') 'Observe mode suppresses all protection actions, including persisted latch'
$b=[pscustomobject]@{SchemaVersion=1;Phase='Streaming';MonitorId='MTT';ModeKey='2560x1440@120';BootKey='boot1';Record=[pscustomobject]@{Topology=[pscustomobject]@{PathCount=1};Displays=@([pscustomobject]@{Attached=$true})}}
Assert (Test-GuardBaseline $b Streaming MTT '2560x1440@120' boot1) 'Exact verified baseline accepted'
Assert (!(Test-GuardBaseline $b Streaming MTT '1920x1080@60' boot1)) 'Different client mode cannot reuse old stream snapshot'
Assert (!(Test-GuardBaseline $b Streaming MTT '2560x1440@120' boot2)) 'Native adapter identifiers are not reused across boots'
Assert (!(Test-GuardBaseline $b Streaming OTHER '2560x1440@120' boot1)) 'Changed monitor identity invalidates snapshot'
$capture=New-CaptureState
Update-CaptureState $capture @('[2026-11-02 21:42:00.000]: Info: Sunshine version: test','[2026-11-02 21:42:50.000]: Info: Scheduling display device configuration:','{','  "resolution": { "width": 2560, "height": 1440 },','  "refresh_rate": { "type": "rational", "value": { "numerator": 120, "denominator": 1 } }','}','[2026-11-02 21:42:54.000]: Info: CLIENT CONNECTED','[2025-01-03 00:03:37.000]: Info: CLIENT CONNECTED','[2025-01-03 00:03:38.000]: Info: CLIENT DISCONNECTED')
Assert ($capture.RequestedMode -eq '2560x1440@120') 'Client requested mode is parsed separately from fallback capture'
Assert ($capture.Clients -eq 1 -and $capture.FirstConnect -eq [datetime]'2026-11-02 21:42:54') 'Overlapping clients do not create a fresh session or grace window'
Write-Output 'Monitor guard policy tests passed; no native display/lock/service actions executed.'
