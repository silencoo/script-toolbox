# Read-only planning helpers. Native runtime policy is in native/RecoveryEngine.cs.
Set-StrictMode -Version Latest
function Get-BootRecoveryInstallPlan {
    param([ValidateSet('Install','Uninstall','Rollback')][string]$Operation='Install',[ValidateSet('Tray','Recovery','All')][string]$Component='All',[bool]$StartupCoordinationApproved=$false)
    [pscustomobject]@{
        Operation=$Operation;Component=$Component;Preview=$true
        ServiceName='SunshineBootRecovery';TrayTask='SunshineDisplayHealthTray'
        BinaryDirectory=(Join-Path $env:ProgramFiles 'SunshineDisplayHealth')
        DataDirectory=(Join-Path $env:ProgramData 'SunshineDisplayHealth')
        ChangesSunshineStartup=($Component -ne 'Tray' -and $StartupCoordinationApproved)
        Dependency=if($Component -ne 'Tray' -and $StartupCoordinationApproved){'SunshineService -> SunshineBootRecovery (SCM START_PENDING gate)'}else{'None; recovery refuses topology changes'}
        StartsRecoveryNow=$false;ChangesLiveTopology=$false;StopsSunshine=$false
        ExistingMonitor='Preserved; upgrade separately with Install-Monitor.ps1 after review'
        ReconnectRace='Polling is not atomic. Coordination covers only the approved sole SCM launcher. Alternate/manual launch is outside that interlock and must be absent.'
        ApprovalRequired='Installation/tasks and Sunshine startup coordination require explicit user approval. A usable independent recovery channel is also required.'
    }
}
Export-ModuleMember -Function Get-BootRecoveryInstallPlan
