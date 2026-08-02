[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^(?i)ROOT\\DISPLAY\\\d+$')]
    [string]$InstanceId,

    [switch]$RecoveryConfirmed,

    [switch]$AllowNoPhysicalFallback,

    [switch]$AllowDisableEnableFallback,

    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-PnpUtil {
    param([Parameter(Mandatory)][string[]]$Arguments)

    $output = & pnputil.exe @Arguments 2>&1 | Out-String
    [pscustomobject]@{
        Arguments = $Arguments
        ExitCode  = $LASTEXITCODE
        Output    = $output.Trim()
    }
}

$inventoryScript = Join-Path $PSScriptRoot 'Get-SunshineVddState.ps1'
$before = & $inventoryScript -AsObject
$physicalAttached = @($before.Displays | Where-Object { $_.Attached -and -not $_.IsMttVdd -and -not $_.IsOtherVirtual })
if ($physicalAttached.Count -eq 0 -and -not $AllowNoPhysicalFallback) {
    throw 'No attached physical fallback display was detected. Stop, restore a physical display, or explicitly accept this risk with -AllowNoPhysicalFallback.'
}

$device = Invoke-PnpUtil -Arguments @('/enum-devices', '/instanceid', $InstanceId)
if ($device.ExitCode -ne 0) {
    throw "pnputil could not inspect '$InstanceId': $($device.Output)"
}
if ($device.Output -notmatch '(?i)MttVDD|Virtual Display Driver|MikeTheTech') {
    throw "The requested PnP instance was not positively identified as MTT VDD. No action taken. pnputil output: $($device.Output)"
}

if (-not $Apply) {
    [pscustomobject][ordered]@{
        Mode                     = 'DryRun'
        InstanceId               = $InstanceId
        IdentityVerified         = $true
        PhysicalFallbackDisplays = @($physicalAttached.DeviceName)
        RecoveryConfirmed        = $RecoveryConfirmed.IsPresent
        PlannedCommand           = ('pnputil.exe /restart-device "{0}"' -f $InstanceId)
        DeviceDetails            = $device.Output
    }
    return
}

if (-not $RecoveryConfirmed) {
    throw 'Confirm local or alternate recovery access, then rerun with -RecoveryConfirmed.'
}
if (-not (Test-Administrator)) {
    throw 'Restarting the VDD device requires an elevated PowerShell session.'
}

$restart = Invoke-PnpUtil -Arguments @('/restart-device', $InstanceId)
$fallbackUsed = $false
if ($restart.ExitCode -ne 0) {
    if (-not $AllowDisableEnableFallback) {
        throw "The guarded device restart failed. No disable/enable fallback was attempted: $($restart.Output)"
    }
    $disable = Invoke-PnpUtil -Arguments @('/disable-device', $InstanceId)
    if ($disable.ExitCode -ne 0) { throw "VDD disable fallback failed: $($disable.Output)" }
    $enable = Invoke-PnpUtil -Arguments @('/enable-device', $InstanceId)
    if ($enable.ExitCode -ne 0) { throw "VDD enable fallback failed: $($enable.Output)" }
    $fallbackUsed = $true
}

Start-Sleep -Seconds 2
$after = & $inventoryScript -AsObject
[pscustomobject][ordered]@{
    Mode           = 'Applied'
    InstanceId     = $InstanceId
    FallbackUsed   = $fallbackUsed
    RestartOutput  = $restart.Output
    DisplaysBefore = $before.Displays
    DisplaysAfter  = $after.Displays
}
