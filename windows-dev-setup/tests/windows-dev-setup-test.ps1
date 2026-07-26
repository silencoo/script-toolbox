Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$setupDir = Split-Path -Parent $PSScriptRoot
$setupScript = Join-Path $setupDir 'setup.ps1'
$configFile = Join-Path $setupDir 'packages.psd1'
$powerShell = (Get-Process -Id $PID -ErrorAction Stop).Path
$testDirectory = Join-Path ([IO.Path]::GetTempPath()) (
  'windows-dev-setup-test-' + [guid]::NewGuid().ToString('N')
)

function Stop-Test {
  param([string] $Message)
  throw "FAIL: $Message"
}

try {
  New-Item -ItemType Directory -Path $testDirectory -Force | Out-Null

  $tokens = $null
  $errors = $null
  [Management.Automation.Language.Parser]::ParseFile(
    $setupScript,
    [ref] $tokens,
    [ref] $errors
  ) | Out-Null
  if ($errors.Count -gt 0) {
    Stop-Test "PowerShell parser reported $($errors.Count) error(s)."
  }

  $config = Import-PowerShellDataFile -LiteralPath $configFile
  if ($config.SchemaVersion -ne 1) {
    Stop-Test 'Unexpected package configuration schema.'
  }
  if ($config.PythonVersion -ne '3.14.6') {
    Stop-Test 'The exact Python version pin changed unexpectedly.'
  }

  $identifiers = @{}
  foreach ($groupName in $config.Groups.Keys) {
    foreach ($package in @($config.Groups[$groupName])) {
      if ($identifiers.ContainsKey($package.Id)) {
        Stop-Test "Duplicate package identifier: $($package.Id)"
      }
      $identifiers[$package.Id] = $true
    }
  }
  foreach ($required in @(
      'EclipseAdoptium.Temurin.25.JDK',
      'Microsoft.DotNet.SDK.10',
      'Rustlang.Rustup',
      'Schniz.fnm',
      'astral-sh.uv'
    )) {
    if (-not $identifiers.ContainsKey($required)) {
      Stop-Test "Required package is missing: $required"
    }
  }

  foreach ($profileName in @('core', 'default', 'full')) {
    $outputFile = Join-Path $testDirectory "$profileName-plan.txt"
    & $powerShell -NoProfile -ExecutionPolicy Bypass -File $setupScript `
      plan -Profile $profileName *> $outputFile
    if ($LASTEXITCODE -ne 0) {
      Stop-Test "Plan command failed for profile '$profileName'."
    }
    $output = Get-Content -LiteralPath $outputFile -Raw
    if ($output -notmatch "Plan: $profileName profile") {
      Stop-Test "Plan output did not identify profile '$profileName'."
    }
  }

  $defaultOutput = Get-Content `
    -LiteralPath (Join-Path $testDirectory 'default-plan.txt') -Raw
  if ($defaultOutput -notmatch 'Python: exact CPython 3\.14\.6') {
    Stop-Test 'Default plan did not show the exact Python pin.'
  }
  if ($defaultOutput -notmatch 'EclipseAdoptium\.Temurin\.25\.JDK') {
    Stop-Test 'Default plan did not include JDK 25 LTS.'
  }

  Write-Output 'PASS: Windows dev setup parser, catalog, and plans'
} finally {
  if (Test-Path -LiteralPath $testDirectory) {
    Remove-Item -LiteralPath $testDirectory -Recurse -Force
  }
}
