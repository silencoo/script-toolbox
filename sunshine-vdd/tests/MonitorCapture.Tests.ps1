$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '../monitor/Monitor.Core.psm1') -Force
$physical=[pscustomobject]@{DeviceName='physical';Width=3840;Height=2160;PositionX=0;PositionY=0}
$virtual=[pscustomobject]@{DeviceName='virtual';Width=800;Height=600;PositionX=3840;PositionY=0}
$processes=@([pscustomobject]@{Id=123;StartTime=[datetime]'2025-01-01 17:56:30'})
function Check([string]$Expected,$Actual,[string]$Name){if($Actual.Status-ne$Expected){throw "$Name expected $Expected got $($Actual|ConvertTo-Json -Compress)"};Write-Output "PASS $Name"}
$state=New-CaptureState
Update-CaptureState $state @('[2025-01-01 17:56:30.000]: Info: Sunshine version: test','[2025-01-01 17:56:31.000]: Info: encoder test','Capture size : 3840x2160','Offset : 0x0')
Check 'Idle' (Get-CaptureHealth $state $processes @($physical,$virtual) @($physical) ([datetime]'2025-01-01 17:57:00')) 'Startup probe is not an active stream'
Update-CaptureState $state @('[2025-01-01 17:56:40.492]: Info: CLIENT CONNECTED','[2025-01-01 17:56:41.167]: Info: GPU','Capture size : 3840x2160','Offset : 0x0')
Check 'Starting' (Get-CaptureHealth $state $processes @($physical,$virtual) @($physical) ([datetime]'2025-01-01 17:56:42')) 'Connection grace'
Check 'Healthy' (Get-CaptureHealth $state $processes @($physical,$virtual) @($physical) ([datetime]'2025-01-01 17:56:50')) 'Physical capture'
Update-CaptureState $state @('[2025-01-01 17:56:42.075]: Warning: Previous active display [physical] is no longer present','[2025-01-01 17:56:44.612]: Info: GPU','Capture size : 800x600','Offset : 3840x0')
Check 'Degraded' (Get-CaptureHealth $state $processes @($physical,$virtual) @($physical) ([datetime]'2025-01-01 17:56:50')) 'Physical restored but virtual capture persists'
Check 'Degraded' (Get-CaptureHealth $state $processes @($virtual) @() ([datetime]'2025-01-01 17:56:50')) 'Expected monitor missing'
Check 'Healthy' (Get-CaptureHealth $state $processes @($physical,$virtual) @($virtual) ([datetime]'2025-01-01 17:56:50')) 'Intentional virtual target is valid'
Check 'Unknown' (Get-CaptureHealth $state $processes @($virtual,$virtual) @($physical) ([datetime]'2025-01-01 17:56:50')) 'Ambiguous geometry'
$newProcess=@([pscustomobject]@{Id=124;StartTime=[datetime]'2025-01-01 18:00:00'})
Check 'Unknown' (Get-CaptureHealth $state $newProcess @($physical,$virtual) @($physical) ([datetime]'2025-01-01 18:01:00')) 'Stale process epoch'
Update-CaptureState $state @('[2025-01-01 17:56:57.751]: Info: CLIENT CONNECTED','[2025-01-01 17:57:00.847]: Info: CLIENT DISCONNECTED')
if($state.Clients-ne1){throw 'Multiple client count lost'}
Update-CaptureState $state @('[2025-01-01 17:57:15.566]: Info: CLIENT DISCONNECTED')
Check 'Idle' (Get-CaptureHealth $state $processes @($physical,$virtual) @($physical) ([datetime]'2025-01-01 17:58:00')) 'Disconnected fallback is not an active fault'
Update-CaptureState $state @('[2025-01-01 18:00:00.000]: Info: Sunshine version: restarted')
if($state.Clients-ne0-or$null-ne$state.Capture){throw 'Epoch reset did not clear state'}
Write-Output 'PASS New log epoch resets session state'
