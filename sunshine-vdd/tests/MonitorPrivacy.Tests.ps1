$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '../monitor/Monitor.Core.psm1') -Force
function CheckPrivacy([string]$Reason,$Actual) {
    if($Actual.Reason -ne $Reason){throw "Expected $Reason, got $($Actual|ConvertTo-Json -Compress)"}
    Write-Output "PASS $Reason"
}
$physical=[pscustomobject]@{DeviceName='physical';Width=3840;Height=2160;PositionX=0;PositionY=0;Primary=$true;IsMttVdd=$false;IsOtherVirtual=$false;RefreshRate=144}
$virtual=[pscustomobject]@{DeviceName='virtual';Width=2560;Height=1440;PositionX=0;PositionY=0;Primary=$true;IsMttVdd=$true;IsOtherVirtual=$false;RefreshRate=120}
$sideVirtual=[pscustomobject]@{DeviceName='virtual';Width=2560;Height=1440;PositionX=3840;PositionY=0;Primary=$false;IsMttVdd=$true;IsOtherVirtual=$false;RefreshRate=120}
$settings=[pscustomobject]@{PrivacyMode=$true}
$processes=@([pscustomobject]@{Id=123;StartTime=[datetime]'2025-01-02 04:00:00'})
$state=New-CaptureState
Update-CaptureState $state @('[2025-01-02 04:00:00.000]: Info: Sunshine version: test')
$now=[datetime]'2025-01-02 04:01:00'
CheckPrivacy 'PhysicalOnlyIdleTopologyVerified' (Get-PrivacyCaptureHealth $state $processes @($physical) @() @($physical) $settings $now)
CheckPrivacy 'UnexpectedIdleDisplayTopology' (Get-PrivacyCaptureHealth $state $processes @($physical,$sideVirtual) @($sideVirtual) @($physical) $settings $now)
CheckPrivacy 'IdlePhysicalDisplayNotRestored' (Get-PrivacyCaptureHealth $state $processes @($virtual) @($virtual) @() $settings $now)
Update-CaptureState $state @('[2025-01-02 04:00:20.000]: Info: New streaming session started [active sessions: 1]','[2025-01-02 04:00:21.000]: Info: CLIENT CONNECTED','[2025-01-02 04:00:22.000]: Info: GPU','Capture size : 2560x1440','Offset : 0x0')
CheckPrivacy 'CaptureGeometryMatchesExpectedMonitor' (Get-PrivacyCaptureHealth $state $processes @($virtual) @($virtual) @() $settings $now)
$state.Capture.X=3840
CheckPrivacy 'PrivacyPhysicalDisplayStillAttached' (Get-PrivacyCaptureHealth $state $processes @($physical,$sideVirtual) @($sideVirtual) @($physical) $settings $now)
CheckPrivacy 'ConnectionGracePeriod' (Get-PrivacyCaptureHealth $state $processes @($physical,$sideVirtual) @($sideVirtual) @($physical) $settings ([datetime]'2025-01-02 04:00:25'))
$state.Capture.X=0
$settings | Add-Member ExpectedStreamResolution '1920x1080'
CheckPrivacy 'UnexpectedStreamingResolution' (Get-PrivacyCaptureHealth $state $processes @($virtual) @($virtual) @() $settings $now)
$settings.ExpectedStreamResolution='2560x1440';$settings | Add-Member ExpectedStreamRefreshRate 60
CheckPrivacy 'UnexpectedStreamingRefreshRate' (Get-PrivacyCaptureHealth $state $processes @($virtual) @($virtual) @() $settings $now)
$settings.ExpectedStreamResolution=$null;$settings.ExpectedStreamRefreshRate=$null
$badVirtual=[pscustomobject]@{DeviceName='virtual';Width=800;Height=600;PositionX=0;PositionY=0;Primary=$true;IsMttVdd=$true;IsOtherVirtual=$false;RefreshRate=30}
Update-CaptureState $state @('[2025-01-02 04:00:30.000]: Info: GPU','Capture size : 800x600','Offset : 0x0')
CheckPrivacy 'VirtualDisplayFallback800x600' (Get-PrivacyCaptureHealth $state $processes @($badVirtual) @($badVirtual) @() $settings $now)
Update-CaptureState $state @('[2025-01-02 04:00:55.000]: Info: CLIENT DISCONNECTED')
CheckPrivacy 'DisplayRevertGracePeriod' (Get-PrivacyCaptureHealth $state $processes @($virtual) @($virtual) @() $settings $now)
CheckPrivacy 'IdlePhysicalDisplayNotRestored' (Get-PrivacyCaptureHealth $state $processes @($virtual) @($virtual) @() $settings ([datetime]'2025-01-02 04:01:15'))
Write-Output 'Privacy monitor fixture tests passed.'
