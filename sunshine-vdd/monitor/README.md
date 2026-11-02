# Sunshine display monitor and optional protection

This is the versioned successor to the existing `SunshineDisplayDiagnosticMonitor`
task. It replaces that task's runtime; it does not create a second monitor or alter
Sunshine's executable. The default is **Observe**, with the same diagnostics as the
original monitor. **Protect** adds opt-in corrective actions for a single physical
idle monitor and a single exclusive MTT stream monitor.

## Behavior

- Poll every two seconds. Trust only the current Sunshine process/log epoch.
- Allow Sunshine's connection/revert grace period, then require a persistent fault
  and a stable display inventory before a correction. Respect custom revert delay.
- Remember full native CCD snapshots only after a healthy, identity-verified layout
  remains stable. Never save a fallback layout as a good baseline. The physical
  and stream baselines are separate from Sunshine's internal restore state.
- Before correcting privacy loss, request Windows lock and verify the session's
  locked state. Restore the verified stream snapshot at most twice per session,
  with ten seconds between attempts. New clients joining and brief healthy periods
  do not reset the budget. Each apply has a preceding native recovery snapshot and
  fresh session checks. Never blindly enable all displays during a stream.
- Verify on subsequent polls instead of treating a successful API call as recovery.
- When correction is unavailable/exhausted, persist a failure latch, confirm lock,
  then stop `SunshineService`. If lock cannot be confirmed, do not stop the service
  or expose a physical recovery desktop: retain the latch and notify for manual action.
- After shutdown/disconnect has settled, restore only a verified physical baseline.
  Missing/stale idle baselines cause a notification, never a guessed topology.
- Protection never unlocks Windows, reloads a driver, edits Sunshine settings,
  clears Sunshine persistence, or automatically restarts the stopped service.

Display identities and the client requested resolution/rate must match the saved
baseline. Native snapshots are valid only in the same Windows boot. After reboot
they must be learned again from healthy layouts; without a valid stream baseline,
a persistent streaming fault locks/stops rather than attempting an unsafe restore.
For a new client mode, first establish a healthy stream in that mode.

This is reactive protection, not a guarantee of zero visible frames on the panel.
There are polling, grace, Windows lock and display-transition delays. A monitor
process crash also prevents protection until Task Scheduler restarts it. Local
balloon notifications are best-effort; `data/protection-notice.json`, `status.json`
and the action journal are the durable record. No messages leave the computer.

## Install / migrate

Run `scripts/Install-Monitor.ps1` from elevated PowerShell, first without `-Apply`.
For an existing monitor, settings and diagnostic records are retained. Supply
`-IdleMonitorInstanceId` if its old physical identity no longer matches live PnP
inventory. New installations also require `-StreamMonitorInstanceId` and
`-OutputGuid`. The installer backs up runtime files and task XML, then updates the
same task and starts it in Observe mode. It does not restart Sunshine or change
display topology.

While Observe runs, establish healthy physical-only idle and VDD-only streaming
states for at least 15 seconds each. Use the existing guarded recovery/physical
topology tools if necessary, with every client disconnected before idle repair.
Then preview/apply `scripts/Set-MonitorMode.ps1 -Mode Protect`. This requires both
verified baselines from the current boot. Complete a normal connect/disconnect
cycle. Do not deliberately trigger lock/service-stop while an unsaved remote work
session is in progress; run the fixture tests to verify the failure path safely.

## Control / rollback

- `Set-MonitorMode.ps1 -Mode Observe -Apply`: turn off corrective actions while
  keeping diagnostics. Restarting only the monitor does not interrupt Sunshine.
- After investigating a latched failure, with clients disconnected, use
  `Set-MonitorMode.ps1 -Mode Protect -ClearFailureLatch -Apply`; restart Sunshine
  manually when ready. A monitor restart alone does not clear a failure latch.
- `Stop-ScheduledTask -TaskName SunshineDisplayDiagnosticMonitor` stops monitoring;
  disable that task separately to prevent startup at login.
- To revert an upgrade, stop the task, restore the files from the installer's
  reported backup directory, restore `task.xml` using `Register-ScheduledTask`,
  then start the same task. Keep `data/`; do not delete diagnostic or baseline files.

The source does not contain personal monitor IDs, credentials or log snapshots.
Regression tests in `tests/Monitor*.Tests.ps1` use synthetic events and mocked
actions and do not switch displays, lock Windows or stop Sunshine.
