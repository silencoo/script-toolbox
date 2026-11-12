# Boot recovery and display-health tray

This implementation is for **physical-only idle and VDD-only private streaming**.
Physical monitors must be detached during a private stream. Do not replace this
policy with `ensure_primary`, a permanently attached panel, automatic login,
desktop ACL changes, or disabled security features.

## Implementation and verification status

- C#/.NET Framework runtime, WinForms tray, LocalSystem SCM service and fixed console
  helper are implemented. Build uses installed Visual Studio Roslyn or Framework
  `csc`.
- Native fixture tests and Windows PowerShell regression tests run without display
  changes. Logged-in native enumeration and a scratch Observe-mode monitor check
  were exercised on Windows 11.
- Tray installation and migration of the existing monitor to protected ProgramData
  in Observe mode were host-verified on Windows, including running tasks, schema-2
  heartbeat, file ACLs and unchanged Sunshine processes/configuration/dependencies.
  Visual verification of the tray UI is pending.
- **Boot service validation is limited to fixtures.** On-device testing is pending
  for pre-login helper launch, display changes, SCM startup coordination, installer
  rollback, and recovery after a full boot or forced shutdown. Verify the sign-in
  screen on the physical panel before relying on recovery.
- The current boot-service implementation requires Fast Startup disabled; this is
  an implementation limitation, not a requirement of Sunshine, VDD or the tray.
  If Fast Startup must remain enabled, do not deploy this service or its Sunshine
  dependency. Hybrid-startup recovery and its reconnect interlock remain unimplemented.
  Tray-only and Observe-monitor installation can proceed independently.
  Disabling Fast Startup is a power
  policy change, not a security change, and is a separate installer opt-in. With
  Fast Startup enabled, service startup cannot cover every apparent boot because
  Windows can resume kernel/session-0 state. Sleep/hibernate resume is outside
  this boot service's scope; it does not add a display-control loop after boot.

## Why startup coordination is required

An idle log event, no connected clients, an empty network table, repeated polling,
or a final process check cannot atomically exclude a reconnect during
`SetDisplayConfig`. Recovery therefore refuses to apply without an explicit
startup coordination policy.

The proposed deployment adds **one SCM dependency**:
`SunshineService -> SunshineBootRecovery`. Recovery stays `START_PENDING` until its
console worker has exited and its result is durable. SCM holds the dependent
Sunshine service until then. Recovery subsequently becomes an inert `RUNNING`
service so dependencies remain satisfied. Recovery work has finished: no timer,
shutdown cleanup, tray interaction, or reconnect re-arms it.

This interlock covers **only the approved sole SCM Sunshine launcher**. It does
not coordinate a manual `sunshine.exe`, another launcher, or another capture
server. Installation requires confirming the launcher inventory; any detected
Sunshine process cancels the worker. Those checks are defense in depth, **not an
atomic guarantee for unmanaged launches**. If sole-launcher coordination cannot be
established, do not enable recovery. No firewall/connection block or Sunshine
startup change is made by a preview, inventory or build.

If recovery has an ordinary bounded failure, it records Fault and releases the
startup dependency, preserving remote access for diagnosis. If privileged state,
ACLs or the startup prerequisites are corrupt, service startup fails and Sunshine's
dependency may prevent startup; independent recovery access is essential. This
does not repair Sunshine's capture configuration. Verify its approved VDD GUID and
`ensure_only_display` separately before deployment.

## Console/session boundary

Session 0 never calls CCD to change the login display. The service waits up to 20
seconds for `WTSGetActiveConsoleSessionId`, duplicates **its own** SYSTEM primary
token, sets `TokenSessionId`, and calls `CreateProcessAsUser` with the fixed
installed executable and `winsta0\default`. There is no dependency on a logged-in
user token. It neither copies a Winlogon token, switches desktops, alters desktop
ACLs, nor sets `SERVICE_INTERACTIVE_PROCESS`.

The child starts suspended, is assigned to a kill-on-close job, then resumes.
Creation failure, parent death, console change or the 125-second supervisor limit
terminates only this child. The worker verifies SYSTEM identity, current console,
SCM parent PID/`START_PENDING`, protected current-boot claim, dependency, and absence
of Sunshine before applying. Access-denied at the login desktop is a failure to
investigate, never permission to bypass isolation or use SYSTEM DisplaySwitch.

## Fresh physical layout and completion

The approved configuration contains physical monitor PnP identities, positions,
dimensions, refresh rates and the primary flag. It contains no executable, script,
adapter LUID, `DISPLAYn`, source/target ID or CCD snapshot. Unknown, missing or
ambiguous identities fail safely. Changed IDs require deliberate reapproval.

The helper queries `QDC_ALL_PATHS` in the current console and matches targets to
the approved identities. MTT may advertise HDMI: physical classification also
requires a PCI display adapter and excludes MTT identities. USB/wireless/unknown
adapters are currently unsupported, rather than guessed physical. Multiple routes
to one target are normal; distinct target identities and independent source routes
are checked. It creates source modes from the approved layout, validates, then
applies only the selected physical paths. Windows may adjust modes; verification
rejects deviations from the approved dimensions, positions, primary and rate.

Enumeration must stabilize. At most three applies occur within the 90-second
worker budget. Success requires repeated fresh active CCD queries plus independent
GDI attached/primary/mode and monitor-identity enumeration. A successful API return
alone is not success. Panel power, input selection, cable signal and visible pixels
remain unverified until a person checks them.

The service creates a random epoch under a protected **volatile** registry subkey
`HKLM\SOFTWARE\SunshineDisplayHealth\CurrentBoot`. It survives service restarts and
disappears on a full kernel boot. The file `boot-state.json` is flushed and atomically
published before any apply. Success, cancellation, fault and an interrupted claim
all prevent another recovery in the same boot. A corrupt completion file is unsafe.
Uninstall/rollback retain this state and registry epoch. Never delete them as a
retry mechanism during a private stream. Wall-clock boot timestamps are used only
for tray diagnostics, not privileged recovery authorization.

## Build and read-only preview

From the repository root:

```powershell
./sunshine-vdd/scripts/Build-Native.ps1 -Test
./sunshine-vdd/scripts/Get-BootRecoveryReadiness.ps1
./sunshine-vdd/native/bin/SunshineDisplay.Recovery.exe --inventory
./sunshine-vdd/scripts/Manage-DisplayHealth.ps1
```

Inventory and readiness output can include monitor identities, local file paths,
task arguments, and recent log entries. Redact those values before sharing a report.
Keep the local configuration, runtime logs, and native topology snapshots out of Git.

Copy `recovery.example.json` outside the tracked source, replace every identity and
mode with the reviewed physical layout, then preview:

```powershell
./sunshine-vdd/scripts/Manage-DisplayHealth.ps1 -ConfigurationPath C:\review\recovery.json `
  -ApproveSunshineStartupDependency -ConfirmSoleSunshineServiceLauncher -ApproveFastStartupChange
```

These switches describe a proposed change during preview; nothing is installed
without `-Apply`. After **explicit user approval** of that plan and confirmation of
independent recovery access, run the reviewed command elevated with `-Apply
-IndependentRecoveryConfirmed`. This installs the fixed service and a limited-token
at-logon tray task. It does not start recovery now, stop Sunshine, change current
topology, restart the old monitor, or reboot. The boot test is a separate approval.

The existing `SunshineDisplayDiagnosticMonitor` task remains the diagnostic writer.
Review its separate `Install-Monitor.ps1` preview to upgrade it. Its existing policy
is not edited by this installer. A legacy schema, missing heartbeat or NUL-filled
status appears Unknown in the new tray. New monitor status uses flushed atomic
replacement; automatic idle physical restoration is rejected because that monitor
does not own a reconnect interlock. Private-stream protection remains separate.

## Privilege boundary, logs and rollback

- Binaries/configuration: `%ProgramFiles%\SunshineDisplayHealth`.
- State/logs/backups: `%ProgramData%\SunshineDisplayHealth`.
- SYSTEM and Administrators write; Users read. Service permissions do not grant
  ordinary users start/stop/configuration access. Reparse paths and unprivileged
  writes/ownership are rejected. The privileged service does not consume the
  user-profile monitor's settings, actions, status or native snapshots.
- No public command pipe, arbitrary-command handler or arbitrary-executable setting
  exists. The fixed helper command accepts only the service PID and generated run
  GUID, and requires SYSTEM plus a matching protected claim.
- Recovery JSON logs retain at most 128 records, 16 MiB and 14 days. Current status
  and completion records are separate. Timestamped installation backups are retained
  for deliberate rollback. Local logs can be read with an already tested independent
  local/RDP/remote-shell channel; the installer does not provision one. Tailscale
  connectivity by itself does not prove such access.
- Every apply journals a native snapshot **from that boot** for investigation.
  Automatic rollback to physical paths after loss of safety evidence is forbidden.
  Use a supervised, same-boot recovery procedure only after disconnect and approval.

Preview uninstall with `Manage-DisplayHealth.ps1 -Operation Uninstall`; preview
rollback with `-Operation Rollback -BackupId <reported-directory-name>`. Apply needs
the same recovery/startup approvals, and `-ApproveFastStartupChange` if restoring a
different prior power setting. Only this product's service, task and dependency
membership are changed; unrelated Sunshine dependencies are preserved. Logs,
completion state and backups are retained. A failed install attempts rollback and
reports the backup path if manual repair is required. Service recovery is never
started automatically by rollback.

## Host acceptance, separately approved

1. Confirm a usable independent channel and save work. Correct any existing
   Sunshine capture/privacy mismatch through a separately reviewed change.
2. Confirm the approved physical layout, VDD identity/GUID, sole launcher, full
   boots, runtime ACLs, monitor heartbeat and installer preview.
3. Install only after approval. First test a normal reboot with no active stream;
   physically verify the login screen before logging in. Inspect worker session,
   CCD/GDI evidence, result, timestamps and terminal completion.
4. Verify normal VDD-only connect/disconnect and that restarting recovery after
   completion cannot undo private streaming. Do not induce a privacy leak to test.
5. Forced-shutdown/power-loss testing needs its own approval and saved work. Fixtures
   cover interrupted claims; they do not prove driver recovery after a power loss.

References: [Microsoft console-session service guidance](https://learn.microsoft.com/en-us/windows/win32/shell/fastuserswitching),
[SetDisplayConfig](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setdisplayconfig),
[QueryDisplayConfig](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-querydisplayconfig),
[Fast Startup behavior](https://learn.microsoft.com/en-us/windows-hardware/test/weg/delivering-a-great-startup-and-shutdown-experience),
[Sunshine's console launcher](https://github.com/LizardByte/Sunshine/blob/master/tools/sunshinesvc.cpp).
