Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$rootDir = Split-Path -Parent $PSScriptRoot
$setupScript = Join-Path $rootDir 'setup.ps1'
$fixture = Join-Path $PSScriptRoot 'fixtures\wsl.ps1'
$testTmpDir = Join-Path ([IO.Path]::GetTempPath()) (
  'wsl2-setup-test-' + [guid]::NewGuid().ToString('N')
)
$powerShell = (Get-Process -Id $PID -ErrorAction Stop).Path
$managedEnvironment = @(
  'NO_COLOR',
  'WSL2_MANAGER_TEST_MODE',
  'WSL2_MANAGER_WSL_COMMAND',
  'WSL2_TEST_LOG',
  'WSL2_TEST_DISTROS',
  'WSL2_TEST_DEFAULT_VERSION',
  'WSL2_TEST_DEFAULT_DISTRO',
  'WSL2_TEST_WSL_READY',
  'WSL2_TEST_WSL_FEATURE',
  'WSL2_TEST_VM_FEATURE',
  'WSL2_TEST_ADMIN'
)
$originalEnvironment = @{}
foreach ($name in $managedEnvironment) {
  $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable(
    $name,
    [EnvironmentVariableTarget]::Process
  )
}

function Stop-Test {
  param([string] $Message)
  throw "FAIL: $Message"
}

function Initialize-Case {
  param(
    [string] $Name,
    [string] $WslFeature = 'Enabled',
    [string] $VmFeature = 'Enabled',
    [string] $Admin = '1',
    [string] $WslReady = '1'
  )

  $caseDir = Join-Path $testTmpDir $Name
  New-Item -ItemType Directory -Path $caseDir -Force | Out-Null
  foreach ($file in @(
    'log', 'distros', 'default-version', 'default-distro'
  )) {
    New-Item -ItemType File -Path (Join-Path $caseDir $file) -Force |
      Out-Null
  }

  $env:NO_COLOR = '1'
  $env:WSL2_MANAGER_TEST_MODE = '1'
  $env:WSL2_MANAGER_WSL_COMMAND = $fixture
  $env:WSL2_TEST_LOG = Join-Path $caseDir 'log'
  $env:WSL2_TEST_DISTROS = Join-Path $caseDir 'distros'
  $env:WSL2_TEST_DEFAULT_VERSION = Join-Path $caseDir 'default-version'
  $env:WSL2_TEST_DEFAULT_DISTRO = Join-Path $caseDir 'default-distro'
  $env:WSL2_TEST_WSL_READY = $WslReady
  $env:WSL2_TEST_WSL_FEATURE = $WslFeature
  $env:WSL2_TEST_VM_FEATURE = $VmFeature
  $env:WSL2_TEST_ADMIN = $Admin
  return $caseDir
}

function Invoke-SetupCase {
  param(
    [string] $CaseDir,
    [string[]] $SetupArguments
  )

  $output = Join-Path $CaseDir 'output'
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $powerShell -NoProfile -ExecutionPolicy Bypass `
      -File $setupScript @SetupArguments *> $output
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

function Assert-LogContains {
  param(
    [string] $CaseDir,
    [string] $Expected
  )
  $lines = @(Get-Content -LiteralPath (Join-Path $CaseDir 'log'))
  if ($lines -notcontains $Expected) {
    Stop-Test "expected '$Expected' in the command log"
  }
}

function Assert-LogExcludes {
  param(
    [string] $CaseDir,
    [string] $Unexpected
  )
  $lines = @(Get-Content -LiteralPath (Join-Path $CaseDir 'log'))
  if ($lines -contains $Unexpected) {
    Stop-Test "did not expect '$Unexpected' in the command log"
  }
}

New-Item -ItemType Directory -Path $testTmpDir -Force | Out-Null

try {
  $tokens = $null
  $errors = $null
  [Management.Automation.Language.Parser]::ParseFile(
    $setupScript,
    [ref] $tokens,
    [ref] $errors
  ) | Out-Null
  if ($errors.Count -gt 0) {
    Stop-Test "PowerShell parser reported $($errors.Count) error(s)"
  }

  # Disabled Windows features invoke the official platform-only install and
  # stop before updating or installing a distribution.
  $platform = Initialize-Case -Name 'platform' `
    -WslFeature 'Disabled' -VmFeature 'Disabled'
  if ((Invoke-SetupCase $platform @(
        '--yes', '--no-distro', 'setup'
      )) -ne 0) {
    Stop-Test 'platform initialization failed'
  }
  Assert-LogContains $platform '--install --no-distribution'
  Assert-LogExcludes $platform '--update'
  Assert-LogExcludes $platform '--set-default-version 2'

  # A fresh ready platform updates WSL, selects WSL 2, installs without
  # launching, and chooses the requested default distro.
  $fresh = Initialize-Case 'fresh'
  if ((Invoke-SetupCase $fresh @(
        '--yes', '--distro', 'Ubuntu-24.04', 'setup'
      )) -ne 0) {
    Stop-Test 'fresh WSL 2 setup failed'
  }
  Assert-LogContains $fresh '--update'
  Assert-LogContains $fresh '--set-default-version 2'
  Assert-LogContains $fresh (
    '--install --distribution Ubuntu-24.04 --no-launch'
  )
  Assert-LogContains $fresh '--set-default Ubuntu-24.04'
  $freshDistros = Get-Content -LiteralPath (Join-Path $fresh 'distros')
  if ($freshDistros -notcontains 'Ubuntu-24.04|2|Stopped') {
    Stop-Test 'fresh setup did not persist the simulated WSL 2 distro'
  }

  # Platform-only setup can skip update and does not install a distro.
  $platformOnly = Initialize-Case 'platform-only'
  if ((Invoke-SetupCase $platformOnly @(
        '--no-distro', '--skip-update', 'setup'
      )) -ne 0) {
    Stop-Test 'platform-only setup failed'
  }
  Assert-LogContains $platformOnly '--set-default-version 2'
  Assert-LogExcludes $platformOnly '--update'
  $platformOnlyLog = @(Get-Content -LiteralPath (
    Join-Path $platformOnly 'log'
  ))
  if (@($platformOnlyLog | Where-Object {
        $_ -like '--install --distribution*'
      }).Count -gt 0) {
    Stop-Test 'platform-only setup installed a distribution'
  }

  # Restricted shells may not be able to inspect optional features. A working
  # WSL status is sufficient to continue without demanding elevation.
  $restricted = Initialize-Case -Name 'restricted' `
    -WslFeature 'Unknown' -VmFeature 'Unknown' -Admin '0'
  if ((Invoke-SetupCase $restricted @(
        '--no-distro', '--skip-update', 'setup'
      )) -ne 0) {
    Stop-Test 'working WSL was rejected when feature state was unreadable'
  }
  Assert-LogExcludes $restricted '--install --no-distribution'
  Assert-LogContains $restricted '--set-default-version 2'

  # An existing WSL 1 distribution is converted only with approval.
  $convert = Initialize-Case 'convert'
  Set-Content -LiteralPath (Join-Path $convert 'distros') `
    -Value 'Debian|1|Stopped'
  if ((Invoke-SetupCase $convert @(
        '--yes', '--skip-update', '--distro', 'Debian', 'setup'
      )) -ne 0) {
    Stop-Test 'approved WSL 1 conversion failed'
  }
  Assert-LogContains $convert '--set-version Debian 2'
  Assert-LogContains $convert '--set-default Debian'
  $convertedState = (
    Get-Content -LiteralPath (Join-Path $convert 'distros') -Raw
  ).Trim()
  if ($convertedState -ne 'Debian|2|Stopped') {
    Stop-Test 'conversion did not update the simulated distro version'
  }

  # Existing WSL 2 installations remain untouched.
  $existing = Initialize-Case 'existing'
  Set-Content -LiteralPath (Join-Path $existing 'distros') `
    -Value 'Debian|2|Stopped'
  if ((Invoke-SetupCase $existing @(
        '--skip-update', '--distro', 'Debian', 'setup'
      )) -ne 0) {
    Stop-Test 'existing WSL 2 setup failed'
  }
  Assert-LogExcludes $existing '--set-version Debian 2'
  $existingLog = @(Get-Content -LiteralPath (Join-Path $existing 'log'))
  if (@($existingLog | Where-Object {
        $_ -like '--install --distribution*'
      }).Count -gt 0) {
    Stop-Test 'existing distro was reinstalled'
  }

  # A non-elevated process cannot enable missing platform features.
  $nonAdmin = Initialize-Case -Name 'non-admin' `
    -WslFeature 'Disabled' -VmFeature 'Disabled' -Admin '0'
  if ((Invoke-SetupCase $nonAdmin @('--yes', 'setup')) -eq 0) {
    Stop-Test 'non-elevated platform initialization unexpectedly succeeded'
  }
  Assert-LogExcludes $nonAdmin '--install --no-distribution'

  # Operational commands map directly to safe WSL CLI operations.
  $operations = Initialize-Case 'operations'
  Set-Content -LiteralPath (Join-Path $operations 'distros') `
    -Value 'Ubuntu-24.04|2|Stopped'
  if ((Invoke-SetupCase $operations @('distros', '--online')) -ne 0) {
    Stop-Test 'online distro listing failed'
  }
  Assert-LogContains $operations '--list --online'
  if ((Invoke-SetupCase $operations @('shutdown')) -ne 0) {
    Stop-Test 'WSL shutdown helper failed'
  }
  Assert-LogContains $operations '--shutdown'

  Write-Output 'PASS: WSL 2 platform, distro, conversion, and operations flow'
} finally {
  foreach ($name in $managedEnvironment) {
    [Environment]::SetEnvironmentVariable(
      $name,
      $originalEnvironment[$name],
      [EnvironmentVariableTarget]::Process
    )
  }
  if (Test-Path -LiteralPath $testTmpDir) {
    Remove-Item -LiteralPath $testTmpDir -Recurse -Force
  }
}
