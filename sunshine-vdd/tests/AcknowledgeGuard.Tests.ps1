$ErrorActionPreference='Stop'
$command=Join-Path $PSScriptRoot '../scripts/Set-MonitorMode.ps1'
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('guard-review-'+[guid]::NewGuid().ToString('N'))
$data=New-Item -ItemType Directory -Path (Join-Path $fixture 'data') -Force
$archive='guard-state.json.unreadable-20250101T000000000Z.json'
$archivePath=Join-Path $data.FullName $archive
$runtime=Join-Path $data.FullName 'guard-state.json'
$policyPath=Join-Path $fixture 'guard.json'
$taskMock=@{State='Running';Stops=0;Starts=0;ChangeOnStop=$false}
function Get-ScheduledTask($TaskName){[pscustomobject]@{State=$taskMock.State}}
function Stop-ScheduledTask($TaskName){
    $taskMock.State='Ready';$taskMock.Stops++
    if($taskMock.ChangeOnStop){$state.Notice='Different incident';$state|ConvertTo-Json|Set-Content -LiteralPath $runtime}
}
function Start-ScheduledTask($TaskName){$taskMock.State='Running';$taskMock.Starts++}
function Expect-Rejection([scriptblock]$Action,[string]$Pattern){
    try{& $Action | Out-Null}catch{if($_.Exception.Message -match $Pattern){return};throw}
    throw "Expected rejection matching $Pattern"
}
try{
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../monitor/Status.Core.psm1') -Destination $fixture
    [IO.File]::WriteAllBytes($archivePath,[byte[]]@(0,0))
    '{}' | Set-Content -LiteralPath (Join-Path $fixture 'settings.json')
    '{"Mode":"Observe"}' | Set-Content -LiteralPath $policyPath
    $state=[pscustomobject]@{SchemaVersion=1;Latched=$true;FailureHandled=$true;Notice="Stored guard state was unreadable. Observe only; inspect $archivePath before deliberately clearing the latch.";Attempts=0;LastAttempt=$null;SessionKey='preserve-session'}
    $state | ConvertTo-Json | Set-Content -LiteralPath $runtime
    $initial=[IO.File]::ReadAllBytes($runtime)
    $target=@{InstallDirectory=$fixture;AcknowledgeUnreadableState=$archive;TaskName='fixture'}
    $preview=& $command @target
    if($preview.Mode -ne 'DryRun' -or $taskMock.Stops){throw 'Preview changed the monitor'}
    Expect-Rejection {& $command @target -Mode Protect} 'requires Observe'
    Expect-Rejection {& $command @target -ClearFailureLatch} 'combined with a reset'
    $state.LastAttempt='2025-01-01'
    $state | ConvertTo-Json | Set-Content -LiteralPath $runtime
    Expect-Rejection {& $command @target -Apply} 'recorded a protection action'
    $state.LastAttempt=$null
    [IO.File]::WriteAllBytes($runtime,$initial)
    $taskMock.ChangeOnStop=$true
    Expect-Rejection {& $command @target -Apply} 'does not match'
    if($taskMock.State -ne 'Running'){throw 'Task was not restarted after a changed incident'}
    $taskMock.ChangeOnStop=$false
    [IO.File]::WriteAllBytes($runtime,$initial)
    $originalPolicy=[Convert]::ToBase64String([IO.File]::ReadAllBytes($policyPath))
    $result=& $command @target -Apply
    $cleared=Get-Content -LiteralPath $runtime -Raw | ConvertFrom-Json
    if($cleared.Latched -or $cleared.FailureHandled -or $cleared.Notice -or $cleared.SessionKey -ne 'preserve-session'){throw 'Incorrect acknowledgment state'}
    if([Convert]::ToBase64String([IO.File]::ReadAllBytes($policyPath)) -ne $originalPolicy -or $taskMock.State -ne 'Running'){throw 'Policy or task state changed'}
    $backup=[IO.File]::ReadAllBytes((Join-Path $result.BackupDirectory 'guard-state.json'))
    if([Convert]::ToBase64String($backup) -ne [Convert]::ToBase64String($initial) -or !(Test-Path -LiteralPath $archivePath)){throw 'Backup or archive missing'}
    'PASS reviewed Observe warning, mode restrictions, changed incident, backup and monitor reload'
}finally{
    $resolved=[IO.Path]::GetFullPath($fixture)
    if([IO.Path]::GetDirectoryName($resolved) -eq ([IO.Path]::GetTempPath()).TrimEnd('\','/') -and [IO.Path]::GetFileName($resolved) -match '^guard-review-[a-f0-9]{32}$'){
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
