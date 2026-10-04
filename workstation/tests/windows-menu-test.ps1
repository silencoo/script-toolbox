Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$projectDirectory = Split-Path -Parent $PSScriptRoot
$windowsDirectory = Join-Path $projectDirectory 'windows'
$powerShell = (Get-Process -Id $PID -ErrorAction Stop).Path
$testDirectory = Join-Path ([IO.Path]::GetTempPath()) ('workstation-menu-test-' + [guid]::NewGuid().ToString('N'))
$originalLog = $env:WORKSTATION_MENU_TEST_LOG
$originalExit = $env:WORKSTATION_MENU_TEST_EXIT
$script:Cases = 0

function Stop-Test {
  param([string] $Message)
  throw "FAIL: $Message"
}

function Invoke-MenuCase {
  param(
    [string[]] $Arguments = @(),
    [string[]] $Replies = @(),
    [int] $ExpectedExit = 0,
    [int] $ChildExit = 0
  )
  $script:Cases += 1
  $env:WORKSTATION_MENU_TEST_LOG = Join-Path $testDirectory ("case-$($script:Cases).json")
  $env:WORKSTATION_MENU_TEST_EXIT = [string] $ChildExit
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $inputText = ($Replies -join [Environment]::NewLine) + [Environment]::NewLine
    $output = @($inputText | & $powerShell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $testDirectory 'setup.ps1') @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  $text = ($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
  if ($exitCode -ne $ExpectedExit) {
    Stop-Test "Expected exit $ExpectedExit, got $exitCode for $($Arguments -join ' '): $text"
  }
  $record = $null
  if (Test-Path -LiteralPath $env:WORKSTATION_MENU_TEST_LOG) {
    $record = Get-Content -LiteralPath $env:WORKSTATION_MENU_TEST_LOG -Raw | ConvertFrom-Json
  }
  return [pscustomobject] @{ Record = $record; Text = $text }
}

try {
  New-Item -ItemType Directory -Path $testDirectory | Out-Null
  Copy-Item (Join-Path $windowsDirectory 'setup.ps1') (Join-Path $testDirectory 'setup.ps1')
  Copy-Item (Join-Path $windowsDirectory 'packages.psd1') (Join-Path $testDirectory 'packages.psd1')
  $stub = @'
[CmdletBinding()]
param(
  [string] $Command,
  [string[]] $Profiles,
  [string] $Profile,
  [string[]] $PackageIds,
  [string] $ConfigFile,
  [switch] $IncludeOptional,
  [switch] $Yes,
  [switch] $DryRun,
  [switch] $FailFast,
  [switch] $IncludeWSL,
  [string] $WSLDistro,
  [switch] $WSLWebDownload,
  [switch] $WSLSkipUpdate,
  [switch] $EnableLongPaths,
  [switch] $NoGitConfig,
  [switch] $NoShellConfig
)
$record = @{ Child = [IO.Path]::GetFileNameWithoutExtension($PSCommandPath); Options = @{} }
foreach ($key in $PSBoundParameters.Keys) {
  $value = $PSBoundParameters[$key]
  if ($value -is [Management.Automation.SwitchParameter]) { $value = [bool] $value }
  $record.Options[$key] = $value
}
$record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $env:WORKSTATION_MENU_TEST_LOG
exit ([int] $env:WORKSTATION_MENU_TEST_EXIT)
'@
  foreach ($name in @('utilities', 'developer')) {
    Set-Content -LiteralPath (Join-Path $testDirectory "$name.ps1") -Value $stub
  }
  Set-Content -LiteralPath (Join-Path $testDirectory 'wsl.ps1') -Value @'
@{ Child = 'wsl'; Arguments = @($args) } | ConvertTo-Json | Set-Content -LiteralPath $env:WORKSTATION_MENU_TEST_LOG
exit ([int] $env:WORKSTATION_MENU_TEST_EXIT)
'@

  $exitCase = Invoke-MenuCase -Replies @('0')
  if ($null -ne $exitCase.Record -or $exitCase.Text -notmatch 'Windows workstation setup') {
    Stop-Test 'No-argument invocation must show the menu and allow exit without dispatch.'
  }
  $invalid = Invoke-MenuCase -Replies @('9', '0')
  if ($null -ne $invalid.Record -or $invalid.Text -notmatch 'Choose a number from 0 to 6') {
    Stop-Test 'An invalid menu choice must reprompt without dispatch.'
  }
  $cancel = Invoke-MenuCase -Replies @('1', '0')
  if ($null -ne $cancel.Record) { Stop-Test 'Cancelling profile selection dispatched installation.' }
  $utilities = Invoke-MenuCase -Arguments @('-DryRun', '-IncludeOptional') -Replies @('1', '99', '2,3,2')
  if ($utilities.Record.Child -ne 'utilities' -or $utilities.Record.Options.Command -ne 'install' -or
      (@($utilities.Record.Options.Profiles) -join ',') -ne 'core,media' -or
      -not $utilities.Record.Options.DryRun -or -not $utilities.Record.Options.IncludeOptional -or
      $utilities.Text -notmatch 'Enter valid profile numbers') {
    Stop-Test 'Utility selection must validate, deduplicate, and preserve install options.'
  }
  foreach ($choice in @(@('2', 'core'), @('3', 'default'), @('4', 'full'))) {
    $developer = Invoke-MenuCase -Arguments @('-DryRun', '-NoShellConfig', '-IncludeWSL', '-WSLDistro', 'Debian') -Replies @($choice[0])
    if ($developer.Record.Child -ne 'developer' -or $developer.Record.Options.Command -ne 'setup' -or
        $developer.Record.Options.Profile -ne $choice[1] -or -not $developer.Record.Options.DryRun -or
        -not $developer.Record.Options.NoShellConfig -or -not $developer.Record.Options.IncludeWSL -or
        $developer.Record.Options.WSLDistro -ne 'Debian') {
      Stop-Test "Developer choice $($choice[0]) lost its profile or options."
    }
  }
  $wslPreview = Invoke-MenuCase -Arguments @('-DryRun', '-WSLDistro', 'Debian') -Replies @('5')
  if ($null -ne $wslPreview.Record -or $wslPreview.Text -notmatch 'wsl.ps1 --distro Debian setup') {
    Stop-Test 'WSL dry run must preview without dispatch.'
  }
  $wsl = Invoke-MenuCase -Arguments @('-Yes', '-WSLDistro', 'Debian', '-WSLWebDownload', '-WSLSkipUpdate') -Replies @('5')
  if ($wsl.Record.Child -ne 'wsl' -or ($wsl.Record.Arguments -join ' ') -ne '--distro Debian --yes --web-download --skip-update setup') {
    Stop-Test 'WSL selection did not forward the requested distribution and options.'
  }
  $uninstall = Invoke-MenuCase -Replies @('6')
  if ($uninstall.Record.Child -ne 'utilities' -or $uninstall.Record.Options.Command -ne 'uninstall' -or
      $uninstall.Record.Options.PSObject.Properties.Name -contains 'Profiles') {
    Stop-Test 'Uninstall menu must preserve selection from the whole utility catalog.'
  }
  $cli = Invoke-MenuCase -Arguments @('plan', '-Profiles', 'apps,media')
  if ($cli.Record.Child -ne 'utilities' -or $cli.Record.Options.Profiles -ne 'apps,media') {
    Stop-Test 'Existing utility CLI arguments changed.'
  }
  $implicitPlan = Invoke-MenuCase -Arguments @('-Profiles', 'media')
  if ($implicitPlan.Record.Options.Command -ne 'plan') { Stop-Test 'Parameter-only utility invocation must remain a plan.' }
  $developerCli = Invoke-MenuCase -Arguments @('install', '-Mode', 'developer', '-Profile', 'core', '-Yes', '-NoGitConfig')
  if ($developerCli.Record.Child -ne 'developer' -or $developerCli.Record.Options.Command -ne 'setup' -or
      -not $developerCli.Record.Options.Yes -or -not $developerCli.Record.Options.NoGitConfig) {
    Stop-Test 'Unified developer install did not preserve configuration switches.'
  }
  $legacy = Invoke-MenuCase -Arguments @('setup', '-Profile', 'default')
  if ($legacy.Record.Child -ne 'developer') { Stop-Test 'The previous developer command shape must remain usable at the new path.' }
  $failed = Invoke-MenuCase -Arguments @('plan') -ChildExit 7 -ExpectedExit 7
  $rejected = Invoke-MenuCase -Arguments @('plan', '-Mode', 'utilities', '-Profile', 'core') -ExpectedExit 1
  if ($null -ne $rejected.Record -or $rejected.Text -notmatch '-Profile applies to another mode') {
    Stop-Test 'Conflicting mode-specific options must fail before dispatch.'
  }
  $unsupported = Invoke-MenuCase -Arguments @('uninstall', '-Mode', 'developer') -ExpectedExit 1
  if ($null -ne $unsupported.Record) { Stop-Test 'Unsupported developer uninstall was dispatched.' }

  Write-Output "PASS: Windows menu, CLI compatibility, cancellation, dry runs, and exit propagation ($($script:Cases) cases)"
} finally {
  $env:WORKSTATION_MENU_TEST_LOG = $originalLog
  $env:WORKSTATION_MENU_TEST_EXIT = $originalExit
  if (Test-Path -LiteralPath $testDirectory) { Remove-Item -LiteralPath $testDirectory -Recurse -Force }
}
