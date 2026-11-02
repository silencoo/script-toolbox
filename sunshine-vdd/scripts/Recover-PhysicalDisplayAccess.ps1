[CmdletBinding()]
param(
    [ValidateRange(5, 300)]
    [int]$InitialDelaySeconds = 20,

    [ValidateRange(30, 900)]
    [int]$DisconnectTimeoutSeconds = 180,

    [ValidateRange(1, 15)]
    [int]$PollIntervalSeconds = 2,

    [ValidateRange(3, 90)]
    [int]$PostInactiveDelaySeconds = 8,

    [string]$SunshineRoot = "$env:ProgramFiles\Sunshine",

    [string]$SunshineConfigPath,

    [string]$LogDirectory = "$env:LOCALAPPDATA\SunshineVddSetup",

    [switch]$ConfirmNormalDisconnect,

    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$inventoryScript = Join-Path $PSScriptRoot 'Get-SunshineVddState.ps1'
$topologyModule = Join-Path $PSScriptRoot 'DisplayTopology.psm1'
$inventoryArguments = @{
    SunshineRoot = $SunshineRoot
    AsObject      = $true
}
if ($SunshineConfigPath) { $inventoryArguments.SunshineConfigPath = $SunshineConfigPath }
$state = & $inventoryScript @inventoryArguments
$detachedPhysical = @($state.Displays | Where-Object { -not $_.Attached -and -not $_.IsMttVdd -and -not $_.IsOtherVirtual })
$configuredRevertDelayMilliseconds = 3000
if ($state.Sunshine.Config -and $state.Sunshine.Config.PSObject.Properties.Name -contains 'dd_config_revert_delay') {
    $parsedRevertDelay = 0
    if ([int]::TryParse([string]$state.Sunshine.Config.dd_config_revert_delay, [ref]$parsedRevertDelay) -and $parsedRevertDelay -ge 0) {
        $configuredRevertDelayMilliseconds = $parsedRevertDelay
    }
}
$minimumSettleSeconds = [int][Math]::Ceiling($configuredRevertDelayMilliseconds / 1000.0) + 2
$effectivePostInactiveDelaySeconds = [Math]::Max($PostInactiveDelaySeconds, $minimumSettleSeconds)

$preview = [pscustomobject][ordered]@{
    Mode                       = if ($Apply) { 'Scheduling' } else { 'DryRun' }
    Action                     = 'WaitForInactiveStreamThenApplyVerifiedNativeExtend'
    InitialDelaySeconds        = $InitialDelaySeconds
    DisconnectTimeoutSeconds  = $DisconnectTimeoutSeconds
    PollIntervalSeconds        = $PollIntervalSeconds
    PostInactiveDelaySeconds   = $effectivePostInactiveDelaySeconds
    ConfiguredRevertDelayMs    = $configuredRevertDelayMilliseconds
    StreamingState             = $state.Sunshine.Streaming
    DetachedPhysicalDisplays   = $detachedPhysical
    TopologyModule             = $topologyModule
    ConfirmNormalDisconnect    = $ConfirmNormalDisconnect.IsPresent
}

if (-not $Apply) {
    $preview
    return
}
if (-not $ConfirmNormalDisconnect) {
    throw 'Rerun with -ConfirmNormalDisconnect only when you will immediately disconnect every Moonlight client normally. The recovery worker never changes topology while stream state is Active or Unknown.'
}
if (-not (Test-Path -LiteralPath $topologyModule)) {
    throw "Display topology module was not found: $topologyModule"
}

[void](New-Item -ItemType Directory -Path $LogDirectory -Force)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $LogDirectory "physical-display-recovery-$stamp.log"
$resolvedConfigPath = [string]$state.Sunshine.ConfigPath

function ConvertTo-SingleQuotedLiteral {
    param([Parameter(Mandatory)][string]$Value)
    "'" + $Value.Replace("'", "''") + "'"
}

$inventoryLiteral = ConvertTo-SingleQuotedLiteral -Value $inventoryScript
$sunshineRootLiteral = ConvertTo-SingleQuotedLiteral -Value $SunshineRoot
$configLiteral = ConvertTo-SingleQuotedLiteral -Value $resolvedConfigPath
$moduleLiteral = ConvertTo-SingleQuotedLiteral -Value $topologyModule
$backupLiteral = ConvertTo-SingleQuotedLiteral -Value ([IO.Path]::GetFullPath($LogDirectory))
$logLiteral = ConvertTo-SingleQuotedLiteral -Value $logPath

$payload = @"
`$ErrorActionPreference = 'Stop'
function Write-RecoveryLog([string]`$Message) {
    ('{0:o} {1}' -f (Get-Date), `$Message) | Add-Content -LiteralPath $logLiteral -Encoding utf8
}
Write-RecoveryLog 'Recovery worker started.'
Import-Module $moduleLiteral -Force
Start-Sleep -Seconds $InitialDelaySeconds
`$deadline = (Get-Date).AddSeconds($DisconnectTimeoutSeconds)
do {
    try {
        `$stream = & $inventoryLiteral -SunshineRoot $sunshineRootLiteral -SunshineConfigPath $configLiteral -StreamingOnly -AsObject
        Write-RecoveryLog ('Sunshine stream state: {0}' -f `$stream.Status)
        if (`$stream.Status -eq 'Inactive') {
            Write-RecoveryLog 'Inactive detected; waiting for Sunshine display reversion to settle.'
            Start-Sleep -Seconds $effectivePostInactiveDelaySeconds
            `$confirmedStream = & $inventoryLiteral -SunshineRoot $sunshineRootLiteral -SunshineConfigPath $configLiteral -StreamingOnly -AsObject
            Write-RecoveryLog ('Post-settle Sunshine stream state: {0}' -f `$confirmedStream.Status)
            if (`$confirmedStream.Status -eq 'Inactive') {
                `$validation = Set-VddExtendedDisplayTopology
                if (`$validation -ne 0) { Write-RecoveryLog ('Native Extend validation failed: {0}; no change applied.' -f `$validation); exit 3 }
                `$backup = New-VddDisplayTopologyBackup -Directory $backupLiteral -Reason 'physical-recovery'
                Write-RecoveryLog ('Recovery snapshot: {0}' -f `$backup)
                `$finalStream = & $inventoryLiteral -SunshineRoot $sunshineRootLiteral -SunshineConfigPath $configLiteral -StreamingOnly -AsObject
                if (`$finalStream.Status -ne 'Inactive') { Write-RecoveryLog 'Stream changed before apply; no change applied.'; exit 2 }
                `$result = Set-VddExtendedDisplayTopology -Apply
                if (`$result -ne 0) { Write-RecoveryLog ('Native Extend apply failed: {0}.' -f `$result); exit 3 }
                Start-Sleep -Seconds 3
                `$physical = @(Get-VddDisplayInventory | Where-Object { `$_.Attached -and -not `$_.IsMttVdd -and -not `$_.IsOtherVirtual })
                if (`$physical.Count -eq 0) { Write-RecoveryLog 'Windows accepted Extend but no physical display is attached; recovery NOT verified.'; exit 4 }
                Write-RecoveryLog ('Physical display recovery verified: {0}' -f ((`$physical | ForEach-Object { `$_.DeviceName }) -join ', '))
                exit 0
            }
        }
    }
    catch {
        Write-RecoveryLog ('State check failed; no topology change: {0}' -f `$_.Exception.Message)
    }
    Start-Sleep -Seconds $PollIntervalSeconds
} while ((Get-Date) -lt `$deadline)
Write-RecoveryLog 'Timed out without a positively detected Inactive state; no topology change was made.'
exit 2
"@

$encodedPayload = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($payload))
$powerShellExe = (Get-Command powershell.exe -ErrorAction Stop).Source
$worker = Start-Process -FilePath $powerShellExe -ArgumentList @(
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-EncodedCommand', $encodedPayload
    ) -WindowStyle Hidden -PassThru

[pscustomobject][ordered]@{
    Mode                      = 'Scheduled'
    WorkerProcessId           = $worker.Id
    InitialDelaySeconds       = $InitialDelaySeconds
    DisconnectTimeoutSeconds = $DisconnectTimeoutSeconds
    PostInactiveDelaySeconds  = $effectivePostInactiveDelaySeconds
    LogPath                   = $logPath
    NextAction                = 'Disconnect every Moonlight client normally now. The worker validates, backs up and applies native Extend only after Sunshine is positively Inactive.'
    StreamingStateAtSchedule  = $state.Sunshine.Streaming
}
