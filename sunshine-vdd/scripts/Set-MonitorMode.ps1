[CmdletBinding()]
param([ValidateSet('Observe','Protect')][string]$Mode='Observe',[string]$InstallDirectory="$env:LOCALAPPDATA\SunshineMonitor",[string]$TaskName='SunshineDisplayDiagnosticMonitor',[switch]$ClearFailureLatch,[switch]$Apply)
$ErrorActionPreference='Stop'
$path=Join-Path $InstallDirectory 'guard.json'
$policy=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json
$settings=Get-Content -LiteralPath (Join-Path $InstallDirectory 'settings.json') -Raw|ConvertFrom-Json
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
if(!$Apply){[pscustomobject]@{Mode='DryRun';Previous=$policy.Mode;Proposed=$Mode;ClearFailureLatch=$ClearFailureLatch.IsPresent};return}
$backup=Join-Path $InstallDirectory ('backups/mode-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
[void](New-Item -ItemType Directory -Path $backup -Force)
Copy-Item -LiteralPath $path -Destination $backup
Stop-ScheduledTask -TaskName $TaskName
$deadline=(Get-Date).AddSeconds(10)
while((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running' -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 200}
if((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running'){throw 'Monitor did not stop; policy unchanged.'}
try{
    $policy.Mode=$Mode;$policy|ConvertTo-Json|Set-Content -LiteralPath $path -Encoding UTF8
    if($ClearFailureLatch){$runtimePath=Join-Path $InstallDirectory 'data/guard-state.json';if(Test-Path -LiteralPath $runtimePath){Copy-Item -LiteralPath $runtimePath -Destination $backup;Import-Module (Join-Path $InstallDirectory 'Guard.Core.psm1') -Force;New-GuardState|ConvertTo-Json|Set-Content -LiteralPath $runtimePath -Encoding UTF8}}
}finally{Start-ScheduledTask -TaskName $TaskName}
[pscustomobject]@{Mode=$Mode;BackupDirectory=$backup;SunshineRestarted=$false}
