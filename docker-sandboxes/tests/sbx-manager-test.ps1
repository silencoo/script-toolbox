Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$rootDir = Split-Path -Parent $PSScriptRoot
$manager = Join-Path $rootDir 'sbx-manager.ps1'
$fixtureDir = Join-Path $PSScriptRoot 'fixtures'
$shellKit = Join-Path $rootDir 'kits\zsh-shell'
$shellKitVersion = (
  Get-Content -LiteralPath (
    Join-Path $shellKit 'files\home\.config\sbx-manager\zsh-shell.version'
  ) -Raw
).Trim()
$testTmpDir = Join-Path ([IO.Path]::GetTempPath()) (
  'sbx-manager-test-' + [guid]::NewGuid().ToString('N')
)
$powerShell = (Get-Process -Id $PID -ErrorAction Stop).Path

function Stop-Test {
  param([string] $Message)
  throw "FAIL: $Message"
}

function Assert-LogContains {
  param(
    [string] $Path,
    [string] $Expected
  )
  $lines = @(Get-Content -LiteralPath $Path)
  if ($lines -notcontains $Expected) {
    Stop-Test "expected '$Expected' in $Path"
  }
}

function Assert-LogExcludes {
  param(
    [string] $Path,
    [string] $Unexpected
  )
  $lines = @(Get-Content -LiteralPath $Path)
  if ($lines -contains $Unexpected) {
    Stop-Test "did not expect '$Unexpected' in $Path"
  }
}

function Assert-TextContains {
  param(
    [string] $Path,
    [string] $Expected
  )
  $content = Get-Content -LiteralPath $Path -Raw
  if (-not $content.Contains($Expected)) {
    Stop-Test "expected text '$Expected' in $Path"
  }
}

function Assert-TextExcludes {
  param(
    [string] $Path,
    [string] $Unexpected
  )
  $content = Get-Content -LiteralPath $Path -Raw
  if ($content.Contains($Unexpected)) {
    Stop-Test "did not expect text '$Unexpected' in $Path"
  }
}

function Initialize-Case {
  param([string] $Name)

  $caseDir = Join-Path $testTmpDir $Name
  $localAppData = Join-Path $caseDir 'local-app-data'
  New-Item -ItemType Directory -Path $caseDir, $localAppData -Force |
    Out-Null
  New-Item -ItemType File -Path (Join-Path $caseDir 'log') -Force |
    Out-Null
  return $caseDir
}

function Set-CaseEnvironment {
  param([string] $CaseDir)

  $env:LOCALAPPDATA = Join-Path $CaseDir 'local-app-data'
  $env:NO_COLOR = '1'
  $env:SBX_TEST_LOG = Join-Path $CaseDir 'log'
  $env:SBX_TEST_POLICY_STATE = Join-Path $CaseDir 'policy-state'
  $env:SBX_TEST_AUTH_STATE = Join-Path $CaseDir 'auth-state'
  $env:SBX_TEST_SANDBOX_NAMES = ''
  $env:SBX_TEST_SHELL_KIT_CURRENT = '1'
  $env:SBX_TEST_KIT_ADD_TRANSIENT_STATE = $null
  $env:SBX_MANAGER_TEST_MODE = '1'
  $env:SBX_MANAGER_SHELL_KIT = $null
}

function Invoke-ManagerCase {
  param(
    [string] $CaseDir,
    [string[]] $ManagerArguments
  )

  $output = Join-Path $CaseDir 'output'
  $previousPreference = $ErrorActionPreference
  try {
    # Windows PowerShell 5.1 surfaces a child process's stderr as
    # NativeCommandError records. Capture those without aborting the harness.
    $ErrorActionPreference = 'Continue'
    & $powerShell -NoProfile -ExecutionPolicy Bypass `
      -File $manager @ManagerArguments *> $output
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

New-Item -ItemType Directory -Path $testTmpDir -Force | Out-Null
$originalPath = $env:Path
$originalLocalAppData = $env:LOCALAPPDATA
$originalNoColor = $env:NO_COLOR
$originalTestMode = $env:SBX_MANAGER_TEST_MODE
$originalShellKit = $env:SBX_MANAGER_SHELL_KIT
$originalShellKitCurrent = $env:SBX_TEST_SHELL_KIT_CURRENT
$originalKitAddTransientState = $env:SBX_TEST_KIT_ADD_TRANSIENT_STATE

try {
  $env:Path = "$fixtureDir;$originalPath"

  $tokens = $null
  $errors = $null
  [Management.Automation.Language.Parser]::ParseFile(
    $manager,
    [ref] $tokens,
    [ref] $errors
  ) | Out-Null
  if ($errors.Count -gt 0) {
    Stop-Test "PowerShell parser reported $($errors.Count) error(s)"
  }

  # A no-argument invocation must guide a new user to setup without starting
  # installation. Commands that require sbx should give the same next step.
  $firstRun = Initialize-Case 'first-run'
  Set-CaseEnvironment $firstRun
  $env:Path = $firstRun
  if ((Invoke-ManagerCase $firstRun @()) -ne 0) {
    Stop-Test 'first-run guidance failed'
  }
  $firstRunOutput = Join-Path $firstRun 'output'
  Assert-TextContains $firstRunOutput 'First-time setup'
  Assert-TextContains $firstRunOutput (
    '.\sbx-manager.ps1 setup balanced'
  )
  Assert-TextContains $firstRunOutput 'Usage'

  # PowerShell binds an empty positional array as null at function boundaries.
  # Strict mode must not turn supported no-argument defaults into .Count errors.
  $defaultDaemon = Initialize-Case 'default-daemon'
  Set-CaseEnvironment $defaultDaemon
  $env:Path = "$fixtureDir;$originalPath"
  if ((Invoke-ManagerCase $defaultDaemon @('daemon')) -ne 0) {
    Stop-Test 'daemon default action failed'
  }
  Assert-LogContains (Join-Path $defaultDaemon 'log') 'daemon status'

  $defaultNetwork = Initialize-Case 'default-network'
  Set-CaseEnvironment $defaultNetwork
  if ((Invoke-ManagerCase $defaultNetwork @('network')) -ne 0) {
    Stop-Test 'network default action failed'
  }
  Assert-LogContains (Join-Path $defaultNetwork 'log') (
    'policy ls --include-inactive --wide'
  )

  $missingRunArgument = Initialize-Case 'missing-run-argument'
  Set-CaseEnvironment $missingRunArgument
  if ((Invoke-ManagerCase $missingRunArgument @('run')) -eq 0) {
    Stop-Test 'run without an agent unexpectedly succeeded'
  }
  Assert-TextContains (Join-Path $missingRunArgument 'output') (
    'run <agent> [workspace]'
  )

  $defaultSetup = Initialize-Case 'default-setup'
  Set-CaseEnvironment $defaultSetup
  if ((Invoke-ManagerCase $defaultSetup @('--skip-login', 'setup')) -ne 0) {
    Stop-Test 'setup default mode failed'
  }
  Assert-LogContains (Join-Path $defaultSetup 'log') 'policy init balanced'

  $missingSbx = Initialize-Case 'missing-sbx'
  Set-CaseEnvironment $missingSbx
  $env:Path = $missingSbx
  if ((Invoke-ManagerCase $missingSbx @('login')) -eq 0) {
    Stop-Test 'sbx-dependent command succeeded without sbx'
  }
  Assert-TextContains (Join-Path $missingSbx 'output') (
    '.\sbx-manager.ps1 setup balanced'
  )

  $env:Path = "$fixtureDir;$originalPath"

  foreach ($path in @(
    (Join-Path $shellKit 'spec.yaml'),
    (Join-Path $shellKit 'files\home\.zshrc'),
    (Join-Path $shellKit 'files\home\.config\sbx-manager\apply-home-files.sh'),
    (Join-Path $shellKit 'files\home\.config\sbx-manager\show-motd.zsh'),
    (Join-Path $shellKit 'files\home\.config\starship.toml')
  )) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      Stop-Test "default shell kit file is missing: $path"
    }
  }
  if ((Get-Content -LiteralPath (Join-Path $shellKit 'spec.yaml')) -match (
      '^\s+(startup|initFiles):'
    )) {
    Stop-Test (
      'default shell kit uses lifecycle commands that sbx kit add cannot refresh'
    )
  }

  # Fresh setup initializes policy before diagnose/login.
  $fresh = Initialize-Case 'fresh'
  Set-CaseEnvironment $fresh
  if ((Invoke-ManagerCase $fresh @('setup', 'open')) -ne 0) {
    Stop-Test 'fresh setup failed'
  }
  $freshLog = Join-Path $fresh 'log'
  $freshLines = @(Get-Content -LiteralPath $freshLog)
  if ($freshLines[0] -ne 'policy init allow-all') {
    Stop-Test 'fresh setup did not initialize policy first'
  }
  Assert-LogContains $freshLog 'diagnose --output json'
  Assert-LogContains $freshLog 'login'
  Assert-LogExcludes $freshLog 'policy inspect local-policy'
  if ((Get-Content -LiteralPath (Join-Path $fresh 'policy-state') -Raw).Trim() `
      -ne 'allow-all') {
    Stop-Test 'fresh setup did not retain the open preset'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $fresh 'auth-state'))) {
    Stop-Test 'fresh unauthenticated setup did not call sbx login'
  }

  # Matching setup preserves local policy and custom rules.
  $matching = Initialize-Case 'matching'
  Set-CaseEnvironment $matching
  Set-Content -LiteralPath $env:SBX_TEST_POLICY_STATE -Value 'allow-all'
  New-Item -ItemType File -Path $env:SBX_TEST_AUTH_STATE -Force | Out-Null
  if ((Invoke-ManagerCase $matching @('--skip-login', 'setup', 'open')) -ne 0) {
    Stop-Test 'matching setup failed'
  }
  $matchingLog = Join-Path $matching 'log'
  Assert-LogExcludes $matchingLog 'policy reset --force'
  $matchingInitCount = @(
    Get-Content -LiteralPath $matchingLog |
      Where-Object { $_ -eq 'policy init allow-all' }
  ).Count
  if ($matchingInitCount -ne 1) {
    Stop-Test 'matching setup should probe policy initialization only once'
  }

  # A changed preset resets only with explicit --yes approval.
  $existing = Initialize-Case 'existing'
  Set-CaseEnvironment $existing
  Set-Content -LiteralPath $env:SBX_TEST_POLICY_STATE -Value 'allow-all'
  New-Item -ItemType File -Path $env:SBX_TEST_AUTH_STATE -Force | Out-Null
  if ((Invoke-ManagerCase $existing @(
        '--yes', '--skip-login', 'setup', 'balanced'
      )) -ne 0) {
    Stop-Test 'approved preset reset failed'
  }
  $existingLog = Join-Path $existing 'log'
  Assert-LogContains $existingLog 'policy reset --force'
  $existingInitCount = @(
    Get-Content -LiteralPath $existingLog |
      Where-Object { $_ -eq 'policy init balanced' }
  ).Count
  if ($existingInitCount -ne 2) {
    Stop-Test 'changed setup should initialize once before and after reset'
  }

  # Creation keeps Windows paths intact and applies the shared shell kit.
  $launch = Initialize-Case 'launch'
  Set-CaseEnvironment $launch
  $crlfShellKit = Join-Path $launch 'crlf-zsh-shell'
  Copy-Item -LiteralPath $shellKit -Destination $crlfShellKit -Recurse
  $utf8NoBom = [Text.UTF8Encoding]::new($false)
  foreach ($file in @(
    Get-ChildItem -LiteralPath $crlfShellKit -File -Recurse -Force
  )) {
    $content = [IO.File]::ReadAllText($file.FullName)
    $content = $content.Replace("`r`n", "`n").Replace("`r", "`n")
    $content = $content.Replace("`n", "`r`n")
    [IO.File]::WriteAllText($file.FullName, $content, $utf8NoBom)
  }
  $env:SBX_MANAGER_SHELL_KIT = $crlfShellKit
  $workspace = Join-Path $launch 'workspace with spaces'
  New-Item -ItemType Directory -Path $workspace -Force | Out-Null
  if ((Invoke-ManagerCase $launch @(
        'run', 'shell', $workspace, '--name', 'test-shell'
      )) -ne 0) {
    Stop-Test 'sandbox launch helper failed'
  }
  $env:SBX_MANAGER_SHELL_KIT = $null
  $resolvedWorkspace = (Resolve-Path -LiteralPath $workspace).ProviderPath
  Assert-TextContains (Join-Path $launch 'log') (
    'run --name test-shell --kit '
  )
  Assert-TextContains (Join-Path $launch 'log') " shell $resolvedWorkspace"
  Assert-LogContains (Join-Path $launch 'log') 'kit-line-endings lf'
  Assert-LogContains (Join-Path $launch 'log') 'kit-static-files present'

  # Existing names use reattach-only syntax.
  $reattach = Initialize-Case 'reattach'
  Set-CaseEnvironment $reattach
  $env:SBX_TEST_SANDBOX_NAMES = 'test-claude'
  $env:SBX_TEST_SHELL_KIT_CURRENT = '0'
  $env:SBX_TEST_KIT_ADD_TRANSIENT_STATE = Join-Path $reattach 'kit-add-failed'
  $env:SBX_MANAGER_SHELL_KIT = $crlfShellKit
  $reattachWorkspace = Join-Path $reattach 'workspace'
  New-Item -ItemType Directory -Path $reattachWorkspace -Force | Out-Null
  $reattachArguments = @(
    'run', 'claude', $reattachWorkspace,
    '--name', 'test-claude'
  )
  if ((Invoke-ManagerCase -CaseDir $reattach `
        -ManagerArguments $reattachArguments) -ne 0) {
    Stop-Test 'sandbox reattach helper failed'
  }
  $reattachLog = Join-Path $reattach 'log'
  Assert-TextContains $reattachLog 'kit add test-claude '
  $kitAddCount = @(
    Get-Content -LiteralPath $reattachLog |
      Where-Object { $_ -like 'kit add test-claude *' }
  ).Count
  if ($kitAddCount -ne 2) {
    Stop-Test 'transient kit-add failure was not retried exactly once'
  }
  $reattachOutput = Join-Path $reattach 'output'
  Assert-TextContains $reattachOutput (
    'Shell-kit download failed: curl exit 35 ' +
    '(TLS connection ended unexpectedly).'
  )
  Assert-TextContains $reattachOutput 'retrying kit add (2/3)'
  Assert-TextContains $reattachOutput 'Full diagnostic output:'
  Assert-TextExcludes $reattachOutput 'hidden-test-command'
  $diagnosticLogs = @(
    Get-ChildItem -LiteralPath (
      Join-Path $env:LOCALAPPDATA 'sbx-manager\logs'
    ) -Filter 'kit-add-test-claude-*.log' -File
  )
  if ($diagnosticLogs.Count -ne 1) {
    Stop-Test 'transient kit-add failure did not create one diagnostic log'
  }
  Assert-TextContains $diagnosticLogs[0].FullName 'hidden-test-command'
  Assert-TextContains $reattachLog (
    "kits\zsh-shell-refresh\$shellKitVersion"
  )
  Assert-LogContains $reattachLog 'kit-line-endings lf'
  Assert-LogContains $reattachLog 'kit-static-files absent'
  Assert-TextContains $reattachLog (
    'kit-name zsh-shell-refresh-' +
    (($shellKitVersion.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')) +
    '-'
  )
  Assert-TextContains $reattachLog 'files\home test-claude:/tmp/sbx-manager-zsh-shell-refresh/'
  Assert-LogContains $reattachLog 'run --name test-claude'
  $wrongReattach = @(
    Get-Content -LiteralPath $reattachLog |
      Where-Object { $_ -like 'run --name test-claude claude*' }
  )
  if ($wrongReattach.Count -gt 0) {
    Stop-Test 'reattach command retained sandbox creation arguments'
  }

  Write-Output 'PASS: PowerShell sbx-manager setup, policy, and run flow'
} finally {
  $env:Path = $originalPath
  $env:LOCALAPPDATA = $originalLocalAppData
  $env:NO_COLOR = $originalNoColor
  $env:SBX_MANAGER_TEST_MODE = $originalTestMode
  $env:SBX_MANAGER_SHELL_KIT = $originalShellKit
  $env:SBX_TEST_SHELL_KIT_CURRENT = $originalShellKitCurrent
  $env:SBX_TEST_KIT_ADD_TRANSIENT_STATE = $originalKitAddTransientState
  if (Test-Path -LiteralPath $testTmpDir) {
    Remove-Item -LiteralPath $testTmpDir -Recurse -Force
  }
}
