[CmdletBinding()]
param(
    [string[]]$ExpectedIdlePhysicalDisplays,

    [ValidateRange(0, 16)]
    [int]$ExpectedIdlePhysicalCount = 1,

    [ValidateRange(0, 16)]
    [int]$ExpectedIdleMttVddCount = 0,

    [ValidateRange(0, 16)]
    [int]$ExpectedIdleOtherVirtualCount = 0,

    [string[]]$ExpectedStreamPhysicalDisplays,

    [ValidateRange(0, 16)]
    [int]$ExpectedStreamPhysicalCount = 0,

    [ValidateRange(0, 16)]
    [int]$ExpectedStreamMttVddCount = 1,

    [ValidateRange(0, 16)]
    [int]$ExpectedStreamOtherVirtualCount = 0,

    [ValidatePattern('^\d{3,5}x\d{3,5}$')]
    [string]$ExpectedVirtualResolution,

    [Nullable[double]]$ExpectedVirtualRefreshRate,

    [ValidateRange(0, 5)]
    [double]$RefreshRateTolerance = 0.6,

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

foreach ($name in @($ExpectedIdlePhysicalDisplays) + @($ExpectedStreamPhysicalDisplays)) {
    if ($name -notmatch '^\\\\\.\\DISPLAY\d+$') {
        throw "Invalid expected physical display name '$name'. Re-inventory and use a current GDI name such as \\\\.\\DISPLAY3."
    }
}
if (-not $IdleOnly -and $ExpectedStreamMttVddCount -gt 0 -and -not $ExpectedVirtualResolution) {
    throw 'ExpectedVirtualResolution is required when one or more streaming MTT VDD displays are expected.'
}

function Get-CycleSnapshot {
    $displays = @(Get-VddDisplayInventory)
    [pscustomobject][ordered]@{
        CapturedAt   = (Get-Date).ToString('o')
        Displays     = $displays
        Attached     = @($displays | Where-Object Attached)
        MttVdd       = @($displays | Where-Object { $_.Attached -and $_.IsMttVdd })
        OtherVirtual = @($displays | Where-Object { $_.Attached -and $_.IsOtherVirtual })
        Physical     = @($displays | Where-Object { $_.Attached -and -not $_.IsMttVdd -and -not $_.IsOtherVirtual })
    }
}

function Test-ExpectedNames {
    param(
        [object[]]$ActualDisplays,
        [string[]]$ExpectedNames,
        [int]$ExpectedCount
    )

    if ($ExpectedNames) {
        $uniqueExpected = @($ExpectedNames | Sort-Object -Unique)
        if ($uniqueExpected.Count -ne $ExpectedNames.Count) { return $false }
        if ($ActualDisplays.Count -ne $uniqueExpected.Count) { return $false }
        $actualNames = @($ActualDisplays.DeviceName)
        return @($uniqueExpected | Where-Object { $actualNames -inotcontains $_ }).Count -eq 0
    }
    $ActualDisplays.Count -eq $ExpectedCount
}

function Test-IdleState {
    param($Snapshot)

    if (-not (Test-ExpectedNames -ActualDisplays $Snapshot.Physical -ExpectedNames $ExpectedIdlePhysicalDisplays -ExpectedCount $ExpectedIdlePhysicalCount)) { return $false }
    if ($Snapshot.MttVdd.Count -ne $ExpectedIdleMttVddCount) { return $false }
    if ($Snapshot.OtherVirtual.Count -ne $ExpectedIdleOtherVirtualCount) { return $false }
    $expectedAttached = $(if ($ExpectedIdlePhysicalDisplays) { $ExpectedIdlePhysicalDisplays.Count } else { $ExpectedIdlePhysicalCount }) + $ExpectedIdleMttVddCount + $ExpectedIdleOtherVirtualCount
    $Snapshot.Attached.Count -eq $expectedAttached
}

function Test-StreamState {
    param($Snapshot)

    if (-not (Test-ExpectedNames -ActualDisplays $Snapshot.Physical -ExpectedNames $ExpectedStreamPhysicalDisplays -ExpectedCount $ExpectedStreamPhysicalCount)) { return $false }
    if ($Snapshot.MttVdd.Count -ne $ExpectedStreamMttVddCount) { return $false }
    if ($Snapshot.OtherVirtual.Count -ne $ExpectedStreamOtherVirtualCount) { return $false }
    $expectedAttached = $(if ($ExpectedStreamPhysicalDisplays) { $ExpectedStreamPhysicalDisplays.Count } else { $ExpectedStreamPhysicalCount }) + $ExpectedStreamMttVddCount + $ExpectedStreamOtherVirtualCount
    if ($Snapshot.Attached.Count -ne $expectedAttached) { return $false }

    if ($ExpectedStreamMttVddCount -gt 0) {
        $expectedParts = $ExpectedVirtualResolution -split 'x'
        foreach ($vdd in $Snapshot.MttVdd) {
            if ($vdd.Width -ne [int]$expectedParts[0] -or $vdd.Height -ne [int]$expectedParts[1]) { return $false }
            if ($null -ne $ExpectedVirtualRefreshRate -and [Math]::Abs([double]$vdd.RefreshRate - [double]$ExpectedVirtualRefreshRate) -gt $RefreshRateTolerance) { return $false }
        }
    }
    $true
}

function Wait-ForState {
    param(
        [Parameter(Mandatory)][scriptblock]$Predicate,
        [Parameter(Mandatory)][int]$TimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $snapshot = Get-CycleSnapshot
    do {
        if (& $Predicate $snapshot) {
            return [pscustomobject]@{ Passed = $true; Snapshot = $snapshot }
        }
        Start-Sleep -Seconds $PollIntervalSeconds
        $snapshot = Get-CycleSnapshot
    } while ((Get-Date) -lt $deadline)
    [pscustomobject]@{ Passed = $false; Snapshot = $snapshot }
}

$errors = [Collections.Generic.List[string]]::new()
$idleBefore = Get-CycleSnapshot
if (-not (Test-IdleState $idleBefore)) {
    $errors.Add('Initial attached display set does not match the expected idle topology.')
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
    $errors.Add("The expected streaming topology and VDD mode did not appear within $ConnectTimeoutSeconds seconds.")
}

$idleAfter = $null
if ($stream.Passed) {
    if (-not $StartImmediately) {
        [void](Read-Host 'Disconnect Moonlight normally, then press Enter')
    }
    $idlePredicate = { param($snapshot) Test-IdleState $snapshot }
    $idleAfter = Wait-ForState -Predicate $idlePredicate -TimeoutSeconds $DisconnectTimeoutSeconds
    if (-not $idleAfter.Passed) {
        $errors.Add("The expected idle topology did not return within $DisconnectTimeoutSeconds seconds.")
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
