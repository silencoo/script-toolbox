Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$projectDirectory = Split-Path -Parent $PSScriptRoot
$setupDir = Join-Path $projectDirectory 'windows'
$setupScript = Join-Path $setupDir 'setup.ps1'
$developerScript = Join-Path $setupDir 'developer.ps1'
$wslScript = Join-Path $setupDir 'wsl.ps1'
$configFile = Join-Path $setupDir 'developer-packages.psd1'
$utilityConfigFile = Join-Path $setupDir 'packages.psd1'
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

  $wslTokens = $null
  $wslErrors = $null
  [Management.Automation.Language.Parser]::ParseFile(
    $wslScript,
    [ref] $wslTokens,
    [ref] $wslErrors
  ) | Out-Null
  if ($wslErrors.Count -gt 0) {
    Stop-Test "PowerShell parser reported $($wslErrors.Count) WSL error(s)."
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
      'astral-sh.uv',
      'M2Team.NanaZip',
      'VSCodium.VSCodium'
    )) {
    if (-not $identifiers.ContainsKey($required)) {
      Stop-Test "Required package is missing: $required"
    }
  }

  if ($identifiers.ContainsKey('Microsoft.VisualStudioCode')) {
    Stop-Test 'Developer catalog still installs VS Code.'
  }
  $editor = @($config.Groups.core | Where-Object { $_.Id -eq 'VSCodium.VSCodium' })
  if ($editor.Count -ne 1 -or $editor[0].Command -ne 'codium') {
    Stop-Test 'VSCodium must use the codium command for health checks.'
  }

  # Exercise migration of an existing managed profile using the real writer,
  # entirely inside the test directory rather than the user's shell profiles.
  $developerTokens = $null
  $developerErrors = $null
  $developerAst = [Management.Automation.Language.Parser]::ParseFile(
    $developerScript, [ref] $developerTokens, [ref] $developerErrors
  )
  if ($developerErrors.Count -gt 0) { Stop-Test 'Developer implementation has parser errors.' }
  foreach ($definition in $developerAst.FindAll({
      param($node)
      $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -in @('Set-ManagedProfileBlock', 'Write-Skip', 'Write-Success')
    }, $true)) {
    Invoke-Expression $definition.Extent.Text
  }
  $developerSource = Get-Content -LiteralPath $developerScript -Raw
  $blockMatch = [regex]::Match($developerSource, "(?ms)^\s*\`$profileBlock = @'\r?\n(.*?)\r?\n'@")
  if (-not $blockMatch.Success) { Stop-Test 'Managed PowerShell block was not found.' }
  $block = $blockMatch.Groups[1].Value
  if ([regex]::Matches($block, "'codium --wait'").Count -ne 3 -or $block -match "'code --wait'") {
    Stop-Test 'Shell editor settings must all use codium --wait.'
  }
  $script:MarkerStart = '# >>> windows-dev-setup >>>'
  $script:MarkerEnd = '# <<< windows-dev-setup <<<'
  $profilePath = Join-Path $testDirectory 'existing-profile.ps1'
  Set-Content -LiteralPath $profilePath -Value @'
# User configuration stays intact
$env:MY_CUSTOM_SETTING = 'keep'
# >>> windows-dev-setup >>>
$env:EDITOR = 'code --wait'
# <<< windows-dev-setup <<<
'@
  $originalProfile = [IO.File]::ReadAllBytes($profilePath)
  Set-ManagedProfileBlock -Path $profilePath -Block $block
  $updatedProfile = Get-Content -LiteralPath $profilePath -Raw
  if ($updatedProfile -notmatch 'MY_CUSTOM_SETTING' -or
      [regex]::Matches($updatedProfile, [regex]::Escape($script:MarkerStart)).Count -ne 1 -or
      $updatedProfile -match "'code --wait'") {
    Stop-Test 'Profile migration lost user settings or duplicated the managed block.'
  }
  $backupPath = "$profilePath.windows-dev-setup.bak"
  if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($backupPath)) -ne
      [Convert]::ToBase64String($originalProfile)) {
    Stop-Test 'The first profile backup did not preserve the original bytes.'
  }
  Set-ManagedProfileBlock -Path $profilePath -Block $block
  if ((Get-Content -LiteralPath $profilePath -Raw) -ne $updatedProfile -or
      [Convert]::ToBase64String([IO.File]::ReadAllBytes($backupPath)) -ne
      [Convert]::ToBase64String($originalProfile)) {
    Stop-Test 'Repeat profile migration changed configuration or overwrote the first backup.'
  }

  $utilityConfig = Import-PowerShellDataFile -LiteralPath $utilityConfigFile
  $allowedSharedIdentifiers = @{
    'M2Team.NanaZip' = $true
    'VSCodium.VSCodium' = $true
  }
  foreach ($id in $identifiers.Keys) {
    $isAllowedShared = $allowedSharedIdentifiers.ContainsKey($id)
    if ($utilityConfig.Packages.ContainsKey($id) -and
        -not $isAllowedShared) {
      Stop-Test "Package is owned by both setup catalogs: $id"
    }
    foreach ($utilityId in $utilityConfig.Packages.Keys) {
      $utilityPackage = $utilityConfig.Packages[$utilityId]
      if (-not $isAllowedShared -and
          $utilityPackage.ContainsKey('Conflicts') -and
          @($utilityPackage.Conflicts) -contains $id) {
        Stop-Test (
          "Developer package '$id' conflicts with utility '$utilityId'."
        )
      }
    }
  }

  foreach ($profileName in @('core', 'default', 'full')) {
    $outputFile = Join-Path $testDirectory "$profileName-plan.txt"
    & $powerShell -NoProfile -ExecutionPolicy Bypass -File $setupScript `
      plan -Mode developer -Profile $profileName *> $outputFile
    $output = Get-Content -LiteralPath $outputFile -Raw
    if ($LASTEXITCODE -ne 0) {
      Stop-Test (
        "Plan command failed for profile '$profileName':" +
        [Environment]::NewLine + $output.Trim()
      )
    }
    if ($output -notmatch "Plan: $profileName profile") {
      Stop-Test "Plan output did not identify profile '$profileName'."
    }
  }

  $defaultOutput = Get-Content `
    -LiteralPath (Join-Path $testDirectory 'default-plan.txt') -Raw
  if ($defaultOutput -notmatch 'VSCodium\.VSCodium' -or
      $defaultOutput -match 'Microsoft\.VisualStudioCode') {
    Stop-Test 'Developer plan must install VSCodium instead of VS Code.'
  }
  if ($defaultOutput -notmatch 'Python: exact CPython 3\.14\.6') {
    Stop-Test 'Default plan did not show the exact Python pin.'
  }
  if ($defaultOutput -notmatch 'EclipseAdoptium\.Temurin\.25\.JDK') {
    Stop-Test 'Default plan did not include JDK 25 LTS.'
  }

  $wslPlanFile = Join-Path $testDirectory 'wsl-plan.txt'
  & $powerShell -NoProfile -ExecutionPolicy Bypass -File $setupScript `
    plan -Mode developer -Profile default -IncludeWSL -WSLDistro Debian *> $wslPlanFile
  $wslPlan = Get-Content -LiteralPath $wslPlanFile -Raw
  if ($LASTEXITCODE -ne 0) {
    Stop-Test (
      'WSL plan failed:' + [Environment]::NewLine + $wslPlan.Trim()
    )
  }
  if ($wslPlan -notmatch 'WSL 2 \+ Debian:\s+enabled') {
    Stop-Test 'WSL plan did not show the selected distribution.'
  }

  Write-Output 'PASS: Windows developer setup, VSCodium catalog, WSL parser, and plans'
} finally {
  if (Test-Path -LiteralPath $testDirectory) {
    Remove-Item -LiteralPath $testDirectory -Recurse -Force
  }
}
