param([switch]$Once, [string]$Root=$PSScriptRoot, [ValidateRange(0,3600)][int]$DurationSeconds=0)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'Monitor.Core.psm1') -Force
$topologyModule=Join-Path $PSScriptRoot 'DisplayTopology.psm1'
if(-not (Test-Path -LiteralPath $topologyModule)){$topologyModule=Join-Path $PSScriptRoot '../scripts/DisplayTopology.psm1'}
Import-Module $topologyModule -Force
Import-Module (Join-Path $PSScriptRoot 'Guard.Actions.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Status.Core.psm1')
$settings=Get-Content -LiteralPath (Join-Path $Root 'settings.json') -Raw | ConvertFrom-Json
$data=Join-Path $Root 'data'
[void](New-Item -ItemType Directory -Path $data -Force)
$utf8=[Text.UTF8Encoding]::new($false)
$rootHash=[Security.Cryptography.SHA256]::Create()
try{$mutexSuffix=([BitConverter]::ToString($rootHash.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($Root).ToLowerInvariant())))).Replace('-','')}finally{$rootHash.Dispose()}
$mutex=[Threading.Mutex]::new($false,('Local\SunshineDisplayDiagnosticMonitor-'+$mutexSuffix))
if (-not $mutex.WaitOne(0)) { $mutex.Dispose(); exit 0 }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class MonitorIdentity {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Device {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string Name;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string Description;
    public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string Id;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string Key;
  }
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool EnumDisplayDevices(string name,uint index,ref Device d,uint flags);
  public class Item { public string DisplayName; public string InstanceId; public string Description; }
  public static Item[] Get(string name) {
    var list=new List<Item>();
    for(uint i=0;i<32;i++) {
      var d=new Device(); d.cb=Marshal.SizeOf(d);
      if(!EnumDisplayDevices(name,i,ref d,1)) break;
      var id=d.Id ?? "";
      if(id.StartsWith(@"\\?\")) {
        var parts=id.Substring(4).Split('#');
        if(parts.Length>=3) id=parts[0]+@"\"+parts[1]+@"\"+parts[2];
      }
      list.Add(new Item {DisplayName=name,InstanceId=id,Description=d.Description});
    }
    return list.ToArray();
  }
}
'@
$state=New-CaptureState
$position=0L; $fileCreation=$null; $partial=''; $processKey=''; $ring=[Collections.Generic.Queue[object]]::new()
$logRing=[Collections.Generic.Queue[object]]::new(); $decoder=$utf8.GetDecoder()
$eventCursor=@{}; $nextEvents=Get-Date; $nextCleanup=Get-Date; $lastHealth=''; $lastDisplays=''; $lastConfig=''; $lastWrite=[datetime]::MinValue
$candidate=''; $candidateAt=Get-Date; $lastAlert=@{}; $iteration=0; $errorCount=0
$monitorStarted=Get-Date; $lastWarning=$null
$guard=Initialize-Guard -Root $Root -Settings $settings
$bootKey=$guard.BootKey
$deviceEvidence=$null; $deviceEvidenceAt=[datetime]::MinValue
function Get-MonitorProcesses {
    $items=@(Get-Process -Name sunshine -ErrorAction SilentlyContinue | Select-Object Id,StartTime)
    if(@($items | Where-Object {-not $_.StartTime}).Count -gt 0){
        $cim=@(Get-CimInstance Win32_Process -Filter "Name='sunshine.exe'" -ErrorAction SilentlyContinue)
        foreach($item in $items){if(!$item.StartTime){$match=@($cim | Where-Object ProcessId -eq $item.Id);if($match.Count -eq 1){$item.StartTime=$match[0].CreationDate}}}
    }
    return $items
}
function Append-Record([string]$Kind,$Value) {
    $entry=[ordered]@{RecordedAt=(Get-Date).ToString('o');Kind=$Kind;Data=$Value}
    $path=Join-Path $data ($Kind+'-'+(Get-Date -Format 'yyyy-MM-dd')+'.jsonl')
    $line=($entry | ConvertTo-Json -Depth 12 -Compress)+[Environment]::NewLine
    if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -gt 8MB) {
        $archive=Join-Path $data ($Kind+'-'+(Get-Date -Format 'yyyy-MM-dd-HHmmss-fff')+'.jsonl')
        Move-Item -LiteralPath $path -Destination $archive
    }
    [IO.File]::AppendAllText($path,$line,$utf8)
}
function Save-Incident([string]$Reason,$Snapshot) {
    $now=Get-Date
    if ($lastAlert.ContainsKey($Reason) -and ($now-$lastAlert[$Reason]).TotalSeconds -lt 60) { return }
    $lastAlert[$Reason]=$now
    $persistence=Join-Path (Split-Path $settings.LogPath) 'display_device.state'
    $guids=@()
    if ((Test-Path -LiteralPath $persistence) -and (Get-Item -LiteralPath $persistence).Length -lt 2MB) {
        $guids=@([regex]::Matches([IO.File]::ReadAllText($persistence),'\{[0-9a-fA-F-]{36}\}') | ForEach-Object {$_.Value} | Sort-Object -Unique)
    }
    $record=[ordered]@{At=$now.ToString('o');Reason=$Reason;Current=$Snapshot;RecentSamples=@($ring.ToArray());RecentLogEvents=@($logRing.ToArray());PersistenceGuids=$guids}
    $file=Join-Path $data ('incident-'+$now.ToString('yyyyMMdd-HHmmss-fff')+'.json')
    [IO.File]::WriteAllText($file,($record|ConvertTo-Json -Depth 15),$utf8)
    Append-Record 'alerts' ([ordered]@{Reason=$Reason;EvidenceFile=$file})
}
function Read-NewLog($Processes) {
    $key=(@($Processes | ForEach-Object { '{0}:{1}' -f $_.Id,$_.StartTime.Ticks }) -join ',')
    if (-not (Test-Path -LiteralPath $settings.LogPath)) { throw 'Sunshine log is unavailable' }
    $info=Get-Item -LiteralPath $settings.LogPath
    if ($key -ne $script:processKey -or $script:position -gt $info.Length -or $script:fileCreation -ne $info.CreationTimeUtc) {
        $script:processKey=$key; $script:position=0L; $script:partial=''; $script:decoder.Reset()
        $script:fileCreation=$info.CreationTimeUtc; $script:state=New-CaptureState
        # If an epoch marker is outside this bounded bootstrap window, health stays Unknown.
        if ($info.Length -gt 4MB) { $script:position=$info.Length-4MB }
        Append-Record 'monitor' @{Event='LogReaderReset';ProcessKey=$key;InitialOffset=$script:position}
    }
    $stream=[IO.File]::Open($settings.LogPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    try {
        [void]$stream.Seek($script:position,[IO.SeekOrigin]::Begin)
        $remaining=[int][math]::Min(4MB,[math]::Max(0,$stream.Length-$script:position))
        if ($remaining -eq 0) { return }
        $bytes=New-Object byte[] $remaining; $read=$stream.Read($bytes,0,$remaining); $script:position+=$read
        $chars=New-Object char[] ($utf8.GetMaxCharCount($read))
        $count=$script:decoder.GetChars($bytes,0,$read,$chars,0,$false)
        $chunk=$script:partial+[string]::new($chars,0,$count)
        $parts=$chunk -split "`n"; $script:partial=$parts[-1]
        $lines=@(); if ($parts.Count -gt 1) { $lines=@($parts[0..($parts.Count-2)] | ForEach-Object {$_.TrimEnd("`r")}) }
        if ($script:partial.Length -gt 65536) { $script:partial=''; throw 'Unexpected oversized log line' }
        $lineTime=$script:state.LastTimestamp
        foreach ($line in $lines) {
            if ($line -match '^\[(?<time>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\]') { $lineTime=[datetime]::Parse($Matches.time,[cultureinfo]::InvariantCulture) }
            # Retain diagnostic fields only; never copy Sunshine credential state or arbitrary config values.
            if ($line -match 'Sunshine version:|CLIENT (CONNECTED|DISCONNECTED)|New streaming session started|Previous active display|^Capture size\s*:|^Offset\s*:|^Virtual Desktop\s*:|Desktop resolution \[|Display refresh rate \[|Capture format \[|Failed.*(?:display|revert)|Unable.*(?:display|revert)|Optimize game settings|NvEnc:.*(?:failed|doesn.t support)|config: .(?:output_name|adapter_name|dd_configuration_option).') {
                $entry=[pscustomobject]@{At=$lineTime;Line=$line}
                Append-Record 'sunshine-events' $entry
                $logRing.Enqueue($entry); if($logRing.Count -gt 256){[void]$logRing.Dequeue()}
            }
        }
        Update-CaptureState $script:state $lines
    } finally { $stream.Dispose() }
}
function Read-DeviceEvents($Snapshot) {
    $channels=@(
        @{Name='Microsoft-Windows-Kernel-PnP/Device Management';Predicate='(EventID=1010 or EventID=1011)'},
        @{Name='System';Predicate="((EventID=566 and Provider[@Name='Microsoft-Windows-Kernel-Power']) or (EventID=4101 and Provider[@Name='Display']))"}
    )
    foreach ($channel in $channels) {
        $name=$channel.Name
        if (-not $eventCursor.ContainsKey($name)) {
            $latest=Get-WinEvent -LogName $name -MaxEvents 1 -ErrorAction Stop
            $eventCursor[$name]=[long]$latest.RecordId
            Append-Record 'monitor' @{Event='EventCursorInitialized';Channel=$name;RecordId=$latest.RecordId}
            continue
        }
        $xpath='*[System[EventRecordID > '+$eventCursor[$name]+' and '+$channel.Predicate+']]'
        $queryErrors=@()
        $events=@(Get-WinEvent -LogName $name -FilterXPath $xpath -ErrorAction SilentlyContinue -ErrorVariable queryErrors)
        foreach($err in $queryErrors) { if($err.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*'){throw $err} }
        foreach ($event in @($events | Sort-Object RecordId)) {
            $eventCursor[$name]=[long]$event.RecordId
            [xml]$xml=$event.ToXml(); $fields=[ordered]@{}
            foreach ($field in $xml.Event.EventData.Data) { if ($field.Name) {$fields[[string]$field.Name]=[string]$field.'#text'} }
            if ($name -like '*Kernel-PnP*' -and $fields.DeviceInstanceId -notlike 'DISPLAY\*' -and $fields.DeviceInstanceId -notlike 'HDAUDIO\*') { continue }
            $record=[ordered]@{At=$event.TimeCreated.ToString('o');Channel=$name;Id=$event.Id;RecordId=$event.RecordId;Fields=$fields}
            Append-Record 'device-events' $record
            if ($event.Id -eq 1010 -and $fields.DeviceInstanceId -eq $settings.ExpectedMonitorInstanceId) {
                $privacyMode=$settings.PSObject.Properties.Name -contains 'PrivacyMode' -and $settings.PrivacyMode
                if(-not $privacyMode -or $Snapshot.Clients -gt 0){Save-Incident 'ExpectedMonitorSurpriseRemoved' $Snapshot}
            }
        }
    }
}
function Trim-Records {
    $files=@(Get-ChildItem -LiteralPath $data -File | Where-Object {$_.Name -match '^(incident-|alerts-|samples-|sunshine-events-|device-events-|monitor-|protection-actions-|display-topology-before-guard-correction-)'} | Sort-Object LastWriteTimeUtc)
    foreach ($file in $files) { if ($file.LastWriteTimeUtc -lt [datetime]::UtcNow.AddDays(-[int]$settings.RetentionDays)) { Remove-Item -LiteralPath $file.FullName } }
    $files=@($files|Where-Object {Test-Path -LiteralPath $_.FullName});$size=($files|Measure-Object Length -Sum).Sum
    foreach($file in $files){if($size -le [long]$settings.MaxDataBytes){break};Remove-Item -LiteralPath $file.FullName;$size-=$file.Length}
}
function Get-MonitorSnapshot {
    param($processes,[datetime]$now=(Get-Date))
            $paths=@([SunshineVddSkill.NativeDisplay]::EnumeratePaths($true))
            if(($now-$script:deviceEvidenceAt).TotalSeconds -ge 15){
                try {
                    $script:deviceEvidence=@(Get-CimInstance Win32_PnPEntity -Filter "PNPClass='Monitor'" -ErrorAction Stop | Select-Object @{N='InstanceId';E={$_.PNPDeviceID}},Name,Present,Status,ConfigManagerErrorCode)
                } catch {$script:deviceEvidence=@([pscustomobject]@{Error=$_.Exception.Message;Present=$null})}
                $script:deviceEvidenceAt=$now
            }
            $allDisplays=@(Get-VddDisplayInventory)
            $displays=@($allDisplays | Where-Object Attached | Select-Object DeviceName,DeviceString,Attached,Width,Height,RefreshRate,PositionX,PositionY,Primary,IsMttVdd,IsOtherVirtual)
            $identities=@(foreach($d in $displays){[MonitorIdentity]::Get($d.DeviceName)})
            $targetNames=@($identities | Where-Object InstanceId -eq $settings.ExpectedMonitorInstanceId | ForEach-Object {$_.DisplayName})
            $target=@($displays | Where-Object {$_.DeviceName -in $targetNames})
            $config=[ordered]@{}
            foreach($line in [IO.File]::ReadAllLines($settings.ConfigPath)) {
                if($line -match '^\s*(output_name|adapter_name|dd_configuration_option|dd_resolution_option|dd_refresh_rate_option|dd_config_revert_on_disconnect|dd_manual_resolution|dd_manual_refresh_rate|dd_config_revert_delay)\s*=\s*(.*?)\s*$'){$config[$Matches[1]]=$Matches[2]}
            }
            $privacyMode=$settings.PSObject.Properties.Name -contains 'PrivacyMode' -and $settings.PrivacyMode
            if($privacyMode) {
                $idleNames=@($identities | Where-Object InstanceId -eq $settings.IdleMonitorInstanceId | ForEach-Object {$_.DisplayName})
                $idleTarget=@($displays | Where-Object {$_.DeviceName -in $idleNames})
                $health=Get-PrivacyCaptureHealth -State $state -Processes $processes -Displays $displays -StreamTarget $target -IdleTarget $idleTarget -Settings $settings -Now $now
            } else {$health=Get-CaptureHealth $state $processes $displays $target $now}
            if($config.output_name -ne $settings.ExpectedOutputGuid){$health.Status='Degraded';$health.Reason='ConfiguredOutputChangedFromBaseline'}
            if($privacyMode -and $config.dd_configuration_option -ne 'ensure_only_display'){$health.Status='Degraded';$health.Reason='ConfiguredTopologyChangedFromBaseline'}
            if($privacyMode -and $config.dd_config_revert_on_disconnect -ne 'enabled'){$health.Status='Degraded';$health.Reason='DisplayRevertDisabled'}
            if($privacyMode -and $health.Status -eq 'Healthy' -and (@($paths).Count -ne 1 -or $paths[0].InstanceId -ine $settings.ExpectedMonitorInstanceId -or $paths[0].PhysicalConnector)){$health.Status='Degraded';$health.Reason='ActiveCcdPathsDoNotMatchPrivateStream'}
            if($privacyMode -and $health.Reason -eq 'PhysicalOnlyIdleTopologyVerified' -and (@($paths).Count -ne 1 -or $paths[0].InstanceId -ine $settings.IdleMonitorInstanceId -or !$paths[0].PhysicalConnector)){$health.Status='Degraded';$health.Reason='ActiveCcdPathsDoNotMatchPhysicalIdle'}
            $snapshot=[pscustomobject][ordered]@{At=$now.ToString('o');MonitorPid=$PID;SunshineProcesses=$processes;Health=$health;Clients=$(if(@($processes).Count -eq 0){0}else{$state.Clients});LogEpoch=$state.Epoch;Capture=$(if(@($processes).Count -eq 0){$null}else{$state.Capture});ExpectedMonitor=$settings.ExpectedMonitorInstanceId;Displays=$displays;MonitorIdentities=$identities;Config=$config;LastWarnings=$state.Warnings;Iteration=$iteration;EventCursors=$eventCursor}
            $snapshot | Add-Member SchemaVersion 2
            $snapshot | Add-Member BootKey $bootKey
            $snapshot | Add-Member ExpectedPhysicalMonitor $settings.IdleMonitorInstanceId
            $snapshot | Add-Member Devices ([pscustomobject]@{At=$script:deviceEvidenceAt.ToString('o');Items=$script:deviceEvidence;Meaning='PnP presence is not desktop attachment or a visible image'})
            $snapshot | Add-Member DisplayPaths $paths
            $snapshot | Add-Member DisplayTargets @(foreach($adapter in $allDisplays){foreach($identity in [MonitorIdentity]::Get($adapter.DeviceName)){[pscustomobject]@{InstanceId=$identity.InstanceId;Name=$identity.Description;DisplayName=$adapter.DeviceName;Attached=$adapter.Attached;Primary=$adapter.Primary;IsMttVdd=$adapter.IsMttVdd;IsOtherVirtual=$adapter.IsOtherVirtual}}})
            $snapshot | Add-Member VisiblePicture 'Unverified; Windows enumeration cannot prove a panel shows an image'
    return $snapshot
}
function Read-GuardFresh {
    $freshProcesses=@(Get-MonitorProcesses)
    Read-NewLog $freshProcesses
    $freshSnapshot=Get-MonitorSnapshot $freshProcesses
    [pscustomobject]@{Observation=(Get-GuardObservation $guard $freshSnapshot $state);Snapshot=$freshSnapshot}
}
try {
    Append-Record 'monitor' @{Event='MonitorStarted';Pid=$PID;Identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name;ExpectedMonitor=$settings.ExpectedMonitorInstanceId}
    while ($true) {
        $iteration++; $now=Get-Date
        try {
            $processes=@(Get-MonitorProcesses)
            Read-NewLog $processes
            $snapshot=Get-MonitorSnapshot $processes $now
            $observation=Invoke-GuardTick $guard $snapshot $state $settings {Read-GuardFresh}
            $snapshot | Add-Member Protection ([pscustomobject]@{Mode=$guard.Policy.Mode;Latched=$guard.Runtime.Latched;Notice=$guard.Runtime.Notice;Attempts=$guard.Runtime.Attempts;Decision=$guard.LastDecision;BaselineAvailable=$observation.BaselineAvailable})
            $health=$snapshot.Health; $displays=$snapshot.Displays; $config=$snapshot.Config
            $ring.Enqueue($snapshot);if($ring.Count -gt 120){[void]$ring.Dequeue()}
            $healthKey=$health.Status+':'+$health.Reason
            $displayKey=$displays|ConvertTo-Json -Compress; $configKey=$config|ConvertTo-Json -Compress
            if($healthKey -ne $lastHealth -or $displayKey -ne $lastDisplays -or $configKey -ne $lastConfig -or ($now-$lastWrite).TotalSeconds -ge 60){Append-Record 'samples' $snapshot;$lastWrite=$now}
            $lastHealth=$healthKey;$lastDisplays=$displayKey;$lastConfig=$configKey
            foreach($warning in $state.Warnings){if($warning.At -ge $monitorStarted -and (!$lastWarning -or $warning.At -gt $lastWarning)){Save-Incident 'SunshineDisplayWarning' $snapshot;$lastWarning=$warning.At}}
            if($candidate -ne $healthKey){$candidate=$healthKey;$candidateAt=$now}
            if($health.Status -eq 'Degraded' -and ($now-$candidateAt).TotalSeconds -ge 5){Save-Incident $health.Reason $snapshot}
            if($now -ge $nextEvents){Read-DeviceEvents $snapshot;$nextEvents=$now.AddSeconds(10)}
            if($now -ge $nextCleanup){Trim-Records;$nextCleanup=$now.AddMinutes(5)}
            Write-DiagnosticJson -Path (Join-Path $data 'status.json') -Value $snapshot
            $errorCount=0
            if($Once){$snapshot|ConvertTo-Json -Depth 12;break}
            if($DurationSeconds -gt 0 -and ((Get-Date)-$monitorStarted).TotalSeconds -ge $DurationSeconds){break}
        } catch {
            $checkError=$_.Exception.Message
            Write-DiagnosticJson -Path (Join-Path $data 'status.json') -Value ([pscustomobject]@{SchemaVersion=2;BootKey=$bootKey;At=(Get-Date).ToString('o');MonitorPid=$PID;Health=@{Status='Unknown';Reason=$checkError};VisiblePicture='Unverified'})
            $errorCount++; Append-Record 'monitor' @{Event='CheckFailed';Error=$_.Exception.Message;ConsecutiveErrors=$errorCount;Iteration=$iteration}
            if($Once -or $errorCount -ge 15){throw}
        }
        Start-Sleep -Seconds ([int]$settings.PollSeconds)
    }
} finally { $mutex.ReleaseMutex();$mutex.Dispose() }
