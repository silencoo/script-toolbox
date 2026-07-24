# setup.ps1
# Install, initialize, inspect, and maintain WSL 2 on Windows.
# Compatible with Windows PowerShell 5.1 and PowerShell 7+.

[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $Arguments
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference `
    -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$script:ScriptName = Split-Path -Leaf $PSCommandPath
$script:ScriptVersion = '1.0.0'
$script:DefaultDistro = 'Ubuntu-24.04'
$script:AssumeYes = $false
$script:NoDistro = $false
$script:WebDownload = $false
$script:SkipUpdate = $false
$script:SelectedDistro = $script:DefaultDistro
$script:RestartRequired = $false

$script:UseColor = $false
if (-not $env:NO_COLOR) {
  try {
    $script:UseColor = [bool] $Host.UI.SupportsVirtualTerminal
  } catch {
    $script:UseColor = $false
  }
}
$escape = [char] 27
$script:ColorBold = if ($script:UseColor) { "$escape[1m" } else { '' }
$script:ColorGreen = if ($script:UseColor) { "$escape[32m" } else { '' }
$script:ColorYellow = if ($script:UseColor) { "$escape[33m" } else { '' }
$script:ColorRed = if ($script:UseColor) { "$escape[31m" } else { '' }
$script:ColorBlue = if ($script:UseColor) { "$escape[34m" } else { '' }
$script:ColorReset = if ($script:UseColor) { "$escape[0m" } else { '' }

function Write-Line {
  param([AllowEmptyString()][string] $Message = '')
  Write-Output $Message
}

function Write-InfoLine {
  param([string] $Message)
  Write-Output "$($script:ColorBlue)==>$($script:ColorReset) $Message"
}

function Write-Success {
  param([string] $Message)
  Write-Output "$($script:ColorGreen)OK$($script:ColorReset)  $Message"
}

function Write-WarnLine {
  param([string] $Message)
  [Console]::Error.WriteLine(
    "$($script:ColorYellow)WARN$($script:ColorReset) $Message"
  )
}

function Stop-Setup {
  param([string] $Message)
  throw [InvalidOperationException]::new($Message)
}

function Write-Section {
  param([string] $Title)
  Write-Line
  Write-Line "$($script:ColorBold)$Title$($script:ColorReset)"
  Write-Line '------------------------------------------------------------'
}

function Confirm-Action {
  param([string] $Question)
  if ($script:AssumeYes) {
    return $true
  }
  try {
    $reply = Read-Host "$Question [y/N]"
  } catch {
    return $false
  }
  return $reply -match '^(?i:y|yes)$'
}

function Show-Usage {
  Write-Line @"
$($script:ColorBold)WSL 2 setup $($script:ScriptVersion)$($script:ColorReset)
Install, initialize, inspect, and maintain WSL 2 on Windows.

$($script:ColorBold)Usage$($script:ColorReset)
  .\$($script:ScriptName) [global options] [command] [arguments]

$($script:ColorBold)Global options$($script:ColorReset)
  -y, --yes                  Accept feature-enable and conversion prompts.
      --distro NAME          Select the setup distro (default: Ubuntu-24.04).
      --no-distro            Initialize WSL 2 without installing a distro.
      --web-download         Download WSL/distro from the web, not Store.
      --skip-update          Do not run 'wsl --update' during setup.
  -h, --help                 Show this help.
      --version              Show the script version.

$($script:ColorBold)Commands$($script:ColorReset)
  setup                      Initialize WSL 2 and the selected distro (default).
  info                       Show Windows, feature, WSL, and distro state.
  doctor                     Run host, virtualization, feature, and WSL checks.
  distros [--online]         List installed distros; optionally list downloads.
  update                     Update WSL to the latest stable release.
  install-distro NAME        Install a distro without launching it.
  convert NAME               Convert an installed WSL 1 distro to WSL 2.
  set-default NAME           Set the default Linux distribution.
  shutdown                   Stop all distros and the WSL 2 utility VM.

$($script:ColorBold)Examples$($script:ColorReset)
  .\$($script:ScriptName) --yes setup
  .\$($script:ScriptName) --distro Debian setup
  .\$($script:ScriptName) --no-distro setup
  .\$($script:ScriptName) --web-download update
  .\$($script:ScriptName) distros --online
  .\$($script:ScriptName) convert Ubuntu-24.04

After installing a distro, launch it once to create the Linux user:
  wsl.exe --distribution Ubuntu-24.04

Microsoft documentation:
  https://learn.microsoft.com/windows/wsl/install
"@
}

function Invoke-NativeCapture {
  param(
    [Parameter(Mandatory = $true)][string] $FilePath,
    [string[]] $ArgumentList = @()
  )

  $global:LASTEXITCODE = 0
  $output = @(& $FilePath @ArgumentList 2>&1)
  $exitCode = $LASTEXITCODE
  $lines = @(
    $output |
      ForEach-Object { $_.ToString().Replace([string][char]0, '') }
  )
  return [pscustomobject] @{
    ExitCode = $exitCode
    Output = $lines
    Text = $lines -join [Environment]::NewLine
  }
}

function Get-WslCommand {
  if ($env:WSL2_MANAGER_WSL_COMMAND) {
    if (-not (Test-Path -LiteralPath $env:WSL2_MANAGER_WSL_COMMAND `
        -PathType Leaf)) {
      Stop-Setup (
        'WSL2_MANAGER_WSL_COMMAND points to a missing file: ' +
        $env:WSL2_MANAGER_WSL_COMMAND
      )
    }
    return (Resolve-Path -LiteralPath $env:WSL2_MANAGER_WSL_COMMAND).Path
  }

  $command = Get-Command 'wsl.exe' -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    $command = Get-Command 'wsl' -ErrorAction SilentlyContinue
  }
  if ($null -eq $command) {
    Stop-Setup (
      'wsl.exe is unavailable. Install current Windows updates, then rerun ' +
      'this script from an elevated PowerShell prompt.'
    )
  }
  return $command.Source
}

function Invoke-WslCapture {
  param([string[]] $ArgumentList = @())
  return Invoke-NativeCapture -FilePath (Get-WslCommand) `
    -ArgumentList $ArgumentList
}

function Invoke-Wsl {
  param([string[]] $ArgumentList = @())
  $wsl = Get-WslCommand
  $global:LASTEXITCODE = 0
  & $wsl @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    Stop-Setup "wsl.exe failed with exit code $LASTEXITCODE."
  }
}

function Invoke-WslBestEffort {
  param([string[]] $ArgumentList = @())
  $wsl = Get-WslCommand
  & $wsl @ArgumentList
}

function Test-IsAdministrator {
  if ($env:WSL2_MANAGER_TEST_MODE -eq '1' -and $env:WSL2_TEST_LOG) {
    return $env:WSL2_TEST_ADMIN -ne '0'
  }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
  )
}

function Get-WindowsInfo {
  if ($env:WSL2_MANAGER_TEST_MODE -eq '1' -and $env:WSL2_TEST_LOG) {
    return [pscustomobject] @{
      Caption = 'Microsoft Windows 11 Pro'
      Version = '10.0.26100'
      Build = 26100
      Architecture = 'AMD64'
    }
  }

  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($env:PROCESSOR_ARCHITEW6432) {
    $arch = $env:PROCESSOR_ARCHITEW6432
  }
  try {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    return [pscustomobject] @{
      Caption = $os.Caption
      Version = $os.Version
      Build = [int] $os.BuildNumber
      Architecture = $arch
    }
  } catch {
    $version = [Environment]::OSVersion.Version
    $caption = 'Microsoft Windows'
    try {
      $currentVersion = Get-ItemProperty -LiteralPath (
        'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
      ) -ErrorAction Stop
      if ($currentVersion.ProductName) {
        $caption = [string] $currentVersion.ProductName
      }
    } catch {
      # Environment.OSVersion still supplies the required build.
    }
    if ($version.Build -ge 22000 -and $caption -match 'Windows 10') {
      $caption = $caption -replace 'Windows 10', 'Windows 11'
    }
    return [pscustomobject] @{
      Caption = $caption
      Version = $version.ToString()
      Build = [int] $version.Build
      Architecture = $arch
    }
  }
}

function Get-OptionalFeatureState {
  param([string] $Name)

  if ($env:WSL2_MANAGER_TEST_MODE -eq '1' -and $env:WSL2_TEST_LOG) {
    if ($Name -eq 'VirtualMachinePlatform') {
      return $env:WSL2_TEST_VM_FEATURE
    }
    return $env:WSL2_TEST_WSL_FEATURE
  }

  try {
    $feature = Get-CimInstance -ClassName Win32_OptionalFeature `
      -Filter "Name='$Name'" -ErrorAction Stop
    if ($null -ne $feature) {
      switch ([int] $feature.InstallState) {
        1 { return 'Enabled' }
        2 { return 'Disabled' }
        3 { return 'Absent' }
        default { return 'Unknown' }
      }
    }
  } catch {
    # An elevated DISM-backed check below may still be available.
  }
  if (Test-IsAdministrator) {
    try {
      $feature = Get-WindowsOptionalFeature -Online `
        -FeatureName $Name -ErrorAction Stop
      if ($feature.State -eq 'Enabled') {
        return 'Enabled'
      }
      if ($feature.State -eq 'Disabled') {
        return 'Disabled'
      }
    } catch {
      return 'Unknown'
    }
  }
  return 'Unknown'
}

function Get-FeatureState {
  return [pscustomobject] @{
    Wsl = Get-OptionalFeatureState 'Microsoft-Windows-Subsystem-Linux'
    VirtualMachinePlatform = Get-OptionalFeatureState 'VirtualMachinePlatform'
  }
}

function Get-VirtualizationState {
  if ($env:WSL2_MANAGER_TEST_MODE -eq '1' -and $env:WSL2_TEST_LOG) {
    return [pscustomobject] @{
      FirmwareEnabled = $true
      SlatSupported = $true
      Known = $true
    }
  }
  try {
    $processors = @(Get-CimInstance -ClassName Win32_Processor `
      -ErrorAction Stop)
    if ($processors.Count -eq 0) {
      throw 'No processor information returned.'
    }
    $firmware = @(
      $processors | ForEach-Object { $_.VirtualizationFirmwareEnabled }
    ) -notcontains $false
    $slat = @(
      $processors |
        ForEach-Object { $_.SecondLevelAddressTranslationExtensions }
    ) -notcontains $false
    return [pscustomobject] @{
      FirmwareEnabled = $firmware
      SlatSupported = $slat
      Known = $true
    }
  } catch {
    return [pscustomobject] @{
      FirmwareEnabled = $null
      SlatSupported = $null
      Known = $false
    }
  }
}

function Test-RebootPending {
  if ($env:WSL2_MANAGER_TEST_MODE -eq '1' -and $env:WSL2_TEST_LOG) {
    return $false
  }
  foreach ($path in @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
  )) {
    try {
      if (Test-Path -LiteralPath $path -ErrorAction Stop) {
        return $true
      }
    } catch {
      # Restricted processes may not be able to inspect servicing keys.
    }
  }
  return $false
}

function Test-HostPrerequisites {
  $windows = Get-WindowsInfo
  Write-Line (
    "Detected: $($windows.Caption) $($windows.Version) " +
    "($($windows.Architecture))"
  )
  if ($windows.Build -lt 19041) {
    Stop-Setup (
      'The modern WSL installation command requires Windows 10 version 2004 ' +
      "or newer (build 19041+) or Windows 11; detected build $($windows.Build)."
    )
  }
  if ($windows.Architecture -notin @(
      'AMD64', 'x86_64', 'ARM64', 'aarch64'
    )) {
    Stop-Setup "Unsupported Windows architecture: $($windows.Architecture)"
  }
  Write-Success 'Windows version and architecture support WSL 2.'

  $virtualization = Get-VirtualizationState
  if (-not $virtualization.Known) {
    Write-WarnLine (
      'Could not query firmware virtualization or SLAT support. If WSL 2 ' +
      'fails with 0x80370102, enable CPU virtualization in BIOS/UEFI.'
    )
    return
  }
  if (-not $virtualization.SlatSupported) {
    Stop-Setup 'The processor does not report the SLAT support required by WSL 2.'
  }
  if (-not $virtualization.FirmwareEnabled) {
    Stop-Setup (
      'CPU virtualization is disabled in BIOS/UEFI. Enable Intel VT-x or ' +
      'AMD-V/SVM, restart Windows, and rerun setup.'
    )
  }
  Write-Success 'Firmware virtualization and SLAT checks passed.'
}

function Test-WslReady {
  try {
    $result = Invoke-WslCapture @('--status')
    return $result.ExitCode -eq 0
  } catch {
    return $false
  }
}

function Install-WslPlatform {
  $features = Get-FeatureState
  $featuresEnabled = (
    $features.Wsl -eq 'Enabled' -and
    $features.VirtualMachinePlatform -eq 'Enabled'
  )
  $featureUnavailable = (
    $features.Wsl -in @('Disabled', 'Absent') -or
    $features.VirtualMachinePlatform -in @('Disabled', 'Absent')
  )
  $wslReady = Test-WslReady
  if ($wslReady -and -not $featureUnavailable) {
    if ($featuresEnabled) {
      Write-Success 'WSL and Virtual Machine Platform are enabled.'
    } else {
      Write-WarnLine (
        'WSL is operational, but this process could not read every optional ' +
        'feature state. Continuing with the working WSL installation.'
      )
    }
    return
  }

  if (-not (Test-IsAdministrator)) {
    Stop-Setup (
      'Installing the WSL platform requires elevation. Open PowerShell as ' +
      "Administrator and rerun: .\$($script:ScriptName) setup"
    )
  }
  if (-not (Confirm-Action (
        'Install WSL and enable Virtual Machine Platform? A reboot may be required.'
      ))) {
    Stop-Setup 'WSL platform installation was cancelled.'
  }

  Write-InfoLine 'Installing the WSL platform without a Linux distribution...'
  $arguments = @('--install', '--no-distribution')
  if ($script:WebDownload) {
    $arguments += '--web-download'
  }
  Invoke-Wsl $arguments

  if ($featureUnavailable) {
    $script:RestartRequired = $true
    Write-WarnLine (
      'Windows features changed. Restart Windows, then rerun setup to ' +
      'install/update WSL and the selected distribution.'
    )
    return
  }
  if (Test-RebootPending) {
    $script:RestartRequired = $true
    Write-WarnLine 'Windows reports a pending reboot. Restart, then rerun setup.'
    return
  }
  Write-Success 'WSL platform installation completed.'
}

function Update-Wsl {
  Write-InfoLine 'Updating WSL...'
  $arguments = @('--update')
  if ($script:WebDownload) {
    $arguments += '--web-download'
  }
  Invoke-Wsl $arguments
  Write-Success 'WSL update completed.'
}

function Get-InstalledDistros {
  $result = Invoke-WslCapture @('--list', '--quiet')
  if ($result.ExitCode -ne 0) {
    return @()
  }
  return @(
    $result.Output |
      ForEach-Object { $_.Trim() } |
      Where-Object { $_ }
  )
}

function Test-DistroInstalled {
  param([string] $Name)
  foreach ($distro in @(Get-InstalledDistros)) {
    if ($distro.Equals($Name, [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

function Get-DistroVersion {
  param([string] $Name)
  $result = Invoke-WslCapture @('--list', '--verbose')
  if ($result.ExitCode -ne 0) {
    return $null
  }
  $escapedName = [regex]::Escape($Name)
  foreach ($line in $result.Output) {
    if ($line -match (
        "^\s*\*?\s*$escapedName\s{2,}.*\s+([12])\s*$"
      )) {
      return [int] $Matches[1]
    }
  }
  return $null
}

function Install-Distro {
  param([string] $Name)
  if ([string]::IsNullOrWhiteSpace($Name)) {
    Stop-Setup 'A distribution name is required.'
  }
  if (-not (Test-WslReady)) {
    Stop-Setup 'WSL is not ready. Run setup from an elevated PowerShell prompt.'
  }
  if (Test-DistroInstalled $Name) {
    Write-Success "Distribution is already installed: $Name"
    return
  }

  Write-InfoLine "Installing WSL distribution: $Name"
  $arguments = @(
    '--install',
    '--distribution', $Name,
    '--no-launch'
  )
  if ($script:WebDownload) {
    $arguments += '--web-download'
  }
  Invoke-Wsl $arguments
  Write-Success "Installed distribution without launching it: $Name"
  Write-Line "Initialize its Linux user with: wsl.exe --distribution $Name"
}

function Convert-DistroToWsl2 {
  param([string] $Name)
  if (-not (Test-DistroInstalled $Name)) {
    Stop-Setup "Distribution is not installed: $Name"
  }
  $version = Get-DistroVersion $Name
  if ($version -eq 2) {
    Write-Success "Distribution already uses WSL 2: $Name"
    return
  }
  Write-WarnLine (
    'Converting a large distribution can take time. Back up important data ' +
    'before changing its WSL version.'
  )
  if (-not (Confirm-Action "Convert '$Name' to WSL 2?")) {
    Stop-Setup 'Distribution conversion was cancelled.'
  }
  Invoke-Wsl @('--set-version', $Name, '2')
  Write-Success "Converted distribution to WSL 2: $Name"
}

function Set-DefaultDistro {
  param([string] $Name)
  if (-not (Test-DistroInstalled $Name)) {
    Stop-Setup "Distribution is not installed: $Name"
  }
  Invoke-Wsl @('--set-default', $Name)
  Write-Success "Default distribution: $Name"
}

function Show-Distros {
  param([switch] $Online)
  Write-Section 'Installed distributions'
  $result = Invoke-WslCapture @('--list', '--verbose')
  if ($result.ExitCode -eq 0 -and $result.Text) {
    Write-Line $result.Text
  } else {
    Write-Line 'No installed distributions were reported.'
  }
  if ($Online) {
    Write-Section 'Distributions available online'
    Invoke-Wsl @('--list', '--online')
  }
}

function Get-HypervisorLaunchType {
  if ($env:WSL2_MANAGER_TEST_MODE -eq '1' -and $env:WSL2_TEST_LOG) {
    return 'Auto'
  }
  $command = Get-Command 'bcdedit.exe' -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    return 'Unknown'
  }
  $result = Invoke-NativeCapture -FilePath $command.Source `
    -ArgumentList @('/enum', '{current}')
  if ($result.Text -match '(?im)hypervisorlaunchtype\s+(\S+)') {
    return $Matches[1]
  }
  return 'Unknown'
}

function Show-HostInfo {
  Write-Section 'Windows host'
  $windows = Get-WindowsInfo
  Write-Line "OS: $($windows.Caption)"
  Write-Line "Version: $($windows.Version) (build $($windows.Build))"
  Write-Line "Architecture: $($windows.Architecture)"
  Write-Line "PowerShell: $($PSVersionTable.PSVersion)"
  Write-Line "Elevated: $(Test-IsAdministrator)"
  Write-Line "Pending reboot: $(Test-RebootPending)"

  $virtualization = Get-VirtualizationState
  if ($virtualization.Known) {
    Write-Line (
      "Virtualization enabled in firmware: $($virtualization.FirmwareEnabled)"
    )
    Write-Line "SLAT supported: $($virtualization.SlatSupported)"
  } else {
    Write-Line 'Firmware virtualization: unknown'
    Write-Line 'SLAT support: unknown'
  }
  Write-Line "Hypervisor launch type: $(Get-HypervisorLaunchType)"
}

function Show-FeatureInfo {
  Write-Section 'Windows features'
  $features = Get-FeatureState
  Write-Line "Microsoft-Windows-Subsystem-Linux: $($features.Wsl)"
  Write-Line "VirtualMachinePlatform: $($features.VirtualMachinePlatform)"
}

function Show-WslInfo {
  Write-Section 'WSL version'
  $version = Invoke-WslCapture @('--version')
  if ($version.ExitCode -eq 0 -and $version.Text) {
    Write-Line $version.Text
  } else {
    Write-Line 'The installed WSL does not report component versions.'
  }

  Write-Section 'WSL status'
  $status = Invoke-WslCapture @('--status')
  if ($status.ExitCode -eq 0 -and $status.Text) {
    Write-Line $status.Text
  } elseif ($status.Text) {
    Write-WarnLine $status.Text
  } else {
    Write-Line 'WSL is not initialized.'
  }
}

function Show-Info {
  Show-HostInfo
  Show-FeatureInfo
  Show-WslInfo
  Show-Distros
}

function Invoke-Doctor {
  Show-HostInfo
  Write-Section 'Host prerequisites'
  Test-HostPrerequisites
  Show-FeatureInfo
  Show-WslInfo
  Show-Distros

  Write-Section 'Related services'
  foreach ($name in @('WslService', 'LxssManager', 'vmcompute', 'hns')) {
    try {
      $service = Get-Service -Name $name -ErrorAction Stop
      Write-Line "$name`: $($service.Status) / $($service.StartType)"
    } catch {
      Write-Line "$name`: not present or unavailable"
    }
  }

  if ((Get-HypervisorLaunchType) -match '^(?i:off)$') {
    Write-WarnLine (
      'The Windows hypervisor is disabled in boot configuration. From an ' +
      'elevated prompt run: bcdedit /set hypervisorlaunchtype auto'
    )
  }
}

function Invoke-Setup {
  Test-HostPrerequisites
  Install-WslPlatform
  if ($script:RestartRequired) {
    return
  }

  if (-not $script:SkipUpdate) {
    Update-Wsl
  } else {
    Write-WarnLine 'Skipping WSL update by request.'
  }

  Invoke-Wsl @('--set-default-version', '2')
  Write-Success 'New distributions will use WSL 2 by default.'

  if (-not $script:NoDistro) {
    Install-Distro $script:SelectedDistro
    if ((Get-DistroVersion $script:SelectedDistro) -eq 1) {
      Convert-DistroToWsl2 $script:SelectedDistro
    }
    Set-DefaultDistro $script:SelectedDistro
  } else {
    Write-WarnLine 'Skipping Linux distribution installation by request.'
  }
  Show-Info
}

function Split-GlobalOptions {
  param([string[]] $RawArguments)

  $remaining = [Collections.Generic.List[string]]::new()
  $action = 'Continue'
  $index = 0
  while ($index -lt $RawArguments.Count) {
    $argument = $RawArguments[$index]
    switch ($argument) {
      { $_ -in @('-y', '--yes') } { $script:AssumeYes = $true }
      '--distro' {
        $index++
        if ($index -ge $RawArguments.Count) {
          Stop-Setup '--distro requires a distribution name'
        }
        $script:SelectedDistro = $RawArguments[$index]
      }
      '--no-distro' { $script:NoDistro = $true }
      '--web-download' { $script:WebDownload = $true }
      '--skip-update' { $script:SkipUpdate = $true }
      { $_ -in @('-h', '--help') } {
        $action = 'Help'
        $index = $RawArguments.Count
      }
      '--version' {
        $action = 'Version'
        $index = $RawArguments.Count
      }
      default {
        while ($index -lt $RawArguments.Count) {
          $remaining.Add($RawArguments[$index])
          $index++
        }
        return [pscustomobject] @{
          Action = $action
          Remaining = @($remaining)
        }
      }
    }
    $index++
  }
  return [pscustomobject] @{
    Action = $action
    Remaining = @($remaining)
  }
}

function Require-Argument {
  param(
    [string[]] $CommandArguments,
    [string] $Usage
  )
  if ($CommandArguments.Count -lt 1) {
    Stop-Setup "Usage: .\$($script:ScriptName) $Usage"
  }
  return $CommandArguments[0]
}

function Invoke-Main {
  param([string[]] $RawArguments)

  if ($null -eq $RawArguments) {
    $RawArguments = @()
  }
  $parsed = Split-GlobalOptions $RawArguments
  if ($parsed.Action -eq 'Help') {
    Show-Usage
    return
  }
  if ($parsed.Action -eq 'Version') {
    Write-Line $script:ScriptVersion
    return
  }

  $remaining = @($parsed.Remaining)
  $command = if ($remaining.Count -gt 0) { $remaining[0] } else { 'setup' }
  $commandArguments = if ($remaining.Count -gt 1) {
    @($remaining[1..($remaining.Count - 1)])
  } else {
    @()
  }

  switch ($command) {
    { $_ -in @('help', '-h', '--help') } { Show-Usage }
    'setup' { Invoke-Setup }
    'info' { Show-Info }
    { $_ -in @('doctor', 'diagnose') } { Invoke-Doctor }
    'distros' {
      $online = $false
      foreach ($argument in $commandArguments) {
        if ($argument -eq '--online') {
          $online = $true
        } else {
          Stop-Setup "Unknown distros option: $argument"
        }
      }
      Show-Distros -Online:$online
    }
    'update' {
      Test-HostPrerequisites
      Update-Wsl
    }
    'install-distro' {
      $name = Require-Argument $commandArguments 'install-distro NAME'
      Install-Distro $name
    }
    'convert' {
      $name = Require-Argument $commandArguments 'convert NAME'
      Convert-DistroToWsl2 $name
    }
    'set-default' {
      $name = Require-Argument $commandArguments 'set-default NAME'
      Set-DefaultDistro $name
    }
    'shutdown' {
      Invoke-Wsl @('--shutdown')
      Write-Success 'Stopped all distributions and the WSL 2 utility VM.'
    }
    default {
      Stop-Setup (
        "Unknown command: $command. Run '.\$($script:ScriptName) --help'."
      )
    }
  }
}

try {
  Invoke-Main $Arguments
  $setupExitCode = 0
} catch {
  [Console]::Error.WriteLine(
    "$($script:ColorRed)ERROR$($script:ColorReset) $($_.Exception.Message)"
  )
  $setupExitCode = 1
}
exit $setupExitCode
