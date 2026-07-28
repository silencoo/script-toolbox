# Safe, profile-based utility installer for Windows 10 and Windows 11.
# Compatible with Windows PowerShell 5.1 and PowerShell 7+.

[CmdletBinding(PositionalBinding = $true)]
param(
  [Parameter(Position = 0)]
  [ValidateSet('plan', 'install', 'uninstall', 'list')]
  [string] $Command = 'plan',

  [string[]] $Profiles = @('core'),

  [string[]] $PackageIds = @(),

  [string] $ConfigFile = '',

  [switch] $IncludeOptional,
  [switch] $Yes,
  [switch] $DryRun,
  [switch] $FailFast
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ConfigFile)) {
  $ConfigFile = Join-Path $PSScriptRoot 'packages.psd1'
}
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference `
    -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$script:ScriptVersion = '0.2.0'
$script:Config = $null
$script:SelectedProfiles = @()
$script:SelectedPackages = @()
$script:ProfilesWereSpecified = $PSBoundParameters.ContainsKey('Profiles')
$script:Failures = New-Object 'System.Collections.Generic.List[string]'

function Stop-Setup {
  param([string] $Message)
  throw [System.InvalidOperationException]::new($Message)
}

function Write-Section {
  param([string] $Title)

  Write-Host ''
  Write-Host $Title -ForegroundColor Cyan
  Write-Host ('-' * 68)
}

function Write-InfoLine {
  param([string] $Message)
  Write-Host "==> $Message"
}

function Write-Success {
  param([string] $Message)
  Write-Host "OK   $Message" -ForegroundColor Green
}

function Write-Skip {
  param([string] $Message)
  Write-Host "SKIP $Message" -ForegroundColor DarkGray
}

function Write-WarnLine {
  param([string] $Message)
  Write-Host "WARN $Message" -ForegroundColor Yellow
}

function Test-IsWindows {
  return $env:OS -eq 'Windows_NT'
}

function Resolve-Application {
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
  Write-Host (
    '    $ ' + $FilePath + ' ' + ($displayArguments -join ' ')
  ) -ForegroundColor DarkGray
}

function Invoke-NativeCapture {
  param(
    [Parameter(Mandatory = $true)][string] $FilePath,
    [string[]] $ArgumentList = @()
  )

  $previousPreference = $ErrorActionPreference
  $global:LASTEXITCODE = 0
  try {
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

function Get-NormalizedProfiles {
  $normalized = New-Object 'System.Collections.Generic.List[string]'
  $seen = @{}

  foreach ($value in @($Profiles)) {
    foreach ($candidate in @($value -split ',')) {
      $name = $candidate.Trim().ToLowerInvariant()
      if ([string]::IsNullOrWhiteSpace($name)) {
        continue
      }
      if (-not $seen.ContainsKey($name)) {
        $seen[$name] = $true
        $normalized.Add($name)
      }
    }
  }

  if ($normalized.Count -eq 0) {
    $normalized.Add('core')
  }
  return $normalized.ToArray()
}

function Import-SetupConfig {
  if (-not (Test-Path -LiteralPath $ConfigFile -PathType Leaf)) {
    Stop-Setup "Configuration file not found: $ConfigFile"
  }

  $loaded = Import-PowerShellDataFile -LiteralPath $ConfigFile
  if ($loaded.SchemaVersion -ne 1) {
    Stop-Setup "Unsupported configuration schema: $($loaded.SchemaVersion)"
  }

  $selectedProfiles = @(Get-NormalizedProfiles)
  foreach ($profileName in $selectedProfiles) {
    if (-not $loaded.Profiles.ContainsKey($profileName)) {
      Stop-Setup (
        "Unknown profile '$profileName'. Run '.\setup.ps1 list' for choices."
      )
    }
  }

  foreach ($profileName in $loaded.Profiles.Keys) {
    $profile = $loaded.Profiles[$profileName]
    if ([string]::IsNullOrWhiteSpace($profile.Description)) {
      Stop-Setup "Profile '$profileName' needs a description."
    }
    foreach ($id in @($profile.Packages) + @($profile.OptionalPackages)) {
      if (-not $loaded.Packages.ContainsKey($id)) {
        Stop-Setup "Profile '$profileName' refers to unknown package '$id'."
      }
    }
  }

  foreach ($id in $loaded.Packages.Keys) {
    $package = $loaded.Packages[$id]
    if ([string]::IsNullOrWhiteSpace($package.Name) -or
        [string]::IsNullOrWhiteSpace($package.Purpose)) {
      Stop-Setup "Package '$id' needs Name and Purpose."
    }
    foreach ($relatedKey in @('Conflicts', 'Replaces')) {
      if ($package.ContainsKey($relatedKey)) {
        foreach ($relatedId in @($package[$relatedKey])) {
          if ($relatedId -ne '7zip.7zip' -and
              -not $loaded.Packages.ContainsKey($relatedId)) {
            Stop-Setup (
              "Package '$id' has unknown $relatedKey entry '$relatedId'."
            )
          }
        }
      }
    }
  }

  $requestedIds = New-Object 'System.Collections.Generic.List[string]'
  $optionalIds = @{}
  foreach ($profileName in $selectedProfiles) {
    $profile = $loaded.Profiles[$profileName]
    foreach ($id in @($profile.Packages)) {
      $requestedIds.Add($id)
    }
    if ($IncludeOptional) {
      foreach ($id in @($profile.OptionalPackages)) {
        $requestedIds.Add($id)
        $optionalIds[$id.ToLowerInvariant()] = $true
      }
    }
  }

  $replacedIds = @{}
  foreach ($id in $requestedIds) {
    $package = $loaded.Packages[$id]
    if ($package.ContainsKey('Replaces')) {
      foreach ($replacedId in @($package.Replaces)) {
        $replacedIds[$replacedId.ToLowerInvariant()] = $true
      }
    }
  }

  $seenPackages = @{}
  $selectedPackages = New-Object 'System.Collections.Generic.List[object]'
  foreach ($id in $requestedIds) {
    $key = $id.ToLowerInvariant()
    if ($seenPackages.ContainsKey($key) -or
        $replacedIds.ContainsKey($key)) {
      continue
    }
    $seenPackages[$key] = $true

    $definition = $loaded.Packages[$id]
    $selectedPackages.Add([pscustomobject] @{
      Id = $id
      Name = $definition.Name
      Purpose = $definition.Purpose
      Optional = $optionalIds.ContainsKey($key)
      Conflicts = if ($definition.ContainsKey('Conflicts')) {
        @($definition.Conflicts)
      } else {
        @()
      }
      AvailabilityNote = if (
        $definition.ContainsKey('AvailabilityNote')
      ) {
        $definition.AvailabilityNote
      } else {
        $null
      }
    })
  }

  $script:Config = $loaded
  $script:SelectedProfiles = $selectedProfiles
  $script:SelectedPackages = $selectedPackages.ToArray()
}

function Show-Profiles {
  Write-Section "Workstation utilities for Windows $($script:ScriptVersion)"
  foreach ($profileName in @(
      'core',
      'media',
      'maintenance',
      'desktop',
      'admin',
      'power-archive'
    )) {
    $profile = $script:Config.Profiles[$profileName]
    $requiredCount = @($profile.Packages).Count
    $optionalCount = @($profile.OptionalPackages).Count
    Write-Host (
      '  {0,-15} {1,2} required, {2,2} optional  {3}' -f
      $profileName,
      $requiredCount,
      $optionalCount,
      $profile.Description
    )
  }

  Write-Host ''
  Write-Host 'Use -IncludeOptional to add opt-in alternatives and launchers.'
  Write-WarnLine (
    'The admin profile is explicit because tools may require elevation, ' +
    'drivers, network access, or account configuration.'
  )
}

function Show-Plan {
  Write-Section (
    'Plan: ' + ($script:SelectedProfiles -join ', ') + ' profile(s)'
  )
  Write-Host "Config: $ConfigFile"
  Write-Host (
    'Optional packages: ' +
    $(if ($IncludeOptional) { 'included' } else { 'excluded' })
  )
  Write-Host ''

  foreach ($package in $script:SelectedPackages) {
    $suffix = if ($package.Optional) { ' [optional]' } else { '' }
    Write-Host (
      '  {0,-38} {1} - {2}{3}' -f
      $package.Id,
      $package.Name,
      $package.Purpose,
      $suffix
    )
    if (-not [string]::IsNullOrWhiteSpace($package.AvailabilityNote)) {
      Write-WarnLine "  $($package.Name): $($package.AvailabilityNote)"
    }
  }

  if ($script:SelectedProfiles -contains 'power-archive') {
    Write-Host ''
    Write-Host (
      'Archive selection: 7-Zip Zstandard Edition replaces NanaZip in this ' +
      'plan.'
    )
    Write-WarnLine (
      'If NanaZip or standard 7-Zip is already installed, remove it ' +
      'manually after reviewing file associations, then rerun this installer.'
    )
  }

  Write-Host ''
  Write-Host 'Safety boundary:'
  Write-Host '  - installs missing packages only'
  Write-Host '  - the install action never uninstalls applications or deletes files'
  Write-Host '  - never clears caches or changes Windows security settings'
}

function Confirm-Install {
  if ($Yes -or $DryRun) {
    return $true
  }
  $reply = Read-Host 'Install the missing packages in this plan? [y/N]'
  return $reply -match '^(?i:y|yes)$'
}

function Assert-WindowsHost {
  if (-not (Test-IsWindows)) {
    Stop-Setup (
      'Package installation and the uninstall menu must run on Windows 10 ' +
      'or Windows 11.'
    )
  }
}

function Get-WingetPath {
  $winget = Resolve-Application 'winget.exe'
  if ($null -eq $winget) {
    Stop-Setup (
      'WinGet is required. Install or update Microsoft App Installer, open ' +
      'a new PowerShell window, and rerun this command.'
    )
  }
  return $winget
}

function Test-WingetPackageInstalled {
  param(
    [string] $WingetPath,
    [string] $Id
  )

  $result = Invoke-NativeCapture -FilePath $WingetPath -ArgumentList @(
    'list',
    '--id', $Id,
    '--exact',
    '--source', 'winget',
    '--accept-source-agreements',
    '--disable-interactivity'
  )
  return $result.ExitCode -eq 0
}

function Get-CatalogPackageRecord {
  param([string] $Id)

  $definition = $script:Config.Packages[$Id]
  return [pscustomobject] @{
    Id = $Id
    Name = $definition.Name
    Purpose = $definition.Purpose
  }
}

function Get-UninstallCandidates {
  $candidateIds = New-Object 'System.Collections.Generic.List[string]'
  $seen = @{}

  if (@($PackageIds).Count -gt 0) {
    foreach ($value in @($PackageIds)) {
      foreach ($candidate in @($value -split ',')) {
        $id = $candidate.Trim()
        if ([string]::IsNullOrWhiteSpace($id)) {
          continue
        }
        if (-not $script:Config.Packages.ContainsKey($id)) {
          Stop-Setup (
            "Unknown package ID '$id'. Use '.\setup.ps1 uninstall' to " +
            'choose from the catalog.'
          )
        }
        $canonicalId = @(
          $script:Config.Packages.Keys |
            Where-Object { $_ -ieq $id }
        )[0]
        $key = $canonicalId.ToLowerInvariant()
        if (-not $seen.ContainsKey($key)) {
          $seen[$key] = $true
          $candidateIds.Add($canonicalId)
        }
      }
    }
  } elseif ($script:ProfilesWereSpecified) {
    foreach ($profileName in $script:SelectedProfiles) {
      $profile = $script:Config.Profiles[$profileName]
      foreach ($id in @($profile.Packages) + @($profile.OptionalPackages)) {
        $key = $id.ToLowerInvariant()
        if (-not $seen.ContainsKey($key)) {
          $seen[$key] = $true
          $candidateIds.Add($id)
        }
      }
    }
  } else {
    foreach ($id in $script:Config.Packages.Keys) {
      $key = $id.ToLowerInvariant()
      if (-not $seen.ContainsKey($key)) {
        $seen[$key] = $true
        $candidateIds.Add($id)
      }
    }
  }

  return @(
    $candidateIds |
      ForEach-Object { Get-CatalogPackageRecord -Id $_ } |
      Sort-Object -Property Name, Id
  )
}

function Select-InstalledPackagesForUninstall {
  param(
    [string] $WingetPath,
    [object[]] $Candidates
  )

  Write-Section 'Installed workstation utilities'
  Write-InfoLine 'Checking catalog packages with WinGet'

  $installed = New-Object 'System.Collections.Generic.List[object]'
  foreach ($package in $Candidates) {
    if (Test-WingetPackageInstalled -WingetPath $WingetPath `
        -Id $package.Id) {
      $installed.Add($package)
    }
  }

  if ($installed.Count -eq 0) {
    Write-Skip 'No matching catalog packages are installed.'
    return @()
  }

  Write-Host ''
  for ($index = 0; $index -lt $installed.Count; $index += 1) {
    $package = $installed[$index]
    Write-Host (
      '  {0,2}. {1,-30} {2} - {3}' -f
      ($index + 1),
      $package.Name,
      $package.Id,
      $package.Purpose
    )
  }

  Write-Host ''
  $reply = Read-Host (
    'Enter package numbers separated by commas, or Q to cancel'
  )
  if ([string]::IsNullOrWhiteSpace($reply) -or
      $reply -match '^(?i:q|quit|cancel)$') {
    return @()
  }

  $selected = New-Object 'System.Collections.Generic.List[object]'
  $seenNumbers = @{}
  foreach ($part in @($reply -split '[,\s]+')) {
    if ([string]::IsNullOrWhiteSpace($part)) {
      continue
    }
    $number = 0
    if (-not [int]::TryParse($part, [ref] $number) -or
        $number -lt 1 -or $number -gt $installed.Count) {
      Stop-Setup (
        "Invalid uninstall selection '$part'. No packages were removed."
      )
    }
    if (-not $seenNumbers.ContainsKey($number)) {
      $seenNumbers[$number] = $true
      $selected.Add($installed[$number - 1])
    }
  }

  return $selected.ToArray()
}

function Show-UninstallSelection {
  param([object[]] $Packages)

  Write-Section 'Uninstall selection'
  foreach ($package in $Packages) {
    Write-Host (
      '  {0,-38} {1} - {2}' -f
      $package.Id,
      $package.Name,
      $package.Purpose
    )
  }
  Write-Host ''
  Write-Host 'Removal boundary:'
  Write-Host '  - removes only the selected application packages'
  Write-Host (
    '  - does not issue commands to delete user files, password databases, ' +
    'or backups'
  )
  Write-Host '  - never clears caches or changes Windows security settings'
}

function Confirm-Uninstall {
  if ($Yes -or $DryRun) {
    return $true
  }
  $reply = Read-Host (
    'Type UNINSTALL to remove exactly the packages shown above'
  )
  return $reply -ceq 'UNINSTALL'
}

function Uninstall-WingetPackages {
  param(
    [string] $WingetPath,
    [object[]] $Packages
  )

  Write-Section 'Uninstalling selected WinGet packages'
  $position = 0
  foreach ($package in $Packages) {
    $position += 1
    Write-InfoLine "[$position/$($Packages.Count)] $($package.Name)"

    try {
      if (-not $DryRun -and
          -not (Test-WingetPackageInstalled -WingetPath $WingetPath `
            -Id $package.Id)) {
        Write-Skip "$($package.Id) is not installed"
        continue
      }

      Invoke-NativeChecked -FilePath $WingetPath -ArgumentList @(
        'uninstall',
        '--id', $package.Id,
        '--exact',
        '--source', 'winget',
        '--accept-source-agreements',
        '--disable-interactivity',
        '--silent'
      ) -Description "Uninstalling $($package.Name)"

      if (-not $DryRun) {
        Write-Success "$($package.Name) uninstalled"
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

function Show-UninstallSummary {
  Write-Section 'Summary'
  if ($script:Failures.Count -eq 0) {
    if ($DryRun) {
      Write-Success 'Dry run completed; no changes were made'
    } else {
      Write-Success 'Selected utility packages were uninstalled'
    }
  } else {
    Write-WarnLine "$($script:Failures.Count) package(s) need attention:"
    foreach ($failure in $script:Failures) {
      Write-Host "  - $failure"
    }
  }
}

function Assert-NoInstalledConflicts {
  param([string] $WingetPath)

  foreach ($package in $script:SelectedPackages) {
    foreach ($conflictId in @($package.Conflicts)) {
      if (Test-WingetPackageInstalled -WingetPath $WingetPath `
          -Id $conflictId) {
        Stop-Setup (
          "$($package.Name) overlaps with installed package '$conflictId'. " +
          'Review and remove the conflicting archive application manually; ' +
          'this initializer will not uninstall it.'
        )
      }
    }
  }
}

function Install-WingetPackages {
  param([string] $WingetPath)

  Write-Section 'Installing missing WinGet packages'
  $position = 0
  foreach ($package in $script:SelectedPackages) {
    $position += 1
    Write-InfoLine (
      "[$position/$($script:SelectedPackages.Count)] $($package.Name)"
    )

    try {
      if (-not $DryRun -and
          (Test-WingetPackageInstalled -WingetPath $WingetPath `
            -Id $package.Id)) {
        Write-Skip "$($package.Id) is already installed"
        continue
      }

      Invoke-NativeChecked -FilePath $WingetPath -ArgumentList @(
        'install',
        '--id', $package.Id,
        '--exact',
        '--source', 'winget',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--disable-interactivity',
        '--silent'
      ) -Description "Installing $($package.Name)"

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

function Show-Summary {
  Write-Section 'Summary'
  if ($script:Failures.Count -eq 0) {
    if ($DryRun) {
      Write-Success 'Dry run completed; no changes were made'
    } else {
      Write-Success 'Requested utility packages are installed'
    }
  } else {
    Write-WarnLine "$($script:Failures.Count) package(s) need attention:"
    foreach ($failure in $script:Failures) {
      Write-Host "  - $failure"
    }
  }
}

try {
  Import-SetupConfig

  if ($Command -ne 'uninstall' -and @($PackageIds).Count -gt 0) {
    Stop-Setup '-PackageIds is valid only with the uninstall command.'
  }

  switch ($Command) {
    'list' {
      Show-Profiles
      exit 0
    }
    'plan' {
      Show-Plan
      exit 0
    }
    'install' {
      Show-Plan
      if (-not (Confirm-Install)) {
        Write-WarnLine 'Installation cancelled; no changes were made.'
        exit 0
      }

      if ($DryRun) {
        Install-WingetPackages -WingetPath 'winget'
      } else {
        Assert-WindowsHost
        $winget = Get-WingetPath
        Assert-NoInstalledConflicts -WingetPath $winget
        Install-WingetPackages -WingetPath $winget
      }

      Show-Summary
      if ($script:Failures.Count -gt 0) {
        exit 1
      }
      exit 0
    }
    'uninstall' {
      $candidates = @(Get-UninstallCandidates)
      if ($candidates.Count -eq 0) {
        Write-Skip 'No catalog packages matched the uninstall request.'
        exit 0
      }

      if (@($PackageIds).Count -gt 0 -and $DryRun) {
        $packagesToRemove = $candidates
        $winget = 'winget'
      } else {
        Assert-WindowsHost
        $winget = Get-WingetPath
        if (@($PackageIds).Count -gt 0) {
          $packagesToRemove = $candidates
        } else {
          $packagesToRemove = @(
            Select-InstalledPackagesForUninstall `
              -WingetPath $winget `
              -Candidates $candidates
          )
        }
      }

      if (@($packagesToRemove).Count -eq 0) {
        Write-WarnLine 'Uninstall cancelled; no changes were made.'
        exit 0
      }

      Show-UninstallSelection -Packages $packagesToRemove
      if (-not (Confirm-Uninstall)) {
        Write-WarnLine 'Uninstall cancelled; no changes were made.'
        exit 0
      }

      Uninstall-WingetPackages `
        -WingetPath $winget `
        -Packages $packagesToRemove
      Show-UninstallSummary
      if ($script:Failures.Count -gt 0) {
        exit 1
      }
      exit 0
    }
  }
} catch {
  Write-Host ''
  Write-Host "ERROR $($_.Exception.Message)" -ForegroundColor Red
  if (-not [string]::IsNullOrWhiteSpace($_.InvocationInfo.PositionMessage)) {
    Write-Host $_.InvocationInfo.PositionMessage -ForegroundColor DarkGray
  }
  if (-not [string]::IsNullOrWhiteSpace($_.ScriptStackTrace)) {
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
  }
  exit 1
}
