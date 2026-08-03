# sbx-manager.ps1
# Install, configure, inspect, and launch Docker Sandboxes (sbx) on Windows.
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
$script:ScriptDir = Split-Path -Parent $PSCommandPath
$script:ScriptVersion = '1.3.0'
$script:CatalogDate = '2026-08-04'
$script:AssumeYes = $false
$script:SkipLogin = $false
$script:RestartRequired = $false
$script:TemporaryDirectories = [Collections.Generic.List[string]]::new()
$script:ManagedEnvironmentNames = @(
  'DOCKER_SANDBOXES_PROXY',
  'DOCKER_SANDBOXES_NO_PROXY',
  'DOCKER_SANDBOXES_ROOT_SIZE',
  'DOCKER_SANDBOXES_DOCKER_SIZE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY'
)
$script:OriginalEnvironment = @{}
foreach ($name in $script:ManagedEnvironmentNames) {
  $script:OriginalEnvironment[$name] = [Environment]::GetEnvironmentVariable(
    $name,
    [EnvironmentVariableTarget]::Process
  )
}

$localAppData = $env:LOCALAPPDATA
if ([string]::IsNullOrWhiteSpace($localAppData)) {
  $localAppData = Join-Path $HOME 'AppData\Local'
}
$script:ConfigDir = Join-Path $localAppData 'sbx-manager'
$script:DaemonConfigFile = Join-Path $script:ConfigDir 'daemon.json'

$script:DocsRoot = 'https://docs.docker.com/ai/sandboxes/'
$script:TemplateRepo = 'docker.io/docker/sandbox-templates'
$script:HubTagsApi = 'https://hub.docker.com/v2/namespaces/docker/repositories/sandbox-templates/tags?page_size=100'
$script:DefaultShellKit = if ($env:SBX_MANAGER_SHELL_KIT) {
  $env:SBX_MANAGER_SHELL_KIT
} else {
  Join-Path $script:ScriptDir 'kits\zsh-shell'
}

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

function Stop-Manager {
  param([string] $Message)
  throw [System.InvalidOperationException]::new($Message)
}

function Write-Section {
  param([string] $Title)
  Write-Line
  Write-Line "$($script:ColorBold)$Title$($script:ColorReset)"
  Write-Line '------------------------------------------------------------'
}

function Test-Command {
  param([string] $Name)
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
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
$($script:ColorBold)sbx-manager $($script:ScriptVersion)$($script:ColorReset)
Install, configure, inspect, and launch Docker Sandboxes on Windows.

$($script:ColorBold)Usage$($script:ColorReset)
  .\$($script:ScriptName) [global options] <command> [arguments]

$($script:ColorBold)Global options$($script:ColorReset)
  -y, --yes                  Accept prerequisite and destructive-policy prompts.
      --skip-login           Do not run Docker OAuth login during setup.
  -h, --help                 Show this help.
      --version              Show the manager version.

$($script:ColorBold)Main commands$($script:ColorReset)
  install                    Check Windows and install sbx; skip policy/login.
  setup [open|balanced|locked]
                             Recommended first command: install if needed,
                             sign in, set policy, and show info.
  login                      Sign in to Docker using sbx OAuth.
  info                       Show host, daemon, policy, sandbox, and cache info.
  doctor                     Run Windows checks plus 'sbx diagnose'.
  templates [--remote]       Print supported templates and launch commands.
                             --remote also queries every published Hub tag.

$($script:ColorBold)Network commands$($script:ColorReset)
  network set <mode>         Reset local policy to open, balanced, or locked.
  network allow <resources>  Add an allow rule, e.g. '**' or github.com.
  network deny <resources>   Add a deny rule.
  network check <target>     Evaluate a URL, host, host:port, or IP.
  network status             Show active/inactive policy rules and checks.
  network logs               Show recent policy decisions.
  network proxy <URL>        Save an upstream proxy and restart sandboxd.
  network proxy off          Remove the manager's saved proxy setting.

$($script:ColorBold)Daemon commands$($script:ColorReset)
  daemon start|stop|restart|status

$($script:ColorBold)Run helper$($script:ColorReset)
  run <agent> [workspace] [options] [-- agent arguments]

  Agents: claude, codex, copilot, cursor, docker-agent, droid,
          gemini, kiro, opencode, shell

  Options:
    --name NAME              Set a persistent sandbox name.
    --clone                  Use a private clone of a Git repository.
    --no-docker              Use the lighter template without nested dockerd.
    --minimal                Use Claude's minimal template (Claude only).
    -t, --template IMAGE     Use an explicit template image.
    -d, --detached           Create/start without attaching.
    --root-size SIZE         Set sandbox root filesystem size, e.g. 40g.
    --docker-size SIZE       Set internal Docker volume size, e.g. 10g.
    --no-shell-kit           Do not install or refresh the default zsh shell kit.

  PowerShell consumes an unquoted -- token. Quote the separator when passing
  agent arguments: '--' --resume session-123

$($script:ColorBold)Examples$($script:ColorReset)
  .\$($script:ScriptName) setup balanced
  .\$($script:ScriptName) templates --remote
  .\$($script:ScriptName) run shell C:\src\app --name app-shell
  .\$($script:ScriptName) run claude C:\src\app --name app-claude --clone
  .\$($script:ScriptName) run codex . --name app-codex --no-docker
  .\$($script:ScriptName) network allow '**'
  .\$($script:ScriptName) network check https://api.minimax.io

Official documentation: $($script:DocsRoot)
"@
}

function Show-FirstRunHint {
  Write-Section 'First-time setup'
  Write-Line 'Docker sbx is not installed yet.'
  Write-Line 'Start with the recommended setup command:'
  Write-Line "  .\$($script:ScriptName) setup balanced"
  Write-Line
  Write-Line (
    'This installs sbx, configures a balanced network policy, and signs in ' +
    'to Docker.'
  )
  Write-Line (
    "Use '.\$($script:ScriptName) install' only to install sbx without " +
    'completing setup.'
  )
}

function Invoke-NativeCapture {
  param(
    [Parameter(Mandatory = $true)][string] $FilePath,
    [string[]] $ArgumentList = @()
  )

  $previousPreference = $ErrorActionPreference
  try {
    # Windows PowerShell 5.1 promotes native stderr to NativeCommandError.
    # sbx writes informational messages there while starting a stopped
    # sandbox, so capture them and use the process exit code as the authority.
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = 0
    $output = @(& $FilePath @ArgumentList 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  $lines = @($output | ForEach-Object { $_.ToString() })
  return [pscustomobject] @{
    ExitCode = $exitCode
    Output = $lines
    Text = $lines -join [Environment]::NewLine
  }
}

function Get-SbxCommand {
  $command = Get-Command 'sbx' -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    Stop-Manager (
      'sbx is not installed. Run the first-time setup: ' +
      ".\$($script:ScriptName) setup balanced"
    )
  }
  return $command.Source
}

function Invoke-Sbx {
  param([string[]] $ArgumentList = @())

  $sbx = Get-SbxCommand
  $global:LASTEXITCODE = 0
  & $sbx @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    Stop-Manager "sbx command failed with exit code $LASTEXITCODE."
  }
}

function Invoke-SbxBestEffort {
  param([string[]] $ArgumentList = @())

  $sbx = Get-SbxCommand
  & $sbx @ArgumentList
}

function Invoke-SbxCapture {
  param([string[]] $ArgumentList = @())
  return Invoke-NativeCapture -FilePath (Get-SbxCommand) -ArgumentList $ArgumentList
}

function Test-TransientKitAddFailure {
  param([string] $Text)

  return $Text -match (
    '(?i)(curl:\s*\((5|6|7|18|28|35|52|55|56|92)\)|' +
    'TLS[^\r\n]*error|unexpected eof|connection (reset|refused)|' +
    'timed out|temporary failure|could not resolve (host|proxy))'
  )
}

function Get-KitAddFailureSummary {
  param(
    [string] $Text,
    [int] $ExitCode
  )

  $curlMatches = [regex]::Matches(
    $Text,
    '(?im)curl:\s*\((?<Code>\d+)\)\s*(?<Detail>[^\r\n]*)'
  )
  if ($curlMatches.Count -gt 0) {
    $failure = $curlMatches[$curlMatches.Count - 1]
    $curlCode = [int] $failure.Groups['Code'].Value
    $detail = $failure.Groups['Detail'].Value
    $description = switch ($curlCode) {
      5 { 'proxy name resolution failed' }
      6 { 'host name resolution failed' }
      7 { 'connection failed' }
      18 { 'download ended before all data was received' }
      28 { 'download timed out' }
      35 {
        if ($detail -match '(?i)unexpected eof') {
          'TLS connection ended unexpectedly'
        } else {
          'TLS connection failed'
        }
      }
      52 { 'server returned an empty response' }
      55 { 'network send failed' }
      56 { 'network receive failed' }
      92 { 'HTTP/2 stream failed' }
      default { 'download failed' }
    }
    return "Shell-kit download failed: curl exit $curlCode ($description)."
  }

  $installExit = [regex]::Match(
    $Text,
    '(?im)commands\.install\[\d+\][^\r\n]*exited\s+(?<Code>\d+)'
  )
  if ($installExit.Success) {
    return (
      'A shell-kit install command failed with exit code ' +
      "$($installExit.Groups['Code'].Value)."
    )
  }
  return "sbx kit add failed with exit code $ExitCode."
}

function Add-KitAddDiagnostic {
  param(
    [AllowEmptyString()][string] $Path,
    [string] $SandboxName,
    [int] $Attempt,
    [int] $ExitCode,
    [string] $Text
  )

  try {
    if (-not $Path) {
      $logDirectory = Join-Path $script:ConfigDir 'logs'
      New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
      $safeName = $SandboxName.ToLowerInvariant() -replace '[^a-z0-9._-]+', '-'
      $safeName = $safeName.Trim('-')
      if (-not $safeName) {
        $safeName = 'sandbox'
      }
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      $suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
      $Path = Join-Path $logDirectory (
        "kit-add-$safeName-$stamp-$suffix.log"
      )
    }

    $entry = @(
      "Attempt: $Attempt",
      "Sandbox: $SandboxName",
      "Exit code: $ExitCode",
      '------------------------------------------------------------',
      $Text,
      '',
      ''
    ) -join [Environment]::NewLine
    [IO.File]::AppendAllText(
      $Path,
      $entry,
      [Text.UTF8Encoding]::new($false)
    )
    return $Path
  } catch {
    Write-WarnLine "Could not save full kit-add diagnostics: $($_.Exception.Message)"
    return ''
  }
}

function Invoke-SbxKitAddWithRetry {
  param(
    [string] $SandboxName,
    [string] $KitPath
  )

  $sbx = Get-SbxCommand
  $maximumAttempts = 3
  $diagnosticPath = ''
  for ($attempt = 1; $attempt -le $maximumAttempts; $attempt++) {
    Write-InfoLine (
      "Applying shell-kit install steps to '$SandboxName' " +
      "(attempt $attempt/$maximumAttempts)..."
    )
    $result = Invoke-NativeCapture -FilePath $sbx -ArgumentList @(
      'kit', 'add', $SandboxName, $KitPath
    )
    if ($result.ExitCode -eq 0) {
      Write-Success "Shell-kit install steps applied to '$SandboxName'."
      return
    }

    $summary = Get-KitAddFailureSummary `
      -Text $result.Text -ExitCode $result.ExitCode
    $diagnosticPath = Add-KitAddDiagnostic `
      -Path $diagnosticPath `
      -SandboxName $SandboxName `
      -Attempt $attempt `
      -ExitCode $result.ExitCode `
      -Text $result.Text
    Write-WarnLine $summary
    if ($diagnosticPath) {
      Write-Line "Full diagnostic output: $diagnosticPath"
    }

    if ($attempt -ge $maximumAttempts -or
        -not (Test-TransientKitAddFailure $result.Text)) {
      Stop-Manager "Could not apply shell-kit install steps to '$SandboxName'."
    }

    $nextAttempt = $attempt + 1
    Write-WarnLine (
      "The failure appears transient; retrying kit add " +
      "($nextAttempt/$maximumAttempts)."
    )
    if ($env:SBX_MANAGER_TEST_MODE -ne '1') {
      Start-Sleep -Seconds (2 * $attempt)
    }
  }
}

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
  )
}

function Get-WindowsInfo {
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
      ProductType = [int] $os.ProductType
    }
  } catch {
    $version = [Environment]::OSVersion.Version
    $caption = 'Microsoft Windows'
    $productType = 0
    try {
      $currentVersion = Get-ItemProperty -LiteralPath (
        'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
      ) -ErrorAction Stop
      if ($currentVersion.ProductName) {
        $caption = [string] $currentVersion.ProductName
      }
      if ($currentVersion.InstallationType -eq 'Client') {
        $productType = 1
      }
    } catch {
      # Environment.OSVersion still provides the build needed for validation.
    }
  }
  if ($version.Build -ge 22000 -and $caption -match 'Windows 10') {
    $caption = $caption -replace 'Windows 10', 'Windows 11'
  }
  return [pscustomobject] @{
    Caption = $caption
    Version = $version.ToString()
    Build = [int] $version.Build
    Architecture = $arch
    ProductType = $productType
  }
}

function Get-HypervisorPlatformState {
  try {
    $feature = Get-CimInstance -ClassName Win32_OptionalFeature `
      -Filter "Name='HypervisorPlatform'" -ErrorAction Stop
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
        -FeatureName HypervisorPlatform -ErrorAction Stop
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

function Test-RebootPending {
  $paths = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
  )
  foreach ($path in $paths) {
    try {
      if (Test-Path -LiteralPath $path -ErrorAction Stop) {
        return $true
      }
    } catch {
      # A restricted process may be unable to inspect system servicing keys.
    }
  }
  return $false
}

function Test-WindowsPrerequisites {
  param([switch] $AllowEnable)

  if ($env:SBX_MANAGER_TEST_MODE -eq '1' -and $env:SBX_TEST_LOG) {
    Write-Success 'Using the simulated Windows host for manager tests.'
    return
  }

  $windows = Get-WindowsInfo
  Write-Line "Detected: $($windows.Caption) $($windows.Version) ($($windows.Architecture))"

  if ($windows.Build -lt 22000) {
    Stop-Manager (
      "Docker Sandboxes requires Windows 11 (build 22000 or newer); " +
      "detected build $($windows.Build)."
    )
  }
  if ($windows.ProductType -gt 1) {
    Stop-Manager (
      'Docker Sandboxes supports the Windows 11 client OS; Windows Server is ' +
      "not supported. Detected: $($windows.Caption)"
    )
  }
  if ($windows.Architecture -notin @('AMD64', 'x86_64')) {
    Stop-Manager (
      "Docker Sandboxes for Windows requires a 64-bit Intel or AMD host; " +
      "detected architecture: $($windows.Architecture)"
    )
  }
  Write-Success 'Windows 11 x86_64 prerequisite check passed.'

  $featureState = Get-HypervisorPlatformState
  if ($featureState -eq 'Enabled') {
    Write-Success 'Windows Hypervisor Platform is enabled.'
    if (Test-RebootPending) {
      Write-WarnLine 'Windows reports a pending reboot; restart before launching a sandbox if sbx cannot start.'
    }
    return
  }

  if ($featureState -eq 'Unknown') {
    Write-WarnLine 'Could not determine the Windows Hypervisor Platform state.'
    Write-Line 'Check it from an elevated PowerShell prompt:'
    Write-Line '  Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform'
    return
  }

  if (-not $AllowEnable) {
    Write-WarnLine "Windows Hypervisor Platform is $($featureState.ToLowerInvariant())."
    Write-Line 'Enable it from an elevated PowerShell prompt:'
    Write-Line '  Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All'
    return
  }

  if (-not (Test-IsAdministrator)) {
    Stop-Manager (
      'Windows Hypervisor Platform is not enabled. Open PowerShell as ' +
      "Administrator and rerun: .\$($script:ScriptName) install"
    )
  }
  if (-not (Confirm-Action 'Enable Windows Hypervisor Platform? A reboot may be required.')) {
    Stop-Manager 'Windows Hypervisor Platform is required; setup was cancelled.'
  }

  Write-InfoLine 'Enabling Windows Hypervisor Platform...'
  $result = Enable-WindowsOptionalFeature -Online `
    -FeatureName HypervisorPlatform -All -NoRestart
  Write-Success 'Windows Hypervisor Platform was enabled.'
  if ($result.RestartNeeded) {
    $script:RestartRequired = $true
    Write-WarnLine 'Restart Windows before launching a sandbox.'
  }
}

function Update-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($machinePath, $userPath, $env:Path) |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  $env:Path = $parts -join ';'
}

function Install-Sbx {
  Test-WindowsPrerequisites -AllowEnable

  if (Test-Command 'sbx') {
    $command = Get-Command 'sbx'
    Write-Success "sbx is already installed at $($command.Source)."
    Invoke-SbxBestEffort @('version')
    return
  }

  if (-not (Test-Command 'winget')) {
    Stop-Manager (
      'WinGet is required for the supported Windows installation. Install ' +
      'App Installer from Microsoft Store, then rerun this command.'
    )
  }

  Write-InfoLine 'Installing Docker sbx with WinGet...'
  $winget = (Get-Command 'winget').Source
  $result = Invoke-NativeCapture -FilePath $winget -ArgumentList @(
    'install',
    '--id', 'Docker.sbx',
    '--exact',
    '--silent',
    '--accept-package-agreements',
    '--accept-source-agreements'
  )
  $result.Output | ForEach-Object { Write-Line $_ }
  if ($result.ExitCode -ne 0) {
    Stop-Manager "WinGet could not install Docker.sbx (exit $($result.ExitCode))."
  }

  Update-ProcessPath
  if (-not (Test-Command 'sbx')) {
    Stop-Manager (
      'WinGet completed, but sbx is not visible in this process. Open a new ' +
      'PowerShell window and rerun the manager.'
    )
  }
  Write-Success "Installed $((Invoke-SbxCapture @('version')).Text)."
}

function Get-SavedDaemonConfig {
  if (-not (Test-Path -LiteralPath $script:DaemonConfigFile -PathType Leaf)) {
    return $null
  }
  try {
    return Get-Content -LiteralPath $script:DaemonConfigFile -Raw |
      ConvertFrom-Json
  } catch {
    Stop-Manager "Could not read $($script:DaemonConfigFile): $($_.Exception.Message)"
  }
}

function Load-DaemonEnvironment {
  $config = Get-SavedDaemonConfig
  if ($null -eq $config) {
    return
  }

  $properties = @($config.PSObject.Properties.Name)
  if ($properties -contains 'Proxy') {
    $env:DOCKER_SANDBOXES_PROXY = [string] $config.Proxy
    $env:HTTP_PROXY = [string] $config.Proxy
    $env:HTTPS_PROXY = [string] $config.Proxy
  }
  if ($properties -contains 'NoProxy') {
    $env:DOCKER_SANDBOXES_NO_PROXY = [string] $config.NoProxy
    $env:NO_PROXY = [string] $config.NoProxy
  }
}

function Restore-ManagerEnvironment {
  foreach ($directory in @($script:TemporaryDirectories)) {
    try {
      if (Test-Path -LiteralPath $directory) {
        Remove-Item -LiteralPath $directory -Recurse -Force
      }
    } catch {
      Write-WarnLine (
        "Could not remove temporary shell kit '$directory': " +
        $_.Exception.Message
      )
    }
  }
  $script:TemporaryDirectories.Clear()

  foreach ($name in $script:ManagedEnvironmentNames) {
    [Environment]::SetEnvironmentVariable(
      $name,
      $script:OriginalEnvironment[$name],
      [EnvironmentVariableTarget]::Process
    )
  }
}

function Protect-ConfigFile {
  param([string] $Path)

  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) {
      [void] $acl.RemoveAccessRuleAll($rule)
    }

    $inheritance = [Security.AccessControl.InheritanceFlags]::None
    $propagation = [Security.AccessControl.PropagationFlags]::None
    $type = [Security.AccessControl.AccessControlType]::Allow
    $userRule = [Security.AccessControl.FileSystemAccessRule]::new(
      $identity.User,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      $propagation,
      $type
    )
    $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $systemRule = [Security.AccessControl.FileSystemAccessRule]::new(
      $systemSid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      $propagation,
      $type
    )
    [void] $acl.AddAccessRule($userRule)
    [void] $acl.AddAccessRule($systemRule)
    Set-Acl -LiteralPath $Path -AclObject $acl
  } catch {
    Write-WarnLine "Could not restrict the proxy config ACL: $($_.Exception.Message)"
  }
}

function Test-IsAuthenticated {
  $result = Invoke-SbxCapture @('diagnose', '--output', 'json')
  if ($result.ExitCode -ne 0) {
    return $false
  }
  return $result.Text -match (
    '(?s)"name"\s*:\s*"Authentication".{0,1000}?' +
    '"message"\s*:\s*"authenticated"'
  )
}

function Login-Sbx {
  [void] (Get-SbxCommand)
  Load-DaemonEnvironment
  if (Test-IsAuthenticated) {
    Write-Success 'sbx is already authenticated.'
    return
  }
  Write-InfoLine 'Starting Docker OAuth login...'
  Invoke-Sbx @('login')
  Write-Success 'Docker login completed.'
}

function Start-Daemon {
  Load-DaemonEnvironment
  Invoke-Sbx @('daemon', 'start', '--detach')
}

function Restart-Daemon {
  Load-DaemonEnvironment
  $stop = Invoke-SbxCapture @('daemon', 'stop')
  if ($stop.ExitCode -ne 0 -and $stop.Text) {
    Write-WarnLine $stop.Text
  }
  Invoke-Sbx @('daemon', 'start', '--detach')
  Invoke-Sbx @('daemon', 'status')
}

function Invoke-DaemonCommand {
  param([string[]] $CommandArguments)

  $CommandArguments = @($CommandArguments)
  $action = if ($CommandArguments.Count -gt 0) {
    $CommandArguments[0]
  } else {
    'status'
  }
  switch ($action) {
    'start' { Start-Daemon }
    'stop' { Invoke-Sbx @('daemon', 'stop') }
    'restart' { Restart-Daemon }
    'status' { Invoke-Sbx @('daemon', 'status') }
    default {
      Stop-Manager (
        "Unknown daemon action: $action " +
        '(use start, stop, restart, or status)'
      )
    }
  }
}

function ConvertTo-PolicyPreset {
  param([string] $Mode)
  switch ($Mode) {
    { $_ -in @('open', 'allow-all') } { return 'allow-all' }
    'balanced' { return 'balanced' }
    { $_ -in @('locked', 'locked-down', 'deny-all') } { return 'deny-all' }
    default {
      Stop-Manager "Unknown network mode: $Mode (use open, balanced, or locked)"
    }
  }
}

function Get-PolicyCheck {
  param([string] $Target)
  return Invoke-SbxCapture @('policy', 'check', 'network', $Target)
}

function Test-PolicyAllowed {
  param([string] $Target)
  $result = Get-PolicyCheck $Target
  return $result.Text -match 'Allowed:'
}

function Get-CurrentNetworkPreset {
  $result = Invoke-SbxCapture @(
    'policy', 'ls',
    '--include-inactive',
    '--source', 'local',
    '--type', 'network',
    '--json'
  )
  if ($result.ExitCode -ne 0) {
    return $null
  }
  if ($result.Text -match 'default-allow-all') {
    return 'allow-all'
  }
  if ($result.Text -match 'default-deny-all') {
    return 'deny-all'
  }
  if ($result.Text -match '"origin"\s*:\s*"local"') {
    return 'balanced'
  }
  return $null
}

function Set-NetworkMode {
  param(
    [string] $Mode,
    [switch] $KeepMatching
  )

  Load-DaemonEnvironment
  $preset = ConvertTo-PolicyPreset $Mode
  $initialized = $false
  $result = Invoke-SbxCapture @('policy', 'init', $preset)

  if ($result.ExitCode -eq 0) {
    if ($result.Text) {
      Write-Line $result.Text
    }
    $initialized = $true
  } elseif ($result.Text -match 'global network policy is already initialized') {
    $currentPreset = Get-CurrentNetworkPreset
    if ($KeepMatching -and $currentPreset -eq $preset) {
      Write-Success "Local network policy already uses preset: $preset"
    } else {
      Write-WarnLine (
        'Changing the preset resets local policy rules and stops the sbx ' +
        'daemon. Sandbox disks are preserved.'
      )
      if (-not (Confirm-Action "Reset local policy to '$Mode'?")) {
        Stop-Manager 'Cancelled.'
      }
      Invoke-Sbx @('policy', 'reset', '--force')
      Invoke-Sbx @('policy', 'init', $preset)
      $initialized = $true
    }
  } else {
    if ($result.Text) {
      Write-WarnLine $result.Text
    }
    Stop-Manager "Could not initialize the local network policy preset: $preset"
  }

  if ($initialized) {
    Write-Success "Initialized local policy preset: $preset"
  }

  if ($preset -eq 'allow-all') {
    if (-not (Test-PolicyAllowed 'github.com')) {
      Write-WarnLine (
        'Open policy is present but the daemon check is stale; restarting ' +
        'sandboxd once.'
      )
      Restart-Daemon | Out-Null
    }
    Write-Line (Get-PolicyCheck 'github.com').Text
    Write-Line (Get-PolicyCheck 'api.minimax.io').Text
  }

  Invoke-Sbx @('policy', 'ls', '--include-inactive', '--wide')
}

function Hide-ProxyCredentials {
  param([AllowEmptyString()][string] $Proxy)
  if ([string]::IsNullOrEmpty($Proxy)) {
    return $Proxy
  }
  return $Proxy -replace '(?<=://)[^/@]+@', '***@'
}

function Save-Proxy {
  param([string] $Url)

  if ($Url -notmatch '^(?i:https?|socks5h?)://') {
    Stop-Manager (
      'Proxy URL must start with http://, https://, socks5://, or socks5h://'
    )
  }

  New-Item -ItemType Directory -Path $script:ConfigDir -Force | Out-Null
  $config = [ordered] @{
    Proxy = $Url
    NoProxy = 'localhost,127.0.0.1'
  }
  $config | ConvertTo-Json |
    Set-Content -LiteralPath $script:DaemonConfigFile -Encoding UTF8
  Protect-ConfigFile $script:DaemonConfigFile

  Write-Success (
    "Saved manager proxy configuration: $(Hide-ProxyCredentials $Url)"
  )
  Write-WarnLine (
    "This file is used when the daemon is started through $($script:ScriptName). " +
    'It does not rewrite your PowerShell profile.'
  )
  Restart-Daemon
}

function Remove-Proxy {
  if (Test-Path -LiteralPath $script:DaemonConfigFile) {
    Remove-Item -LiteralPath $script:DaemonConfigFile -Force
    Write-Success "Removed $($script:DaemonConfigFile)"
  } else {
    Write-InfoLine 'No manager proxy file exists.'
  }
  Write-WarnLine (
    'Proxy variables inherited from your current process, if any, still apply.'
  )
  Restart-Daemon
}

function Show-NetworkStatus {
  Write-Section 'Policy rules'
  Invoke-SbxBestEffort @('policy', 'ls', '--include-inactive', '--wide')

  Write-Section 'Representative checks'
  foreach ($target in @(
    'https://github.com',
    'https://registry-1.docker.io',
    'https://auth.docker.io',
    'https://api.minimax.io'
  )) {
    Invoke-SbxBestEffort @('policy', 'check', 'network', $target)
  }

  Write-Section 'Saved upstream proxy'
  $config = Get-SavedDaemonConfig
  if ($null -ne $config -and
      @($config.PSObject.Properties.Name) -contains 'Proxy') {
    Write-Line "Manager config: $(Hide-ProxyCredentials ([string] $config.Proxy))"
  } else {
    Write-Line 'Manager config: none'
  }
  $processProxy = if ($env:DOCKER_SANDBOXES_PROXY) {
    $env:DOCKER_SANDBOXES_PROXY
  } else {
    '<unset>'
  }
  $httpsProxy = if ($env:HTTPS_PROXY) { $env:HTTPS_PROXY } else { '<unset>' }
  Write-Line (
    'Current process DOCKER_SANDBOXES_PROXY: ' +
    (Hide-ProxyCredentials $processProxy)
  )
  Write-Line (
    'Current process HTTPS_PROXY: ' + (Hide-ProxyCredentials $httpsProxy)
  )
}

function Invoke-NetworkCommand {
  param([string[]] $CommandArguments)

  $CommandArguments = @($CommandArguments)
  $subcommand = if ($CommandArguments.Count -gt 0) {
    $CommandArguments[0]
  } else {
    'status'
  }
  $rest = if ($CommandArguments.Count -gt 1) {
    @($CommandArguments[1..($CommandArguments.Count - 1)])
  } else {
    @()
  }

  switch ($subcommand) {
    'set' {
      if ($rest.Count -lt 1) {
        Stop-Manager (
          "Usage: .\$($script:ScriptName) network set <open|balanced|locked>"
        )
      }
      Set-NetworkMode $rest[0]
    }
    'allow' {
      if ($rest.Count -lt 1) {
        Stop-Manager (
          "Usage: .\$($script:ScriptName) network allow <resource[,resource...]>"
        )
      }
      Invoke-Sbx @('policy', 'allow', 'network', $rest[0])
      if ($rest[0] -eq '**' -and -not (Test-PolicyAllowed 'github.com')) {
        Write-WarnLine (
          'Wildcard rule did not appear in the daemon snapshot; restarting ' +
          'sandboxd once.'
        )
        Restart-Daemon | Out-Null
      }
      Invoke-Sbx @('policy', 'ls', '--include-inactive', '--wide')
    }
    'deny' {
      if ($rest.Count -lt 1) {
        Stop-Manager (
          "Usage: .\$($script:ScriptName) network deny <resource[,resource...]>"
        )
      }
      Invoke-Sbx @('policy', 'deny', 'network', $rest[0])
      Invoke-Sbx @('policy', 'ls', '--include-inactive', '--wide')
    }
    'check' {
      if ($rest.Count -lt 1) {
        Stop-Manager (
          "Usage: .\$($script:ScriptName) network check <target>"
        )
      }
      Invoke-Sbx @('policy', 'check', 'network', $rest[0])
    }
    'status' { Show-NetworkStatus }
    { $_ -in @('logs', 'log') } { Invoke-Sbx @('policy', 'log') }
    'proxy' {
      if ($rest.Count -lt 1) {
        Stop-Manager (
          "Usage: .\$($script:ScriptName) network proxy <URL|off>"
        )
      }
      if ($rest[0] -eq 'off') {
        Remove-Proxy
      } else {
        Save-Proxy $rest[0]
      }
    }
    default { Stop-Manager "Unknown network command: $subcommand" }
  }
}

function Get-BaseVariant {
  param([string] $Agent)
  $variants = @{
    claude = 'claude-code'
    codex = 'codex'
    copilot = 'copilot'
    cursor = 'cursor-agent'
    'docker-agent' = 'docker-agent'
    droid = 'droid'
    gemini = 'gemini'
    kiro = 'kiro'
    opencode = 'opencode'
    shell = 'shell'
  }
  if (-not $variants.ContainsKey($Agent)) {
    Stop-Manager "Unsupported agent: $Agent"
  }
  return $variants[$Agent]
}

function Show-TemplateCatalog {
  Write-Section 'Official documented template families'
  Write-Line "Catalog date: $($script:CatalogDate)"
  Write-Line "Repository: $($script:TemplateRepo):<variant>"
  Write-Line (
    'There are 11 documented base variants; each also has a -docker variant ' +
    '(22 stable variant names).'
  )
  Write-Line 'Built-in agent launches use the -docker variant by default.'
  Write-Line
  Write-Line (
    '{0,-14} {1,-25} {2,-32} {3}' -f
    'AGENT', 'LIGHT TEMPLATE', 'DOCKER TEMPLATE (DEFAULT)', 'START COMMAND'
  )
  Write-Line (
    '{0,-14} {1,-25} {2,-32} {3}' -f
    '--------------', '-------------------------',
    '--------------------------------', '------------------------------'
  )
  $rows = @(
    @('claude', 'claude-code', 'claude-code-docker'),
    @('codex', 'codex', 'codex-docker'),
    @('copilot', 'copilot', 'copilot-docker'),
    @('cursor', 'cursor-agent', 'cursor-agent-docker'),
    @('docker-agent', 'docker-agent', 'docker-agent-docker'),
    @('droid', 'droid', 'droid-docker'),
    @('gemini', 'gemini', 'gemini-docker'),
    @('kiro', 'kiro', 'kiro-docker'),
    @('opencode', 'opencode', 'opencode-docker'),
    @('shell', 'shell', 'shell-docker')
  )
  foreach ($row in $rows) {
    Write-Line (
      '{0,-14} {1,-25} {2,-32} {3}' -f
      $row[0], $row[1], $row[2], "sbx run $($row[0]) C:\src\project"
    )
  }

  Write-Section 'Additional Claude minimal variants'
  Write-Line "  $($script:TemplateRepo):claude-code-minimal"
  Write-Line "  $($script:TemplateRepo):claude-code-minimal-docker"
  Write-Line 'Launch examples:'
  Write-Line (
    "  sbx run --template $($script:TemplateRepo):claude-code-minimal " +
    'claude C:\src\project'
  )
  Write-Line (
    "  sbx run --template $($script:TemplateRepo):claude-code-minimal-docker " +
    'claude C:\src\project'
  )

  Write-Section 'Common launch patterns'
  Write-Line @"
  # Default Docker-enabled template
  sbx run --name my-agent claude C:\src\project

  # Protect the host working tree with a private Git clone
  sbx run --clone --name my-agent claude C:\src\repository

  # Lighter template: no nested Docker Engine
  sbx run --template $($script:TemplateRepo):claude-code claude C:\src\project

  # Reattach to an existing sandbox
  sbx run --name my-agent

  # Open an extra Bash shell in a running sandbox
  sbx exec -it my-agent bash

  # Stop without deleting, or remove permanently
  sbx stop my-agent
  sbx rm my-agent
"@
}

function Show-LocalTemplates {
  Write-Section 'Templates cached locally by sbx'
  if (Test-Command 'sbx') {
    Invoke-SbxBestEffort @('template', 'ls')
  } else {
    Write-Line 'sbx is not installed; no local cache can be queried.'
  }
}

function Show-RemoteTags {
  Write-Section 'Every currently published Docker Hub tag'
  Write-Line 'Source: docker/sandbox-templates'
  Write-Line 'This includes stable aliases, versioned tags, and nightly tags.'
  Write-Line

  $url = $script:HubTagsApi
  $tags = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::Ordinal
  )
  $seen = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::Ordinal
  )
  try {
    while ($url) {
      if (-not $seen.Add($url)) {
        throw 'Docker Hub pagination loop detected.'
      }
      $response = Invoke-RestMethod -Uri $url -Method Get `
        -Headers @{
          'User-Agent' = 'sbx-manager/1.0'
          Accept = 'application/json'
        } -TimeoutSec 30
      foreach ($item in @($response.results)) {
        if ($item.name) {
          [void] $tags.Add([string] $item.name)
        }
      }
      $url = [string] $response.next
    }
    @($tags) | Sort-Object | ForEach-Object { Write-Line $_ }
    Write-Line
    Write-Line "Total published tags: $($tags.Count)"
  } catch {
    Write-WarnLine (
      'Remote tags could not be fetched; the static supported catalog above ' +
      "is still available. $($_.Exception.Message)"
    )
  }
}

function Invoke-TemplatesCommand {
  param([string[]] $CommandArguments)

  $remote = $false
  foreach ($argument in $CommandArguments) {
    if ($argument -eq '--remote') {
      $remote = $true
    } else {
      Stop-Manager "Unknown templates option: $argument"
    }
  }
  Show-TemplateCatalog
  Show-LocalTemplates
  if ($remote) {
    Show-RemoteTags
  }
}

function Show-HostInfo {
  Write-Section 'Host'
  $windows = Get-WindowsInfo
  Write-Line "OS: $($windows.Caption)"
  Write-Line "Version: $($windows.Version) (build $($windows.Build))"
  Write-Line "Architecture: $($windows.Architecture)"
  Write-Line "PowerShell: $($PSVersionTable.PSVersion)"
  Write-Line "Elevated: $(Test-IsAdministrator)"
  Write-Line "Windows Hypervisor Platform: $(Get-HypervisorPlatformState)"
  Write-Line "Pending reboot: $(Test-RebootPending)"

  try {
    $processors = @(Get-CimInstance -ClassName Win32_Processor)
    if ($processors.Count -gt 0) {
      $firmware = $processors |
        ForEach-Object { $_.VirtualizationFirmwareEnabled } |
        Select-Object -Unique
      Write-Line "Virtualization enabled in firmware: $($firmware -join ', ')"
    }
  } catch {
    Write-WarnLine "Could not query CPU virtualization state: $($_.Exception.Message)"
  }
}

function Show-ProxyInfo {
  Write-Section 'Proxy environment'
  $config = Get-SavedDaemonConfig
  if ($null -ne $config -and
      @($config.PSObject.Properties.Name) -contains 'Proxy') {
    Write-Line (
      'Manager-saved upstream proxy: ' +
      (Hide-ProxyCredentials ([string] $config.Proxy))
    )
    Write-Line "Config file: $($script:DaemonConfigFile) (restricted ACL)"
  } else {
    Write-Line 'Manager-saved upstream proxy: <none>'
  }
  $managerProxy = if ($env:DOCKER_SANDBOXES_PROXY) {
    $env:DOCKER_SANDBOXES_PROXY
  } else {
    '<unset>'
  }
  $httpsProxy = if ($env:HTTPS_PROXY) { $env:HTTPS_PROXY } else { '<unset>' }
  $noProxy = if ($env:NO_PROXY) { $env:NO_PROXY } else { '<unset>' }
  Write-Line (
    'Process DOCKER_SANDBOXES_PROXY: ' +
    (Hide-ProxyCredentials $managerProxy)
  )
  Write-Line "Process HTTPS_PROXY: $(Hide-ProxyCredentials $httpsProxy)"
  Write-Line "Process NO_PROXY: $noProxy"
}

function Show-StorageInfo {
  Write-Section 'Local storage'
  $paths = @(
    (Join-Path $HOME '.sbx'),
    (Join-Path $localAppData 'com.docker.sandboxes')
  )
  $found = $false
  foreach ($path in $paths) {
    if (Test-Path -LiteralPath $path -PathType Container) {
      $found = $true
      Write-Line $path
    }
  }
  if (-not $found) {
    Write-Line 'No known sbx storage directory was found.'
  }
}

function Show-Info {
  Show-HostInfo
  Show-ProxyInfo

  Write-Section 'sbx installation'
  if (-not (Test-Command 'sbx')) {
    Write-Line 'sbx: not installed'
    return
  }
  Write-Line "Binary: $((Get-Command 'sbx').Source)"
  Invoke-SbxBestEffort @('version')

  Write-Section 'Daemon'
  Invoke-SbxBestEffort @('daemon', 'status')

  Write-Section 'Policy'
  Invoke-SbxBestEffort @('policy', 'ls', '--include-inactive', '--wide')

  Write-Section 'Network policy checks'
  foreach ($target in @(
    'github.com',
    'auth.docker.io',
    'registry-1.docker.io',
    'api.minimax.io'
  )) {
    Invoke-SbxBestEffort @('policy', 'check', 'network', $target)
  }

  Write-Section 'Sandboxes'
  Invoke-SbxBestEffort @('ls')
  Show-LocalTemplates
  Show-StorageInfo
}

function Invoke-Doctor {
  Show-HostInfo
  Write-Section 'Windows prerequisites'
  Test-WindowsPrerequisites

  Write-Section 'sbx diagnostics'
  Invoke-Sbx @('diagnose')

  Write-Section 'Daemon'
  Invoke-SbxBestEffort @('daemon', 'status')

  Write-Section 'Policy checks'
  foreach ($target in @(
    'https://github.com',
    'https://auth.docker.io',
    'https://registry-1.docker.io'
  )) {
    Invoke-SbxBestEffort @('policy', 'check', 'network', $target)
  }

  if (Test-Command 'curl.exe') {
    Write-Section 'Host-side Docker Registry reachability'
    Write-Line (
      'A 401 from registry-1.docker.io is normal: it means the registry is ' +
      'reachable and requested authentication.'
    )
    & curl.exe -sS -o NUL -w "registry-1.docker.io: HTTP %{http_code}`n" `
      --connect-timeout 10 --max-time 20 https://registry-1.docker.io/v2/
    & curl.exe -sS -o NUL -w "auth.docker.io:       HTTP %{http_code}`n" `
      --connect-timeout 10 --max-time 20 `
      'https://auth.docker.io/token?service=registry.docker.io&scope=repository:docker/sandbox-templates:pull'
  }
}

function Test-DefaultShellKit {
  $required = @(
    (Join-Path $script:DefaultShellKit 'spec.yaml'),
    (Join-Path $script:DefaultShellKit 'files\home\.zshrc'),
    (Join-Path $script:DefaultShellKit (
      'files\home\.config\sbx-manager\enter-workspace.zsh'
    )),
    (Join-Path $script:DefaultShellKit (
      'files\home\.config\sbx-manager\show-motd.zsh'
    )),
    (Join-Path $script:DefaultShellKit (
      'files\home\.config\sbx-manager\apply-home-files.sh'
    )),
    (Join-Path $script:DefaultShellKit (
      'files\home\.config\sbx-manager\zsh-shell.version'
    )),
    (Join-Path $script:DefaultShellKit 'files\home\.config\starship.toml')
  )
  foreach ($path in $required) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      Stop-Manager "The default zsh shell kit is missing a required file: $path"
    }
  }
}

function Get-DefaultShellKitPath {
  Test-DefaultShellKit

  $sourceFiles = @(
    Get-ChildItem -LiteralPath $script:DefaultShellKit -File -Recurse -Force
  )
  $requiresNormalization = $false
  foreach ($file in $sourceFiles) {
    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    if ($bytes -contains [byte] 13) {
      $requiresNormalization = $true
      break
    }
  }
  if (-not $requiresNormalization) {
    return $script:DefaultShellKit
  }

  $temporaryKit = Join-Path ([IO.Path]::GetTempPath()) (
    'sbx-manager-zsh-shell-' + [guid]::NewGuid().ToString('N')
  )
  try {
    New-Item -ItemType Directory -Path $temporaryKit -Force | Out-Null
    foreach ($entry in @(
      Get-ChildItem -LiteralPath $script:DefaultShellKit -Force
    )) {
      Copy-Item -LiteralPath $entry.FullName -Destination $temporaryKit `
        -Recurse -Force
    }

    $utf8NoBom = [Text.UTF8Encoding]::new($false)
    foreach ($file in @(
      Get-ChildItem -LiteralPath $temporaryKit -File -Recurse -Force
    )) {
      $bytes = [IO.File]::ReadAllBytes($file.FullName)
      if ($bytes -contains [byte] 13) {
        # The bundled kit consists of UTF-8 text files. Remove both Windows
        # CRLF and stray CR line endings without adding a UTF-8 BOM.
        $content = [IO.File]::ReadAllText($file.FullName)
        $content = $content.Replace("`r`n", "`n").Replace("`r", "`n")
        [IO.File]::WriteAllText($file.FullName, $content, $utf8NoBom)
      }
    }
  } catch {
    if (Test-Path -LiteralPath $temporaryKit) {
      Remove-Item -LiteralPath $temporaryKit -Recurse -Force `
        -ErrorAction SilentlyContinue
    }
    Stop-Manager "Could not prepare an LF-only shell kit: $($_.Exception.Message)"
  }

  $script:TemporaryDirectories.Add($temporaryKit)
  return $temporaryKit
}

function Get-ShellKitRefreshName {
  param([string] $Version)

  $namePrefix = 'zsh-shell-refresh-'
  $hash = $null
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $hashBytes = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($Version))
    $hash = [BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
  $hash = $hash.Substring(0, 12)

  $versionSlug = $Version.ToLowerInvariant() -replace '[^a-z0-9]+', '-'
  $versionSlug = $versionSlug.Trim('-')
  if (-not $versionSlug) {
    $versionSlug = 'revision'
  }
  $maxSlugLength = 64 - $namePrefix.Length - $hash.Length - 1
  if ($versionSlug.Length -gt $maxSlugLength) {
    $versionSlug = $versionSlug.Substring(0, $maxSlugLength).TrimEnd('-')
  }
  return "$namePrefix$versionSlug-$hash"
}

function Get-ShellKitRefreshView {
  param(
    [string] $ShellKitPath,
    [string] $Version
  )

  if ($Version -notmatch '^[A-Za-z0-9._-]+$') {
    Stop-Manager "The default shell kit version is not safe for a cache path: $Version"
  }
  $refreshKit = Join-Path $script:ConfigDir (
    "kits\zsh-shell-refresh\$Version"
  )
  $refreshName = Get-ShellKitRefreshName $Version
  try {
    New-Item -ItemType Directory -Path $refreshKit -Force | Out-Null
    $sourceSpec = Join-Path $ShellKitPath 'spec.yaml'
    $specContent = [IO.File]::ReadAllText($sourceSpec)
    $namePattern = [regex]::new('(?m)^name:[^\r\n]*$')
    if ($namePattern.Matches($specContent).Count -ne 1) {
      throw "Expected exactly one top-level name in $sourceSpec"
    }

    # kit add appends to the sandbox's existing composition. Give this
    # install-only revision its own name so it does not collide with the
    # original zsh-shell kit already attached to the sandbox.
    $specContent = $namePattern.Replace(
      $specContent,
      "name: $refreshName",
      1
    )
    $utf8NoBom = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText(
      (Join-Path $refreshKit 'spec.yaml'),
      $specContent,
      $utf8NoBom
    )
  } catch {
    if (Test-Path -LiteralPath $refreshKit) {
      Remove-Item -LiteralPath $refreshKit -Recurse -Force `
        -ErrorAction SilentlyContinue
    }
    Stop-Manager "Could not prepare the install-only shell kit: $($_.Exception.Message)"
  }

  return $refreshKit
}

function Copy-ShellKitHomeFiles {
  param(
    [string] $SandboxName,
    [string] $ShellKitPath
  )

  $remoteStage = '/tmp/sbx-manager-zsh-shell-refresh'
  $homeFiles = Join-Path $ShellKitPath 'files\home'
  Invoke-Sbx @(
    'exec', '-u', 'root', $SandboxName, '/bin/sh', '-c',
    'set -eu; stage="$1"; rm -rf -- "$stage"; mkdir -p "$stage"',
    'sh', $remoteStage
  )
  Invoke-Sbx @(
    'cp', $homeFiles, "${SandboxName}:$remoteStage/"
  )

  Invoke-Sbx @(
    'exec', '-u', 'root', $SandboxName, '/bin/sh',
    "$remoteStage/home/.config/sbx-manager/apply-home-files.sh",
    $remoteStage
  )
}

function Update-ExistingShellKit {
  param([string] $SandboxName)

  $shellKitPath = Get-DefaultShellKitPath
  $localVersionFile = Join-Path $shellKitPath (
    'files\home\.config\sbx-manager\zsh-shell.version'
  )
  $remoteVersionFile = '/home/agent/.config/sbx-manager/zsh-shell.version'
  $expectedVersion = [IO.File]::ReadAllText($localVersionFile).Trim()
  if ([string]::IsNullOrWhiteSpace($expectedVersion)) {
    Stop-Manager "The default shell kit version marker is empty: $localVersionFile"
  }

  $versionCheck = Invoke-SbxCapture @(
    'exec', $SandboxName, '/bin/sh', '-c',
    'actual="$(sed -n "1p" "$1" 2>/dev/null || :)"; [ "$actual" = "$2" ]',
    'sh', $remoteVersionFile, $expectedVersion
  )
  if ($versionCheck.ExitCode -eq 0) {
    return
  }

  Write-Section 'Refreshing shell kit'
  Write-Line (
    "The existing sandbox '$SandboxName' is missing shell kit " +
    "$expectedVersion."
  )
  Write-Line (
    'Applying install steps, then copying the current LF-only home files ' +
    'before reattaching.'
  )
  $refreshKit = Get-ShellKitRefreshView -ShellKitPath $shellKitPath `
    -Version $expectedVersion
  Invoke-SbxKitAddWithRetry -SandboxName $SandboxName -KitPath $refreshKit
  Copy-ShellKitHomeFiles -SandboxName $SandboxName `
    -ShellKitPath $shellKitPath
}

function Format-CommandArgument {
  param([AllowEmptyString()][string] $Value)
  if ($Value -match '^[A-Za-z0-9_./:\\@=-]+$') {
    return $Value
  }
  return "'" + $Value.Replace("'", "''") + "'"
}

function Invoke-RunCommand {
  param([string[]] $CommandArguments)

  $CommandArguments = @($CommandArguments)
  if ($CommandArguments.Count -lt 1) {
    Stop-Manager (
      "Usage: .\$($script:ScriptName) run <agent> [workspace] " +
      '[options] [-- agent arguments]'
    )
  }

  $agent = $CommandArguments[0]
  $base = Get-BaseVariant $agent
  $workspace = ''
  $name = ''
  $clone = $false
  $noDocker = $false
  $minimal = $false
  $detached = $false
  $template = ''
  $rootSize = ''
  $dockerSize = ''
  $shellKit = $true
  $shellKitExplicitlyDisabled = $false
  $workspaceProvided = $false
  $extraArguments = [Collections.Generic.List[string]]::new()

  $index = 1
  while ($index -lt $CommandArguments.Count) {
    $argument = $CommandArguments[$index]
    $index++
    switch ($argument) {
      '--name' {
        if ($index -ge $CommandArguments.Count) {
          Stop-Manager '--name requires a value'
        }
        $name = $CommandArguments[$index]
        $index++
      }
      '--clone' { $clone = $true }
      '--no-docker' { $noDocker = $true }
      '--minimal' { $minimal = $true }
      { $_ -in @('-t', '--template') } {
        if ($index -ge $CommandArguments.Count) {
          Stop-Manager "$argument requires an image reference"
        }
        $template = $CommandArguments[$index]
        $index++
      }
      { $_ -in @('-d', '--detached') } { $detached = $true }
      '--root-size' {
        if ($index -ge $CommandArguments.Count) {
          Stop-Manager '--root-size requires a value such as 40g'
        }
        $rootSize = $CommandArguments[$index]
        $index++
      }
      '--docker-size' {
        if ($index -ge $CommandArguments.Count) {
          Stop-Manager '--docker-size requires a value such as 10g'
        }
        $dockerSize = $CommandArguments[$index]
        $index++
      }
      '--no-shell-kit' {
        $shellKit = $false
        $shellKitExplicitlyDisabled = $true
      }
      '--' {
        while ($index -lt $CommandArguments.Count) {
          $extraArguments.Add($CommandArguments[$index])
          $index++
        }
      }
      default {
        if ($argument.StartsWith('-')) {
          Stop-Manager "Unknown run option: $argument"
        }
        if (-not $workspace) {
          $workspace = $argument
          $workspaceProvided = $true
        } else {
          Stop-Manager (
            'Only one workspace is accepted by this helper. Use raw ' +
            "'sbx run' for additional mounts."
          )
        }
      }
    }
  }

  Load-DaemonEnvironment
  $reattach = $false
  if ($name) {
    $list = Invoke-SbxCapture @('ls', '-q')
    if ($list.ExitCode -ne 0) {
      Stop-Manager "Could not list existing sandboxes before running '$name'."
    }
    $sandboxNames = @($list.Output | ForEach-Object { $_.Trim() })
    $reattach = $sandboxNames -contains $name
  }

  if ($reattach) {
    if ($shellKit) {
      Update-ExistingShellKit $name
    } else {
      Write-InfoLine "Skipping shell kit refresh for existing sandbox '$name'."
    }
  }

  $sbxArguments = [Collections.Generic.List[string]]::new()
  $sbxArguments.Add('run')

  if ($reattach) {
    Write-InfoLine (
      "Reattaching to existing sandbox '$name'; its original agent and " +
      'workspace are preserved.'
    )
    if ($clone -or $noDocker -or $minimal -or $detached -or $template -or
        $rootSize -or $dockerSize -or $shellKitExplicitlyDisabled) {
      Write-WarnLine "Ignoring creation-only options while reattaching to '$name'."
    }
    if ($workspaceProvided) {
      Write-Line "Requested workspace is ignored for reattach: $workspace"
    }
    $sbxArguments.Add('--name')
    $sbxArguments.Add($name)
  } else {
    if (-not $workspace) {
      $workspace = (Get-Location).ProviderPath
    }
    if (-not (Test-Path -LiteralPath $workspace -PathType Container)) {
      Stop-Manager "Workspace directory does not exist: $workspace"
    }
    $workspace = (Resolve-Path -LiteralPath $workspace).ProviderPath

    if ($minimal) {
      if ($agent -ne 'claude') {
        Stop-Manager '--minimal is only valid with the claude agent.'
      }
      $base = 'claude-code-minimal'
    }
    if ($template -and ($noDocker -or $minimal)) {
      Write-WarnLine (
        'An explicit --template overrides automatic --no-docker/--minimal ' +
        'template selection.'
      )
    }
    if (-not $template) {
      if ($minimal) {
        if ($noDocker) {
          $template = "$($script:TemplateRepo):$base"
        } else {
          $template = "$($script:TemplateRepo):$base-docker"
        }
      } elseif ($noDocker) {
        $template = "$($script:TemplateRepo):$base"
      }
    }

    if ($clone -and (Test-Command 'git')) {
      $git = (Get-Command 'git').Source
      $gitResult = Invoke-NativeCapture -FilePath $git -ArgumentList @(
        '-C', $workspace, 'rev-parse', '--is-inside-work-tree'
      )
      if ($gitResult.ExitCode -ne 0) {
        Write-WarnLine (
          '--clone was requested, but the workspace does not appear to be a ' +
          'Git working tree. sbx may reject it.'
        )
      }
    }

    if ($name) {
      $sbxArguments.Add('--name')
      $sbxArguments.Add($name)
    }
    if ($clone) {
      $sbxArguments.Add('--clone')
    }
    if ($detached) {
      $sbxArguments.Add('--detached')
    }
    if ($template) {
      $sbxArguments.Add('--template')
      $sbxArguments.Add($template)
    }
    if ($shellKit) {
      $shellKitPath = Get-DefaultShellKitPath
      $sbxArguments.Add('--kit')
      $sbxArguments.Add($shellKitPath)
    }
    $sbxArguments.Add($agent)
    $sbxArguments.Add($workspace)
  }

  if ($extraArguments.Count -gt 0) {
    $sbxArguments.Add('--')
    foreach ($argument in $extraArguments) {
      $sbxArguments.Add($argument)
    }
  }

  if ($reattach) {
    Write-Section 'Reattaching sandbox'
  } else {
    Write-Section 'Launching sandbox'
  }
  $displayArguments = @('sbx') + @($sbxArguments) |
    ForEach-Object { Format-CommandArgument $_ }
  Write-Line "Command: $($displayArguments -join ' ')"

  if (-not $reattach -and $rootSize) {
    $env:DOCKER_SANDBOXES_ROOT_SIZE = $rootSize
    Write-Line "DOCKER_SANDBOXES_ROOT_SIZE=$rootSize"
  }
  if (-not $reattach -and $dockerSize) {
    $env:DOCKER_SANDBOXES_DOCKER_SIZE = $dockerSize
    Write-Line "DOCKER_SANDBOXES_DOCKER_SIZE=$dockerSize"
  }
  Invoke-Sbx @($sbxArguments)
}

function Invoke-Setup {
  param([string[]] $CommandArguments)

  $CommandArguments = @($CommandArguments)
  $mode = if ($CommandArguments.Count -gt 0) {
    $CommandArguments[0]
  } else {
    'balanced'
  }
  if (-not (Test-Command 'sbx')) {
    Install-Sbx
  } else {
    Write-Success "Using existing sbx at $((Get-Command 'sbx').Source)."
    Test-WindowsPrerequisites
  }

  if ($script:RestartRequired) {
    Write-WarnLine 'Restart Windows, then rerun setup to continue.'
    return
  }

  Set-NetworkMode -Mode $mode -KeepMatching
  if ($script:SkipLogin) {
    Write-WarnLine 'Skipping sbx login by request.'
  } else {
    Login-Sbx
  }
  Show-Info
  Show-TemplateCatalog
}

function Split-GlobalOptions {
  param([string[]] $RawArguments)

  $RawArguments = @($RawArguments)
  $remaining = [Collections.Generic.List[string]]::new()
  $action = 'Continue'
  $index = 0
  while ($index -lt $RawArguments.Count) {
    $argument = $RawArguments[$index]
    switch ($argument) {
      { $_ -in @('-y', '--yes') } { $script:AssumeYes = $true }
      '--skip-login' { $script:SkipLogin = $true }
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

  if ($remaining.Count -eq 0) {
    if (-not (Test-Command 'sbx')) {
      Show-FirstRunHint
    }
    Show-Usage
    return
  }

  $command = $remaining[0]
  $commandArguments = @()
  if ($remaining.Count -gt 1) {
    $commandArguments = @($remaining[1..($remaining.Count - 1)])
  }

  switch ($command) {
    { $_ -in @('help', '-h', '--help') } { Show-Usage }
    'install' { Install-Sbx }
    'setup' { Invoke-Setup $commandArguments }
    'login' { Login-Sbx }
    'info' { Show-Info }
    { $_ -in @('doctor', 'diagnose') } { Invoke-Doctor }
    { $_ -in @('templates', 'template') } {
      Invoke-TemplatesCommand $commandArguments
    }
    { $_ -in @('network', 'policy') } {
      Invoke-NetworkCommand $commandArguments
    }
    'daemon' { Invoke-DaemonCommand $commandArguments }
    { $_ -in @('run', 'start') } { Invoke-RunCommand $commandArguments }
    default {
      Stop-Manager (
        "Unknown command: $command. Run '.\$($script:ScriptName) --help'."
      )
    }
  }
}

try {
  Invoke-Main $Arguments
  $managerExitCode = 0
} catch {
  [Console]::Error.WriteLine(
    "$($script:ColorRed)ERROR$($script:ColorReset) $($_.Exception.Message)"
  )
  $managerExitCode = 1
} finally {
  Restore-ManagerEnvironment
}
exit $managerExitCode
