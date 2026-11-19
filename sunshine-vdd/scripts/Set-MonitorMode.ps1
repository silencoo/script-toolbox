[CmdletBinding()]
param(
    [ValidateSet('Observe','Protect')][string]$Mode='Observe',
    [string]$InstallDirectory="$env:ProgramData\SunshineDisplayHealth\monitor",
    [string]$TaskName='SunshineDisplayDiagnosticMonitor',
    [switch]$ClearFailureLatch,
    [ValidatePattern('^guard-state\.json\.unreadable-\d{8}T\d{9}Z\.json$')][string]$AcknowledgeUnreadableState,
    [switch]$Apply
)
$ErrorActionPreference='Stop'
$InstallDirectory=[IO.Path]::GetFullPath($InstallDirectory)
$path=Join-Path $InstallDirectory 'guard.json'
$runtimePath=Join-Path $InstallDirectory 'data/guard-state.json'
function Get-ReviewedGuardState {
    $currentPolicy=Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if($currentPolicy.Mode -ne 'Observe' -or $Mode -ne 'Observe' -or $ClearFailureLatch){
        throw 'Acknowledging an unreadable-state notice requires Observe mode and cannot be combined with a reset or mode change.'
    }
    $archive=Join-Path (Split-Path -Parent $runtimePath) $AcknowledgeUnreadableState
    $expected="Stored guard state was unreadable. Observe only; inspect $archive before deliberately clearing the latch."
    $state=Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
    if(!(Test-Path -LiteralPath $archive -PathType Leaf) -or $state.SchemaVersion -ne 1 -or
        $state.Latched -isnot [bool] -or !$state.Latched -or $state.FailureHandled -isnot [bool] -or !$state.FailureHandled -or
        $state.Notice -cne $expected -or $state.Attempts -ne 0 -or $null -ne $state.LastAttempt){
        throw 'The reviewed archive does not match the current unreadable-state notice, or the guard recorded a protection action.'
    }
    return $state
}
$lock=$null
try {
    if($Apply){
        # Serialize mode changes and acknowledgments while the diagnostic task reloads its state.
        $lock=[IO.File]::Open((Join-Path $InstallDirectory 'mode-change.lock'),'OpenOrCreate','ReadWrite','None')
    }
    $policy=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json
    $settings=Get-Content -LiteralPath (Join-Path $InstallDirectory 'settings.json') -Raw|ConvertFrom-Json
    if($AcknowledgeUnreadableState){$null=Get-ReviewedGuardState}
    if($Mode -eq 'Protect'){
        $boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
        foreach($phase in @('idle','streaming')){
            $baseline=Get-Content -LiteralPath (Join-Path $InstallDirectory "data/baseline-$phase.json") -Raw|ConvertFrom-Json
            $id=if($phase -eq 'idle'){$settings.IdleMonitorInstanceId}else{$settings.ExpectedMonitorInstanceId}
            if($baseline.BootKey -ne $boot -or $baseline.MonitorId -ine $id -or $baseline.Record.Topology.PathCount -ne 1){throw "Verified $phase baseline from this boot is required."}
        }
    }
    if($ClearFailureLatch){
        $stream=& (Join-Path $PSScriptRoot 'Get-SunshineVddState.ps1') -StreamingOnly -AsObject
        if($stream.Status -ne 'Inactive'){throw 'Disconnect all clients before explicitly clearing a failure latch.'}
    }
    if(!$Apply){[pscustomobject]@{Mode='DryRun';Previous=$policy.Mode;Proposed=$Mode;ClearFailureLatch=$ClearFailureLatch.IsPresent;ReviewedArchive=$AcknowledgeUnreadableState};return}
    $backup=Join-Path $InstallDirectory ('backups/mode-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    [void](New-Item -ItemType Directory -Path $backup -Force)
    Copy-Item -LiteralPath $path -Destination $backup
    $wasRunning=(Get-ScheduledTask -TaskName $TaskName).State -eq 'Running'
    try{
        if($wasRunning){
            Stop-ScheduledTask -TaskName $TaskName
            $deadline=(Get-Date).AddSeconds(10)
            while((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running' -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 200}
            if((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running'){throw 'Monitor did not stop; policy unchanged.'}
        }
        if($AcknowledgeUnreadableState){
            $state=Get-ReviewedGuardState
            Copy-Item -LiteralPath $runtimePath -Destination $backup
            $state.Latched=$false
            $state.FailureHandled=$false
            $state.Notice=''
            Import-Module (Join-Path $InstallDirectory 'Status.Core.psm1') -Force
            Write-DiagnosticJson -Path $runtimePath -Value $state
        }else{
            $policy.Mode=$Mode;$policy|ConvertTo-Json|Set-Content -LiteralPath $path -Encoding UTF8
            if($ClearFailureLatch -and (Test-Path -LiteralPath $runtimePath)){
                Copy-Item -LiteralPath $runtimePath -Destination $backup
                Import-Module (Join-Path $InstallDirectory 'Guard.Core.psm1') -Force
                New-GuardState|ConvertTo-Json|Set-Content -LiteralPath $runtimePath -Encoding UTF8
            }
        }
    }finally{if($wasRunning -or !$AcknowledgeUnreadableState){Start-ScheduledTask -TaskName $TaskName}}
    [pscustomobject]@{Mode=$Mode;BackupDirectory=$backup;SunshineRestarted=$false}
}finally{if($null -ne $lock){$lock.Dispose()}}
