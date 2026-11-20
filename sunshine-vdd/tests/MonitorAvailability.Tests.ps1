$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '../monitor/Monitor.Core.psm1') -Force
function Check($condition,$message){if(!$condition){throw $message}}
$ended=[datetime]'2025-01-02 12:00:00'
$started=$ended.AddHours(-1)
$state=New-CaptureState
$state.Epoch=$started
$state.LastFullDisconnect=$ended
$panel=[pscustomobject]@{InstanceId='panel';Present=$true}
$vdd=[pscustomobject]@{InstanceId='vdd';Present=$true}
$vddPath=[pscustomobject]@{InstanceId='vdd';Active=$true;PhysicalConnector=$false;SourceName='display2'}
$physicalPath=[pscustomobject]@{InstanceId='panel';Active=$true;PhysicalConnector=$true;SourceName='display1'}
$s=[pscustomobject]@{
    ExpectedPhysicalMonitor='Panel';ExpectedMonitor='Vdd';Config=@{dd_config_revert_delay='20000'}
    SunshineProcesses=@([pscustomobject]@{StartTime=$started})
    DisplayPaths=@($vddPath);Displays=@([pscustomobject]@{Primary=$true;DeviceName='display2'})
    DisplayTargets=@($vdd);Devices=[pscustomobject]@{At=$ended;Items=@($vdd)}
    PhysicalAvailability=$null;Health=[pscustomobject]@{Phase='Idle';Status='Degraded';Reason='IdlePhysicalDisplayNotRestored'}
}
function Tick([int]$seconds,$previous,[int]$evidenceAge=0){
    $now=$ended.AddSeconds($seconds)
    $s.Devices.At=$now.AddSeconds(-$evidenceAge).ToString('o')
    $s.PhysicalAvailability=Get-PhysicalMonitorAvailability $s.PhysicalAvailability $s $now
    $s.Health.Reason='IdlePhysicalDisplayNotRestored';$s.Health.Status='Degraded'
    Update-IdleDisplayHealth $s $now
    Get-DisconnectResult $previous $state $s $started $now
}
$waiting=Tick 30 $null
Check ($waiting.Outcome -eq 'WaitingForMonitor' -and $s.Health.Status -eq 'Starting' -and $s.Health.Reason -eq 'WaitingForPhysicalMonitor') 'Confirmed absence should be quiet in live and historical health'
$state.Clients=1
$closed=Tick 31 ($waiting|ConvertTo-Json|ConvertFrom-Json)
Check ($closed.Outcome -eq 'WaitingForMonitor' -and $closed.Closed) 'Reconnection keeps a quiet historical result'
$state.Clients=0
$result=Tick 40 $null 20
Check ($s.PhysicalAvailability.Status -eq 'Unknown' -and $result.Outcome -eq 'Pending' -and $s.Health.Reason -eq 'PhysicalMonitorPresenceUnverified') 'Stale PnP evidence must not decide presence'
$s.Devices.Items=@([pscustomobject]@{Error='Fixture';Present=$null})
$result=Tick 41 $result
Check ($s.PhysicalAvailability.Status -eq 'Unknown' -and $result.Outcome -eq 'Pending') 'CIM failure cannot mean absence or failure'
$s.Devices.Items=@($vdd,$panel)
$result=Tick 42 $waiting
Check ($s.PhysicalAvailability.Status -eq 'Unknown' -and $result.Outcome -ne 'Failed') 'Disagreeing inventories cannot establish failure'
$s.DisplayTargets=@($vdd,$panel)
$checking=Tick 50 $waiting
Check ($checking.Outcome -eq 'Pending' -and $s.Health.Reason -eq 'DisplayRevertGracePeriod') 'A returning panel gets a fresh grace period'
$result=Tick 74 $checking
Check ($result.Outcome -eq 'Pending' -and $s.Health.Status -eq 'Starting') 'Honor the custom revert delay after return'
$s.DisplayPaths=@($physicalPath);$s.Displays[0].DeviceName='display1'
Check ((Tick 74 $checking).Outcome -eq 'Restored') 'Recovery during return grace stays quiet even after a long absence'
$s.DisplayPaths=@($vddPath);$s.Displays[0].DeviceName='display2'
$failed=Tick 75 $checking
Check ($failed.Outcome -eq 'Failed' -and $s.Health.Status -eq 'Degraded') 'A present panel that fails to restore still warns'
$s.DisplayTargets=@($vdd);$s.Devices.Items=@($vdd)
Check ((Tick 85 $failed).Outcome -eq 'Failed') 'Later absence cannot erase an observed failure'
$s.DisplayPaths=@($physicalPath);$s.Displays[0].DeviceName='display1'
Check ((Tick 90 $failed).Outcome -eq 'Late') 'Recovery following an observed failure still warns'
$state.Clients=1
Check ((Tick 100 $closed).Outcome -eq 'WaitingForMonitor') 'A panel returning during the next stream cannot change history'
$s.Health.Phase='Streaming';$s.Health.Status='Degraded';$s.Health.Reason='PrivacyPhysicalDisplayStillAttached'
Update-IdleDisplayHealth $s ($ended.AddSeconds(101))
Check ($s.Health.Reason -eq 'PrivacyPhysicalDisplayStillAttached' -and $s.Health.Status -eq 'Degraded') 'An active physical path during streaming is still a privacy fault'
Write-Output 'Physical monitor availability fixtures passed.'
