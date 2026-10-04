[CmdletBinding()]
param(
    [Alias('PhysicalDisplayName')]
    [string[]]$PhysicalDisplayNames,

    [string]$BackupDirectory = 'C:\VirtualDisplayDriver',

    [switch]$ConfirmNoActiveStream,

    [switch]$AllowUnknownStreamState,

    [switch]$RecoveryConfirmed,

    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module -Force (Join-Path $PSScriptRoot 'DisplayTopology.psm1')

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$inventoryScript = Join-Path $PSScriptRoot 'Get-SunshineVddState.ps1'
$state = & $inventoryScript -AsObject
$before = @($state.Displays)
$attached = @($before | Where-Object Attached)
$physical = @($attached | Where-Object { -not $_.IsMttVdd -and -not $_.IsOtherVirtual })

if ($PhysicalDisplayNames) {
    foreach ($name in $PhysicalDisplayNames) {
        if ($name -notmatch '^\\\\\.\\DISPLAY\d+$') {
            throw "Invalid physical display name '$name'. Use a current GDI name such as \\\\.\\DISPLAY3."
        }
    }
    $requestedNames = @($PhysicalDisplayNames | Sort-Object -Unique)
    if ($requestedNames.Count -ne $PhysicalDisplayNames.Count) {
        throw 'PhysicalDisplayNames contains a duplicate display name.'
    }
    $targets = @($physical | Where-Object { $requestedNames -icontains $_.DeviceName })
    if ($targets.Count -ne $requestedNames.Count) {
        $foundNames = @($targets.DeviceName)
        $missing = @($requestedNames | Where-Object { $foundNames -inotcontains $_ })
        throw "The requested display is not one uniquely attached physical display: $($missing -join ', ')."
    }
}
else {
    $targets = @($physical | Where-Object Primary)
    if ($targets.Count -ne 1) {
        throw 'Could not choose one attached physical primary display. Supply -PhysicalDisplayNames explicitly.'
    }
    $requestedNames = @($targets.DeviceName)
}

$selectedPrimary = @($targets | Where-Object Primary)
if ($selectedPrimary.Count -ne 1) {
    throw 'The selected physical display set must include the current primary display. Make one selected display primary before saving the baseline.'
}

$operation = Set-VddSelectedDisplayTopology -DisplayNames $requestedNames
$validationMessage = switch ($operation.ValidationCode) {
    0 { 'Validated' }
    5 { 'ElevationRequiredForValidation' }
    default { "WindowsError:$($operation.ValidationCode)" }
}

if (-not $Apply) {
    [pscustomobject][ordered]@{
        Mode                    = 'DryRun'
        Targets                 = $targets
        AttachedBefore          = $attached
        ValidationCode          = $operation.ValidationCode
        ValidationStatus        = $validationMessage
        StreamingState          = $state.Sunshine.Streaming
        RecoveryConfirmed       = $RecoveryConfirmed.IsPresent
        StreamConfirmedOff      = $ConfirmNoActiveStream.IsPresent
        AllowUnknownStreamState = $AllowUnknownStreamState.IsPresent
        BackupDirectory         = $BackupDirectory
    }
    return
}

if (-not $ConfirmNoActiveStream) {
    throw 'Disconnect Moonlight, confirm no stream is active, then rerun with -ConfirmNoActiveStream.'
}
if ($state.Sunshine.Streaming.Status -eq 'Active') {
    throw 'Sunshine log evidence shows an active Moonlight stream. Disconnect every client before changing the idle topology.'
}
if ($state.Sunshine.Streaming.Status -eq 'Unknown' -and -not $AllowUnknownStreamState) {
    throw 'Sunshine stream state could not be proven inactive. Inspect Streaming.LastRelevantEvents, then rerun with -AllowUnknownStreamState only after independently confirming every client is disconnected.'
}
if (-not $RecoveryConfirmed) {
    throw 'Confirm local or alternate recovery access, then rerun with -RecoveryConfirmed.'
}
if (-not (Test-Administrator)) {
    throw 'Persisting the display topology requires an elevated PowerShell session.'
}
if ($operation.ValidationCode -ne 0) {
    throw "Windows rejected the proposed physical-only topology during validation (error $($operation.ValidationCode))."
}

$snapshotPath = New-VddDisplayTopologyBackup -Directory $BackupDirectory -Reason 'physical-only'
$rollbackStatus = 'NotNeeded'
try {
    $applied = Set-VddSelectedDisplayTopology -DisplayNames $requestedNames -Apply
    Start-Sleep -Seconds 2
    $after = @(Get-VddDisplayInventory)
    $attachedAfter = @($after | Where-Object Attached)
    $attachedNames = @($attachedAfter.DeviceName)
    $missingAfter = @($requestedNames | Where-Object { $attachedNames -inotcontains $_ })
    $unexpected = @($attachedAfter | Where-Object { $requestedNames -inotcontains $_.DeviceName })
    $nonPhysical = @($attachedAfter | Where-Object { $_.IsMttVdd -or $_.IsOtherVirtual })
    if ($missingAfter.Count -gt 0 -or $unexpected.Count -gt 0 -or $nonPhysical.Count -gt 0 -or $attachedAfter.Count -ne $requestedNames.Count) {
        throw 'Windows accepted the topology call, but the resulting attached display set did not match the selected physical displays.'
    }
}
catch {
    $applyError = $_.Exception.Message
    try {
        [void](Restore-VddDisplayTopology -SnapshotPath $snapshotPath -Apply)
        Start-Sleep -Seconds 2
        $rollbackStatus = 'RestoredOriginalTopology'
    }
    catch {
        $rollbackStatus = "RollbackFailed: $($_.Exception.Message)"
    }
    throw "Physical-only topology failed: $applyError Rollback status: $rollbackStatus. Recovery snapshot: $snapshotPath"
}

[pscustomobject][ordered]@{
    Mode             = 'Applied'
    Targets          = $requestedNames
    SnapshotPath     = $snapshotPath
    Operation        = $applied
    AttachedAfter    = $attachedAfter
    Verified         = $true
    RollbackStatus   = $rollbackStatus
    StreamingState   = $state.Sunshine.Streaming
}
