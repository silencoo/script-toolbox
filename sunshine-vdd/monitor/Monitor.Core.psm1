function New-CaptureState {
    [pscustomobject]@{ Epoch=$null; LastTimestamp=$null; Clients=0; SessionStarted=$null; FirstConnect=$null; LastConnect=$null; LastDisconnect=$null; LastFullDisconnect=$null; Capture=$null; Pending=$null; Warnings=@(); ConfigurationLines=$null; RequestedMode=$null }
}

function Update-CaptureState {
    param($State, [string[]]$Lines)
    foreach ($line in $Lines) {
        if ($line -match '^\[(?<time>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\]') {
            $State.LastTimestamp = [datetime]::Parse($Matches.time, [cultureinfo]::InvariantCulture)
        }
        if ($line -match 'Sunshine version:') {
            $State.Epoch=$State.LastTimestamp; $State.Clients=0; $State.Capture=$null; $State.Pending=$null
            $State.SessionStarted=$null; $State.FirstConnect=$null; $State.LastConnect=$null; $State.LastDisconnect=$null; $State.LastFullDisconnect=$null; $State.Warnings=@(); $State.ConfigurationLines=$null; $State.RequestedMode=$null
        }
        if ($line -match 'Scheduling display device configuration:') { $State.ConfigurationLines=@(); $State.RequestedMode=$null; continue }
        if ($null -ne $State.ConfigurationLines) {
            if ($line -match '^\[') { $State.ConfigurationLines=$null }
            else {
                $State.ConfigurationLines += $line
                if ($State.ConfigurationLines.Count -gt 100) { $State.ConfigurationLines=$null }
                elseif ($line -eq '}') {
                    try {
                        $config=($State.ConfigurationLines -join "`n") | ConvertFrom-Json -ErrorAction Stop
                        if ($config.resolution.width -and $config.resolution.height -and $config.refresh_rate.value) {
                            $rate=$config.refresh_rate.value
                            if ($rate.numerator -and $rate.denominator) { $rate=[double]$rate.numerator/[double]$rate.denominator }
                            $State.RequestedMode=('{0}x{1}@{2}' -f $config.resolution.width,$config.resolution.height,([double]$rate).ToString('0.###',[cultureinfo]::InvariantCulture))
                        }
                    } catch { }
                    $State.ConfigurationLines=$null
                }
            }
        }
        if ($line -match 'New streaming session started') { $State.SessionStarted=$State.LastTimestamp }
        if ($line -match 'CLIENT CONNECTED') {
            if ($State.Clients -eq 0) { $State.FirstConnect=$State.LastTimestamp }
            if ($State.Clients -eq 0 -and (!$State.SessionStarted -or ($State.Capture -and $State.Capture.At -lt $State.SessionStarted))) { $State.Capture=$null; $State.Pending=$null }
            $State.Clients++; $State.LastConnect=$State.LastTimestamp
        }
        if ($line -match 'CLIENT DISCONNECTED') {
            if ($State.Clients -eq 1) { $State.LastFullDisconnect=$State.LastTimestamp }
            $State.Clients=[math]::Max(0,$State.Clients-1); $State.LastDisconnect=$State.LastTimestamp
            if ($State.Clients -eq 0) { $State.Capture=$null; $State.Pending=$null }
        }
        if ($line -match '^Capture size\s*:\s*(\d+)x(\d+)') {
            $State.Pending=[pscustomobject]@{ At=$State.LastTimestamp; Width=[int]$Matches[1]; Height=[int]$Matches[2]; X=$null; Y=$null }
        }
        if ($State.Pending -and $line -match '^Offset\s*:\s*(-?\d+)x(-?\d+)') {
            $State.Pending.X=[int]$Matches[1]; $State.Pending.Y=[int]$Matches[2]
            $State.Capture=$State.Pending; $State.Pending=$null
        }
        if ($line -match 'Previous active display .* is no longer present|Failed.*(?:display|revert)|Unable.*(?:display|revert)') {
            $State.Warnings=@($State.Warnings + [pscustomobject]@{At=$State.LastTimestamp;Text=$line} | Select-Object -Last 16)
        }
    }
}

function Get-CaptureHealth {
    param($State, $Processes, $Displays, $Target, [datetime]$Now=(Get-Date), [int]$GraceSeconds=5)
    $reason=''; $status='Unknown'; $match=@()
    if (@($Processes).Count -eq 0) { $status='Idle'; $reason='SunshineNotRunning' }
    elseif (@($Processes).Count -ne 1) { $reason='MultipleSunshineProcesses' }
    elseif (-not $Processes[0].StartTime) { $reason='ProcessStartTimeUnavailable' }
    elseif (-not $State.Epoch -or [math]::Abs(($State.Epoch - $Processes[0].StartTime).TotalSeconds) -gt 15) { $reason='LogEpochDoesNotMatchProcess' }
    elseif ($State.Clients -eq 0) {
        if ($State.SessionStarted -and (!$State.LastDisconnect -or $State.SessionStarted -gt $State.LastDisconnect)) { $status='Starting';$reason='SessionSetupInProgress' }
        else { $status='Idle';$reason='NoConnectedClients' }
    }
    elseif ($State.FirstConnect -and ($Now-$State.FirstConnect).TotalSeconds -lt $GraceSeconds) { $status='Starting';$reason='ConnectionGracePeriod' }
    elseif (@($Target).Count -eq 0) { $status='Degraded';$reason='ExpectedMonitorNotAttached' }
    elseif (@($Target).Count -gt 1) { $reason='ExpectedMonitorIdentityAmbiguous' }
    elseif (-not $State.Capture) { $reason='NoCaptureEvidence' }
    else {
        $c=$State.Capture
        $match=@($Displays | Where-Object { $_.Width -eq $c.Width -and $_.Height -eq $c.Height -and $_.PositionX -eq $c.X -and $_.PositionY -eq $c.Y })
        if ($match.Count -ne 1) { $reason='CaptureGeometryCannotIdentifyOneDisplay' }
        elseif ($match[0].DeviceName -eq $Target[0].DeviceName) { $status='Healthy';$reason='CaptureGeometryMatchesExpectedMonitor' }
        else { $status='Degraded';$reason='CaptureGeometryMatchesDifferentMonitor' }
    }
    [pscustomobject]@{ Status=$status; Reason=$reason; GeometryCandidates=@($match | ForEach-Object {$_.DeviceName}); Evidence='Sunshine capture geometry correlated with live native display inventory; not a direct capture GUID' }
}
Export-ModuleMember -Function New-CaptureState, Update-CaptureState, Get-CaptureHealth

function Get-PrivacyCaptureHealth {
    param($State, $Processes, $Displays, $StreamTarget, $IdleTarget, $Settings, [datetime]$Now=(Get-Date))
    $health=Get-CaptureHealth -State $State -Processes $Processes -Displays $Displays -Target $StreamTarget -Now $Now -GraceSeconds 12
    $phase=if(@($Processes).Count -gt 0 -and $State.Clients -gt 0){'Streaming'}else{'Idle'}
    $health | Add-Member -NotePropertyName Phase -NotePropertyValue $phase
    if($phase -eq 'Streaming') {
        if($health.Status -ne 'Healthy'){return $health}
        $physical=@($Displays | Where-Object {-not $_.IsMttVdd -and -not $_.IsOtherVirtual})
        if($physical.Count -gt 0){$health.Status='Degraded';$health.Reason='PrivacyPhysicalDisplayStillAttached'}
        elseif(@($Displays).Count -ne 1){$health.Status='Degraded';$health.Reason='UnexpectedStreamingDisplayTopology'}
        elseif($State.Capture.Width -eq 800 -and $State.Capture.Height -eq 600){$health.Status='Degraded';$health.Reason='VirtualDisplayFallback800x600'}
        elseif($Settings.PSObject.Properties.Name -contains 'ExpectedStreamResolution' -and $Settings.ExpectedStreamResolution) {
            $parts=$Settings.ExpectedStreamResolution -split 'x'
            if($State.Capture.Width -ne [int]$parts[0] -or $State.Capture.Height -ne [int]$parts[1]){$health.Status='Degraded';$health.Reason='UnexpectedStreamingResolution'}
        }
        if($health.Status -eq 'Healthy' -and $Settings.PSObject.Properties.Name -contains 'ExpectedStreamRefreshRate' -and $Settings.ExpectedStreamRefreshRate) {
            if([math]::Abs([double]$StreamTarget[0].RefreshRate-[double]$Settings.ExpectedStreamRefreshRate) -gt 0.6){$health.Status='Degraded';$health.Reason='UnexpectedStreamingRefreshRate'}
        }
        return $health
    }
    # Never use startup encoder probes or an untrusted log epoch as proof of idle topology.
    if($health.Status -ne 'Idle' -or $health.Reason -notin @('NoConnectedClients','SunshineNotRunning')){return $health}
    if($State.LastDisconnect -and ($Now-$State.LastDisconnect).TotalSeconds -lt 15){$health.Status='Starting';$health.Reason='DisplayRevertGracePeriod';return $health}
    if(@($IdleTarget).Count -ne 1){$health.Status='Degraded';$health.Reason='IdlePhysicalDisplayNotRestored';return $health}
    if(@($Displays).Count -ne 1 -or $Displays[0].DeviceName -ne $IdleTarget[0].DeviceName -or -not $IdleTarget[0].Primary){$health.Status='Degraded';$health.Reason='UnexpectedIdleDisplayTopology';return $health}
    $health.Reason='PhysicalOnlyIdleTopologyVerified'
    return $health
}
Export-ModuleMember -Function New-CaptureState, Update-CaptureState, Get-CaptureHealth, Get-PrivacyCaptureHealth

# Return the same record until evidence changes its outcome. The caller persists transitions.
function Get-DisconnectResult($Previous,$State,$Snapshot,[datetime]$Started,[datetime]$Now) {
    if(!$State.Epoch -or @($Snapshot.SunshineProcesses).Count -ne 1){return $Previous}
    $processStart=$Snapshot.SunshineProcesses[0].StartTime
    if(!$processStart -or [math]::Abs(($State.Epoch-$processStart).TotalSeconds) -gt 15){return $Previous}
    if(!$State.LastFullDisconnect){
        if($Previous -and !$Previous.Closed -and $State.Epoch.ToUniversalTime().Ticks -gt $Previous.Id){
            $record=$Previous.PSObject.Copy()
            if($record.Outcome -eq 'Pending'){$record.Outcome='Unverified'}
            $record.Closed=$true
            return $record
        }
        return $Previous
    }
    $ended=[datetime]$State.LastFullDisconnect
    $id=$ended.ToUniversalTime().Ticks
    if($ended -gt $Now -or ($Previous -and $Previous.Id -gt $id)){return $Previous}
    $record=$Previous
    if(!$Previous -or $Previous.Id -ne $id){
        # Replaying old Sunshine log lines on startup provides no historical topology.
        if($ended -lt $Started){return [pscustomobject]@{Id=$id;Outcome='Unverified';Seconds=0;Closed=$true}}
        $record=[pscustomobject]@{Id=$id;Outcome='Pending';Seconds=0;Closed=$false}
    }
    if($record.Closed){return $record}
    if($State.Clients -gt 0 -or ($State.SessionStarted -and $State.SessionStarted -gt $ended)){
        $next=$record.PSObject.Copy()
        if($next.Outcome -eq 'Pending'){$next.Outcome='Unverified'}
        $next.Closed=$true
        return $next
    }
    $active=@($Snapshot.DisplayPaths | Where-Object Active)
    if(!$active.Count -or !$Snapshot.ExpectedPhysicalMonitor -or @($active | Where-Object {!$_.InstanceId}).Count){return $record}
    $seconds=($Now-$ended).TotalSeconds
    $physicalOnly=$active.Count -eq 1 -and $active[0].PhysicalConnector -and $active[0].InstanceId -ieq $Snapshot.ExpectedPhysicalMonitor
    $displays=@($Snapshot.Displays)
    if($physicalOnly -and $displays.Count -eq 1 -and $displays[0].Primary -and $active[0].SourceName -and $active[0].SourceName -eq $displays[0].DeviceName){
        $outcome=if($record.Outcome -eq 'Failed'){'Late'}else{'Restored'}
        return [pscustomobject]@{Id=$id;Outcome=$outcome;Seconds=[long][math]::Ceiling($seconds);Closed=$true}
    }
    $grace=15.0
    $delayMs=0L
    if([long]::TryParse([string]$Snapshot.Config.dd_config_revert_delay,[ref]$delayMs)){
        $grace=[math]::Max($grace,5+($delayMs/1000))
    }
    $unexpectedPath=@($active | Where-Object {$_.InstanceId -ine $Snapshot.ExpectedPhysicalMonitor}).Count -gt 0
    if($unexpectedPath -and $seconds -ge $grace -and $record.Outcome -eq 'Pending'){
        return [pscustomobject]@{Id=$id;Outcome='Failed';Seconds=[long][math]::Floor($seconds);Closed=$false}
    }
    return $record
}
Export-ModuleMember -Function Get-DisconnectResult
