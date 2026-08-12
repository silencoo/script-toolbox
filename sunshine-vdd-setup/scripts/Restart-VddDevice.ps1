[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^(?i)ROOT\\(?:MTTVDD|DISPLAY)\\[A-Z0-9&._-]+$')]
    [string]$InstanceId,

    [switch]$RecoveryConfirmed,

    [switch]$ConfirmNoActiveStream,

    [switch]$AllowUnknownStreamState,

    [switch]$AllowNoPhysicalFallback,

    [switch]$AllowDisableEnableFallback,

    [switch]$Apply,

    [string]$BackupDirectory = 'C:\VirtualDisplayDriver'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module -Force (Join-Path $PSScriptRoot 'DisplayTopology.psm1')

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-PnpUtil {
    param([Parameter(Mandatory)][string[]]$Arguments)

    $output = & pnputil.exe @Arguments 2>&1 | Out-String
    [pscustomobject]@{
        Arguments = $Arguments
        ExitCode  = $LASTEXITCODE
        Output    = $output.Trim()
    }
}

$inventoryScript = Join-Path $PSScriptRoot 'Get-SunshineVddState.ps1'
$before = & $inventoryScript -AsObject
$physicalAttached = @($before.Displays | Where-Object { $_.Attached -and -not $_.IsMttVdd -and -not $_.IsOtherVirtual })
if ($physicalAttached.Count -eq 0 -and -not $AllowNoPhysicalFallback) {
    throw 'No attached physical fallback display was detected. Stop, restore a physical display, or explicitly accept this risk with -AllowNoPhysicalFallback.'
}

$device = Invoke-PnpUtil -Arguments @('/enum-devices', '/instanceid', $InstanceId)
if ($device.ExitCode -ne 0) {
    throw "pnputil could not inspect '$InstanceId': $($device.Output)"
}
$structuredMatch = @($before.MttVddPnpDevices | Where-Object InstanceId -ieq $InstanceId)
if ($structuredMatch.Count -ne 1 -and $device.Output -notmatch '(?i)MttVDD|Virtual Display Driver|MikeTheTech|IddSampleDriver Device HDR') {
    throw "The requested PnP instance was not positively identified as MTT VDD. No action taken. pnputil output: $($device.Output)"
}

if (-not $Apply) {
    [pscustomobject][ordered]@{
        Mode                     = 'DryRun'
        InstanceId               = $InstanceId
        IdentityVerified         = $true
        PhysicalFallbackDisplays = @($physicalAttached.DeviceName)
        StreamingState           = $before.Sunshine.Streaming
        RecoveryConfirmed        = $RecoveryConfirmed.IsPresent
        StreamConfirmedOff       = $ConfirmNoActiveStream.IsPresent
        AllowUnknownStreamState  = $AllowUnknownStreamState.IsPresent
        PlannedCommand           = ('pnputil.exe /restart-device "{0}"' -f $InstanceId)
        DeviceDetails            = $device.Output
        BackupDirectory          = $BackupDirectory
    }
    return
}

if (-not $RecoveryConfirmed) {
    throw 'Confirm local or alternate recovery access, then rerun with -RecoveryConfirmed.'
}
if (-not $ConfirmNoActiveStream) {
    throw 'Disconnect Moonlight, confirm no stream is active, then rerun with -ConfirmNoActiveStream.'
}
if ($before.Sunshine.Streaming.Status -eq 'Active') {
    throw 'Sunshine log evidence shows an active Moonlight stream. Disconnect every client before restarting VDD.'
}
if ($before.Sunshine.Streaming.Status -eq 'Unknown' -and -not $AllowUnknownStreamState) {
    throw 'Sunshine stream state could not be proven inactive. Inspect Streaming.LastRelevantEvents, then use -AllowUnknownStreamState only after independently confirming every client is disconnected.'
}
if (-not (Test-Administrator)) {
    throw 'Restarting the VDD device requires an elevated PowerShell session.'
}

$snapshotPath = New-VddDisplayTopologyBackup -Directory $BackupDirectory -Reason 'vdd-restart'
$restart = Invoke-PnpUtil -Arguments @('/restart-device', $InstanceId)
$fallbackUsed = $false
if ($restart.ExitCode -ne 0) {
    if (-not $AllowDisableEnableFallback) {
        throw "The guarded device restart failed. No disable/enable fallback was attempted: $($restart.Output) Recovery snapshot: $snapshotPath"
    }
    $disable = Invoke-PnpUtil -Arguments @('/disable-device', $InstanceId)
    if ($disable.ExitCode -ne 0) { throw "VDD disable fallback failed: $($disable.Output)" }
    $enable = Invoke-PnpUtil -Arguments @('/enable-device', $InstanceId)
    if ($enable.ExitCode -ne 0) { throw "VDD enable fallback failed: $($enable.Output)" }
    $fallbackUsed = $true
}

Start-Sleep -Seconds 2
$after = & $inventoryScript -AsObject
$physicalAfter = @($after.Displays | Where-Object { $_.Attached -and -not $_.IsMttVdd -and -not $_.IsOtherVirtual })
$rollbackStatus = 'NotNeeded'
if ($physicalAttached.Count -gt 0 -and $physicalAfter.Count -eq 0) {
    try {
        [void](Restore-VddDisplayTopology -SnapshotPath $snapshotPath -Apply)
        Start-Sleep -Seconds 2
        $after = & $inventoryScript -AsObject
        $physicalAfter = @($after.Displays | Where-Object { $_.Attached -and -not $_.IsMttVdd -and -not $_.IsOtherVirtual })
        $rollbackStatus = if ($physicalAfter.Count -gt 0) { 'RestoredOriginalTopology' } else { 'RestoreAppliedButPhysicalFallbackStillMissing' }
    }
    catch {
        $rollbackStatus = "RollbackFailed: $($_.Exception.Message)"
    }
}
[pscustomobject][ordered]@{
    Mode           = 'Applied'
    InstanceId     = $InstanceId
    FallbackUsed   = $fallbackUsed
    RestartOutput  = $restart.Output
    SnapshotPath   = $snapshotPath
    RollbackStatus = $rollbackStatus
    DisplaysBefore = $before.Displays
    DisplaysAfter  = $after.Displays
    MttVddPnpAfter = $after.MttVddPnpDevices
}
