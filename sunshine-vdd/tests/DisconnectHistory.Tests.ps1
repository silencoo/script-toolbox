$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '../monitor/Monitor.Core.psm1') -Force
function Assert($condition,[string]$message){if(!$condition){throw $message}}
$state=New-CaptureState
Update-CaptureState $state @('[2025-01-02 12:00:00.000]: Sunshine version: fixture',
    '[2025-01-02 12:00:10.000]: CLIENT CONNECTED','[2025-01-02 12:00:11.000]: CLIENT CONNECTED',
    '[2025-01-02 12:01:00.000]: CLIENT DISCONNECTED')
Assert (!$state.LastFullDisconnect) 'One remaining client is still streaming'
Update-CaptureState $state @('[2025-01-02 12:02:00.100]: CLIENT DISCONNECTED',
    '[2025-01-02 12:02:01.100]: CLIENT DISCONNECTED')
$ended=[datetime]'2025-01-02 12:02:00.100'
Assert ($state.LastFullDisconnect -eq $ended) 'Duplicate disconnect moved the session end'
$start=$ended.AddMinutes(-1)
$panel=[pscustomobject]@{InstanceId='panel';Active=$true;PhysicalConnector=$true;SourceName='display1'}
$virtual=[pscustomobject]@{InstanceId='vdd';Active=$true;PhysicalConnector=$false;SourceName='display2'}
$snapshot=[pscustomobject]@{ExpectedPhysicalMonitor='Panel';Config=@{};SunshineProcesses=@([pscustomobject]@{StartTime=$state.Epoch})
    DisplayPaths=@($virtual);Displays=@([pscustomobject]@{Primary=$true;DeviceName='display1'})}
function Sample($previous,[double]$seconds){Get-DisconnectResult $previous $state $snapshot $start ($ended.AddSeconds($seconds))}
$pending=Sample $null 14.8
Assert ($pending.Outcome -eq 'Pending') 'An ordinary revert can still finish during grace'
$snapshot.DisplayPaths=@($panel)
$normal=Sample $pending 14.9
Assert ($normal.Outcome -eq 'Restored' -and $normal.Seconds -eq 15 -and $normal.Closed) 'Physical-only restoration should be timed and closed'
$snapshot.Displays[0].Primary=$false
Assert ((Sample $pending 29).Outcome -eq 'Pending') 'An unverified primary cannot confirm restore'
$snapshot.Displays[0].Primary=$true
$snapshot.DisplayPaths=@()
Assert ((Sample $pending 29).Outcome -eq 'Pending') 'Missing native paths cannot establish failure'
$snapshot.DisplayPaths=@([pscustomobject]@{InstanceId='';Active=$true})
Assert ((Sample $pending 29).Outcome -eq 'Pending') 'An unidentified path cannot establish failure'
$snapshot.DisplayPaths=@($virtual)
Assert ((Sample $normal 30).Outcome -eq 'Restored') 'A later display change cannot rewrite a confirmed restore'
$snapshot.Config.dd_config_revert_delay='20000'
Assert ((Sample $pending 24.9).Outcome -eq 'Pending') 'Honor the configured delay and settling time'
$failed=Sample $pending 25
Assert ($failed.Outcome -eq 'Failed' -and $failed.Seconds -eq 25 -and !$failed.Closed) 'An unexpected output after grace must be recorded'
$snapshot.DisplayPaths=@($panel,$virtual)
Assert ((Sample $failed 29).Outcome -eq 'Failed') 'A mixed desktop has not returned to physical-only'
$snapshot.DisplayPaths=@($panel)
# A durable result can be resumed after a diagnostic monitor restart.
$start=$ended.AddSeconds(30)
$late=Sample ($failed | ConvertTo-Json | ConvertFrom-Json) 33.4
Assert ($late.Outcome -eq 'Late' -and $late.Seconds -eq 34 -and $late.Closed) 'Late restore must retain its duration'
Assert ((Sample $null 34).Outcome -eq 'Unverified') 'Historical log replay cannot prove restoration'
$start=$ended.AddMinutes(-1)
Update-CaptureState $state @('[2025-01-02 12:02:35.000]: New streaming session started')
$closed=Sample $failed 36
Assert ($closed.Outcome -eq 'Failed' -and $closed.Closed) 'Starting another stream closes the prior observation window'
Assert ((Sample $pending 36).Outcome -eq 'Unverified') 'A quick reconnect has no failure evidence'
Update-CaptureState $state @('[2025-01-02 12:02:36.000]: CLIENT CONNECTED','[2025-01-02 12:02:40.000]: CLIENT DISCONNECTED')
$new=Sample $closed 42
Assert ($new.Id -gt $closed.Id -and $new.Outcome -eq 'Restored') 'Next disconnect receives a distinct result'
Update-CaptureState $state @('[2025-01-02 12:03:00.000]: Sunshine version: fixture')
Assert (!(Sample $pending 62).Closed) 'A stale process/log pair cannot change history'
$snapshot.SunshineProcesses[0].StartTime=$state.Epoch
Assert ((Sample $pending 62).Outcome -eq 'Unverified') 'A new Sunshine process closes unfinished observations'
Write-Output 'Disconnect history fixtures passed.'
