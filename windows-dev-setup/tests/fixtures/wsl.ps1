Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

foreach ($name in @(
  'WSL2_TEST_LOG',
  'WSL2_TEST_DISTROS',
  'WSL2_TEST_DEFAULT_VERSION',
  'WSL2_TEST_DEFAULT_DISTRO'
)) {
  if (-not [Environment]::GetEnvironmentVariable($name)) {
    Write-Error -ErrorAction Continue "$name is required"
    exit 90
  }
}

Add-Content -LiteralPath $env:WSL2_TEST_LOG -Value ($args -join ' ')
$command = if ($args.Count -gt 0) { $args[0] } else { '' }

function Get-TestDistros {
  if (-not (Test-Path -LiteralPath $env:WSL2_TEST_DISTROS)) {
    return @()
  }
  return @(
    Get-Content -LiteralPath $env:WSL2_TEST_DISTROS |
      Where-Object { $_ }
  )
}

function Save-TestDistros {
  param([string[]] $Lines)
  Set-Content -LiteralPath $env:WSL2_TEST_DISTROS -Value $Lines
}

switch ($command) {
  '--version' {
    Write-Output 'WSL version: 2.5.9.0'
    Write-Output 'Kernel version: 6.6.87.2'
  }
  '--status' {
    if ($env:WSL2_TEST_WSL_READY -eq '0') {
      Write-Error -ErrorAction Continue 'WSL is not installed.'
      exit 1
    }
    $defaultVersion = '2'
    if (Test-Path -LiteralPath $env:WSL2_TEST_DEFAULT_VERSION) {
      $savedVersion = Get-Content `
        -LiteralPath $env:WSL2_TEST_DEFAULT_VERSION -Raw
      if (-not [string]::IsNullOrWhiteSpace($savedVersion)) {
        $defaultVersion = $savedVersion.Trim()
      }
    }
    Write-Output "Default Version: $defaultVersion"
  }
  '--update' {
    Write-Output 'Checking for updates.'
    Write-Output 'The most recent version of Windows Subsystem for Linux is already installed.'
  }
  '--set-default-version' {
    Set-Content -LiteralPath $env:WSL2_TEST_DEFAULT_VERSION -Value $args[1]
    Write-Output "The operation completed successfully."
  }
  '--list' {
    if ($args -contains '--online') {
      Write-Output 'NAME               FRIENDLY NAME'
      Write-Output 'Ubuntu-24.04       Ubuntu 24.04 LTS'
      Write-Output 'Debian             Debian GNU/Linux'
      exit 0
    }
    $distros = @(Get-TestDistros)
    if ($args -contains '--quiet') {
      foreach ($line in $distros) {
        Write-Output (($line -split '\|', 3)[0])
      }
      exit 0
    }
    if ($args -contains '--verbose') {
      Write-Output '  NAME                   STATE           VERSION'
      $defaultDistro = ''
      if (Test-Path -LiteralPath $env:WSL2_TEST_DEFAULT_DISTRO) {
        $savedDefault = Get-Content `
          -LiteralPath $env:WSL2_TEST_DEFAULT_DISTRO -Raw
        if (-not [string]::IsNullOrWhiteSpace($savedDefault)) {
          $defaultDistro = $savedDefault.Trim()
        }
      }
      foreach ($line in $distros) {
        $parts = $line -split '\|', 3
        $marker = if ($parts[0] -eq $defaultDistro) { '*' } else { ' ' }
        Write-Output (
          '{0} {1,-22} {2,-15} {3}' -f
          $marker, $parts[0], $parts[2], $parts[1]
        )
      }
      exit 0
    }
    Write-Error -ErrorAction Continue 'Unsupported list option.'
    exit 2
  }
  '--install' {
    if ($args -contains '--no-distribution') {
      Write-Output 'The requested operation was successful.'
      exit 0
    }
    $distributionIndex = [Array]::IndexOf($args, '--distribution')
    if ($distributionIndex -lt 0 -or
        $distributionIndex + 1 -ge $args.Count) {
      Write-Error -ErrorAction Continue 'Missing distribution name.'
      exit 2
    }
    $name = $args[$distributionIndex + 1]
    $distros = [Collections.Generic.List[string]]::new()
    foreach ($line in @(Get-TestDistros)) {
      $distros.Add($line)
    }
    $exists = $false
    foreach ($line in $distros) {
      if (($line -split '\|', 3)[0] -eq $name) {
        $exists = $true
      }
    }
    if (-not $exists) {
      $distros.Add("$name|2|Stopped")
      Save-TestDistros @($distros)
    }
    Write-Output "Installing: $name"
    Write-Output 'The distribution was installed successfully.'
  }
  '--set-default' {
    Set-Content -LiteralPath $env:WSL2_TEST_DEFAULT_DISTRO -Value $args[1]
    Write-Output 'The operation completed successfully.'
  }
  '--set-version' {
    $name = $args[1]
    $version = $args[2]
    $updated = @(
      foreach ($line in @(Get-TestDistros)) {
        $parts = $line -split '\|', 3
        if ($parts[0] -eq $name) {
          "$($parts[0])|$version|$($parts[2])"
        } else {
          $line
        }
      }
    )
    Save-TestDistros $updated
    Write-Output 'Conversion in progress, this may take a few minutes.'
    Write-Output 'The operation completed successfully.'
  }
  '--shutdown' {
    Write-Output 'WSL shutdown complete.'
  }
  default {
    Write-Error -ErrorAction Continue "Unsupported WSL command: $command"
    exit 99
  }
}
