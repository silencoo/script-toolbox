[CmdletBinding()]
param(
    [ValidatePattern('^\\\\\.\\DISPLAY\d+$')]
    [string]$PhysicalDisplayName,

    [string]$BackupDirectory = 'C:\VirtualDisplayDriver',

    [switch]$ConfirmNoActiveStream,

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

$before = @(Get-VddDisplayInventory)
$attached = @($before | Where-Object Attached)
$physical = @($attached | Where-Object { -not $_.IsMttVdd -and -not $_.IsOtherVirtual })

if ($PhysicalDisplayName) {
    $target = @($physical | Where-Object DeviceName -ieq $PhysicalDisplayName)
    if ($target.Count -ne 1) {
        throw "The requested physical display '$PhysicalDisplayName' is not one uniquely attached physical display."
    }
    $target = $target[0]
}
else {
    $primary = @($physical | Where-Object Primary)
    if ($primary.Count -ne 1) {
        throw 'Could not choose one attached physical primary display. Supply -PhysicalDisplayName explicitly.'
    }
    $target = $primary[0]
}

if (-not $target.Primary) {
    throw "The selected physical display '$($target.DeviceName)' is not currently primary. Make it primary before saving a physical-only baseline."
}

$operation = Set-VddSingleDisplayTopology -DisplayName $target.DeviceName -Apply:$false
$validationMessage = switch ($operation.ValidationCode) {
    0 { 'Validated' }
    5 { 'ElevationRequiredForValidation' }
    default { "WindowsError:$($operation.ValidationCode)" }
}

if (-not $Apply) {
    [pscustomobject][ordered]@{
        Mode               = 'DryRun'
        Target             = $target
        AttachedBefore     = $attached
        ValidationCode     = $operation.ValidationCode
        ValidationStatus   = $validationMessage
        RecoveryConfirmed  = $RecoveryConfirmed.IsPresent
        StreamConfirmedOff = $ConfirmNoActiveStream.IsPresent
        BackupDirectory    = $BackupDirectory
    }
    return
}

if (-not $ConfirmNoActiveStream) {
    throw 'Disconnect Moonlight, confirm no stream is active, then rerun with -ConfirmNoActiveStream.'
}
if (-not $RecoveryConfirmed) {
    throw 'Confirm local or alternate recovery access, then rerun with -RecoveryConfirmed.'
}
if (-not (Test-Administrator)) {
    throw 'Persisting the display topology requires an elevated PowerShell session.'
}

[void](New-Item -ItemType Directory -Path $BackupDirectory -Force)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$snapshotPath = Join-Path $BackupDirectory "display-topology-before-physical-only-$stamp.json"
$snapshot = [pscustomobject][ordered]@{
    CapturedAt              = (Get-Date).ToString('o')
    SelectedPhysicalDisplay = $target.DeviceName
    Displays                = $before
}
$snapshot | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $snapshotPath -Encoding utf8

$applied = Set-VddSingleDisplayTopology -DisplayName $target.DeviceName -Apply
Start-Sleep -Seconds 2
$after = @(Get-VddDisplayInventory)
$attachedAfter = @($after | Where-Object Attached)
$unexpected = @($attachedAfter | Where-Object DeviceName -ine $target.DeviceName)
if ($attachedAfter.Count -ne 1 -or $unexpected.Count -gt 0 -or $attachedAfter[0].IsMttVdd -or $attachedAfter[0].IsOtherVirtual) {
    throw "Windows accepted the topology call, but verification failed. The pre-change record is $snapshotPath."
}

[pscustomobject][ordered]@{
    Mode          = 'Applied'
    Target        = $target.DeviceName
    SnapshotPath  = $snapshotPath
    Operation     = $applied
    AttachedAfter = $attachedAfter
    Verified      = $true
}
