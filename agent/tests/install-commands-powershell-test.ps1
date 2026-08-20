#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    Write-Host 'SKIP: install-commands-powershell-test.ps1 requires Windows'
    exit 0
}

$AgentDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Installer = Join-Path $AgentDir 'install-commands.ps1'
$TestRoot = Join-Path ([IO.Path]::GetTempPath()) ('script-toolbox PowerShell 工具 ' + [Guid]::NewGuid().ToString('N'))
$Prefix = Join-Path $TestRoot 'command bin'
$Runtime = Join-Path $TestRoot 'standalone runtime'
$Bash = (Get-Command bash.exe -ErrorAction Stop).Source

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
}

function Invoke-Installer([hashtable]$NamedArguments, [string[]]$ExtraArguments = @()) {
    & $Installer @NamedArguments @ExtraArguments
    if ($LASTEXITCODE -notin @(0, $null)) {
        throw "FAIL: installer exited with $LASTEXITCODE"
    }
}

try {
    $common = @{
        Prefix = $Prefix
        Runtime = $Runtime
        BashPath = $Bash
        ReleaseId = 'powershell-test-v1'
    }

    $preview = & $Installer @common 2>&1 | Out-String
    Assert-True ($preview -match '\[preview\]') 'install preview did not describe preview mode'
    Assert-True (-not (Test-Path -LiteralPath $Prefix)) 'install preview created the command prefix'
    Assert-True (-not (Test-Path -LiteralPath $Runtime)) 'install preview created the runtime'

    $typoRefused = $false
    try {
        & $Installer @common '--ues' *> $null
    } catch {
        $typoRefused = $true
    }
    Assert-True $typoRefused 'unknown GNU-style option was not rejected'
    Assert-True (-not (Test-Path -LiteralPath $Prefix)) 'unknown option became an install prefix'

    # GNU-style boolean flags are accepted for users moving from the Shell
    # installer, while canonical PowerShell examples continue to use -Yes.
    Invoke-Installer $common @('--yes')
    Assert-True (Test-Path -LiteralPath (Join-Path $Runtime '.script-toolbox-agent-runtime') -PathType Leaf) `
        'PowerShell install omitted the standalone runtime marker'
    Assert-True (Test-Path -LiteralPath (Join-Path $Prefix '.script-toolbox-agent-powershell.json') -PathType Leaf) `
        'PowerShell install omitted its ownership manifest'
    Assert-True (Test-Path -LiteralPath (Join-Path $Prefix '.script-toolbox-agent-launcher.ps1') -PathType Leaf) `
        'PowerShell install omitted the shared launcher'
    Assert-True (Test-Path -LiteralPath (Join-Path $Prefix 'jq.exe') -PathType Leaf) `
        'PowerShell install omitted the managed jq dependency'
    $jqVersion = (& (Join-Path $Prefix 'jq.exe') --version | Out-String).Trim()
    Assert-True ($jqVersion -eq 'jq-1.8.2') "managed jq returned an unexpected version: $jqVersion"
    foreach ($name in @('agentctl', 'mcpctl', 'promptctl', 'skillsctl')) {
        Assert-True (Test-Path -LiteralPath (Join-Path $Prefix "$name.cmd") -PathType Leaf) `
            "PowerShell install omitted $name.cmd"
        Assert-True (Test-Path -LiteralPath (Join-Path $Prefix $name) -PathType Leaf) `
            "shared Windows install omitted the Git Bash $name launcher"
    }

    $version = (& (Join-Path $Prefix 'agentctl.cmd') --version | Out-String).Trim()
    Assert-True ($LASTEXITCODE -eq 0) 'agentctl.cmd returned a non-zero exit code'
    Assert-True ($version -eq 'agentctl 0.17.4') "agentctl.cmd returned an unexpected version: $version"

    # The updater must leave its installed runtime before asking the shared
    # installer to rename it. Windows otherwise reports access denied while
    # the updater script is still open inside that directory.
    $cygpathCandidates = @(
        (Join-Path (Split-Path -Parent $Bash) 'cygpath.exe'),
        (Join-Path (Split-Path -Parent $Bash) '..\usr\bin\cygpath.exe')
    )
    $Cygpath = $cygpathCandidates | Where-Object {
        Test-Path -LiteralPath $_ -PathType Leaf
    } | Select-Object -First 1
    Assert-True (-not [string]::IsNullOrWhiteSpace($Cygpath)) 'could not locate cygpath for update test'
    $RepoRoot = [IO.Path]::GetFullPath((Join-Path $AgentDir '..'))
    $RepoRootMsys = ([string](& $Cygpath -u -- $RepoRoot | Select-Object -Last 1)).Trim()
    $updateOutput = & (Join-Path $Prefix 'agentctl.cmd') update --yes `
        --source $RepoRootMsys --release-id powershell-test-v2 2>&1 | Out-String
    Assert-True ($LASTEXITCODE -eq 0) "agentctl update failed on Windows: $updateOutput"
    $runtimeMarker = Get-Content -LiteralPath (Join-Path $Runtime '.script-toolbox-agent-runtime') -Raw
    Assert-True ($runtimeMarker -match '(?m)^release_id=powershell-test-v2$') `
        'agentctl update did not replace the Windows runtime metadata'

    $agentctlShim = Join-Path $Prefix 'agentctl.cmd'
    $shimHashBefore = (Get-FileHash -LiteralPath $agentctlShim -Algorithm SHA256).Hash
    $reinstallArguments = $common.Clone()
    $reinstallArguments.Yes = $true
    Invoke-Installer $reinstallArguments
    $shimHashAfter = (Get-FileHash -LiteralPath $agentctlShim -Algorithm SHA256).Hash
    Assert-True ($shimHashAfter -eq $shimHashBefore) 'PowerShell reinstall was not shim-idempotent'

    $uninstallPreviewArguments = $common.Clone()
    $uninstallPreviewArguments.Uninstall = $true
    $uninstallPreview = & $Installer @uninstallPreviewArguments 2>&1 | Out-String
    Assert-True ($uninstallPreview -match '\[preview\]') 'uninstall preview did not describe preview mode'
    Assert-True (Test-Path -LiteralPath (Join-Path $Prefix 'agentctl.cmd')) 'uninstall preview removed a shim'
    Assert-True (Test-Path -LiteralPath $Runtime) 'uninstall preview removed the runtime'

    $uninstallArguments = $common.Clone()
    $uninstallArguments.Uninstall = $true
    $uninstallArguments.Yes = $true
    Invoke-Installer $uninstallArguments
    Assert-True (-not (Test-Path -LiteralPath $Runtime)) 'PowerShell uninstall left the runtime'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $Prefix 'agentctl.cmd'))) `
        'PowerShell uninstall left an owned shim'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $Prefix 'jq.exe'))) `
        'PowerShell uninstall left the managed jq dependency'

    New-Item -ItemType Directory -Path $Prefix -Force | Out-Null
    $ownedConflict = Join-Path $Prefix 'mcpctl.cmd'
    [IO.File]::WriteAllText($ownedConflict, "@echo user-owned`r`n", [Text.Encoding]::ASCII)
    $refused = $false
    try {
        $conflictArguments = $common.Clone()
        $conflictArguments.Yes = $true
        & $Installer @conflictArguments *> $null
    } catch {
        $refused = $true
    }
    Assert-True $refused 'PowerShell installer replaced an unowned shim without -Force'
    Assert-True ((Get-Content -LiteralPath $ownedConflict -Raw) -eq "@echo user-owned`r`n") `
        'refused PowerShell shim conflict was modified'

    $forceArguments = $common.Clone()
    $forceArguments.Force = $true
    $forceArguments.Yes = $true
    Invoke-Installer $forceArguments
    Assert-True ((Get-Content -LiteralPath $ownedConflict -Raw) -ne "@echo user-owned`r`n") `
        '-Force did not install over the tracked PowerShell shim backup'
    Invoke-Installer $uninstallArguments
    Assert-True ((Get-Content -LiteralPath $ownedConflict -Raw) -eq "@echo user-owned`r`n") `
        'PowerShell uninstall did not restore the user-owned shim'

    Write-Host 'ok  : PowerShell preview, managed jq, Windows shims, conflicts, and reversible uninstall'
} finally {
    if (Test-Path -LiteralPath $TestRoot) {
        Remove-Item -LiteralPath $TestRoot -Recurse -Force
    }
}
