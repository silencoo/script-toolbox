# setup.ps1
# Opinionated, repeatable Windows 10/11 development workstation bootstrap.
# Compatible with Windows PowerShell 5.1 and PowerShell 7+.

[CmdletBinding(PositionalBinding = $true)]
param(
  [Parameter(Position = 0)]
  [ValidateSet('setup', 'plan', 'list', 'doctor')]
  [string] $Command = 'plan',

  [ValidateSet('core', 'default', 'full')]
  [string] $Profile = 'default',

  [string] $ConfigFile = (Join-Path $PSScriptRoot 'packages.psd1'),

  [switch] $Yes,
  [switch] $DryRun,
  [switch] $IncludeWSL,
  [switch] $EnableLongPaths,
  [switch] $NoGitConfig,
  [switch] $NoShellConfig,
  [switch] $FailFast
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference `
    -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$script:ScriptVersion = '0.1.0'
$script:Config = $null
$script:SelectedGroups = @()
$script:SelectedPackages = @()
$script:Failures = New-Object 'System.Collections.Generic.List[string]'
$script:RestartRequired = $false
$script:MarkerStart = '# >>> windows-dev-setup >>>'
$script:MarkerEnd = '# <<< windows-dev-setup <<<'

function Write-Section {
  param([string] $Title)

  Write-Host ''
  Write-Host $Title -ForegroundColor Cyan
  Write-Host ('-' * 64)
}

function Write-InfoLine {
  param([string] $Message)
  Write-Host "==> $Message"
}

function Write-Success {
  param([string] $Message)
  Write-Host "OK  $Message" -ForegroundColor Green
}

function Write-Skip {
  param([string] $Message)
  Write-Host "SKIP $Message" -ForegroundColor DarkGray
}

function Write-WarnLine {
  param([string] $Message)
  Write-Host "WARN $Message" -ForegroundColor Yellow
}

function Stop-Setup {
  param([string] $Message)
  throw [System.InvalidOperationException]::new($Message)
}

function Test-IsWindows {
  return $env:OS -eq 'Windows_NT'
}

function Test-IsAdministrator {
  if (-not (Test-IsWindows)) {
    return $false
  }

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
  )
}

function Resolve-CommandPath {
  param([Parameter(Mandatory = $true)][string] $Name)

  $resolved = Get-Command -Name $Name -CommandType Application `
    -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $resolved) {
    return $null
  }
  return $resolved.Source
}

function Format-NativeArgument {
  param([AllowEmptyString()][string] $Value)

  if ($Value -notmatch '[\s"]') {
    return $Value
  }
  return '"' + ($Value -replace '"', '\"') + '"'
}

function Write-NativePreview {
  param(
    [string] $FilePath,
    [string[]] $ArgumentList = @()
  )

  $displayArguments = @(
    $ArgumentList | ForEach-Object { Format-NativeArgument $_ }
  )
  Write-Host ('    $ ' + $FilePath + ' ' + ($displayArguments -join ' ')) `
    -ForegroundColor DarkGray
}

function Invoke-NativeCapture {
  param(
    [Parameter(Mandatory = $true)][string] $FilePath,
    [string[]] $ArgumentList = @()
  )

  $previousPreference = $ErrorActionPreference
  $global:LASTEXITCODE = 0
  try {
    # Windows PowerShell 5.1 can wrap native stderr as NativeCommandError.
    $ErrorActionPreference = 'Continue'
    $output = @(& $FilePath @ArgumentList 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }

  $lines = @($output | ForEach-Object { $_.ToString() })
  return [pscustomobject] @{
    ExitCode = $exitCode
    Lines = $lines
    Text = $lines -join [Environment]::NewLine
  }
}

function Invoke-NativeChecked {
  param(
    [Parameter(Mandatory = $true)][string] $FilePath,
    [string[]] $ArgumentList = @(),
    [string] $Description = $FilePath
  )

  Write-NativePreview -FilePath $FilePath -ArgumentList $ArgumentList
  if ($DryRun) {
    return
  }

  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    Stop-Setup "$Description failed with exit code $LASTEXITCODE."
  }
}

function Refresh-ProcessPath {
  if (-not (Test-IsWindows)) {
    return
  }

  $machinePath = [Environment]::GetEnvironmentVariable(
    'Path',
    [EnvironmentVariableTarget]::Machine
  )
  $userPath = [Environment]::GetEnvironmentVariable(
    'Path',
    [EnvironmentVariableTarget]::User
  )
  $userProfilePath = [Environment]::GetFolderPath('UserProfile')
  $extraPaths = @(
    (Join-Path $userProfilePath '.cargo\bin'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps')
  )

  $allPaths = @($machinePath, $userPath, $env:Path) + $extraPaths
  $seen = @{}
  $normalized = New-Object 'System.Collections.Generic.List[string]'
  foreach ($entry in ($allPaths -join ';') -split ';') {
    $trimmed = $entry.Trim()
    if (-not [string]::IsNullOrWhiteSpace($trimmed) -and
        -not $seen.ContainsKey($trimmed.ToLowerInvariant())) {
      $seen[$trimmed.ToLowerInvariant()] = $true
      $normalized.Add($trimmed)
    }
  }
  $env:Path = $normalized -join ';'
}

function Import-SetupConfig {
  if (-not (Test-Path -LiteralPath $ConfigFile -PathType Leaf)) {
    Stop-Setup "Configuration file not found: $ConfigFile"
  }

  $loaded = Import-PowerShellDataFile -LiteralPath $ConfigFile
  if ($loaded.SchemaVersion -ne 1) {
    Stop-Setup "Unsupported configuration schema: $($loaded.SchemaVersion)"
  }
  if (-not $loaded.Profiles.ContainsKey($Profile)) {
    Stop-Setup "Profile '$Profile' is not defined in $ConfigFile."
  }
  if ([string]::IsNullOrWhiteSpace($loaded.PythonVersion)) {
    Stop-Setup 'PythonVersion must be set in packages.psd1.'
  }

  foreach ($profileName in $loaded.Profiles.Keys) {
    foreach ($groupName in @($loaded.Profiles[$profileName])) {
      if (-not $loaded.Groups.ContainsKey($groupName)) {
        Stop-Setup "Profile '$profileName' refers to unknown group '$groupName'."
      }
    }
  }

  foreach ($groupName in $loaded.Groups.Keys) {
    foreach ($package in @($loaded.Groups[$groupName])) {
      if ([string]::IsNullOrWhiteSpace($package.Id) -or
          [string]::IsNullOrWhiteSpace($package.Name)) {
        Stop-Setup "Every package in group '$groupName' needs Id and Name."
      }
    }
  }

  $script:Config = $loaded
  $script:SelectedGroups = @($loaded.Profiles[$Profile])

  $seenPackages = @{}
  $selected = New-Object 'System.Collections.Generic.List[object]'
  foreach ($groupName in $script:SelectedGroups) {
    foreach ($package in @($loaded.Groups[$groupName])) {
      $key = $package.Id.ToLowerInvariant()
      if (-not $seenPackages.ContainsKey($key)) {
        $seenPackages[$key] = $true
        $selected.Add($package)
      }
    }
  }
  $script:SelectedPackages = @($selected)
}

function Show-Profiles {
  Write-Section "Windows dev setup $($script:ScriptVersion)"
  Write-Host 'Profiles:'
  foreach ($profileName in @('core', 'default', 'full')) {
    $groups = @($script:Config.Profiles[$profileName])
    $packageCount = 0
    foreach ($groupName in $groups) {
      $packageCount += @($script:Config.Groups[$groupName]).Count
    }
    Write-Host ('  {0,-8} {1,2} packages  [{2}]' -f
      $profileName, $packageCount, ($groups -join ', '))
  }

  Write-Host ''
  Write-Host 'Optional system changes:'
  Write-Host '  -IncludeWSL       Install WSL 2 with Ubuntu (admin/reboot possible)'
  Write-Host '  -EnableLongPaths  Enable Win32 long paths (admin required)'
}

function Show-Plan {
  Write-Section "Plan: $Profile profile"
  Write-Host "Config: $ConfigFile"
  Write-Host "Groups: $($script:SelectedGroups -join ', ')"
  if ($script:SelectedGroups -contains 'languages') {
    Write-Host "Python: exact CPython $($script:Config.PythonVersion)"
    Write-Host 'Java: Eclipse Temurin JDK 25 LTS (latest security update)'
    Write-Host 'Node: latest LTS through fnm'
  }
  Write-Host ''

  foreach ($groupName in $script:SelectedGroups) {
    Write-Host "[$groupName]" -ForegroundColor Cyan
    foreach ($package in @($script:Config.Groups[$groupName])) {
      Write-Host ('  {0,-37} {1}' -f $package.Id, $package.Name)
    }
  }

  Write-Host ''
  Write-Host 'Post-install configuration:'
  Write-Host (
    '  Git defaults and credential manager: ' +
    $(if ($NoGitConfig) { 'disabled' } else { 'enabled' })
  )
  Write-Host (
    '  PowerShell profile integration:       ' +
    $(if ($NoShellConfig) { 'disabled' } else { 'enabled' })
  )
  Write-Host "  Workspace directory:                  ~\$($script:Config.WorkspaceDirectory)"
  Write-Host (
    '  WSL 2 + Ubuntu:                       ' +
    $(if ($IncludeWSL) { 'enabled' } else { 'disabled' })
  )
  Write-Host (
    '  Win32 long paths:                     ' +
    $(if ($EnableLongPaths) { 'enabled' } else { 'disabled' })
  )

  if ($script:SelectedGroups -contains 'native') {
    Write-WarnLine (
      'The native toolchain includes Visual Studio C++ Build Tools and LLVM ' +
      'and can use several gigabytes of disk space.'
    )
  }
  if ($Profile -eq 'full') {
    Write-WarnLine (
      'The full profile also includes Docker Desktop, DevOps CLIs, and ' +
      'desktop apps.'
    )
  }
}

function Confirm-SetupPlan {
  if ($Yes -or $DryRun) {
    return $true
  }

  $reply = Read-Host 'Apply this plan? [y/N]'
  return $reply -match '^(?i:y|yes)$'
}

function Assert-WindowsHost {
  if (-not (Test-IsWindows)) {
    Stop-Setup 'The setup and doctor commands must run on Windows 10 or 11.'
  }

  $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
  if ($os.Caption -notmatch 'Windows 10|Windows 11') {
    Stop-Setup "Unsupported operating system: $($os.Caption)"
  }

  Write-Success "$($os.Caption), build $($os.BuildNumber), $env:PROCESSOR_ARCHITECTURE"
}

function Get-WingetPath {
  $winget = Resolve-CommandPath 'winget.exe'
  if ($null -eq $winget) {
    Stop-Setup (
      'WinGet is required. Install or update Microsoft App Installer from ' +
      'the Microsoft Store, open a new PowerShell window, and rerun setup.'
    )
  }
  return $winget
}

function Test-WingetPackageInstalled {
  param(
    [string] $WingetPath,
    [hashtable] $Package
  )

  $arguments = @(
    'list',
    '--id', $Package.Id,
    '--exact',
    '--accept-source-agreements',
    '--disable-interactivity'
  )
  if ($Package.ContainsKey('Source')) {
    $arguments += @('--source', $Package.Source)
  }

  $result = Invoke-NativeCapture -FilePath $WingetPath `
    -ArgumentList $arguments
  return $result.ExitCode -eq 0
}

function Install-WingetPackages {
  param([string] $WingetPath)

  Write-Section 'Installing WinGet packages'
  $position = 0
  foreach ($package in $script:SelectedPackages) {
    $position += 1
    Write-InfoLine "[$position/$($script:SelectedPackages.Count)] $($package.Name)"

    try {
      if (-not $DryRun -and
          (Test-WingetPackageInstalled -WingetPath $WingetPath `
            -Package $package)) {
        Write-Skip "$($package.Id) is already installed"
        continue
      }

      $arguments = @(
        'install',
        '--id', $package.Id,
        '--exact',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--disable-interactivity',
        '--silent'
      )
      if ($package.ContainsKey('Source')) {
        $arguments += @('--source', $package.Source)
      } else {
        $arguments += @('--source', 'winget')
      }
      if ($package.ContainsKey('Version')) {
        $arguments += @('--version', $package.Version)
      }
      if ($package.ContainsKey('WingetArguments')) {
        $arguments += @($package.WingetArguments)
      }

      Invoke-NativeChecked -FilePath $WingetPath -ArgumentList $arguments `
        -Description "Installing $($package.Name)"
      if (-not $DryRun) {
        Write-Success "$($package.Name) installed"
      }
    } catch {
      $message = "$($package.Name): $($_.Exception.Message)"
      $script:Failures.Add($message)
      Write-WarnLine $message
      if ($FailFast) {
        throw
      }
    }
  }
}

function Resolve-PythonManager {
  foreach ($candidate in @('py.exe', 'pymanager.exe')) {
    $path = Resolve-CommandPath $candidate
    if ($null -eq $path) {
      continue
    }
    $probe = Invoke-NativeCapture -FilePath $path `
      -ArgumentList @('help', 'install')
    if ($probe.ExitCode -eq 0) {
      return $path
    }
  }

  $windowsApps = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'
  $managerFamilies = @(
    'PythonSoftwareFoundation.PythonManager_3847v3x7pw1km',
    'PythonSoftwareFoundation.PythonManager_qbz5n2kfra8p0'
  )
  foreach ($family in $managerFamilies) {
    foreach ($executable in @('py.exe', 'pymanager.exe')) {
      $path = Join-Path (Join-Path $windowsApps $family) $executable
      if (Test-Path -LiteralPath $path -PathType Leaf) {
        return $path
      }
    }
  }
  return $null
}

function Install-PythonRuntime {
  $version = $script:Config.PythonVersion
  Write-Section "Configuring Python $version"

  if ($DryRun) {
    Write-NativePreview 'py' @('install', '--configure', '-y')
    Write-NativePreview 'py' @('install', '--dry-run', $version)
    return
  }

  $pythonManager = Resolve-PythonManager
  if ($null -eq $pythonManager) {
    Stop-Setup (
      'Python Install Manager was installed but is not visible yet. Open a ' +
      'new PowerShell window and rerun setup.'
    )
  }

  $existing = Invoke-NativeCapture -FilePath $pythonManager `
    -ArgumentList @("-V:$version", '--version')
  if ($existing.ExitCode -eq 0 -and
      $existing.Text -match [regex]::Escape($version)) {
    Write-Skip "Python $version is already installed"
    return
  }

  Invoke-NativeChecked -FilePath $pythonManager `
    -ArgumentList @('install', '--configure', '-y') `
    -Description 'Configuring Python Install Manager'
  Invoke-NativeChecked -FilePath $pythonManager `
    -ArgumentList @('install', $version) `
    -Description "Installing Python $version"
  Write-Success "Python $version installed"
}

function Install-NodeRuntime {
  Write-Section 'Configuring Node.js LTS'

  if ($DryRun) {
    Write-NativePreview 'fnm' @(
      'install', '--lts', '--use', '--corepack-enabled'
    )
    Write-NativePreview 'fnm' @('default', '<installed-lts-version>')
    return
  }

  $fnm = Resolve-CommandPath 'fnm.exe'
  if ($null -eq $fnm) {
    Stop-Setup (
      'fnm was installed but is not visible yet. Open a new PowerShell ' +
      'window and rerun setup.'
    )
  }

  $environment = Invoke-NativeCapture -FilePath $fnm `
    -ArgumentList @('env', '--shell', 'powershell')
  if ($environment.ExitCode -ne 0) {
    Stop-Setup 'fnm could not initialize the current PowerShell environment.'
  }
  Invoke-Expression $environment.Text

  Invoke-NativeChecked -FilePath $fnm -ArgumentList @(
    'install', '--lts', '--use', '--corepack-enabled'
  ) -Description 'Installing Node.js LTS'

  $current = Invoke-NativeCapture -FilePath $fnm -ArgumentList @('current')
  $nodeVersion = $current.Text.Trim()
  if ($current.ExitCode -ne 0 -or
      [string]::IsNullOrWhiteSpace($nodeVersion) -or
      $nodeVersion -match '^(none|system)$') {
    Stop-Setup 'fnm installed Node.js but did not report an active version.'
  }

  Invoke-NativeChecked -FilePath $fnm `
    -ArgumentList @('default', $nodeVersion) `
    -Description 'Setting the default Node.js version'
  Write-Success "Node.js $nodeVersion is the default; Corepack is enabled"
}

function Install-RustToolchain {
  Write-Section 'Configuring Rust stable'

  if ($DryRun) {
    Write-NativePreview 'rustup' @(
      'toolchain', 'install', 'stable', '--profile', 'default'
    )
    Write-NativePreview 'rustup' @('default', 'stable')
    Write-NativePreview 'rustup' @(
      'component', 'add', 'rustfmt', 'clippy', '--toolchain', 'stable'
    )
    return
  }

  $rustup = Resolve-CommandPath 'rustup.exe'
  if ($null -eq $rustup) {
    Stop-Setup (
      'rustup was installed but is not visible yet. Open a new PowerShell ' +
      'window and rerun setup.'
    )
  }

  Invoke-NativeChecked -FilePath $rustup -ArgumentList @(
    'toolchain', 'install', 'stable', '--profile', 'default'
  ) -Description 'Installing the Rust stable toolchain'
  Invoke-NativeChecked -FilePath $rustup `
    -ArgumentList @('default', 'stable') `
    -Description 'Selecting the Rust stable toolchain'
  Invoke-NativeChecked -FilePath $rustup -ArgumentList @(
    'component', 'add', 'rustfmt', 'clippy', '--toolchain', 'stable'
  ) -Description 'Installing Rust developer components'
  Write-Success 'Rust stable, rustfmt, and clippy are configured'
}

function Set-GitDefaults {
  if ($NoGitConfig) {
    Write-Skip 'Git configuration disabled by -NoGitConfig'
    return
  }

  Write-Section 'Configuring Git defaults'
  if ($DryRun) {
    Write-Host '    init.defaultBranch=main, pull.ff=only, fetch.prune=true'
    Write-Host '    core.autocrlf=input, core.longpaths=true, delta pager'
    return
  }

  $git = Resolve-CommandPath 'git.exe'
  if ($null -eq $git) {
    Stop-Setup 'Git was installed but is not visible in the current session.'
  }

  $settings = New-Object 'System.Collections.Generic.List[object]'
  foreach ($entry in @(
      @{ Name = 'init.defaultBranch'; Value = 'main' },
      @{ Name = 'pull.ff'; Value = 'only' },
      @{ Name = 'fetch.prune'; Value = 'true' },
      @{ Name = 'rebase.autoStash'; Value = 'true' },
      @{ Name = 'core.autocrlf'; Value = 'input' },
      @{ Name = 'core.longpaths'; Value = 'true' },
      @{ Name = 'credential.helper'; Value = 'manager' },
      @{ Name = 'diff.algorithm'; Value = 'histogram' },
      @{ Name = 'merge.conflictStyle'; Value = 'zdiff3' }
    )) {
    $settings.Add($entry)
  }

  if ($null -ne (Resolve-CommandPath 'delta.exe')) {
    foreach ($entry in @(
        @{ Name = 'core.pager'; Value = 'delta' },
        @{ Name = 'interactive.diffFilter'; Value = 'delta --color-only' },
        @{ Name = 'delta.navigate'; Value = 'true' },
        @{ Name = 'delta.side-by-side'; Value = 'true' },
        @{ Name = 'delta.line-numbers'; Value = 'true' }
      )) {
      $settings.Add($entry)
    }
  } else {
    Write-WarnLine 'delta is unavailable; Git pager settings were not changed.'
  }

  foreach ($setting in $settings) {
    Invoke-NativeChecked -FilePath $git `
      -ArgumentList @(
        'config', '--global', $setting.Name, $setting.Value
      ) `
      -Description "Setting Git $($setting.Name)"
  }
  Write-Success 'Git defaults configured (name and email were not changed)'
}

function Set-ManagedProfileBlock {
  param(
    [string] $Path,
    [string] $Block
  )

  $directory = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }

  $existing = ''
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    $existing = Get-Content -LiteralPath $Path -Raw
  }

  $pattern = '(?ms)^' + [regex]::Escape($script:MarkerStart) +
    '.*?^' + [regex]::Escape($script:MarkerEnd) + '\s*'
  $unmanaged = [regex]::Replace($existing, $pattern, '').TrimEnd()
  $updated = if ([string]::IsNullOrWhiteSpace($unmanaged)) {
    $Block.Trim() + [Environment]::NewLine
  } else {
    $unmanaged + [Environment]::NewLine + [Environment]::NewLine +
      $Block.Trim() + [Environment]::NewLine
  }

  if ($updated -eq $existing) {
    Write-Skip "$Path is already current"
    return
  }

  $backup = "$Path.windows-dev-setup.bak"
  if ((Test-Path -LiteralPath $Path -PathType Leaf) -and
      -not (Test-Path -LiteralPath $backup)) {
    Copy-Item -LiteralPath $Path -Destination $backup
  }
  Set-Content -LiteralPath $Path -Value $updated -Encoding UTF8
  Write-Success "Updated $Path"
}

function Set-PowerShellProfiles {
  if ($NoShellConfig) {
    Write-Skip 'PowerShell profile configuration disabled by -NoShellConfig'
    return
  }

  Write-Section 'Configuring PowerShell profiles'
  $profileBlock = @'
# >>> windows-dev-setup >>>
$env:EDITOR = 'code --wait'
$env:VISUAL = 'code --wait'
$env:GIT_EDITOR = 'code --wait'

if (Get-Command fnm -ErrorAction SilentlyContinue) {
  fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
}
if (Get-Command zoxide -ErrorAction SilentlyContinue) {
  Invoke-Expression (& { (zoxide init powershell | Out-String) })
}
if (Get-Command starship -ErrorAction SilentlyContinue) {
  Invoke-Expression (&starship init powershell)
}
if ($PSVersionTable.PSVersion.Major -ge 7 -and
    (Get-Module -ListAvailable PSReadLine)) {
  Set-PSReadLineOption -PredictionSource History -ErrorAction SilentlyContinue
  Set-PSReadLineOption -PredictionViewStyle ListView -ErrorAction SilentlyContinue
}

function global:ll { eza --long --all --group-directories-first @args }
function global:lt { eza --tree --level=2 --group-directories-first @args }
# <<< windows-dev-setup <<<
'@

  $documents = [Environment]::GetFolderPath('MyDocuments')
  $profilePaths = @(
    (Join-Path $documents 'WindowsPowerShell\profile.ps1'),
    (Join-Path $documents 'PowerShell\profile.ps1')
  )

  if ($DryRun) {
    foreach ($path in $profilePaths) {
      Write-Host "    Would update managed block in $path"
    }
    return
  }

  foreach ($path in $profilePaths) {
    Set-ManagedProfileBlock -Path $path -Block $profileBlock
  }
}

function Initialize-Workspace {
  $userProfilePath = [Environment]::GetFolderPath('UserProfile')
  $workspace = Join-Path $userProfilePath $script:Config.WorkspaceDirectory

  Write-Section 'Creating workspace'
  if ($DryRun) {
    Write-Host "    Would create $workspace"
    return
  }
  New-Item -ItemType Directory -Path $workspace -Force | Out-Null
  Write-Success "Workspace ready: $workspace"
}

function Enable-WindowsLongPaths {
  if (-not $EnableLongPaths) {
    return
  }

  Write-Section 'Enabling Win32 long paths'
  if ($DryRun) {
    Write-Host (
      '    Would set HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem\' +
      'LongPathsEnabled to 1'
    )
    return
  }
  New-ItemProperty `
    -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' `
    -Name 'LongPathsEnabled' -PropertyType DWord -Value 1 -Force |
    Out-Null
  Write-Success 'Win32 long paths enabled'
}

function Install-WSL {
  if (-not $IncludeWSL) {
    return
  }

  Write-Section 'Installing WSL 2 and Ubuntu'
  if ($DryRun) {
    Write-NativePreview 'wsl.exe' @('--install', '-d', 'Ubuntu')
    return
  }

  $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
  if ([int] $os.BuildNumber -lt 19041) {
    Stop-Setup 'WSL setup requires Windows build 19041 or newer.'
  }

  $wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
  $listed = Invoke-NativeCapture -FilePath $wsl `
    -ArgumentList @('--list', '--quiet')
  if ($listed.ExitCode -eq 0 -and $listed.Text -match '(?im)^Ubuntu') {
    Write-Skip 'Ubuntu is already registered in WSL'
    return
  }

  Invoke-NativeChecked -FilePath $wsl `
    -ArgumentList @('--install', '-d', 'Ubuntu') `
    -Description 'Installing WSL and Ubuntu'
  $script:RestartRequired = $true
  Write-Success 'WSL installation requested'
}

function Add-PostInstallFailure {
  param(
    [string] $Name,
    [scriptblock] $Action
  )

  try {
    & $Action
  } catch {
    $message = "${Name}: $($_.Exception.Message)"
    $script:Failures.Add($message)
    Write-WarnLine $message
    if ($FailFast) {
      throw
    }
  }
}

function Get-CommandVersion {
  param(
    [string] $Name,
    [string[]] $Arguments = @('--version')
  )

  $path = if (Test-Path -LiteralPath $Name -PathType Leaf) {
    $Name
  } else {
    Resolve-CommandPath $Name
  }
  if ($null -eq $path) {
    return $null
  }
  $result = Invoke-NativeCapture -FilePath $path -ArgumentList $Arguments
  if ($result.ExitCode -ne 0) {
    return $null
  }
  $firstLine = $result.Lines | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_)
  } | Select-Object -First 1
  if ($null -eq $firstLine) {
    return 'available'
  }
  return $firstLine
}

function Get-VisualStudioCppToolsPath {
  $programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
  if ([string]::IsNullOrWhiteSpace($programFilesX86)) {
    return $null
  }

  $vswhere = Join-Path $programFilesX86 `
    'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    return $null
  }

  $result = Invoke-NativeCapture -FilePath $vswhere -ArgumentList @(
    '-latest',
    '-products', '*',
    '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath'
  )
  if ($result.ExitCode -ne 0 -or
      [string]::IsNullOrWhiteSpace($result.Text)) {
    return $null
  }
  return $result.Text.Trim()
}

function Invoke-Doctor {
  param([string] $WingetPath)

  Write-Section "Doctor: $Profile profile"
  $wingetVersion = Get-CommandVersion -Name $WingetPath -Arguments @('--version')
  Write-Success "WinGet $wingetVersion"

  $checks = New-Object 'System.Collections.Generic.List[object]'
  foreach ($package in $script:SelectedPackages) {
    if ($package.ContainsKey('Command') -and
        $package.Id -ne '9NQ7512CXL7T') {
      $checks.Add([pscustomobject] @{
        Name = $package.Name
        Command = $package.Command
        Arguments = if ($package.ContainsKey('VersionArguments')) {
          @($package.VersionArguments)
        } else {
          @('--version')
        }
      })
    }
  }

  if ($script:SelectedGroups -contains 'languages') {
    $fnm = Resolve-CommandPath 'fnm.exe'
    if ($null -ne $fnm) {
      $environment = Invoke-NativeCapture -FilePath $fnm `
        -ArgumentList @('env', '--shell', 'powershell')
      if ($environment.ExitCode -eq 0) {
        Invoke-Expression $environment.Text
      }
    }
    $checks.Add([pscustomobject] @{
      Name = 'Node.js LTS runtime'
      Command = 'node'
      Arguments = @('--version')
    })
    $checks.Add([pscustomobject] @{
      Name = 'Rust stable compiler'
      Command = 'rustc'
      Arguments = @('--version')
    })
  }

  foreach ($check in $checks) {
    $version = Get-CommandVersion -Name $check.Command `
      -Arguments $check.Arguments
    if ($null -eq $version) {
      $script:Failures.Add("$($check.Name): command not found")
      Write-WarnLine "$($check.Name): command '$($check.Command)' not found"
    } else {
      Write-Success ('{0,-30} {1}' -f $check.Name, $version)
    }
  }

  if ($script:SelectedGroups -contains 'native') {
    $cppTools = Get-VisualStudioCppToolsPath
    if ($null -eq $cppTools) {
      $script:Failures.Add('Visual Studio C++ workload: not found')
      Write-WarnLine 'Visual Studio C++ workload was not found'
    } else {
      Write-Success "Visual Studio C++ tools        $cppTools"
    }
  }

  if ($script:SelectedGroups -contains 'languages') {
    $manager = Resolve-PythonManager
    if ($null -eq $manager) {
      $script:Failures.Add('Python Install Manager: command not found')
      Write-WarnLine 'Python Install Manager command not found'
    } else {
      $version = $script:Config.PythonVersion
      $result = Invoke-NativeCapture -FilePath $manager `
        -ArgumentList @("-V:$version", '--version')
      if ($result.ExitCode -eq 0 -and $result.Text -match $version) {
        Write-Success "Python                         $($result.Text.Trim())"
      } else {
        $script:Failures.Add("Python ${version}: exact runtime not found")
        Write-WarnLine "Exact Python $version runtime not found"
      }
    }
  }
}

function Show-Summary {
  Write-Section 'Summary'
  if ($script:Failures.Count -eq 0) {
    if ($DryRun) {
      Write-Success 'Dry run completed; no changes were made'
    } else {
      Write-Success 'Development workstation setup completed'
    }
  } else {
    Write-WarnLine "$($script:Failures.Count) item(s) need attention:"
    foreach ($failure in $script:Failures) {
      Write-Host "  - $failure"
    }
  }

  if ($script:RestartRequired) {
    Write-WarnLine 'Restart Windows, launch Ubuntu once, then rerun doctor.'
  } elseif (-not $DryRun -and $Command -eq 'setup') {
    Write-Host 'Open a new PowerShell 7 terminal, then run:'
    Write-Host "  .\setup.ps1 doctor -Profile $Profile"
  }
}

try {
  Import-SetupConfig

  switch ($Command) {
    'list' {
      Show-Profiles
      exit 0
    }
    'plan' {
      Show-Plan
      exit 0
    }
    'doctor' {
      Assert-WindowsHost
      Refresh-ProcessPath
      $winget = Get-WingetPath
      Invoke-Doctor -WingetPath $winget
      Show-Summary
      if ($script:Failures.Count -gt 0) {
        exit 1
      }
      exit 0
    }
    'setup' {
      Assert-WindowsHost
      if (($IncludeWSL -or $EnableLongPaths) -and
          -not $DryRun -and -not (Test-IsAdministrator)) {
        Stop-Setup (
          '-IncludeWSL and -EnableLongPaths require an Administrator ' +
          'PowerShell window.'
        )
      }

      $winget = Get-WingetPath
      Show-Plan
      if (-not (Confirm-SetupPlan)) {
        Write-WarnLine 'Setup cancelled; no changes were made.'
        exit 0
      }

      Install-WingetPackages -WingetPath $winget
      Refresh-ProcessPath

      if ($script:SelectedGroups -contains 'languages') {
        Add-PostInstallFailure 'Python runtime' { Install-PythonRuntime }
        Add-PostInstallFailure 'Node.js runtime' { Install-NodeRuntime }
        Add-PostInstallFailure 'Rust toolchain' { Install-RustToolchain }
      }

      Add-PostInstallFailure 'Workspace' { Initialize-Workspace }
      Add-PostInstallFailure 'Git defaults' { Set-GitDefaults }
      Add-PostInstallFailure 'PowerShell profiles' { Set-PowerShellProfiles }
      Add-PostInstallFailure 'Win32 long paths' {
        Enable-WindowsLongPaths
      }
      Add-PostInstallFailure 'WSL' { Install-WSL }

      Show-Summary
      if ($script:Failures.Count -gt 0) {
        exit 1
      }
      exit 0
    }
  }
} catch {
  Write-Host ''
  Write-Host "ERROR $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
