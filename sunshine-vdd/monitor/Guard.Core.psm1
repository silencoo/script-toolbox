Set-StrictMode -Version Latest

function New-GuardState {
    [pscustomobject]@{ SchemaVersion=1; SessionKey=''; Phase=''; FaultSince=$null; StableSince=$null; LastFingerprint=''; Attempts=0; LastAttempt=$null; Latched=$false; FailureHandled=$false; Notice=''; LastHealthy=$null }
}

function Get-GuardDecision {
    param($State,$Observation,$Policy,[datetime]$Now=(Get-Date))
    # Pure policy: no native APIs, files, service or display changes here.
    $decision=[pscustomobject]@{ Action='None'; Reason=$Observation.Reason; Phase=$Observation.Phase }
    if ($Policy.Mode -ne 'Protect') { return $decision }
    if ($State.Latched) {
        if (-not $State.FailureHandled) { $decision.Action='FailClosed' }
        elseif ($Observation.Trusted -and $Observation.Phase -eq 'Idle' -and -not $Observation.Grace -and $Observation.Stable -and $Observation.BaselineAvailable -and -not $Observation.Healthy -and $State.Attempts -lt $Policy.MaxAttempts -and (!$State.LastAttempt -or ($Now-[datetime]$State.LastAttempt).TotalSeconds -ge [math]::Max(20,$Policy.RetrySeconds))) {
            $decision.Action='RestoreIdle'
        }
        return $decision
    }
    if (-not $Observation.Trusted) { $State.FaultSince=$null; return $decision }
    # A new client joining an existing session must not reset the retry budget.
    $key=$Observation.SessionKey+':'+$Observation.Phase
    if ($State.SessionKey -ne $key) {
        $State.SessionKey=$key; $State.Attempts=0; $State.LastAttempt=$null; $State.FaultSince=$null
    }
    if ($Observation.Healthy) { $State.FaultSince=$null; $State.LastHealthy=$Now; return $decision }
    if ($Observation.Grace) { return $decision }
    if (!$State.FaultSince) { $State.FaultSince=$Now; return $decision }
    if (($Now-[datetime]$State.FaultSince).TotalSeconds -lt $Policy.FaultSeconds) { return $decision }
    if ($State.LastAttempt -and ($Now-[datetime]$State.LastAttempt).TotalSeconds -lt $Policy.RetrySeconds) { return $decision }
    # Do not chase a moving display topology. Bound the waiting window as well.
    if (-not $Observation.Stable -and ($Now-[datetime]$State.FaultSince).TotalSeconds -lt $Policy.MaxUnstableSeconds) { return $decision }
    if ($State.Attempts -ge $Policy.MaxAttempts -or -not $Observation.BaselineAvailable -or -not $Observation.ConfigMatches -or -not $Observation.Stable) {
        if ($Observation.Phase -eq 'Streaming') { $decision.Action='FailClosed' }
        else { $decision.Action='NotifyIdleFailure' }
        return $decision
    }
    $decision.Action=if($Observation.Phase -eq 'Streaming'){'RestoreStream'}else{'RestoreIdle'}
    return $decision
}

function Test-GuardBaseline {
    param($Baseline,[string]$Phase,[string]$MonitorId,[string]$ModeKey,[string]$BootKey)
    if (!$Baseline -or $Baseline.SchemaVersion -ne 1 -or $Baseline.Phase -ne $Phase -or $Baseline.MonitorId -ine $MonitorId -or $Baseline.BootKey -ne $BootKey) { return $false }
    if ($Phase -eq 'Streaming' -and (!$ModeKey -or $Baseline.ModeKey -ne $ModeKey)) { return $false }
    if ($Baseline.Record.Topology.PathCount -ne 1 -or @($Baseline.Record.Displays | Where-Object Attached).Count -ne 1) { return $false }
    $true
}

Export-ModuleMember -Function New-GuardState,Get-GuardDecision,Test-GuardBaseline
