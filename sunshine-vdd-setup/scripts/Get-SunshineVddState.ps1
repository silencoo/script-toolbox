[CmdletBinding()]
param(
    [string]$SunshineRoot = "$env:ProgramFiles\Sunshine",
    [string]$SunshineConfigPath,
    [string]$VddConfigPath = 'C:\VirtualDisplayDriver\vdd_settings.xml',
    [switch]$AsObject
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module -Force (Join-Path $PSScriptRoot 'DisplayTopology.psm1')

function ConvertFrom-SunshineConfig {
    param([Parameter(Mandatory)][string]$Path)

    $settings = [ordered]@{}
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($line -match '^\s*(?![#;])([^=]+?)\s*=\s*(.*?)\s*$') {
            $settings[$matches[1].Trim()] = $matches[2]
        }
    }
    [pscustomobject]$settings
}

function Find-SunshineConfig {
    param([string]$RequestedPath)

    if ($RequestedPath) {
        return $RequestedPath
    }

    $candidates = @(
        (Join-Path $SunshineRoot 'config\sunshine.conf'),
        (Join-Path $env:ProgramData 'Sunshine\config\sunshine.conf')
    ) | Select-Object -Unique
    $found = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($found) { return $found }
    return $candidates[0]
}

function Get-VddXmlSummary {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{ Exists = $false; Path = $Path }
    }

    [xml]$xml = [System.IO.File]::ReadAllText($Path)
    $rates = @($xml.vdd_settings.global.g_refresh_rate | ForEach-Object { [string]$_ })
    $resolutions = @(
        $xml.vdd_settings.resolutions.resolution | ForEach-Object {
            [pscustomobject]@{
                Width            = [int]$_.width
                Height           = [int]$_.height
                PreferredRefresh = [double]$_.refresh_rate
            }
        }
    )
    [pscustomobject]@{
        Exists             = $true
        Path               = $Path
        MonitorCount       = [int]$xml.vdd_settings.monitors.count
        GpuFriendlyName    = [string]$xml.vdd_settings.gpu.friendlyname
        GlobalRefreshRates = $rates
        Resolutions        = $resolutions
        HardwareCursor     = if ($null -ne $xml.vdd_settings.options.HardwareCursor) { [string]$xml.vdd_settings.options.HardwareCursor } else { $null }
        SDR10bit           = if ($null -ne $xml.vdd_settings.options.SDR10bit) { [string]$xml.vdd_settings.options.SDR10bit } else { $null }
        HDRPlus            = if ($null -ne $xml.vdd_settings.options.HDRPlus) { [string]$xml.vdd_settings.options.HDRPlus } else { $null }
        CustomEdid         = if ($null -ne $xml.vdd_settings.options.CustomEdid) { [string]$xml.vdd_settings.options.CustomEdid } else { $null }
        PreventSpoof       = if ($null -ne $xml.vdd_settings.options.PreventSpoof) { [string]$xml.vdd_settings.options.PreventSpoof } else { $null }
        EdidCeaOverride    = if ($null -ne $xml.vdd_settings.options.EdidCeaOverride) { [string]$xml.vdd_settings.options.EdidCeaOverride } else { $null }
        Logging            = if ($null -ne $xml.vdd_settings.options.logging) { [string]$xml.vdd_settings.options.logging } else { $null }
        DebugLogging       = if ($null -ne $xml.vdd_settings.options.debuglogging) { [string]$xml.vdd_settings.options.debuglogging } else { $null }
    }
}

function Invoke-CapturedCommand {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$ArgumentList = @()
    )

    try {
        $output = & $FilePath @ArgumentList 2>&1 | Out-String
        [pscustomobject]@{
            Available = $true
            ExitCode  = $LASTEXITCODE
            Output    = $output.Trim()
        }
    }
    catch {
        [pscustomobject]@{
            Available = $false
            ExitCode  = $null
            Output    = $_.Exception.Message
        }
    }
}

function Read-SharedTextFile {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        $reader = [IO.StreamReader]::new($stream)
        try { $reader.ReadToEnd() } finally { $reader.Dispose() }
    }
    finally {
        $stream.Dispose()
    }
}

function Get-LatestSunshineDisplayInventory {
    param([Parameter(Mandatory)][string]$Path)

    $content = Read-SharedTextFile -Path $Path
    if ($null -eq $content) { return $null }
    $lines = @($content -split '\r?\n')
    $start = -1
    for ($index = $lines.Length - 1; $index -ge 0; $index--) {
        if ($lines[$index] -match 'Currently available display devices:') {
            $start = $index + 1
            break
        }
    }
    if ($start -lt 0 -or $start -ge $lines.Length) { return $null }

    $builder = [Text.StringBuilder]::new()
    $depth = 0
    $began = $false
    for ($index = $start; $index -lt $lines.Length; $index++) {
        $line = $lines[$index]
        if (-not $began) {
            if ($line.TrimStart().StartsWith('[')) { $began = $true } else { continue }
        }
        [void]$builder.AppendLine($line)
        $depth += ([regex]::Matches($line, '\[')).Count
        $depth -= ([regex]::Matches($line, '\]')).Count
        if ($began -and $depth -eq 0) { break }
    }
    if (-not $began -or $depth -ne 0) { return $null }

    try { $builder.ToString() | ConvertFrom-Json -ErrorAction Stop } catch { $null }
}

function Get-SunshineStreamingState {
    param(
        [Parameter(Mandatory)][string]$Path,
        [object[]]$Processes = @()
    )

    if ($Processes.Count -eq 0) {
        return [pscustomobject][ordered]@{
            Status                 = 'Inactive'
            EstimatedActiveClients = 0
            Detection              = 'SunshineProcessNotRunning'
            LogPath                = $Path
            LastRelevantEvents     = @()
        }
    }

    $content = Read-SharedTextFile -Path $Path
    if ($null -eq $content) {
        return [pscustomobject][ordered]@{
            Status                 = 'Unknown'
            EstimatedActiveClients = $null
            Detection              = 'SunshineLogUnavailable'
            LogPath                = $Path
            LastRelevantEvents     = @()
        }
    }

    $lines = @($content -split '\r?\n')
    $startupIndex = -1
    for ($index = $lines.Count - 1; $index -ge 0; $index--) {
        if ($lines[$index] -match '(?i)Sunshine version:') {
            $startupIndex = $index
            break
        }
    }
    if ($startupIndex -lt 0) {
        return [pscustomobject][ordered]@{
            Status                 = 'Unknown'
            EstimatedActiveClients = $null
            Detection              = 'CurrentSunshineLogEpochNotFound'
            LogPath                = $Path
            LastRelevantEvents     = @($lines | Where-Object { $_ -match '(?i)CLIENT (CONNECTED|DISCONNECTED)|New streaming session started' } | Select-Object -Last 8)
        }
    }

    $events = @($lines[$startupIndex..($lines.Count - 1)] | Where-Object {
        $_ -match '(?i)CLIENT (CONNECTED|DISCONNECTED)|New streaming session started'
    })
    $activeClients = 0
    $lastConnectIndex = -1
    $lastDisconnectIndex = -1
    $lastStartIndex = -1
    for ($index = 0; $index -lt $events.Count; $index++) {
        $event = $events[$index]
        if ($event -match '(?i)CLIENT CONNECTED') {
            $activeClients++
            $lastConnectIndex = $index
        }
        elseif ($event -match '(?i)CLIENT DISCONNECTED') {
            if ($activeClients -gt 0) { $activeClients-- }
            $lastDisconnectIndex = $index
        }
        elseif ($event -match '(?i)New streaming session started') {
            $lastStartIndex = $index
        }
    }

    $status = if ($activeClients -gt 0) {
        'Active'
    }
    elseif ($lastStartIndex -gt $lastDisconnectIndex -and $lastStartIndex -gt $lastConnectIndex) {
        # A session can change display configuration before CLIENT CONNECTED appears.
        'Unknown'
    }
    else {
        'Inactive'
    }
    [pscustomobject][ordered]@{
        Status                 = $status
        EstimatedActiveClients = $activeClients
        Detection              = 'CurrentSunshineLogEpoch'
        LogPath                = $Path
        LastRelevantEvents     = @($events | Select-Object -Last 8)
    }
}

function Get-PnpDisplayDeviceInventory {
    try {
        $devices = @(Get-CimInstance -ClassName Win32_PnPEntity -Filter "PNPClass = 'Display'" -ErrorAction Stop)
        foreach ($device in $devices) {
            $identityText = '{0} {1} {2} {3}' -f $device.PNPDeviceID, $device.Name, $device.Manufacturer, $device.Service
            [pscustomobject][ordered]@{
                InstanceId             = [string]$device.PNPDeviceID
                Name                   = [string]$device.Name
                Manufacturer           = [string]$device.Manufacturer
                Service                = [string]$device.Service
                Status                 = [string]$device.Status
                ConfigManagerErrorCode = [int]$device.ConfigManagerErrorCode
                IsMttVdd               = $identityText -match '(?i)MTTVDD|MikeTheTech|Virtual Display Driver|IddSampleDriver Device HDR'
                IsOtherVirtual         = ($identityText -match '(?i)virtual|indirect|idd|parsec|spacedesk|meta|rustdesk') -and ($identityText -notmatch '(?i)MTTVDD|MikeTheTech|Virtual Display Driver|IddSampleDriver Device HDR')
            }
        }
    }
    catch {
        [pscustomobject][ordered]@{
            InstanceId             = $null
            Name                   = $null
            Manufacturer           = $null
            Service                = $null
            Status                 = 'InventoryFailed'
            ConfigManagerErrorCode = $null
            IsMttVdd               = $false
            IsOtherVirtual         = $false
            Error                  = $_.Exception.Message
        }
    }
}

$resolvedSunshineConfig = Find-SunshineConfig -RequestedPath $SunshineConfigPath
$sunshineConfigExists = Test-Path -LiteralPath $resolvedSunshineConfig
$sunshineConfig = if ($sunshineConfigExists) { ConvertFrom-SunshineConfig -Path $resolvedSunshineConfig } else { $null }
$configuredLogPath = if ($sunshineConfig -and $sunshineConfig.PSObject.Properties.Name -contains 'log_path') {
    [Environment]::ExpandEnvironmentVariables([string]$sunshineConfig.log_path)
}
else { $null }
$sunshineLogPath = if ($configuredLogPath) {
    if ([IO.Path]::IsPathRooted($configuredLogPath)) { $configuredLogPath }
    else { Join-Path (Split-Path -Parent $resolvedSunshineConfig) $configuredLogPath }
}
else {
    Join-Path (Split-Path -Parent $resolvedSunshineConfig) 'sunshine.log'
}
$sunshineExeCandidates = @(
    (Join-Path $SunshineRoot 'sunshine.exe'),
    (Join-Path $SunshineRoot 'tools\sunshine.exe')
) | Select-Object -Unique
$sunshineExe = $sunshineExeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$dxgiCandidates = @(
    (Join-Path $SunshineRoot 'tools\dxgi-info.exe'),
    (Join-Path $SunshineRoot 'dxgi-info.exe')
) | Select-Object -Unique
$dxgiExe = $dxgiCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

$service = Get-Service -Name 'SunshineService' -ErrorAction SilentlyContinue
if (-not $service) {
    $service = Get-Service -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -match '(?i)sunshine' -or $_.DisplayName -match '(?i)sunshine'
    } | Select-Object -First 1
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$sunshineProcesses = @(Get-Process -Name 'sunshine' -ErrorAction SilentlyContinue | Select-Object Id, ProcessName)
$pnp = Invoke-CapturedCommand -FilePath 'pnputil.exe' -ArgumentList @('/enum-devices', '/class', 'Display', '/drivers')
$pnpStructured = @(Get-PnpDisplayDeviceInventory)
$dxgi = if ($dxgiExe) {
    Invoke-CapturedCommand -FilePath $dxgiExe
}
else {
    [pscustomobject]@{ Available = $false; ExitCode = $null; Output = 'dxgi-info.exe was not found under the Sunshine root.' }
}

$state = [pscustomobject][ordered]@{
    CapturedAt = (Get-Date).ToString('o')
    Host = [pscustomobject][ordered]@{
        ComputerName      = $env:COMPUTERNAME
        UserName          = $identity.Name
        IsAdministrator   = $isAdmin
        OsVersion         = [Environment]::OSVersion.VersionString
        PowerShellVersion = $PSVersionTable.PSVersion.ToString()
        SessionName       = $env:SESSIONNAME
    }
    Sunshine = [pscustomobject][ordered]@{
        Root          = $SunshineRoot
        Executable    = $sunshineExe
        Version       = if ($sunshineExe) { (Get-Item -LiteralPath $sunshineExe).VersionInfo.FileVersion } else { $null }
        ConfigPath    = $resolvedSunshineConfig
        ConfigExists  = $sunshineConfigExists
        Config        = $sunshineConfig
        LogPath       = $sunshineLogPath
        DisplayInventoryFromLog = @(Get-LatestSunshineDisplayInventory -Path $sunshineLogPath)
        Streaming     = Get-SunshineStreamingState -Path $sunshineLogPath -Processes $sunshineProcesses
        ServiceName   = if ($service) { $service.Name } else { $null }
        ServiceStatus = if ($service) { [string]$service.Status } else { 'NotFound' }
        Processes     = $sunshineProcesses
        DxgiInfo      = $dxgi
    }
    Vdd = Get-VddXmlSummary -Path $VddConfigPath
    Displays = @(Get-VddDisplayInventory)
    PnpDisplayDevices = $pnp
    PnpDisplayDevicesStructured = $pnpStructured
    MttVddPnpDevices = @($pnpStructured | Where-Object IsMttVdd)
}

if ($AsObject) {
    $state
}
else {
    $state | ConvertTo-Json -Depth 10
}
