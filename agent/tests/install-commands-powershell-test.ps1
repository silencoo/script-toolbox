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

function Invoke-Installer([string[]]$Arguments) {
    & $Installer @Arguments
    if ($LASTEXITCODE -notin @(0, $null)) {
        throw "FAIL: installer exited with $LASTEXITCODE"
    }
}

try {
    $common = @(
        '-Prefix', $Prefix,
        '-Runtime', $Runtime,
        '-BashPath', $Bash,
        '-ReleaseId', 'powershell-test-v1'
    )

    $preview = & $Installer @common 2>&1 | Out-String
    Assert-True ($preview -match '\[preview\]') 'install preview did not describe preview mode'
    Assert-True (-not (Test-Path -LiteralPath $Prefix)) 'install preview created the command prefix'
    Assert-True (-not (Test-Path -LiteralPath $Runtime)) 'install preview created the runtime'

    Invoke-Installer ($common + '-Yes')
    Assert-True (Test-Path -LiteralPath (Join-Path $Runtime '.script-toolbox-agent-runtime') -PathType Leaf) `
        'PowerShell install omitted the standalone runtime marker'
    Assert-True (Test-Path -LiteralPath (Join-Path $Prefix '.script-toolbox-agent-powershell.json') -PathType Leaf) `
        'PowerShell install omitted its ownership manifest'
    Assert-True (Test-Path -LiteralPath (Join-Path $Prefix '.script-toolbox-agent-launcher.ps1') -PathType Leaf) `
        'PowerShell install omitted the shared launcher'
    foreach ($name in @('agentctl', 'mcpctl', 'promptctl', 'skillsctl')) {
        Assert-True (Test-Path -LiteralPath (Join-Path $Prefix "$name.cmd") -PathType Leaf) `
            "PowerShell install omitted $name.cmd"
        Assert-True (Test-Path -LiteralPath (Join-Path $Prefix $name) -PathType Leaf) `
            "shared Windows install omitted the Git Bash $name launcher"
    }

    $version = (& (Join-Path $Prefix 'agentctl.cmd') --version | Out-String).Trim()
    Assert-True ($LASTEXITCODE -eq 0) 'agentctl.cmd returned a non-zero exit code'
    Assert-True ($version -eq 'agentctl 0.17.1') "agentctl.cmd returned an unexpected version: $version"

    $reinstall = & $Installer @common -Yes 2>&1 | Out-String
    Assert-True ($reinstall -match 'keep\s+.*agentctl\.cmd') 'PowerShell reinstall was not shim-idempotent'

    $uninstallPreview = & $Installer @common -Uninstall 2>&1 | Out-String
    Assert-True ($uninstallPreview -match '\[preview\]') 'uninstall preview did not describe preview mode'
    Assert-True (Test-Path -LiteralPath (Join-Path $Prefix 'agentctl.cmd')) 'uninstall preview removed a shim'
    Assert-True (Test-Path -LiteralPath $Runtime) 'uninstall preview removed the runtime'

    Invoke-Installer ($common + @('-Uninstall', '-Yes'))
    Assert-True (-not (Test-Path -LiteralPath $Runtime)) 'PowerShell uninstall left the runtime'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $Prefix 'agentctl.cmd'))) `
        'PowerShell uninstall left an owned shim'

    New-Item -ItemType Directory -Path $Prefix -Force | Out-Null
    $ownedConflict = Join-Path $Prefix 'mcpctl.cmd'
    [IO.File]::WriteAllText($ownedConflict, "@echo user-owned`r`n", [Text.Encoding]::ASCII)
    $refused = $false
    try {
        & $Installer @common -Yes *> $null
    } catch {
        $refused = $true
    }
    Assert-True $refused 'PowerShell installer replaced an unowned shim without -Force'
    Assert-True ((Get-Content -LiteralPath $ownedConflict -Raw) -eq "@echo user-owned`r`n") `
        'refused PowerShell shim conflict was modified'

    Invoke-Installer ($common + @('-Force', '-Yes'))
    Assert-True ((Get-Content -LiteralPath $ownedConflict -Raw) -ne "@echo user-owned`r`n") `
        '-Force did not install over the tracked PowerShell shim backup'
    Invoke-Installer ($common + @('-Uninstall', '-Yes'))
    Assert-True ((Get-Content -LiteralPath $ownedConflict -Raw) -eq "@echo user-owned`r`n") `
        'PowerShell uninstall did not restore the user-owned shim'

    Write-Host 'ok  : PowerShell preview, Windows shims, conflicts, and reversible uninstall'
} finally {
    if (Test-Path -LiteralPath $TestRoot) {
        Remove-Item -LiteralPath $TestRoot -Recurse -Force
    }
}
