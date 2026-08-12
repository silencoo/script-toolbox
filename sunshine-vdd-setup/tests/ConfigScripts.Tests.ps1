[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-True {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

function Assert-Throws {
    param([Parameter(Mandatory)][scriptblock]$Action, [Parameter(Mandatory)][string]$MessagePattern)
    try {
        & $Action
    }
    catch {
        if ($_.Exception.Message -notmatch $MessagePattern) {
            throw "Expected error matching '$MessagePattern', received: $($_.Exception.Message)"
        }
        return
    }
    throw "Expected an error matching '$MessagePattern', but no error was thrown."
}

$root = Split-Path -Parent $PSScriptRoot
$temp = Join-Path ([IO.Path]::GetTempPath()) ('sunshine-vdd-tests-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $temp)
try {
    $sunshinePath = Join-Path $temp 'sunshine.conf'
    @'
# preserved comment
adapter_name = Existing Encoder GPU
output_name = {old-guid}
dd_configuration_option = verify_only
dd_resolution_option = manual
dd_manual_resolution = 1920x1080
dd_manual_resolution = 1280x720
dd_refresh_rate_option = manual
dd_manual_refresh_rate = 60
native_pen_touch = enabled
'@ | Set-Content -LiteralPath $sunshinePath -NoNewline

    $sunshineResult = & (Join-Path $root 'scripts/Set-SunshineDisplayConfig.ps1') `
        -ConfigPath $sunshinePath `
        -OutputName '{new-guid}' `
        -Topology ensure_only_display `
        -ResolutionMode auto `
        -RefreshRateMode auto `
        -HdrMode auto `
        -HdrToggleDelay 500

    Assert-True ($sunshineResult.Mode -eq 'DryRun') 'Sunshine preview must be a dry run.'
    Assert-True ($sunshineResult.RenderedConfig -match '(?m)^adapter_name = Existing Encoder GPU$') 'Omitting AdapterName must preserve the existing encoder adapter.'
    Assert-True ($sunshineResult.RenderedConfig -match '(?m)^output_name = \{new-guid\}$') 'Sunshine output GUID must be updated.'
    Assert-True ($sunshineResult.RenderedConfig -notmatch '(?m)^dd_manual_(resolution|refresh_rate)\s*=') 'Auto modes must remove stale manual keys.'
    Assert-True ($sunshineResult.RenderedConfig -match '(?m)^dd_hdr_option = auto$') 'HDR policy must be rendered.'
    Assert-True ($sunshineResult.RenderedConfig -match '(?m)^dd_wa_hdr_toggle_delay = 500$') 'HDR workaround delay must be rendered when explicitly requested.'
    Assert-True ((Get-Content -LiteralPath $sunshinePath -Raw) -match 'output_name = \{old-guid\}') 'A Sunshine dry run must not mutate the source file.'

    $vddPath = Join-Path $temp 'vdd_settings.xml'
    @'
<?xml version="1.0" encoding="UTF-8"?>
<vdd_settings>
  <monitors><count>1</count></monitors>
  <gpu><friendlyname>Existing VDD GPU</friendlyname></gpu>
  <global><g_refresh_rate>60</g_refresh_rate></global>
  <resolutions><resolution><width>1920</width><height>1080</height><refresh_rate>60</refresh_rate></resolution></resolutions>
  <options>
    <HardwareCursor>true</HardwareCursor>
    <SDR10bit>false</SDR10bit>
    <HDRPlus>false</HDRPlus>
    <CustomEdid>false</CustomEdid>
    <PreventSpoof>false</PreventSpoof>
    <EdidCeaOverride>false</EdidCeaOverride>
  </options>
</vdd_settings>
'@ | Set-Content -LiteralPath $vddPath -NoNewline

    $vddResult = & (Join-Path $root 'scripts/Set-VddSettings.ps1') `
        -ConfigPath $vddPath `
        -Resolutions '2560x1440' `
        -RefreshRates 60, 120 `
        -PreferredRefreshRate 120 `
        -HdrPlus enabled `
        -Sdr10Bit disabled

    Assert-True ($vddResult.Mode -eq 'DryRun') 'VDD preview must be a dry run.'
    Assert-True ($vddResult.GpuFriendlyName -eq 'Existing VDD GPU') 'Omitting GpuFriendlyName must preserve the VDD GPU.'
    Assert-True ($vddResult.HdrPlus -and -not $vddResult.Sdr10Bit) 'The approved HDR+/SDR10 combination must be reflected in preview output.'
    Assert-True ($vddResult.ProposedXml -match '<width>2560</width>') 'The proposed VDD resolution must be rendered.'
    Assert-True ($vddResult.ProposedXml -match '<g_refresh_rate>120</g_refresh_rate>') 'The proposed VDD refresh list must be rendered.'
    Assert-True ($vddResult.ProposedXml -match '<HardwareCursor>true</HardwareCursor>') 'Hardware cursor must remain enabled.'

    Assert-Throws -MessagePattern 'cannot both be enabled' -Action {
        & (Join-Path $root 'scripts/Set-VddSettings.ps1') -ConfigPath $vddPath -Resolutions '2560x1440' -RefreshRates 120 -Sdr10Bit enabled -HdrPlus enabled | Out-Null
    }
    Assert-Throws -MessagePattern 'user_edid\.bin' -Action {
        & (Join-Path $root 'scripts/Set-VddSettings.ps1') -ConfigPath $vddPath -Resolutions '2560x1440' -RefreshRates 120 -CustomEdid enabled | Out-Null
    }

    Import-Module -Force (Join-Path $root 'scripts/DisplayTopology.psm1')
    $sourceType = [SunshineVddSkill.NativeDisplay].GetNestedType('DISPLAYCONFIG_PATH_SOURCE_INFO', [Reflection.BindingFlags]'NonPublic')
    $targetType = [SunshineVddSkill.NativeDisplay].GetNestedType('DISPLAYCONFIG_PATH_TARGET_INFO', [Reflection.BindingFlags]'NonPublic')
    $pathType = [SunshineVddSkill.NativeDisplay].GetNestedType('DISPLAYCONFIG_PATH_INFO', [Reflection.BindingFlags]'NonPublic')
    $modeType = [SunshineVddSkill.NativeDisplay].GetNestedType('DISPLAYCONFIG_MODE_INFO', [Reflection.BindingFlags]'NonPublic')
    $sizeOfTypeMethod = [Runtime.InteropServices.Marshal].GetMethods() | Where-Object {
        $_.Name -eq 'SizeOf' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType -eq [Type]
    } | Select-Object -First 1
    Assert-True ([int]$sizeOfTypeMethod.Invoke($null, @($sourceType)) -eq 20) 'DISPLAYCONFIG_PATH_SOURCE_INFO layout must match wingdi.h.'
    Assert-True ([int]$sizeOfTypeMethod.Invoke($null, @($targetType)) -eq 48) 'DISPLAYCONFIG_PATH_TARGET_INFO layout must match wingdi.h.'
    Assert-True ([int]$sizeOfTypeMethod.Invoke($null, @($pathType)) -eq 72) 'DISPLAYCONFIG_PATH_INFO layout must match wingdi.h.'
    Assert-True ([int]$sizeOfTypeMethod.Invoke($null, @($modeType)) -eq 64) 'DISPLAYCONFIG_MODE_INFO layout must match wingdi.h.'

    $inventoryPath = Join-Path $root 'scripts/Get-SunshineVddState.ps1'
    $tokens = $null
    $parseErrors = $null
    $inventoryAst = [Management.Automation.Language.Parser]::ParseFile($inventoryPath, [ref]$tokens, [ref]$parseErrors)
    foreach ($functionName in 'Read-SharedTextFile', 'Get-SunshineStreamingState') {
        $definition = $inventoryAst.FindAll({
            param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName
        }, $true) | Select-Object -First 1
        Invoke-Expression $definition.Extent.Text
    }

    $logPath = Join-Path $temp 'sunshine.log'
    '[2026-01-01 00:00:00]: Info: Sunshine version: test' | Set-Content -LiteralPath $logPath
    $streamState = Get-SunshineStreamingState -Path $logPath -Processes @([pscustomobject]@{ Id = 1 })
    Assert-True ($streamState.Status -eq 'Inactive') 'A current Sunshine log epoch without session events must be inactive.'
    Add-Content -LiteralPath $logPath -Value '[2026-01-01 00:00:01]: Info: New streaming session started [active sessions: 1]'
    $streamState = Get-SunshineStreamingState -Path $logPath -Processes @([pscustomobject]@{ Id = 1 })
    Assert-True ($streamState.Status -eq 'Unknown') 'A session start before CLIENT CONNECTED must be treated conservatively as unknown.'
    Add-Content -LiteralPath $logPath -Value '[2026-01-01 00:00:02]: Info: CLIENT CONNECTED'
    $streamState = Get-SunshineStreamingState -Path $logPath -Processes @([pscustomobject]@{ Id = 1 })
    Assert-True ($streamState.Status -eq 'Active' -and $streamState.EstimatedActiveClients -eq 1) 'CLIENT CONNECTED must produce an active stream state.'
    Add-Content -LiteralPath $logPath -Value '[2026-01-01 00:00:03]: Info: CLIENT DISCONNECTED'
    $streamState = Get-SunshineStreamingState -Path $logPath -Processes @([pscustomobject]@{ Id = 1 })
    Assert-True ($streamState.Status -eq 'Inactive' -and $streamState.EstimatedActiveClients -eq 0) 'A balanced disconnect must return to inactive.'
    $streamState = Get-SunshineStreamingState -Path $logPath -Processes @()
    Assert-True ($streamState.Status -eq 'Inactive' -and $streamState.Detection -eq 'SunshineProcessNotRunning') 'No Sunshine process must be reported inactive.'

    'All config and native-layout fixture tests passed.'
}
finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
