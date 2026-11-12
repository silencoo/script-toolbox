Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'Guard.Core.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Status.Core.psm1') -Force

function Initialize-GuardWindows {
    if ('SunshineGuard.Session' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
namespace SunshineGuard {
 public static class Session {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Level1 {
   public uint SessionId; public int SessionState; public int SessionFlags;
   [MarshalAs(UnmanagedType.ByValTStr,SizeConst=33)] public string WinStationName;
   [MarshalAs(UnmanagedType.ByValTStr,SizeConst=21)] public string UserName;
   [MarshalAs(UnmanagedType.ByValTStr,SizeConst=18)] public string DomainName;
   public long LogonTime,ConnectTime,DisconnectTime,LastInputTime,CurrentTime;
   public uint IncomingBytes,OutgoingBytes,IncomingFrames,OutgoingFrames,IncomingCompressedBytes,OutgoingCompressedBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct InfoEx {public uint Level; public Level1 Data;}
  [DllImport("wtsapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern bool WTSQuerySessionInformation(IntPtr server,int session,int infoClass,out IntPtr buffer,out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr buffer);
  [DllImport("user32.dll",SetLastError=true)] public static extern bool LockWorkStation();
  public static int LockState() {
   IntPtr buffer; int bytes;
   if (!WTSQuerySessionInformation(IntPtr.Zero,Process.GetCurrentProcess().SessionId,25,out buffer,out bytes)) return -1;
   try {
    if(bytes<Marshal.SizeOf(typeof(InfoEx))) return -1;
    var value=(InfoEx)Marshal.PtrToStructure(buffer,typeof(InfoEx));
    return value.Level==1 ? value.Data.SessionFlags : -1;
   } finally {WTSFreeMemory(buffer);}
  }
 }
}
'@
}

function Write-GuardJson {
    param([string]$Path,$Value)
    Write-DiagnosticJson -Path $Path -Value $Value
}

function Send-GuardNotice {
    param([string]$Root,[string]$Message)
    Write-GuardJson (Join-Path $Root 'data/protection-notice.json') ([pscustomobject]@{At=(Get-Date).ToString('o');Message=$Message})
    # A best-effort local notification; the durable notice/status remains even on a locked desktop.
    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        if (!$script:noticeIcon) {
            $script:noticeIcon=New-Object System.Windows.Forms.NotifyIcon
            $script:noticeIcon.Icon=[Drawing.SystemIcons]::Warning
            $script:noticeIcon.Visible=$true
        }
        $script:noticeIcon.ShowBalloonTip(15000,'Sunshine display protection',$Message,[Windows.Forms.ToolTipIcon]::Warning)
    } catch { }
}
$script:noticeIcon=$null

function Read-GuardRuntime {
    param([string]$Path,[ValidateSet('Observe','Protect')][string]$Mode)
    if(!(Test-Path -LiteralPath $Path)){return New-GuardState}
    try {
        $runtime=Get-Content -LiteralPath $Path -Raw|ConvertFrom-Json
        if(!$runtime -or $runtime.SchemaVersion -ne 1){throw 'Unsupported guard runtime state.'}
        foreach($name in (New-GuardState).PSObject.Properties.Name){if($runtime.PSObject.Properties.Name -notcontains $name){throw "Missing guard state property: $name"}}
        if($runtime.Latched -isnot [bool] -or $runtime.FailureHandled -isnot [bool]){throw 'Invalid failure latch.'}
        return $runtime
    } catch {
        if($Mode -ne 'Observe'){throw 'Stored guard state is unreadable; automatic protection must remain disabled until reviewed.'}
        $evidence=$Path+'.unreadable-'+[datetime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'.json'
        Copy-Item -LiteralPath $Path -Destination $evidence -ErrorAction Stop
        $runtime=New-GuardState
        $runtime.Latched=$true;$runtime.FailureHandled=$true
        $runtime.Notice='Stored guard state was unreadable. Observe only; inspect '+$evidence+' before deliberately clearing the latch.'
        return $runtime
    }
}

function Initialize-Guard {
    param([string]$Root,$Settings)
    Initialize-GuardWindows
    $guardPath=Join-Path $Root 'guard.json'
    $policy=if(Test-Path -LiteralPath $guardPath){Get-Content -LiteralPath $guardPath -Raw|ConvertFrom-Json}else{
        [pscustomobject]@{Mode='Observe';MaxAttempts=2;RetrySeconds=10;FaultSeconds=5;StableSeconds=4;MaxUnstableSeconds=25;BaselineStableSeconds=10;ServiceName='SunshineService'}
    }
    if($policy.Mode -notin @('Observe','Protect') -or $policy.MaxAttempts -lt 1 -or $policy.MaxAttempts -gt 3 -or $policy.RetrySeconds -lt 5 -or $policy.FaultSeconds -lt 2 -or $policy.StableSeconds -lt 2 -or $policy.MaxUnstableSeconds -lt $policy.StableSeconds -or $policy.BaselineStableSeconds -lt 5 -or $policy.ServiceName -ne 'SunshineService'){throw 'Invalid guard policy; refusing to start automatic actions.'}
    $runtimePath=Join-Path $Root 'data/guard-state.json'
    $runtime=Read-GuardRuntime -Path $runtimePath -Mode $policy.Mode
    $boot=(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToString('o')
    [pscustomobject]@{Root=$Root;Policy=$policy;Runtime=$runtime;RuntimePath=$runtimePath;BootKey=$boot;Fingerprint='';StableSince=Get-Date;Baselines=@{};LastDecision=$null}
}

function Get-GuardObservation {
    param($Context,$Snapshot,$CaptureState)
    $now=[datetime]$Snapshot.At
    $trusted=@($Snapshot.SunshineProcesses).Count -eq 1 -and $CaptureState.Epoch -and $Snapshot.SunshineProcesses[0].StartTime -and [math]::Abs(($CaptureState.Epoch-$Snapshot.SunshineProcesses[0].StartTime).TotalSeconds) -le 15
    $phase=if($CaptureState.Clients -gt 0){'Streaming'}else{'Idle'}
    if($phase -eq 'Idle' -and $CaptureState.SessionStarted -and (!$CaptureState.LastDisconnect -or $CaptureState.SessionStarted -gt $CaptureState.LastDisconnect)){$trusted=$false}
    if(@($Snapshot.SunshineProcesses).Count -eq 0){$trusted=$true;$phase='Idle'}
    $sessionKey=if($CaptureState.FirstConnect){$CaptureState.Epoch.ToString('o')+':'+$CaptureState.FirstConnect.ToString('o')}else{'idle'}
    $modeKey=if($CaptureState.RequestedMode){$CaptureState.RequestedMode}else{$sessionKey}
    $configMatches=$Snapshot.Config.output_name -eq $script:guardSettings.ExpectedOutputGuid -and $Snapshot.Config.dd_configuration_option -eq 'ensure_only_display' -and $Snapshot.Config.dd_config_revert_on_disconnect -eq 'enabled'
    $fingerprint=($Snapshot.MonitorIdentities|ConvertTo-Json -Compress)+($Snapshot.Displays|ConvertTo-Json -Compress)+$phase
    if($fingerprint -ne $Context.Fingerprint){$Context.Fingerprint=$fingerprint;$Context.StableSince=$now}
    $healthy=$Snapshot.Health.Reason -in @('CaptureGeometryMatchesExpectedMonitor','PhysicalOnlyIdleTopologyVerified') -and $configMatches
    if($phase -eq 'Idle' -and @($Snapshot.SunshineProcesses).Count -eq 0){$healthy=@($Snapshot.Displays).Count -eq 1 -and @($Snapshot.MonitorIdentities).Count -eq 1 -and $Snapshot.MonitorIdentities[0].InstanceId -ieq $script:guardSettings.IdleMonitorInstanceId}
    if($healthy -and $phase -eq 'Streaming' -and $CaptureState.RequestedMode){
        $d=$Snapshot.Displays[0];$actual=('{0}x{1}@{2}' -f $d.Width,$d.Height,([double]$d.RefreshRate).ToString('0.###',[cultureinfo]::InvariantCulture))
        if($actual -ne $CaptureState.RequestedMode){$healthy=$false}
    }
    $grace=$Snapshot.Health.Status -eq 'Starting'
    # Respect customized Sunshine reversion delays, with time for Windows to settle.
    $revertSeconds=15
    if($Snapshot.Config.Contains('dd_config_revert_delay')){$revertSeconds=[math]::Max(15,([double]$Snapshot.Config.dd_config_revert_delay/1000)+5)}
    if($phase -eq 'Idle' -and $CaptureState.LastDisconnect -and ($now-$CaptureState.LastDisconnect).TotalSeconds -lt $revertSeconds){$grace=$true}
    $targetId=if($phase -eq 'Streaming'){$script:guardSettings.ExpectedMonitorInstanceId}else{$script:guardSettings.IdleMonitorInstanceId}
    $baselinePath=Join-Path $Context.Root ('data/baseline-'+$phase.ToLowerInvariant()+'.json')
    $baseline=$null
    if(Test-Path -LiteralPath $baselinePath){try{$baseline=Get-Content -LiteralPath $baselinePath -Raw|ConvertFrom-Json}catch{}}
    $available=Test-GuardBaseline $baseline $phase $targetId $modeKey $Context.BootKey
    [pscustomobject]@{At=$now;Trusted=[bool]$trusted;Phase=$phase;SessionKey=$sessionKey;ModeKey=$modeKey;MonitorId=$targetId;Healthy=$healthy;Grace=$grace;Reason=$Snapshot.Health.Reason;Stable=($now-$Context.StableSince).TotalSeconds -ge $Context.Policy.StableSeconds;StableSeconds=($now-$Context.StableSince).TotalSeconds;ConfigMatches=$configMatches;BaselineAvailable=$available;BaselinePath=$baselinePath;Baseline=$baseline}
}

function Save-GuardBaseline {
    param($Context,$Observation,$Snapshot)
    if(!$Observation.Trusted -or !$Observation.Healthy -or $Observation.Grace -or $Observation.StableSeconds -lt $Context.Policy.BaselineStableSeconds -or $Context.Runtime.Latched){return}
    # Only accept the exact approved identity and exclusive layout, never a transient fallback.
    if(@($Snapshot.Displays).Count -ne 1 -or @($Snapshot.MonitorIdentities).Count -ne 1 -or $Snapshot.MonitorIdentities[0].InstanceId -ine $Observation.MonitorId){return}
    if($Observation.BaselineAvailable){return}
    $native=Get-VddDisplayTopologySnapshot
    if($native.PathCount -ne 1 -or $native.SourceNames[0] -ne $Snapshot.Displays[0].DeviceName){return}
    $record=[pscustomobject]@{SchemaVersion=1;CapturedAt=(Get-Date).ToString('o');Reason='verified-monitor-baseline';Topology=$native;Displays=$Snapshot.Displays}
    $baseline=[pscustomobject]@{SchemaVersion=1;Phase=$Observation.Phase;MonitorId=$Observation.MonitorId;ModeKey=$Observation.ModeKey;BootKey=$Context.BootKey;Record=$record}
    Write-GuardJson $Observation.BaselinePath $baseline
}

function Confirm-GuardLock {
    if([SunshineGuard.Session]::LockState() -eq 0){return $true}
    [void][SunshineGuard.Session]::LockWorkStation()
    for($i=0;$i -lt 20;$i++){Start-Sleep -Milliseconds 250;if([SunshineGuard.Session]::LockState() -eq 0){return $true}}
    return $false
}

function Assert-GuardFreshObservation {
    param($Expected,$Fresh)
    if(!$Fresh.Trusted -or $Fresh.Phase -ne $Expected.Phase -or $Fresh.SessionKey -ne $Expected.SessionKey -or $Fresh.ModeKey -ne $Expected.ModeKey -or $Fresh.MonitorId -ine $Expected.MonitorId -or !$Fresh.ConfigMatches){throw 'Stream state, requested mode or monitor changed before correction; no display changes made.'}
}

function Invoke-GuardRestore {
    param($Context,$Observation,[scriptblock]$Refresh)
    # This monitor has no connection-admission interlock. Rechecking idle cannot
    # close the reconnect TOCTOU window, so never activate physical paths here.
    if($Observation.Phase -eq 'Idle'){throw 'Physical recovery requires coordinated boot recovery or an explicitly supervised manual operation. Idle polling is not an interlock.'}
    # Re-read stream state after policy evaluation and again immediately before the native apply.
    $fresh=& $Refresh
    Assert-GuardFreshObservation $Observation $fresh.Observation
    $liveIds=@(Get-VddDisplayInventory | ForEach-Object {[MonitorIdentity]::Get($_.DeviceName)} | ForEach-Object {$_.InstanceId})
    if($liveIds -inotcontains $Observation.MonitorId){throw 'Approved monitor is not enumerated; refusing a stale topology restore.'}
    $baseline=Get-Content -LiteralPath $Observation.BaselinePath -Raw|ConvertFrom-Json
    if(!(Test-GuardBaseline $baseline $Observation.Phase $Observation.MonitorId $Observation.ModeKey $Context.BootKey)){throw 'Baseline identity, mode or boot no longer matches.'}
    $path=Join-Path $Context.Root 'data/restore-candidate.json'
    Write-GuardJson $path $baseline.Record
    $validation=Restore-VddDisplayTopology -SnapshotPath $path
    if($validation.ValidationCode -ne 0){throw "Windows rejected baseline validation: $($validation.ValidationCode)"}
    [void](New-VddDisplayTopologyBackup -Directory (Join-Path $Context.Root 'data') -Reason 'guard-correction')
    $fresh=& $Refresh
    Assert-GuardFreshObservation $Observation $fresh.Observation
    if(($Observation.Phase -eq 'Streaming' -or $Context.Runtime.Latched) -and [SunshineGuard.Session]::LockState() -ne 0){throw 'Windows was unlocked during correction validation; no display changes made.'}
    [void](Restore-VddDisplayTopology -SnapshotPath $path -Apply)
}

function Invoke-GuardTick {
    param($Context,$Snapshot,$CaptureState,$Settings,[scriptblock]$Refresh)
    $script:guardSettings=$Settings
    $observation=Get-GuardObservation $Context $Snapshot $CaptureState
    Save-GuardBaseline $Context $observation $Snapshot
    # Refresh baseline availability after a successful capture.
    $observation=Get-GuardObservation $Context $Snapshot $CaptureState
    $decision=Get-GuardDecision $Context.Runtime $observation $Context.Policy ([datetime]$Snapshot.At)
    $Context.LastDecision=$decision
    if($decision.Action -eq 'None'){Write-GuardJson $Context.RuntimePath $Context.Runtime;return $observation}
    $runtime=$Context.Runtime
    if($decision.Action -eq 'NotifyIdleFailure'){
        if($runtime.Notice -ne $runtime.SessionKey){Send-GuardNotice $Context.Root 'Physical display recovery needs attention. No verified baseline or retry budget remains.';$runtime.Notice=$runtime.SessionKey}
        Write-GuardJson $Context.RuntimePath $runtime;return $observation
    }
    if($decision.Action -eq 'FailClosed'){
        # Persist the latch BEFORE side effects. A task restart never clears it or restarts Sunshine.
        $runtime.Latched=$true;$runtime.FailureHandled=$false;$runtime.Attempts=0;$runtime.LastAttempt=Get-Date
        Write-GuardJson $Context.RuntimePath $runtime
        $locked=Confirm-GuardLock
        $message='Protection failed. Windows lock could not be confirmed; Sunshine was not stopped and no physical display was enabled. Manual action required.'
        if($locked){
            try{Stop-Service -Name $Context.Policy.ServiceName -ErrorAction Stop;$message='Protection failed. Windows is locked and Sunshine has been stopped. Inspect logs before manually restarting Sunshine and rearming protection.'}
            catch{$message='Protection failed. Windows is locked, but stopping Sunshine failed: '+$_.Exception.Message}
        }
        Send-GuardNotice $Context.Root $message
        $runtime.FailureHandled=$true
        Write-GuardJson $Context.RuntimePath $runtime
        return $observation
    }
    $runtime.Attempts++;$runtime.LastAttempt=Get-Date
    Write-GuardJson $Context.RuntimePath $runtime
    try {
        if($decision.Action -eq 'RestoreStream' -and !(Confirm-GuardLock)){throw 'Could not confirm Windows lock before privacy correction.'}
        if($runtime.Latched -and [SunshineGuard.Session]::LockState() -ne 0){throw 'Failure latch requires a confirmed locked desktop before physical recovery.'}
        Invoke-GuardRestore $Context $observation $Refresh
        $result='Applied; awaiting independent verification on subsequent polls.'
    } catch { $result=$_.Exception.Message }
    $entry=[pscustomobject]@{At=(Get-Date).ToString('o');Action=$decision.Action;Attempt=$runtime.Attempts;Result=$result}
    Add-Content -LiteralPath (Join-Path $Context.Root ('data/protection-actions-'+(Get-Date -Format 'yyyy-MM-dd')+'.jsonl')) -Value ($entry|ConvertTo-Json -Compress) -Encoding UTF8
    return $observation
}

Export-ModuleMember -Function Initialize-Guard,Invoke-GuardTick,Get-GuardObservation,Write-GuardJson,Initialize-GuardWindows,Read-GuardRuntime
