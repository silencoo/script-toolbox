#Requires -Version 5.1
<#
.SYNOPSIS
Installs the script-toolbox controller suite from PowerShell on Windows.

.DESCRIPTION
The controller runtime remains Bash-based. This installer locates Git for
Windows/MSYS2 Bash, delegates the standalone runtime transaction to the shared
Shell installer, and adds native .cmd shims for PowerShell and cmd.exe.

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

function Convert-ToMsysPath([string]$Path, [string]$Bash) {
    $output = & $Bash -lc 'cygpath -u -- "$1"' bash $Path 2>&1
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
    [hashtable]$Targets
) {
    $targetLines = foreach ($name in $Commands) {
        "    $(Quote-PowerShellLiteral $name) = $(Quote-PowerShellLiteral $Targets[$name])"
    }
    return @"
# script-toolbox-agent PowerShell launcher v1
param(
    [Parameter(Mandatory = `$true, Position = 0)]
    [ValidateSet('agentctl', 'mcpctl', 'promptctl', 'skillsctl')]
    [string]`$Controller,
    [Parameter(ValueFromRemainingArguments = `$true)]
    [string[]]`$ControllerArgs
)
`$ErrorActionPreference = 'Stop'
`$bash = $(Quote-PowerShellLiteral $Bash)
`$targets = @{
$($targetLines -join "`r`n")
}
try {
    & `$bash `$targets[`$Controller] @ControllerArgs
    if (`$null -eq `$LASTEXITCODE) { exit 0 }
    exit `$LASTEXITCODE
} catch {
    [Console]::Error.WriteLine(`$_.Exception.Message)
    exit 1
}
"@
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
    & $Bash @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "The shared Bash installer failed with exit code $LASTEXITCODE"
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
$PrefixMsys = Convert-ToMsysPath $Prefix $BashPath
$RuntimeMsys = Convert-ToMsysPath $Runtime $BashPath
$InstallerMsys = Convert-ToMsysPath $ShellInstaller $BashPath
$ManifestPath = Join-Path $Prefix $ManifestName
$ExistingManifest = Read-Manifest $ManifestPath

$targets = @{}
foreach ($name in $Commands) {
    $targets[$name] = "$RuntimeMsys/$name/$name"
}
$expectedFiles = New-Object System.Collections.Generic.List[object]
$expectedFiles.Add([pscustomobject]@{
    path = Join-Path $Prefix $LauncherName
    content = New-LauncherContent $BashPath $targets
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
        Invoke-ShellInstaller $BashPath $InstallerMsys $PrefixMsys $RuntimeMsys -Removing
        Write-Info '[preview] no files or PATH settings were changed; re-run with -Uninstall -Yes'
        return
    }

    Invoke-ShellInstaller $BashPath $InstallerMsys $PrefixMsys $RuntimeMsys -Apply -Removing
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
if ($conflicts.Count -gt 0) {
    throw "PowerShell command installation has conflicts (use -Force to preserve them): $($conflicts -join ', ')"
}
if ($AddToPath -and -not (Test-PathEntry @(Split-UserPath ([Environment]::GetEnvironmentVariable('Path', 'User'))) $Prefix)) {
    Write-Info "  PATH     add $Prefix to the user PATH"
}

if (-not $Yes) {
    Invoke-ShellInstaller $BashPath $InstallerMsys $PrefixMsys $RuntimeMsys
    Write-Info '[preview] no files or PATH settings were changed; re-run with -Yes to apply'
    return
}

New-Item -ItemType Directory -Path $Prefix -Force | Out-Null
Invoke-ShellInstaller $BashPath $InstallerMsys $PrefixMsys $RuntimeMsys -Apply

foreach ($plan in $plans) {
    if ($plan.action -eq 'keep') { continue }
    if ($plan.action -eq 'backup') {
        Move-Item -LiteralPath $plan.path -Destination $plan.backup
    }
    Write-AtomicText $plan.path $plan.content $plan.encoding
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
    files = @($manifestFiles)
}
$manifestJson = $manifest | ConvertTo-Json -Depth 6
Write-AtomicText $ManifestPath ($manifestJson + "`r`n") (New-Object System.Text.UTF8Encoding($true))

Write-Ok "installed agentctl, mcpctl, promptctl, and skillsctl in $Prefix"
Write-Ok "standalone runtime: $Runtime"
if (-not $pathAdded -and -not (Test-PathEntry @(Split-UserPath $env:Path) $Prefix)) {
    Write-Warn "$Prefix is not on PATH. Re-run with -AddToPath -Yes or add it manually."
}
