[CmdletBinding()]
param(
    [ValidatePattern('^\\\\\.\\DISPLAY\d+$')]
    [string]$ExpectedPhysicalDisplay,

    [Parameter(Mandatory)]
    [ValidatePattern('^\d{3,5}x\d{3,5}$')]
    [string]$ExpectedVirtualResolution,

    [Nullable[int]]$ExpectedVirtualRefreshRate,

    [bool]$RequireVirtualOnly = $true,

    [ValidateRange(10, 1800)]
    [int]$ConnectTimeoutSeconds = 180,

    [ValidateRange(10, 1800)]
    [int]$DisconnectTimeoutSeconds = 120,

    [ValidateRange(1, 30)]
    [int]$PollIntervalSeconds = 2,

    [switch]$StartImmediately,

    [switch]$IdleOnly,

    [switch]$AsObject
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module -Force (Join-Path $PSScriptRoot 'DisplayTopology.psm1')

function Get-CycleSnapshot {
    $displays = @(Get-VddDisplayInventory)
    [pscustomobject][ordered]@{
        CapturedAt = (Get-Date).ToString('o')
        Displays   = $displays
        Attached   = @($displays | Where-Object Attached)
        MttVdd     = @($displays | Where-Object { $_.Attached -and $_.IsMttVdd })
        Physical   = @($displays | Where-Object { $_.Attached -and -not $_.IsMttVdd -and -not $_.IsOtherVirtual })
    }
}

function Test-IdleState {
    param($Snapshot)
    if ($Snapshot.MttVdd.Count -ne 0) { return $false }
    if ($Snapshot.Physical.Count -ne 1) { return $false }
    if ($Snapshot.Attached.Count -ne 1) { return $false }
    if ($ExpectedPhysicalDisplay -and $Snapshot.Physical[0].DeviceName -ine $ExpectedPhysicalDisplay) { return $false }
    $true
}

function Test-StreamState {
    param($Snapshot)
    if ($Snapshot.MttVdd.Count -ne 1) { return $false }
    if ($RequireVirtualOnly -and $Snapshot.Attached.Count -ne 1) { return $false }
    $expectedParts = $ExpectedVirtualResolution -split 'x'
    if ($Snapshot.MttVdd[0].Width -ne [int]$expectedParts[0] -or $Snapshot.MttVdd[0].Height -ne [int]$expectedParts[1]) { return $false }
    if ($null -ne $ExpectedVirtualRefreshRate -and $Snapshot.MttVdd[0].RefreshRate -ne $ExpectedVirtualRefreshRate) { return $false }
    $true
}

function Wait-ForState {
    param(
        [Parameter(Mandatory)][scriptblock]$Predicate,
        [Parameter(Mandatory)][int]$TimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $snapshot = Get-CycleSnapshot
        if (& $Predicate $snapshot) {
            return [pscustomobject]@{ Passed = $true; Snapshot = $snapshot }
        }
        Start-Sleep -Seconds $PollIntervalSeconds
    } while ((Get-Date) -lt $deadline)
    [pscustomobject]@{ Passed = $false; Snapshot = $snapshot }
}

$errors = [Collections.Generic.List[string]]::new()
$idleBefore = Get-CycleSnapshot
if (-not (Test-IdleState $idleBefore)) {
    $errors.Add('Initial state is not one physical display with MTT VDD detached.')
}

if ($IdleOnly) {
    $idleResult = [pscustomobject][ordered]@{
        Passed         = $errors.Count -eq 0
        Errors         = @($errors)
        IdleBefore     = $idleBefore
        StreamObserved = $null
        IdleAfter      = $null
    }
    if ($AsObject) { $idleResult } else { $idleResult | ConvertTo-Json -Depth 10 }
    return
}

if (-not $StartImmediately) {
    [void](Read-Host 'Start a normal Moonlight connection, then press Enter')
}
$streamPredicate = { param($snapshot) Test-StreamState $snapshot }
$stream = Wait-ForState -Predicate $streamPredicate -TimeoutSeconds $ConnectTimeoutSeconds
if (-not $stream.Passed) {
    $errors.Add("The expected VDD stream state did not appear within $ConnectTimeoutSeconds seconds.")
}

$idleAfter = $null
if ($stream.Passed) {
    if (-not $StartImmediately) {
        [void](Read-Host 'Disconnect Moonlight normally, then press Enter')
    }
    $idlePredicate = { param($snapshot) Test-IdleState $snapshot }
    $idleAfter = Wait-ForState -Predicate $idlePredicate -TimeoutSeconds $DisconnectTimeoutSeconds
    if (-not $idleAfter.Passed) {
        $errors.Add("The physical-only idle state did not return within $DisconnectTimeoutSeconds seconds.")
    }
}

$result = [pscustomobject][ordered]@{
    Passed         = $errors.Count -eq 0
    Errors         = @($errors)
    IdleBefore     = $idleBefore
    StreamObserved = $stream
    IdleAfter      = $idleAfter
}

if ($AsObject) { $result } else { $result | ConvertTo-Json -Depth 10 }
