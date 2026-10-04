[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$SnapshotPath,

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
$streamingState = & $inventoryScript -StreamingOnly -AsObject
$preview = Restore-VddDisplayTopology -SnapshotPath $SnapshotPath
if (-not $Apply) {
    [pscustomobject][ordered]@{
        Mode              = 'DryRun'
        SnapshotPath      = $SnapshotPath
        ValidationCode    = $preview.ValidationCode
        ValidationPassed  = $preview.ValidationCode -eq 0
        DisplaysToRestore = @($preview.DisplayNames)
        StreamingState    = $streamingState
        StreamConfirmedOff = $ConfirmNoActiveStream.IsPresent
        RecoveryConfirmed = $RecoveryConfirmed.IsPresent
    }
    return
}

if (-not $ConfirmNoActiveStream) {
    throw 'Disconnect every Moonlight client, confirm no stream is active, then rerun with -ConfirmNoActiveStream.'
}
if ($streamingState.Status -eq 'Active') {
    throw 'Sunshine log evidence shows an active Moonlight stream. Use Recover-PhysicalDisplayAccess.ps1 to schedule recovery after disconnect instead of restoring a topology during capture.'
}
if ($streamingState.Status -eq 'Unknown' -and -not $AllowUnknownStreamState) {
    throw 'Sunshine stream state could not be proven inactive. Inspect the current log, then use -AllowUnknownStreamState only after independently confirming every client is disconnected.'
}
if (-not $RecoveryConfirmed) {
    throw 'Confirm local or alternate recovery access, then rerun with -RecoveryConfirmed.'
}
if (-not (Test-Administrator)) {
    throw 'Restoring a display topology requires an elevated PowerShell session.'
}
if ($preview.ValidationCode -ne 0) {
    throw "Windows rejected the saved topology during validation (error $($preview.ValidationCode)). No change was applied."
}

$currentSnapshotPath = New-VddDisplayTopologyBackup -Directory $BackupDirectory -Reason 'topology-restore'
$operation = Restore-VddDisplayTopology -SnapshotPath $SnapshotPath -Apply
Start-Sleep -Seconds 2

[pscustomobject][ordered]@{
    Mode                  = 'Applied'
    RestoredSnapshotPath  = $SnapshotPath
    PreviousSnapshotPath  = $currentSnapshotPath
    Operation             = $operation
    DisplaysAfter         = @(Get-VddDisplayInventory)
}
