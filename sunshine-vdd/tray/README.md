# Read-only Windows tray

`SunshineDisplay.Tray.exe` is a normal WinForms application that starts after login.
It reads the existing monitor's `data/status.json` and the boot service's separate
status. It cannot change topology, stop Sunshine, clear latches, or trigger recovery.
Boot recovery does not depend on this process or a logged-in user.

States: **Physical ready**, **Privacy streaming**, **Checking or Unknown**, **Fault**.
Physical ready means the monitor verified the approved Windows layout; it does not
mean the panel shows a picture. Capture geometry is correlated log evidence, not a
direct capture GUID or frame observation. Legacy schema, invalid JSON, an old boot,
a timestamp in the future, or a heartbeat older than 15 seconds cannot appear healthy.

Double-click the icon for current identity, PnP presence, attached/primary, CCD path,
Sunshine configured target, capture, protection, recovery and timestamp details.
Recovery completion is displayed separately from live stream health; a historical
success cannot override a current privacy fault. Menus open local diagnostic folders.
The task runs with a limited interactive token, not SYSTEM.

Build, preview, installation, rollback and acceptance are described in
[boot-recovery/README.md](../boot-recovery/README.md). For a manual read-only run:

```powershell
./sunshine-vdd/native/bin/SunshineDisplay.Tray.exe --monitor-root "$env:ProgramData\SunshineDisplayHealth\monitor"
```

The existing monitor must be upgraded separately for schema 2. A corrupt existing
status/task is an actionable Unknown condition; the tray never starts another
monitor or silently edits its settings.

`Manage-DisplayHealth.ps1 -Component Tray` previews a tray-only deployment. Add
`-Apply` in an elevated shell after approval. This installs no recovery service,
changes no Sunshine dependency and preserves Fast Startup. Tray-only mutation is
refused if a recovery service already shares its DLLs. The tray task runs with a
limited interactive token. Use the same component with `-Operation Uninstall`,
or `-Operation Rollback -BackupId <reported-directory-name>`, to reverse it.
