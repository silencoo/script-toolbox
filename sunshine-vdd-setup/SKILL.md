---
name: sunshine-vdd-setup
description: Plan, configure, migrate, troubleshoot, and verify Windows Sunshine + Moonlight setups that use the MikeTheTech Virtual Display Driver (MTT VDD). Use for VDD installation or XML mode configuration, fixed or client-driven stream resolution and refresh rate, Sunshine display-device automation, physical-only idle topology, automatic physical/VDD switching, driver reloads, and cursor or resolution problems involving virtual displays.
---

# Sunshine VDD Setup

Build a reversible two-state Windows display setup: the chosen physical display(s) while idle and the chosen MTT VDD display(s) while Moonlight is streaming.

## Non-negotiable rules

- Enter Plan mode before any mutation when the environment supports it. Otherwise ask the same questions directly and wait for the decisions.
- Do not infer a resolution from a device name, screenshot, or old README. Ask the user which resolution and refresh rate Sunshine must use.
- Read every user-provided setup file completely before acting.
- Inspect the actual host. Treat Sunshine's encoder adapter, VDD's render GPU, `DISPLAYn` names, PnP instance IDs, monitor names, and Sunshine device GUIDs from examples as non-portable and independent.
- Back up every file before editing it. Persist a restorable CCD topology snapshot before every driver reload or topology change; an inventory-only JSON file is not a recovery backup.
- Require a confirmed local or alternate recovery path before restarting a display driver, disabling a display device, or changing the only active display.
- Refuse a driver reload or topology change when Sunshine reports an active stream. Treat an unknown stream state as unsafe unless the user independently confirms disconnection and explicitly approves the override.
- Never use DDC/CI hard power-off for the normal workflow. Change the Windows display topology and let the monitor enter no-signal standby.
- Keep `HardwareCursor=true` unless a targeted test proves otherwise. On MTT VDD, disabling it can make the cursor absent from captured frames.
- Do not disable unrelated virtual-display drivers without explaining the detected conflict and obtaining permission.
- Announce any action or pause caused by this skill.

## Workflow

### 1. Plan the desired state

Read [references/plan-decisions.md](references/plan-decisions.md). Resolve every required choice before changing the host. Ask no more than three short questions per round.

At minimum, obtain:

1. Stream mode policy and exact resolution/refresh-rate choices.
2. Idle and streaming display topologies.
3. HDR/SDR, 8/10/12-bit and custom-EDID requirements, input requirements, and recovery.
4. Sunshine's encoder adapter and VDD's render GPU independently; do not assume they are the same on hybrid-GPU hosts.

If the user chooses a fixed stream mode, clarify both:

- the manual Sunshine mode, such as `2420x1668 @ 120 Hz`;
- whether VDD should publish one strict refresh rate or a compatibility list such as `60, 90, 120`.

### 2. Inventory the host

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Get-SunshineVddState.ps1
```

Confirm:

- Windows version and active interactive session;
- Sunshine path, version, service state, and current config;
- detected Sunshine stream state (`Active`, `Inactive`, or `Unknown`) and the log evidence used;
- physical monitor(s), primary display, active desktop paths, and current modes;
- MTT VDD PnP instance ID, current dynamic `DISPLAYn`, driver version, and XML path;
- Sunshine's stable output device GUID from its display inventory/log, not only the dynamic `DISPLAYn`;
- other installed or active indirect display drivers;
- whether a Moonlight stream is active.

Stop and report discrepancies between a supplied README and the live host.

### 3. Choose the implementation

Use [references/configuration.md](references/configuration.md) for the mapping from plan decisions to VDD and Sunshine options.
Use [references/script-usage.md](references/script-usage.md) for exact preview and apply commands.

If MTT VDD is missing or an upgrade was explicitly requested, read [references/installation.md](references/installation.md) before downloading or installing anything.

Preferred two-state design:

- Idle: one selected physical display attached to the desktop; MTT VDD installed but detached.
- Streaming: Sunshine activates the selected VDD and uses `ensure_only_display` to detach other displays.
- Disconnect: `dd_config_revert_on_disconnect=enabled` restores the saved physical-only idle topology.

Do not add persistent helper processes or scheduled tasks when Sunshine's display-device automation and one saved idle topology are sufficient.

The bundled topology and test scripts also support multiple selected physical displays and explicit physical/VDD counts. Make the preview and acceptance parameters exactly match the approved idle and streaming states.

### 4. Apply in a safe order

Use the bundled scripts instead of rewriting display API or config-editing code.

1. Run all relevant scripts without `-Apply` and review their proposed changes.
2. Install VDD only if the inventory showed it is missing or the approved plan calls for an upgrade.
3. Back up and update VDD XML with `Set-VddSettings.ps1`.
4. If VDD XML changed, prove the stream inactive, confirm recovery access, then reload the exact live MTT VDD PnP instance (commonly `ROOT\MTTVDD\0000`) with `Restart-VddDevice.ps1`. The script saves a restorable topology snapshot first.
5. Re-inventory displays and derive Sunshine's current stable output device GUID.
6. Back up and update Sunshine with `Set-SunshineDisplayConfig.ps1`.
7. Restart Sunshine only after warning that active Moonlight sessions will disconnect.
8. With no active stream and every intended physical display active, save the physical-only idle topology using `Set-PhysicalOnlyTopology.ps1`. It saves a recovery snapshot and automatically attempts rollback if verification fails.

Do not reinstall the driver merely to apply XML changes. Do not assume a PnP instance ID, Sunshine GUID, or `DISPLAYn` value remains stable after a reload. If recovery is needed, preview and apply `Restore-DisplayTopology.ps1` with the reported snapshot path.

### 5. Verify the closed loop

Run `Test-SunshineVddCycle.ps1` and have the user perform one normal connection and disconnection.

Acceptance criteria:

- Idle: the attached physical/VDD/other-virtual counts and identities exactly match the approved idle state.
- Connect: the attached physical/VDD/other-virtual counts and identities exactly match the approved streaming state; for `ensure_only_display`, only the selected VDD is attached.
- Stream: VDD and Sunshine capture use the planned resolution and refresh rate.
- Disconnect: the physical-only idle topology returns and VDD detaches again.
- Cursor: the pointer remains visible in the stream and cannot escape into an idle hidden desktop.
- No unexpected 800x600 fallback display remains attached while idle.

Do not call the setup complete until this connection/disconnection cycle passes. If the user is unavailable, state that configuration is complete but regression verification is pending.

## Script routing

- `scripts/Get-SunshineVddState.ps1`: read-only JSON inventory.
- `scripts/Set-VddSettings.ps1`: validate, preview, back up, and edit MTT VDD XML.
- `scripts/Set-SunshineDisplayConfig.ps1`: validate, preview, back up, and edit Sunshine display/input keys.
- `scripts/Restart-VddDevice.ps1`: guarded restart of one exact MTT VDD PnP instance.
- `scripts/Set-PhysicalOnlyTopology.ps1`: persist the selected active physical display paths, detach other desktop paths without disabling drivers, and roll back a failed verification.
- `scripts/Restore-DisplayTopology.ps1`: validate and restore a restorable topology snapshot; save the current topology before applying the restore.
- `scripts/Test-SunshineVddCycle.ps1`: read-only idle/stream/revert monitor.

## Troubleshooting

Read [references/troubleshooting.md](references/troubleshooting.md) before changing cursor, capture, or driver settings in response to a symptom. Diagnose one layer at a time: client input mode, Sunshine input/capture, Windows cursor state, VDD hardware cursor, display topology, then other IDD drivers.

Prefer official Microsoft, Sunshine, Moonlight, and VirtualDrivers documentation. Browse current official release notes before downloading or upgrading software.
