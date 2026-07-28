Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$projectDirectory = Split-Path -Parent $PSScriptRoot
$setupScript = Join-Path $projectDirectory 'windows\setup.ps1'
$configFile = Join-Path $projectDirectory 'windows\packages.psd1'
$powerShell = (Get-Process -Id $PID -ErrorAction Stop).Path

function Stop-Test {
  param([string] $Message)
  throw "FAIL: $Message"
}

function Invoke-SetupForTest {
  param([string[]] $Arguments)

  $output = @(
    & $powerShell -NoProfile -ExecutionPolicy Bypass -File $setupScript `
      @Arguments 2>&1
  )
  $exitCode = $LASTEXITCODE
  $text = @($output | ForEach-Object { $_.ToString() }) -join (
    [Environment]::NewLine
  )
  if ($exitCode -ne 0) {
    Stop-Test (
      "setup.ps1 exited with $exitCode for '$($Arguments -join ' ')':" +
      [Environment]::NewLine + $text
    )
  }
  return $text
}

$tokens = $null
$errors = $null
[Management.Automation.Language.Parser]::ParseFile(
  $setupScript,
  [ref] $tokens,
  [ref] $errors
) | Out-Null
if ($errors.Count -gt 0) {
  Stop-Test "PowerShell parser reported $($errors.Count) setup error(s)."
}

$configTokens = $null
$configErrors = $null
[Management.Automation.Language.Parser]::ParseFile(
  $configFile,
  [ref] $configTokens,
  [ref] $configErrors
) | Out-Null
if ($configErrors.Count -gt 0) {
  Stop-Test (
    "PowerShell parser reported $($configErrors.Count) catalog error(s)."
  )
}

$config = Import-PowerShellDataFile -LiteralPath $configFile
if ($config.SchemaVersion -ne 1) {
  Stop-Test 'Unexpected package configuration schema.'
}

foreach ($requiredProfile in @(
    'core',
    'media',
    'maintenance',
    'desktop',
    'admin',
    'power-archive'
  )) {
  if (-not $config.Profiles.ContainsKey($requiredProfile)) {
    Stop-Test "Required profile is missing: $requiredProfile"
  }
}

foreach ($profileName in $config.Profiles.Keys) {
  $profile = $config.Profiles[$profileName]
  foreach ($id in @($profile.Packages) + @($profile.OptionalPackages)) {
    if (-not $config.Packages.ContainsKey($id)) {
      Stop-Test "Profile '$profileName' has unknown package '$id'."
    }
  }
}

foreach ($requiredId in @(
    'KeePassXCTeam.KeePassXC',
    'M2Team.NanaZip',
    'Meta.Zstandard',
    'LocalSend.LocalSend',
    'yt-dlp.yt-dlp',
    'Klocman.BulkCrapUninstaller',
    'qarmin.krokiet',
    'REALiX.HWiNFO',
    'Microsoft.Sysinternals.Suite',
    'MoonlightGameStreamingProject.Moonlight',
    'LizardByte.Sunshine',
    'mcmilk.7zip-zstd'
  )) {
  if (-not $config.Packages.ContainsKey($requiredId)) {
    Stop-Test "Required package is missing: $requiredId"
  }
}

$setupSource = Get-Content -LiteralPath $setupScript -Raw
if ($setupSource -match '(?i)Remove-Item|Clear-RecycleBin') {
  Stop-Test 'Installer source contains a file or data cleanup command.'
}

$coreMedia = Invoke-SetupForTest -Arguments @(
  'plan',
  '-Profiles', 'core,media'
)
if ($coreMedia -notmatch 'Plan: core, media profile\(s\)') {
  Stop-Test 'Combined plan did not identify both selected profiles.'
}
if ($coreMedia -notmatch 'M2Team\.NanaZip' -or
    $coreMedia -notmatch 'KeePassXCTeam\.KeePassXC' -or
    $coreMedia -notmatch 'yt-dlp\.yt-dlp') {
  Stop-Test 'Combined core/media plan omitted a required package.'
}

$maintenance = Invoke-SetupForTest -Arguments @(
  'plan',
  '-Profiles', 'maintenance'
)
if ($maintenance -notmatch 'REALiX\.HWiNFO') {
  Stop-Test 'Maintenance plan did not include HWiNFO.'
}
if ($coreMedia -match '(?m)^\s{2}mpv\.net') {
  Stop-Test 'Optional mpv.net appeared without -IncludeOptional.'
}

$optionalMedia = Invoke-SetupForTest -Arguments @(
  'plan',
  '-Profiles', 'media',
  '-IncludeOptional'
)
if ($optionalMedia -notmatch '(?m)^\s{2}mpv\.net') {
  Stop-Test 'Optional media plan did not include mpv.net.'
}

$powerArchive = Invoke-SetupForTest -Arguments @(
  'plan',
  '-Profiles', 'core,power-archive'
)
if ($powerArchive -notmatch '(?m)^\s{2}mcmilk\.7zip-zstd') {
  Stop-Test 'Power archive plan did not include 7-Zip ZS.'
}
if ($powerArchive -match '(?m)^\s{2}M2Team\.NanaZip') {
  Stop-Test 'Power archive plan did not replace NanaZip.'
}

$dryRun = Invoke-SetupForTest -Arguments @(
  'install',
  '-Profiles', 'core',
  '-DryRun',
  '-Yes'
)
if ($dryRun -notmatch '\$ winget install --id M2Team\.NanaZip') {
  Stop-Test 'Dry run did not preview the expected WinGet command.'
}
if ($dryRun -notmatch 'Dry run completed; no changes were made') {
  Stop-Test 'Dry run did not report that it made no changes.'
}

$uninstallDryRun = Invoke-SetupForTest -Arguments @(
  'uninstall',
  '-PackageIds', 'KeePassXCTeam.KeePassXC,REALiX.HWiNFO',
  '-DryRun',
  '-Yes'
)
if ($uninstallDryRun -notmatch (
    '\$ winget uninstall --id KeePassXCTeam\.KeePassXC --exact'
  ) -or
    $uninstallDryRun -notmatch (
      '\$ winget uninstall --id REALiX\.HWiNFO --exact'
    )) {
  Stop-Test 'Uninstall dry run omitted an exact selected package command.'
}
if ($uninstallDryRun -notmatch (
    'does not issue commands to delete user files, password databases, ' +
    'or backups'
  )) {
  Stop-Test 'Uninstall plan omitted its data-preservation boundary.'
}
if ($uninstallDryRun -notmatch 'Dry run completed; no changes were made') {
  Stop-Test 'Uninstall dry run did not report that it made no changes.'
}

Write-Output 'PASS: Windows workstation utility parser, catalog, and plans'
