[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$SnapshotPath,

    [string]$BackupDirectory = 'C:\VirtualDisplayDriver',

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

$preview = Restore-VddDisplayTopology -SnapshotPath $SnapshotPath
if (-not $Apply) {
    [pscustomobject][ordered]@{
        Mode              = 'DryRun'
        SnapshotPath      = $SnapshotPath
        ValidationCode    = $preview.ValidationCode
        ValidationPassed  = $preview.ValidationCode -eq 0
        DisplaysToRestore = @($preview.DisplayNames)
        RecoveryConfirmed = $RecoveryConfirmed.IsPresent
    }
    return
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
