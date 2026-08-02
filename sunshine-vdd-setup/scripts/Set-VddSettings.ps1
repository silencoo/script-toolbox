[CmdletBinding()]
param(
    [string]$ConfigPath = 'C:\VirtualDisplayDriver\vdd_settings.xml',

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$Resolutions,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [double[]]$RefreshRates,

    [Nullable[double]]$PreferredRefreshRate,

    [ValidateRange(1, 16)]
    [int]$MonitorCount = 1,

    [string]$GpuFriendlyName,

    [bool]$HardwareCursor = $true,

    [string]$BackupDirectory,

    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Format-Rate {
    param([double]$Value)
    $Value.ToString('0.###', [Globalization.CultureInfo]::InvariantCulture)
}

function Add-XmlElement {
    param(
        [Parameter(Mandatory)][xml]$Document,
        [Parameter(Mandatory)][System.Xml.XmlElement]$Parent,
        [Parameter(Mandatory)][string]$Name,
        [string]$Value
    )

    $node = $Document.CreateElement($Name)
    if ($PSBoundParameters.ContainsKey('Value')) { $node.InnerText = $Value }
    [void]$Parent.AppendChild($node)
    $node
}

function Get-OrAddChild {
    param(
        [Parameter(Mandatory)][xml]$Document,
        [Parameter(Mandatory)][System.Xml.XmlElement]$Parent,
        [Parameter(Mandatory)][string]$Name
    )

    $node = $Parent.SelectSingleNode($Name)
    if (-not $node) { $node = Add-XmlElement -Document $Document -Parent $Parent -Name $Name }
    $node
}

function ConvertTo-XmlText {
    param([Parameter(Mandatory)][xml]$Document)

    $memory = [IO.MemoryStream]::new()
    try {
        $settings = [Xml.XmlWriterSettings]::new()
        $settings.Encoding = [Text.UTF8Encoding]::new($false)
        $settings.Indent = $true
        $settings.IndentChars = '  '
        $settings.NewLineChars = [Environment]::NewLine
        $settings.NewLineHandling = [Xml.NewLineHandling]::Replace
        $writer = [Xml.XmlWriter]::Create($memory, $settings)
        try { $Document.Save($writer) } finally { $writer.Dispose() }
        [Text.Encoding]::UTF8.GetString($memory.ToArray())
    }
    finally {
        $memory.Dispose()
    }
}

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "VDD settings file not found: $ConfigPath"
}

$parsedResolutions = foreach ($resolution in $Resolutions) {
    if ($resolution -notmatch '^(?<width>\d{3,5})x(?<height>\d{3,5})$') {
        throw "Invalid resolution '$resolution'. Use WIDTHxHEIGHT, for example 2420x1668."
    }
    $width = [int]$matches.width
    $height = [int]$matches.height
    if ($width -lt 320 -or $height -lt 200 -or $width -gt 16384 -or $height -gt 16384) {
        throw "Resolution '$resolution' is outside the accepted 320x200 to 16384x16384 range."
    }
    [pscustomobject]@{ Width = $width; Height = $height; Text = ('{0}x{1}' -f $width, $height) }
}
$duplicateResolution = $parsedResolutions | Group-Object Text | Where-Object Count -gt 1
if ($duplicateResolution) { throw "Duplicate resolution: $($duplicateResolution[0].Name)" }

$normalizedRates = @($RefreshRates | ForEach-Object {
    if ($_ -lt 1 -or $_ -gt 1000) { throw "Refresh rate '$_' is outside the accepted 1-1000 Hz range." }
    [double]$_
} | Sort-Object -Unique)

$preferred = if ($null -ne $PreferredRefreshRate) {
    [double]$PreferredRefreshRate
}
else {
    [double]($normalizedRates | Sort-Object -Descending | Select-Object -First 1)
}
if (-not ($normalizedRates | Where-Object { [Math]::Abs($_ - $preferred) -lt 0.0001 })) {
    throw "PreferredRefreshRate $(Format-Rate $preferred) must also be included in RefreshRates."
}

$document = [Xml.XmlDocument]::new()
$document.PreserveWhitespace = $false
$document.Load($ConfigPath)
$root = $document.DocumentElement
if (-not $root -or $root.Name -ne 'vdd_settings') {
    throw "Unexpected VDD XML root. Expected <vdd_settings> in $ConfigPath."
}

$monitors = Get-OrAddChild -Document $document -Parent $root -Name 'monitors'
$count = Get-OrAddChild -Document $document -Parent $monitors -Name 'count'
$count.InnerText = [string]$MonitorCount

$gpu = Get-OrAddChild -Document $document -Parent $root -Name 'gpu'
$friendlyName = Get-OrAddChild -Document $document -Parent $gpu -Name 'friendlyname'
if ($GpuFriendlyName) { $friendlyName.InnerText = $GpuFriendlyName }

$global = Get-OrAddChild -Document $document -Parent $root -Name 'global'
@($global.SelectNodes('g_refresh_rate')) | ForEach-Object { [void]$global.RemoveChild($_) }
foreach ($rate in $normalizedRates) {
    [void](Add-XmlElement -Document $document -Parent $global -Name 'g_refresh_rate' -Value (Format-Rate $rate))
}

$resolutionRoot = Get-OrAddChild -Document $document -Parent $root -Name 'resolutions'
@($resolutionRoot.SelectNodes('resolution')) | ForEach-Object { [void]$resolutionRoot.RemoveChild($_) }
foreach ($resolution in $parsedResolutions) {
    $node = Add-XmlElement -Document $document -Parent $resolutionRoot -Name 'resolution'
    [void](Add-XmlElement -Document $document -Parent $node -Name 'width' -Value ([string]$resolution.Width))
    [void](Add-XmlElement -Document $document -Parent $node -Name 'height' -Value ([string]$resolution.Height))
    [void](Add-XmlElement -Document $document -Parent $node -Name 'refresh_rate' -Value (Format-Rate $preferred))
}

$options = Get-OrAddChild -Document $document -Parent $root -Name 'options'
$cursor = Get-OrAddChild -Document $document -Parent $options -Name 'HardwareCursor'
$cursor.InnerText = $HardwareCursor.ToString().ToLowerInvariant()

$rendered = ConvertTo-XmlText -Document $document
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
    Mode                 = if ($Apply) { 'Applied' } else { 'DryRun' }
    ConfigPath           = $ConfigPath
    BackupPath           = $backupPath
    MonitorCount         = $MonitorCount
    GpuFriendlyName      = [string]$friendlyName.InnerText
    Resolutions          = @($parsedResolutions.Text)
    RefreshRates         = @($normalizedRates | ForEach-Object { Format-Rate $_ })
    PreferredRefreshRate = Format-Rate $preferred
    HardwareCursor       = $HardwareCursor
    ProposedXml          = if ($Apply) { $null } else { $rendered }
}
