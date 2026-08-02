[CmdletBinding()]
param(
    [string]$ConfigPath = "$env:ProgramFiles\Sunshine\config\sunshine.conf",

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$AdapterName,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$OutputName,

    [ValidateSet('disabled', 'verify_only', 'ensure_active', 'ensure_primary', 'ensure_only_display')]
    [string]$Topology = 'ensure_only_display',

    [ValidateSet('disabled', 'auto', 'manual')]
    [string]$ResolutionMode = 'manual',

    [ValidateSet('disabled', 'auto', 'manual')]
    [string]$RefreshRateMode = 'manual',

    [string]$ManualResolution,

    [Nullable[double]]$ManualRefreshRate,

    [bool]$RevertOnDisconnect = $true,

    [ValidateSet('enabled', 'disabled')]
    [string]$Mouse = 'enabled',

    [ValidateSet('preserve', 'enabled', 'disabled')]
    [string]$NativePenTouch = 'preserve',

    [string]$BackupDirectory,

    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Sunshine configuration file not found: $ConfigPath"
}
if ($ResolutionMode -eq 'manual') {
    if (-not $ManualResolution -or $ManualResolution -notmatch '^\d{3,5}x\d{3,5}$') {
        throw 'ManualResolution must use WIDTHxHEIGHT when ResolutionMode is manual.'
    }
}
if ($RefreshRateMode -eq 'manual') {
    if ($null -eq $ManualRefreshRate -or $ManualRefreshRate -lt 1 -or $ManualRefreshRate -gt 1000) {
        throw 'ManualRefreshRate must be between 1 and 1000 when RefreshRateMode is manual.'
    }
}

$rateText = if ($null -ne $ManualRefreshRate) {
    ([double]$ManualRefreshRate).ToString('0.###', [Globalization.CultureInfo]::InvariantCulture)
}
else { $null }

$desired = [ordered]@{
    adapter_name                   = $AdapterName
    output_name                    = $OutputName
    dd_configuration_option        = $Topology
    dd_resolution_option           = $ResolutionMode
    dd_refresh_rate_option         = $RefreshRateMode
    dd_config_revert_on_disconnect = if ($RevertOnDisconnect) { 'enabled' } else { 'disabled' }
    mouse                          = $Mouse
}
if ($ResolutionMode -eq 'manual') { $desired.dd_manual_resolution = $ManualResolution }
if ($RefreshRateMode -eq 'manual') { $desired.dd_manual_refresh_rate = $rateText }
if ($NativePenTouch -ne 'preserve') { $desired.native_pen_touch = $NativePenTouch }
$removeKeys = @()
if ($ResolutionMode -ne 'manual') { $removeKeys += 'dd_manual_resolution' }
if ($RefreshRateMode -ne 'manual') { $removeKeys += 'dd_manual_refresh_rate' }

$raw = [IO.File]::ReadAllText($ConfigPath)
$newLine = if ($raw.Contains([Environment]::NewLine)) { [Environment]::NewLine } else { [string][char]10 }
$hadTerminalNewLine = $raw.EndsWith([string][char]10)
$lines = @($raw -split '\r?\n')
if ($hadTerminalNewLine -and $lines.Count -gt 0 -and $lines[-1] -eq '') {
    if ($lines.Count -eq 1) { $lines = @() } else { $lines = @($lines[0..($lines.Count - 2)]) }
}

$seen = @{}
$changes = [Collections.Generic.List[object]]::new()
$outputLines = [Collections.Generic.List[string]]::new()
foreach ($line in $lines) {
    if ($line -match '^\s*(?![#;])([^=]+?)\s*=\s*(.*?)\s*$') {
        $key = $matches[1].Trim()
        $oldValue = $matches[2]
        if ($removeKeys -contains $key) {
            $changes.Add([pscustomobject]@{ Key = $key; Before = $oldValue; After = $null; Action = 'Remove' })
            continue
        }
        if ($desired.Contains($key)) {
            if ($seen.ContainsKey($key)) {
                $changes.Add([pscustomobject]@{ Key = $key; Before = $oldValue; After = $null; Action = 'RemoveDuplicate' })
                continue
            }
            $newValue = [string]$desired[$key]
            $outputLines.Add("$key = $newValue")
            $seen[$key] = $true
            if ($oldValue -ne $newValue) {
                $changes.Add([pscustomobject]@{ Key = $key; Before = $oldValue; After = $newValue; Action = 'Update' })
            }
            continue
        }
    }
    $outputLines.Add($line)
}

foreach ($entry in $desired.GetEnumerator()) {
    if (-not $seen.ContainsKey($entry.Key)) {
        $outputLines.Add(('{0} = {1}' -f $entry.Key, $entry.Value))
        $changes.Add([pscustomobject]@{ Key = $entry.Key; Before = $null; After = [string]$entry.Value; Action = 'Add' })
    }
}

$rendered = [string]::Join($newLine, $outputLines)
if ($hadTerminalNewLine) { $rendered += $newLine }
$backupPath = $null
if ($Apply) {
    if (-not $BackupDirectory) { $BackupDirectory = Split-Path -Parent $ConfigPath }
    [void](New-Item -ItemType Directory -Path $BackupDirectory -Force)
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupPath = Join-Path $BackupDirectory ("{0}.bak-sunshine-vdd-setup-{1}" -f (Split-Path -Leaf $ConfigPath), $stamp)
    Copy-Item -LiteralPath $ConfigPath -Destination $backupPath -ErrorAction Stop
    [IO.File]::WriteAllText($ConfigPath, $rendered, [Text.UTF8Encoding]::new($false))
}

[pscustomobject][ordered]@{
    Mode           = if ($Apply) { 'Applied' } else { 'DryRun' }
    ConfigPath     = $ConfigPath
    BackupPath     = $backupPath
    Changed        = $changes.Count -gt 0
    Changes        = @($changes)
    RenderedConfig = if ($Apply) { $null } else { $rendered }
}
