#Requires -Version 5.1
<#
.SYNOPSIS
Installs the script-toolbox controller suite from PowerShell on Windows.

.DESCRIPTION
The controller runtime remains Bash-based. This installer locates Git for
Windows/MSYS2 Bash, delegates the standalone runtime transaction to the shared
Shell installer, installs a pinned jq binary, and adds native .cmd shims for
PowerShell and cmd.exe.

Runs are preview-only unless -Yes is supplied. Managed conflicts are preserved
only with -Force, and -Uninstall restores those tracked backups.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Prefix,
    [string]$Runtime,
    [string]$BashPath,
    [string]$ReleaseId,
    [switch]$AddToPath,
    [switch]$Force,
    [switch]$Uninstall,
    [switch]$Yes,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CompatibilityArguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# PowerShell convention uses one dash (`-Yes`), but accepting the common GNU
# spellings keeps a user moving from install-commands.sh from accidentally
# binding `--yes` as the positional Prefix path. Unknown compatibility
# arguments fail closed instead of becoming directories.
foreach ($argument in @($CompatibilityArguments)) {
    # Windows PowerShell 5.1 binds one empty remaining argument when this
    # script is invoked by MSYS Bash with no real positional values. It is a
    # native argument-marshalling artifact, not a user option.
    if ([string]::IsNullOrEmpty($argument)) { continue }
    switch ($argument) {
        '--yes' { $Yes = $true }
        '--force' { $Force = $true }
        '--uninstall' { $Uninstall = $true }
        '--add-to-path' { $AddToPath = $true }
        default {
            throw "Unknown argument '$argument'. PowerShell options use -Yes, -Force, -Uninstall, and -AddToPath."
        }
    }
}

$Commands = @('agentctl', 'mcpctl', 'promptctl', 'skillsctl')
$ManifestName = '.script-toolbox-agent-powershell.json'
$LauncherName = '.script-toolbox-agent-launcher.ps1'
$JqName = 'jq.exe'
$JqVersion = '1.8.2'
$SourceRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$ShellInstaller = Join-Path $SourceRoot 'install-commands.sh'

function Write-Info([string]$Message) {
    Write-Host $Message
}

function Write-Ok([string]$Message) {
    Write-Host "OK $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
    Write-Warning $Message
}

function Resolve-FullPath([string]$Path, [string]$DefaultPath) {
    $value = if ([string]::IsNullOrWhiteSpace($Path)) { $DefaultPath } else { $Path }
    if (-not [IO.Path]::IsPathRooted($value)) {
        $value = Join-Path (Get-Location).Path $value
    }
    return [IO.Path]::GetFullPath($value)
}

function Find-GitBash([string]$Requested) {
    $candidates = New-Object System.Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace($Requested)) {
        $candidates.Add($Requested)
    }
    $command = Get-Command bash.exe -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        $candidates.Add($command.Source)
    }
    foreach ($candidate in @(
        $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Git\bin\bash.exe' }),
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe' }),
        $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe' })
    )) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            $candidates.Add($candidate)
        }
    }

    $seen = @{}
    foreach ($candidate in $candidates) {
        try {
            $full = [IO.Path]::GetFullPath($candidate)
        } catch {
            continue
        }
        $key = $full.ToLowerInvariant()
        if ($seen.ContainsKey($key) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
            continue
        }
        $seen[$key] = $true
        & $full -lc 'command -v cygpath >/dev/null 2>&1' 2>$null
        if ($LASTEXITCODE -eq 0) {
            return $full
        }
    }
    throw 'Git for Windows or MSYS2 Bash with cygpath was not found. Install Git for Windows or pass -BashPath.'
}

function Find-Cygpath([string]$Bash) {
    $bashDirectory = Split-Path -Parent $Bash
    foreach ($candidate in @(
        (Join-Path $bashDirectory 'cygpath.exe'),
        (Join-Path $bashDirectory '..\usr\bin\cygpath.exe')
    )) {
        try {
            $full = [IO.Path]::GetFullPath($candidate)
        } catch {
            continue
        }
        if (Test-Path -LiteralPath $full -PathType Leaf) { return $full }
    }
    throw "cygpath.exe could not be found beside the selected Bash: $Bash"
}

function Convert-ToMsysPath([string]$Path, [string]$Cygpath) {
    # Invoke cygpath.exe directly. Passing a quoted `$1` through `bash -lc`
    # loses the embedded quotes under Windows PowerShell 5.1, causing paths
    # containing spaces to be split and only their final component to survive.
    $output = & $Cygpath -u -- $Path 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "cygpath could not convert '$Path': $($output -join ' ')"
    }
    $converted = [string]($output | Select-Object -Last 1)
    if ([string]::IsNullOrWhiteSpace($converted)) {
        throw "cygpath returned an empty path for '$Path'"
    }
    return $converted.Trim()
}

function Quote-PowerShellLiteral([string]$Value) {
    return "'" + $Value.Replace("'", "''") + "'"
}

function New-LauncherContent(
    [string]$Bash,
    [hashtable]$Targets,
    [string]$CommandDirectory
) {
    $targetLines = foreach ($name in $Commands) {
        "    $(Quote-PowerShellLiteral $name) = $(Quote-PowerShellLiteral $Targets[$name])"
    }
    return @"
# script-toolbox-agent PowerShell launcher v3
param(
    [Parameter(Mandatory = `$true, Position = 0)]
    [ValidateSet('agentctl', 'mcpctl', 'promptctl', 'skillsctl')]
    [string]`$Controller,
    [Parameter(ValueFromRemainingArguments = `$true)]
    [string[]]`$ControllerArgs
)
`$ErrorActionPreference = 'Stop'
`$bash = $(Quote-PowerShellLiteral $Bash)
`$env:Path = $(Quote-PowerShellLiteral ($CommandDirectory + ';')) + `$env:Path
`$targets = @{
$($targetLines -join "`r`n")
}
try {
    # Git for Windows does not add its POSIX tools when bash.exe inherits a
    # native Windows PATH. Bootstrap /usr/bin before the controller evaluates
    # dirname, readlink, and the shared shell library.
    & `$bash -c 'PATH=/usr/bin`${PATH:+:`$PATH}; export PATH; exec /usr/bin/bash \"`$@\"' ``
        -- `$targets[`$Controller] @ControllerArgs
    if (`$null -eq `$LASTEXITCODE) { exit 0 }
    exit `$LASTEXITCODE
} catch {
    [Console]::Error.WriteLine(`$_.Exception.Message)
    exit 1
}
"@
}

function Get-JqAsset {
    $architecture = if (-not [string]::IsNullOrWhiteSpace($env:PROCESSOR_ARCHITEW6432)) {
        $env:PROCESSOR_ARCHITEW6432
    } else {
        $env:PROCESSOR_ARCHITECTURE
    }
    switch ($architecture.ToUpperInvariant()) {
        'AMD64' {
            $asset = 'jq-windows-amd64.exe'
            $sha256 = 'a6fc67fedaf9128a3309a1e2ebb8b986aeccf70122ee46d2cb4849e423f0c627'
        }
        'ARM64' {
            $asset = 'jq-windows-arm64.exe'
            $sha256 = '083b5377392bc57cf27052b6d20a2d927770683bca844632901ff38b4b7b0ac7'
        }
        'X86' {
            $asset = 'jq-windows-i386.exe'
            $sha256 = 'a99cb668f95bdd788d9ee20529613b115e5d2a0d7f9127ee6976607e878558ba'
        }
        default {
            throw "jq does not publish a supported Windows binary for architecture '$architecture'."
        }
    }
    return [pscustomobject]@{
        url = "https://github.com/jqlang/jq/releases/download/jq-$JqVersion/$asset"
        sha256 = $sha256
        architecture = $architecture
    }
}

function Save-VerifiedDownload(
    [string]$Uri,
    [string]$ExpectedSha256,
    [string]$Destination
) {
    $previousProgressPreference = $ProgressPreference
    try {
        $ProgressPreference = 'SilentlyContinue'
        if ($PSVersionTable.PSVersion.Major -le 5) {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        }
        Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
        $actual = Get-FileSha256 $Destination
        if (-not [string]::Equals($actual, $ExpectedSha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Downloaded jq checksum mismatch: expected $ExpectedSha256, found $actual"
        }
    } finally {
        $ProgressPreference = $previousProgressPreference
        if ((Test-Path -LiteralPath $Destination -PathType Leaf) -and
            -not [string]::Equals(
                (Get-FileSha256 $Destination),
                $ExpectedSha256,
                [StringComparison]::OrdinalIgnoreCase
            )) {
            Remove-Item -LiteralPath $Destination -Force
        }
    }
}

function New-CmdShimContent([string]$Name) {
    return "@echo off`r`n" +
        "rem script-toolbox-agent command shim v1`r`n" +
        "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"%~dp0$LauncherName`" $Name %*`r`n" +
        "exit /b %ERRORLEVEL%`r`n"
}

function Read-TextFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return [IO.File]::ReadAllText($Path)
}

function Get-FileSha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-Manifest([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "PowerShell installer manifest is not a regular file: $Path"
    }
    $manifest = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 1 -or $manifest.kind -ne 'script-toolbox-agent-powershell') {
        throw "Unrecognized PowerShell installer manifest: $Path"
    }
    return $manifest
}

function Find-ManifestFile($Manifest, [string]$Path) {
    if ($null -eq $Manifest -or $null -eq $Manifest.files) { return $null }
    foreach ($entry in $Manifest.files) {
        if ([string]::Equals([string]$entry.path, $Path, [StringComparison]::OrdinalIgnoreCase)) {
            return $entry
        }
    }
    return $null
}

function Test-PreviousManagedFile($Entry, [string]$Path) {
    if ($null -eq $Entry -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    return [string]::Equals(
        (Get-FileSha256 $Path),
        [string]$Entry.sha256,
        [StringComparison]::OrdinalIgnoreCase
    )
}

function Write-AtomicText(
    [string]$Path,
    [string]$Content,
    [Text.Encoding]$Encoding
) {
    $parent = Split-Path -Parent $Path
    $temporary = Join-Path $parent ('.' + [IO.Path]::GetFileName($Path) + '.tmp.' + [Guid]::NewGuid().ToString('N'))
    try {
        [IO.File]::WriteAllText($temporary, $Content, $Encoding)
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

function Write-AtomicBinary([string]$Path, [string]$Source) {
    $parent = Split-Path -Parent $Path
    $temporary = Join-Path $parent ('.' + [IO.Path]::GetFileName($Path) + '.tmp.' + [Guid]::NewGuid().ToString('N'))
    try {
        Copy-Item -LiteralPath $Source -Destination $temporary
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

function Split-UserPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return @() }
    return @($Value.Split(';') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Test-PathEntry([string[]]$Entries, [string]$Wanted) {
    foreach ($entry in $Entries) {
        if ([string]::Equals($entry.TrimEnd('\'), $Wanted.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Add-UserPath([string]$Directory) {
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @(Split-UserPath $current)
    if (Test-PathEntry $entries $Directory) { return $false }
    $updated = (@($Directory) + $entries) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
    if (-not (Test-PathEntry @(Split-UserPath $env:Path) $Directory)) {
        $env:Path = "$Directory;$env:Path"
    }
    return $true
}

function Remove-UserPath([string]$Directory) {
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @(Split-UserPath $current)
    $filtered = @($entries | Where-Object {
        -not [string]::Equals($_.TrimEnd('\'), $Directory.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
    })
    [Environment]::SetEnvironmentVariable('Path', ($filtered -join ';'), 'User')
    $processEntries = @(Split-UserPath $env:Path | Where-Object {
        -not [string]::Equals($_.TrimEnd('\'), $Directory.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
    })
    $env:Path = $processEntries -join ';'
}

function Invoke-ShellInstaller(
    [string]$Bash,
    [string]$Installer,
    [string]$PrefixMsys,
    [string]$RuntimeMsys,
    [switch]$Apply,
    [switch]$Removing
) {
    $arguments = @($Installer, '--standalone', '--prefix', $PrefixMsys, '--runtime', $RuntimeMsys)
    if (-not [string]::IsNullOrWhiteSpace($ReleaseId)) {
        $arguments += @('--release-id', $ReleaseId)
    }
    if ($Force -and -not $Removing) { $arguments += '--force' }
    if ($Removing) { $arguments += '--uninstall' }
    if ($Apply) { $arguments += '--yes' }
    # The shared installer emits its own PATH warning. Temporarily exposing the
    # Windows command directory keeps that nested warning from contradicting
    # the single, actionable PowerShell warning printed after installation.
    $originalPath = $env:Path
    if (-not (Test-PathEntry @(Split-UserPath $env:Path) $Prefix)) {
        $env:Path = "$Prefix;$env:Path"
    }
    try {
        & $Bash @arguments
        if ($LASTEXITCODE -ne 0) {
            throw "The shared Bash installer failed with exit code $LASTEXITCODE"
        }
    } finally {
        $env:Path = $originalPath
    }
}

if ($env:OS -ne 'Windows_NT') {
    throw 'install-commands.ps1 supports Windows only. Use install-commands.sh on macOS or Linux.'
}
if (-not (Test-Path -LiteralPath $ShellInstaller -PathType Leaf)) {
    throw "Shared Shell installer is missing: $ShellInstaller"
}

$localRoot = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA 'script-toolbox'
} else {
    Join-Path $HOME 'AppData\Local\script-toolbox'
}
$Prefix = Resolve-FullPath $Prefix (Join-Path $localRoot 'bin')
$Runtime = Resolve-FullPath $Runtime (Join-Path $localRoot 'agent')
if ([string]::Equals($Prefix.TrimEnd('\'), $Runtime.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Prefix and Runtime must be different directories.'
}
if ($Prefix.StartsWith($Runtime.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $Runtime.StartsWith($Prefix.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Prefix and Runtime must not contain one another.'
}

$BashPath = Find-GitBash $BashPath
$CygpathPath = Find-Cygpath $BashPath
$PrefixMsys = Convert-ToMsysPath $Prefix $CygpathPath
$RuntimeMsys = Convert-ToMsysPath $Runtime $CygpathPath
$InstallerMsys = Convert-ToMsysPath $ShellInstaller $CygpathPath
$ManifestPath = Join-Path $Prefix $ManifestName
$ExistingManifest = Read-Manifest $ManifestPath

$targets = @{}
foreach ($name in $Commands) {
    $targets[$name] = "$RuntimeMsys/$name/$name"
}
$expectedFiles = New-Object System.Collections.Generic.List[object]
$expectedFiles.Add([pscustomobject]@{
    path = Join-Path $Prefix $LauncherName
    content = New-LauncherContent $BashPath $targets $Prefix
    encoding = New-Object System.Text.UTF8Encoding($true)
})
foreach ($name in $Commands) {
    $expectedFiles.Add([pscustomobject]@{
        path = Join-Path $Prefix "$name.cmd"
        content = New-CmdShimContent $name
        encoding = [Text.Encoding]::ASCII
    })
}
if ($Uninstall) {
    if ($null -eq $ExistingManifest) {
        Write-Info "No managed PowerShell installation found at $Prefix"
        return
    }
    $changed = New-Object System.Collections.Generic.List[string]
    foreach ($entry in $ExistingManifest.files) {
        if (Test-Path -LiteralPath $entry.path) {
            if (-not (Test-Path -LiteralPath $entry.path -PathType Leaf) -or
                -not (Test-PreviousManagedFile $entry $entry.path)) {
                $changed.Add([string]$entry.path)
            }
        }
    }
    if ($changed.Count -gt 0) {
        throw "Uninstall stopped because managed files changed: $($changed -join ', ')"
    }
    Write-Info "  remove   Bash runtime and extensionless launchers under $Runtime"
    foreach ($entry in $ExistingManifest.files) {
        Write-Info "  remove   $($entry.path)"
        if (-not [string]::IsNullOrWhiteSpace([string]$entry.backup)) {
            Write-Info "  restore  $($entry.backup) -> $($entry.path)"
        }
    }
    if ($ExistingManifest.path_added) {
        Write-Info "  PATH     remove $Prefix from the user PATH"
    }
    if (-not $Yes) {
        Invoke-ShellInstaller -Bash $BashPath -Installer $InstallerMsys `
            -PrefixMsys $PrefixMsys -RuntimeMsys $RuntimeMsys -Removing
        Write-Info '[preview] no files or PATH settings were changed; re-run with -Uninstall -Yes'
        return
    }

    Invoke-ShellInstaller -Bash $BashPath -Installer $InstallerMsys `
        -PrefixMsys $PrefixMsys -RuntimeMsys $RuntimeMsys -Apply -Removing
    foreach ($entry in $ExistingManifest.files) {
        if (Test-Path -LiteralPath $entry.path -PathType Leaf) {
            Remove-Item -LiteralPath $entry.path -Force
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$entry.backup) -and
            (Test-Path -LiteralPath $entry.backup)) {
            Move-Item -LiteralPath $entry.backup -Destination $entry.path
        }
    }
    Remove-Item -LiteralPath $ManifestPath -Force
    if ($ExistingManifest.path_added) { Remove-UserPath $Prefix }
    Write-Ok "removed the managed Windows controller installation from $Prefix"
    return
}

$jqAsset = Get-JqAsset
$expectedBinaries = @([pscustomobject]@{
    path = Join-Path $Prefix $JqName
    url = $jqAsset.url
    sha256 = $jqAsset.sha256
})

$plans = New-Object System.Collections.Generic.List[object]
$conflicts = New-Object System.Collections.Generic.List[string]
foreach ($file in $expectedFiles) {
    $entry = Find-ManifestFile $ExistingManifest $file.path
    $action = 'create'
    $backup = if ($null -ne $entry) { [string]$entry.backup } else { '' }
    if (Test-Path -LiteralPath $file.path) {
        if (-not (Test-Path -LiteralPath $file.path -PathType Leaf)) {
            $action = 'conflict'
        } elseif ((Read-TextFile $file.path) -eq $file.content) {
            $action = 'keep'
        } elseif (Test-PreviousManagedFile $entry $file.path) {
            $action = 'refresh'
        } elseif ($Force -and [string]::IsNullOrWhiteSpace($backup)) {
            $action = 'backup'
            $backup = "$($file.path).backup.$(Get-Date -Format yyyyMMddHHmmss).$PID"
        } else {
            $action = 'conflict'
        }
    }
    if ($action -eq 'conflict') { $conflicts.Add($file.path) }
    $plans.Add([pscustomobject]@{
        path = $file.path
        content = $file.content
        encoding = $file.encoding
        source = $null
        expectedSha256 = $null
        kind = 'text'
        action = $action
        backup = $backup
    })
    if ($action -eq 'backup') {
        Write-Info "  backup   $($file.path) -> $backup"
        Write-Info "  create   $($file.path)"
    } else {
        Write-Info ("  {0,-8} {1}" -f $action, $file.path)
    }
}
foreach ($file in $expectedBinaries) {
    $entry = Find-ManifestFile $ExistingManifest $file.path
    $action = 'create'
    $backup = if ($null -ne $entry) { [string]$entry.backup } else { '' }
    if (Test-Path -LiteralPath $file.path) {
        if (-not (Test-Path -LiteralPath $file.path -PathType Leaf)) {
            $action = 'conflict'
        } elseif ([string]::Equals(
            (Get-FileSha256 $file.path),
            $file.sha256,
            [StringComparison]::OrdinalIgnoreCase
        )) {
            $action = 'keep'
        } elseif (Test-PreviousManagedFile $entry $file.path) {
            $action = 'refresh'
        } elseif ($Force -and [string]::IsNullOrWhiteSpace($backup)) {
            $action = 'backup'
            $backup = "$($file.path).backup.$(Get-Date -Format yyyyMMddHHmmss).$PID"
        } else {
            $action = 'conflict'
        }
    }
    if ($action -eq 'conflict') { $conflicts.Add($file.path) }
    $plans.Add([pscustomobject]@{
        path = $file.path
        content = $null
        encoding = $null
        source = $file.url
        expectedSha256 = $file.sha256
        kind = 'binary'
        action = $action
        backup = $backup
    })
    if ($action -eq 'backup') {
        Write-Info "  backup   $($file.path) -> $backup"
        Write-Info "  download jq $JqVersion -> $($file.path)"
    } elseif ($action -eq 'create' -or $action -eq 'refresh') {
        Write-Info ("  {0,-8} jq {1} -> {2}" -f $action, $JqVersion, $file.path)
    } else {
        Write-Info ("  {0,-8} {1}" -f $action, $file.path)
    }
}
if ($conflicts.Count -gt 0) {
    throw "PowerShell command installation has conflicts (use -Force to preserve them): $($conflicts -join ', ')"
}
if ($AddToPath -and -not (Test-PathEntry @(Split-UserPath ([Environment]::GetEnvironmentVariable('Path', 'User'))) $Prefix)) {
    Write-Info "  PATH     add $Prefix to the user PATH"
}

if (-not $Yes) {
    Invoke-ShellInstaller -Bash $BashPath -Installer $InstallerMsys `
        -PrefixMsys $PrefixMsys -RuntimeMsys $RuntimeMsys
    Write-Info '[preview] no files or PATH settings were changed; re-run with -Yes to apply'
    return
}

$downloads = @{}
try {
    foreach ($plan in $plans) {
        if ($plan.kind -ne 'binary' -or $plan.action -eq 'keep') { continue }
        $temporary = Join-Path ([IO.Path]::GetTempPath()) ('script-toolbox-jq-' + [Guid]::NewGuid().ToString('N') + '.exe')
        Write-Info "  fetch    jq $JqVersion ($($jqAsset.architecture))"
        $downloads[$plan.path] = $temporary
        Save-VerifiedDownload $plan.source $plan.expectedSha256 $temporary
    }

    New-Item -ItemType Directory -Path $Prefix -Force | Out-Null
    Invoke-ShellInstaller -Bash $BashPath -Installer $InstallerMsys `
        -PrefixMsys $PrefixMsys -RuntimeMsys $RuntimeMsys -Apply

    foreach ($plan in $plans) {
        if ($plan.action -eq 'keep') { continue }
        if ($plan.action -eq 'backup') {
            Move-Item -LiteralPath $plan.path -Destination $plan.backup
        }
        if ($plan.kind -eq 'binary') {
            Write-AtomicBinary $plan.path $downloads[$plan.path]
        } else {
            Write-AtomicText $plan.path $plan.content $plan.encoding
        }
    }

    $pathAdded = $false
    if ($null -ne $ExistingManifest -and $ExistingManifest.path_added) {
        $pathAdded = $true
    }
    if ($AddToPath -and (Add-UserPath $Prefix)) {
        $pathAdded = $true
    }

    $manifestFiles = foreach ($plan in $plans) {
        [ordered]@{
            path = $plan.path
            sha256 = Get-FileSha256 $plan.path
            backup = $plan.backup
        }
    }
    $manifest = [ordered]@{
        schema = 1
        kind = 'script-toolbox-agent-powershell'
        installed_at = (Get-Date).ToUniversalTime().ToString('o')
        prefix = $Prefix
        runtime = $Runtime
        bash = $BashPath
        path_added = $pathAdded
        jq_version = $JqVersion
        files = @($manifestFiles)
    }
    $manifestJson = $manifest | ConvertTo-Json -Depth 6
    Write-AtomicText $ManifestPath ($manifestJson + "`r`n") (New-Object System.Text.UTF8Encoding($true))
} finally {
    foreach ($temporary in $downloads.Values) {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

Write-Ok "installed agentctl, mcpctl, promptctl, and skillsctl in $Prefix"
Write-Ok "standalone runtime: $Runtime"
if (-not $pathAdded -and -not (Test-PathEntry @(Split-UserPath $env:Path) $Prefix)) {
    Write-Warn "$Prefix is not on PATH. Re-run with -AddToPath -Yes or add it manually."
}
