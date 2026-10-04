# Windows workstation menu and command-line entry point.
# Compatible with Windows PowerShell 5.1 and PowerShell 7+.

[CmdletBinding(PositionalBinding = $true)]
param(
  [Parameter(Position = 0)]
  [ValidateSet('menu', 'plan', 'install', 'uninstall', 'list', 'setup', 'doctor')]
  [string] $Command = 'menu',

  [ValidateSet('utilities', 'developer')]
  [string] $Mode = 'utilities',

  [string[]] $Profiles = @('core'),
  [ValidateSet('core', 'default', 'full')]
  [string] $Profile = 'default',
  [string[]] $PackageIds = @(),
  [string] $ConfigFile = '',
  [switch] $IncludeOptional,
  [switch] $Yes,
  [switch] $DryRun,
  [switch] $IncludeWSL,
  [ValidateNotNullOrEmpty()]
  [string] $WSLDistro = 'Ubuntu-24.04',
  [switch] $WSLWebDownload,
  [switch] $WSLSkipUpdate,
  [switch] $EnableLongPaths,
  [switch] $NoGitConfig,
  [switch] $NoShellConfig,
  [switch] $FailFast
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$script:Options = @{}
foreach ($key in $PSBoundParameters.Keys) {
  if ($key -notin @('Command', 'Mode')) {
    $script:Options[$key] = $PSBoundParameters[$key]
  }
}

$script:UtilityOptions = @(
  'Profiles', 'PackageIds', 'ConfigFile', 'IncludeOptional',
  'Yes', 'DryRun', 'FailFast'
)
$script:DeveloperOptions = @(
  'Profile', 'ConfigFile', 'Yes', 'DryRun', 'IncludeWSL', 'WSLDistro',
  'WSLWebDownload', 'WSLSkipUpdate', 'EnableLongPaths', 'NoGitConfig',
  'NoShellConfig', 'FailFast'
)

function Invoke-WorkstationAction {
  param(
    [string] $SelectedMode,
    [string] $SelectedCommand,
    [string[]] $SelectedProfiles = @()
  )

  $allowed = $script:UtilityOptions
  $scriptPath = Join-Path $PSScriptRoot 'utilities.ps1'
  if ($SelectedMode -eq 'developer') {
    $allowed = $script:DeveloperOptions
    $scriptPath = Join-Path $PSScriptRoot 'developer.ps1'
    if ($SelectedCommand -eq 'install') {
      $SelectedCommand = 'setup'
    }
    if ($SelectedCommand -notin @('setup', 'plan', 'list', 'doctor')) {
      throw "The developer mode does not support '$SelectedCommand'."
    }
  } elseif ($SelectedCommand -notin @('plan', 'install', 'uninstall', 'list')) {
    throw "The utilities mode does not support '$SelectedCommand'."
  }

  $forward = @{ Command = $SelectedCommand }
  foreach ($key in $script:Options.Keys) {
    if ($key -notin $allowed -and $key -notin @('Verbose', 'Debug', 'ErrorAction', 'WarningAction', 'InformationAction')) {
      throw "-$key applies to another mode. Select the matching menu option or use -Mode utilities/developer."
    }
    $forward[$key] = $script:Options[$key]
  }
  if ($SelectedProfiles.Count -gt 0) {
    if ($SelectedMode -eq 'developer') {
      $forward['Profile'] = $SelectedProfiles[0]
    } else {
      $forward['Profiles'] = $SelectedProfiles
    }
  }

  # The child scripts already own confirmation, dry runs, and error reporting.
  $global:LASTEXITCODE = 0
  & $scriptPath @forward
  exit $LASTEXITCODE
}

function Select-UtilityProfiles {
  $catalogPath = Join-Path $PSScriptRoot 'packages.psd1'
  if (-not [string]::IsNullOrWhiteSpace($ConfigFile)) {
    $catalogPath = $ConfigFile
  }
  $catalog = Import-PowerShellDataFile -LiteralPath $catalogPath
  $names = @('apps', 'core', 'media', 'maintenance', 'desktop', 'admin', 'power-archive')
  $names = @($names | Where-Object { $catalog.Profiles.ContainsKey($_) }) + @(
    $catalog.Profiles.Keys | Where-Object { $_ -notin $names } | Sort-Object
  )
  while ($true) {
    Write-Host ''
    Write-Host 'Choose utility profiles' -ForegroundColor Cyan
    for ($index = 0; $index -lt $names.Count; $index += 1) {
      $name = $names[$index]
      Write-Host ('  {0}. {1,-15} {2}' -f ($index + 1), $name, $catalog.Profiles[$name].Description)
    }
    Write-Host '  0. Cancel'
    $reply = Read-Host 'Profile numbers, separated by commas'
    if ([string]::IsNullOrWhiteSpace($reply) -or $reply -match '^(?i:0|q|quit|cancel)$') {
      return @()
    }

    $selected = New-Object 'System.Collections.Generic.List[string]'
    $valid = $true
    foreach ($part in @($reply -split '[,\s]+')) {
      if ([string]::IsNullOrWhiteSpace($part)) { continue }
      $number = 0
      if (-not [int]::TryParse($part, [ref] $number) -or $number -lt 1 -or $number -gt $names.Count) {
        $valid = $false
        break
      }
      $name = $names[$number - 1]
      if (-not $selected.Contains($name)) { $selected.Add($name) }
    }
    if ($valid -and $selected.Count -gt 0) { return $selected.ToArray() }
    Write-Host 'Enter valid profile numbers or 0 to cancel.' -ForegroundColor Yellow
  }
}

function Show-WorkstationMenu {
  while ($true) {
    Write-Host ''
    Write-Host 'Windows workstation setup' -ForegroundColor Cyan
    Write-Host '  1. Everyday utilities (choose profiles)'
    Write-Host '  2. Developer core (VSCodium, Git, terminal and shell tools)'
    Write-Host '  3. Developer standard (core, language runtimes and compilers)'
    Write-Host '  4. Developer full (standard, Docker and DevOps tools)'
    Write-Host '  5. Set up WSL 2'
    Write-Host '  6. Uninstall utilities (choose installed apps)'
    Write-Host '  0. Exit'
    $reply = Read-Host 'Choose an option'
    if ([string]::IsNullOrWhiteSpace($reply) -or $reply -match '^(?i:0|q|quit|cancel)$') {
      return
    }
    switch ($reply.Trim()) {
      '1' {
        $selected = @(Select-UtilityProfiles)
        if ($selected.Count -eq 0) { return }
        Invoke-WorkstationAction utilities install $selected
      }
      '2' { Invoke-WorkstationAction developer install @('core') }
      '3' { Invoke-WorkstationAction developer install @('default') }
      '4' { Invoke-WorkstationAction developer install @('full') }
      '5' {
        foreach ($key in $script:Options.Keys) {
          if ($key -notin @('Yes', 'DryRun', 'WSLDistro', 'WSLWebDownload', 'WSLSkipUpdate')) {
            throw "-$key does not apply to WSL setup."
          }
        }
        $arguments = @('--distro', $WSLDistro)
        if ($Yes) { $arguments += '--yes' }
        if ($WSLWebDownload) { $arguments += '--web-download' }
        if ($WSLSkipUpdate) { $arguments += '--skip-update' }
        $arguments += 'setup'
        $manager = Join-Path $PSScriptRoot 'wsl.ps1'
        if ($DryRun) {
          Write-Host ('Would run: wsl.ps1 ' + ($arguments -join ' '))
          Write-Host 'Dry run completed; no changes were made'
          return
        }
        $global:LASTEXITCODE = 0
        & $manager @arguments
        exit $LASTEXITCODE
      }
      '6' { Invoke-WorkstationAction utilities uninstall }
      default { Write-Host 'Choose a number from 0 to 6.' -ForegroundColor Yellow }
    }
  }
}

try {
  if (-not $PSBoundParameters.ContainsKey('Command') -and
      ($PSBoundParameters.ContainsKey('Mode') -or
       $PSBoundParameters.ContainsKey('Profiles') -or
       $PSBoundParameters.ContainsKey('Profile') -or
       $PSBoundParameters.ContainsKey('PackageIds'))) {
    $Command = 'plan'
  }
  if ($Command -eq 'menu') {
    Show-WorkstationMenu
    exit 0
  }
  if (-not $PSBoundParameters.ContainsKey('Mode') -and
      ($PSBoundParameters.ContainsKey('Profile') -or $Command -in @('setup', 'doctor'))) {
    $Mode = 'developer'
  }
  Invoke-WorkstationAction $Mode $Command
} catch {
  Write-Host "ERROR $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
