# Configuration reference

## State mapping

| Desired behavior | Sunshine setting |
| --- | --- |
| Fail-open streaming: activate VDD, make it primary, retain physical recovery display | `dd_configuration_option = ensure_primary` |
| Activate VDD but keep other displays | `dd_configuration_option = ensure_active` |
| Exclusive VDD-only streaming (high risk) | `dd_configuration_option = ensure_only_display` plus explicit risk acceptance |
| Fixed stream resolution | `dd_resolution_option = manual` and `dd_manual_resolution = WIDTHxHEIGHT` |
| Client-requested resolution | `dd_resolution_option = auto` |
| Fixed display refresh | `dd_refresh_rate_option = manual` and `dd_manual_refresh_rate = RATE` |
| Client-requested refresh | `dd_refresh_rate_option = auto` |
| Follow the client's HDR request | `dd_hdr_option = auto` |
| Leave the Windows HDR state unmanaged | `dd_hdr_option = disabled` |
| Restore idle topology | `dd_config_revert_on_disconnect = enabled` |

Use `disabled` for a display-device option only when the user explicitly wants Sunshine not to manage that part.

## Fail-open versus exclusive topology

`ensure_primary` is the default because a physical display remains available if Sunshine sleeps, exits uncleanly, or loses its in-memory revert state. It activates the selected VDD and makes it primary while retaining other attached displays. The tradeoff is that the physical monitor remains part of the Windows desktop during streaming.

`ensure_only_display` deliberately detaches every other display. `dd_config_revert_on_disconnect=enabled` improves the normal-disconnect path, but it is not an independent watchdog and cannot guarantee recovery across sleep, process failure, or display-driver re-enumeration. The configuration script therefore requires `-AcceptExclusiveTopologyRisk`, `-ConfirmAutomaticSleepDisabled`, and `-RecoveryPathConfirmed` when applying this mode. Do not approve it for unattended/overnight use while automatic sleep is enabled.

## Stable and dynamic identifiers

- MTT PnP instance IDs are discovered live and commonly look like `ROOT\MTTVDD\0000`; some releases/Windows enumerations may expose `ROOT\DISPLAY\0001`. They can change after reinstalling the driver.
- GDI display names such as `\\.\DISPLAY19` can change after reloads and topology changes.
- Sunshine's Windows `output_name` should use the stable device GUID reported by the installed Sunshine display inventory, for example `{...}`.
- Re-inventory all identifiers after installing or reloading VDD. Never copy identifiers from a README or another host.

## VDD XML

Typical MTT VDD settings live at `C:\VirtualDisplayDriver\vdd_settings.xml`:

```xml
<monitors><count>1</count></monitors>
<gpu><friendlyname>EXACT GPU NAME</friendlyname></gpu>
<global>
  <g_refresh_rate>120</g_refresh_rate>
</global>
<resolutions>
  <resolution>
    <width>2420</width>
    <height>1668</height>
    <refresh_rate>120</refresh_rate>
  </resolution>
</resolutions>
<options>
  <HardwareCursor>true</HardwareCursor>
</options>
```

The example values are illustrative only. Generate the XML from the approved plan.

- Keep one monitor unless the user explicitly requests more.
- For a strict single mode, publish one resolution and one global refresh rate.
- For compatibility refresh rates, publish the approved list while keeping Sunshine manual if a fixed stream is required.
- Preserve unrelated XML options unless the plan changes them.
- Keep normal and debug logging disabled after troubleshooting to prevent oversized logs.

VDD color/EDID options are separate from Sunshine's HDR request handling:

- `SDR10bit` and `HDRPlus` must not both be enabled.
- `CustomEdid=true` requires `user_edid.bin` beside `vdd_settings.xml`.
- `PreventSpoof` and `EdidCeaOverride` require custom EDID to be enabled.
- Preserve these values unless the approved plan explicitly changes them. Do not enable Sunshine's HDR toggle delay unless a targeted HDR-color test requires the workaround.

## Encoder adapter versus VDD GPU

- Sunshine `adapter_name` chooses a capture/encoding adapter. Omit it to keep Sunshine's automatic selection unless live testing proves pinning is necessary.
- VDD `<gpu><friendlyname>` chooses the render GPU used by the virtual display driver.
- Treat these as independent choices on hybrid systems. `dxgi-info.exe` output is useful inventory, not proof of physical wiring.

## Sunshine input

- `mouse = enabled` permits Moonlight mouse input.
- `native_pen_touch` controls native pen/touch events; it does not fix an ordinary MacBook mouse cursor.
- Keep input decisions separate from display capture and cursor composition decisions.

## Physical-only idle topology

Persisting a physical-only idle topology must:

1. Run with no active Moonlight session.
2. Confirm every chosen physical target is currently attached and that the selected set includes the current primary display.
3. Save the pre-change native CCD paths and modes in an integrity-checked snapshot.
4. Keep only the approved physical display path(s) active using virtual-mode-aware `SetDisplayConfig` calls when supported.
5. Save the result to the Windows display database.
6. Leave MTT VDD installed and started but detached from the desktop.

This avoids a hidden 800x600 fallback desktop and does not require a background helper.

The physical-only topology is an **idle baseline**. It does not make exclusive VDD-only streaming fail-safe. For emergency recovery, `Recover-PhysicalDisplayAccess.ps1` schedules `DisplaySwitch.exe /extend`, polls the lightweight Sunshine stream state, waits for Sunshine's configured revert delay to settle, and applies the topology change only after a second positively detected `Inactive` state.

## Backups

Create timestamped backups beside the original files or in an approved recovery directory:

- `sunshine.conf.bak-<purpose>-<timestamp>`
- `vdd_settings.xml.bak-<purpose>-<timestamp>`
- `display-topology-before-<purpose>-<timestamp>.json`

The topology JSON must contain serialized native paths and modes, not only a friendly inventory. Preview `Restore-DisplayTopology.ps1` before applying it; the restore script also snapshots the current state. Report every path in the handoff.
