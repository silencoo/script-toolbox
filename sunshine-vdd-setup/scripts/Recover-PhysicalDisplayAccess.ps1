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
$displaySwitch = Join-Path $env:SystemRoot 'System32\DisplaySwitch.exe'
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
    Action                     = 'WaitForInactiveStreamThenRunDisplaySwitchExtend'
    InitialDelaySeconds        = $InitialDelaySeconds
    DisconnectTimeoutSeconds  = $DisconnectTimeoutSeconds
    PollIntervalSeconds        = $PollIntervalSeconds
    PostInactiveDelaySeconds   = $effectivePostInactiveDelaySeconds
    ConfiguredRevertDelayMs    = $configuredRevertDelayMilliseconds
    StreamingState             = $state.Sunshine.Streaming
    DetachedPhysicalDisplays   = $detachedPhysical
    DisplaySwitchPath          = $displaySwitch
    ConfirmNormalDisconnect    = $ConfirmNormalDisconnect.IsPresent
}

if (-not $Apply) {
    $preview
    return
}
if (-not $ConfirmNormalDisconnect) {
    throw 'Rerun with -ConfirmNormalDisconnect only when you will immediately disconnect every Moonlight client normally. The recovery worker never changes topology while stream state is Active or Unknown.'
}
if (-not (Test-Path -LiteralPath $displaySwitch)) {
    throw "DisplaySwitch.exe was not found: $displaySwitch"
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
$displaySwitchLiteral = ConvertTo-SingleQuotedLiteral -Value $displaySwitch
$logLiteral = ConvertTo-SingleQuotedLiteral -Value $logPath

$payload = @"
`$ErrorActionPreference = 'Stop'
function Write-RecoveryLog([string]`$Message) {
    ('{0:o} {1}' -f (Get-Date), `$Message) | Add-Content -LiteralPath $logLiteral -Encoding utf8
}
Write-RecoveryLog 'Recovery worker started.'
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
                Start-Process -FilePath $displaySwitchLiteral -ArgumentList '/extend'
                Write-RecoveryLog 'Started DisplaySwitch.exe /extend after Sunshine remained inactive through the settle interval.'
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
) -PassThru

[pscustomobject][ordered]@{
    Mode                      = 'Scheduled'
    WorkerProcessId           = $worker.Id
    InitialDelaySeconds       = $InitialDelaySeconds
    DisconnectTimeoutSeconds = $DisconnectTimeoutSeconds
    PostInactiveDelaySeconds  = $effectivePostInactiveDelaySeconds
    LogPath                   = $logPath
    NextAction                = 'Disconnect every Moonlight client normally now. The worker applies /extend only after Sunshine is positively Inactive.'
    StreamingStateAtSchedule  = $state.Sunshine.Streaming
}
