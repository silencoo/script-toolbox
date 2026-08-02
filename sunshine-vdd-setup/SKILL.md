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
- Inspect the actual host. Treat GPU names, `DISPLAYn` names, PnP instance IDs, monitor names, and Sunshine device GUIDs from examples as non-portable.
- Back up every file before editing it. Record the pre-change display topology before changing it.
- Require a confirmed local or alternate recovery path before restarting a display driver, disabling a display device, or changing the only active display.
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
3. HDR/SDR, touch/pen, and recovery requirements.

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

### 4. Apply in a safe order

Use the bundled scripts instead of rewriting display API or config-editing code.

1. Run all relevant scripts without `-Apply` and review their proposed changes.
2. Install VDD only if the inventory showed it is missing or the approved plan calls for an upgrade.
3. Back up and update VDD XML with `Set-VddSettings.ps1`.
4. If VDD XML changed, confirm recovery access, then reload the exact MTT VDD PnP instance with `Restart-VddDevice.ps1`.
5. Re-inventory displays and derive Sunshine's current stable output device GUID.
6. Back up and update Sunshine with `Set-SunshineDisplayConfig.ps1`.
7. Restart Sunshine only after warning that active Moonlight sessions will disconnect.
8. With no active stream and the intended physical display active, save the physical-only idle topology using `Set-PhysicalOnlyTopology.ps1`.

Do not reinstall the driver merely to apply XML changes. Do not assume a `DISPLAYn` value remains stable after a reload.

### 5. Verify the closed loop

Run `Test-SunshineVddCycle.ps1` and have the user perform one normal connection and disconnection.

Acceptance criteria:

- Idle: only the planned physical display paths are attached; MTT VDD remains installed but is not part of the desktop.
- Connect: only the selected VDD is attached when `ensure_only_display` was chosen.
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
- `scripts/Set-PhysicalOnlyTopology.ps1`: persist one selected active physical display path and detach other desktop paths without disabling their drivers.
- `scripts/Test-SunshineVddCycle.ps1`: read-only idle/stream/revert monitor.

## Troubleshooting

Read [references/troubleshooting.md](references/troubleshooting.md) before changing cursor, capture, or driver settings in response to a symptom. Diagnose one layer at a time: client input mode, Sunshine input/capture, Windows cursor state, VDD hardware cursor, display topology, then other IDD drivers.

Prefer official Microsoft, Sunshine, Moonlight, and VirtualDrivers documentation. Browse current official release notes before downloading or upgrading software.
