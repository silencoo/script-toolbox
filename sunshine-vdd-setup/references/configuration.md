# Configuration reference

## State mapping

| Desired behavior | Sunshine setting |
| --- | --- |
| VDD only while streaming | `dd_configuration_option = ensure_only_display` |
| Activate VDD but keep other displays | `dd_configuration_option = ensure_active` |
| Make VDD primary while retaining others | `dd_configuration_option = ensure_primary` |
| Fixed stream resolution | `dd_resolution_option = manual` and `dd_manual_resolution = WIDTHxHEIGHT` |
| Client-requested resolution | `dd_resolution_option = auto` |
| Fixed display refresh | `dd_refresh_rate_option = manual` and `dd_manual_refresh_rate = RATE` |
| Client-requested refresh | `dd_refresh_rate_option = auto` |
| Restore idle topology | `dd_config_revert_on_disconnect = enabled` |

Use `disabled` for a display-device option only when the user explicitly wants Sunshine not to manage that part.

## Stable and dynamic identifiers

- MTT PnP instance IDs such as `ROOT\DISPLAY\0001` can change after reinstalling the driver.
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

## Sunshine input

- `mouse = enabled` permits Moonlight mouse input.
- `native_pen_touch` controls native pen/touch events; it does not fix an ordinary MacBook mouse cursor.
- Keep input decisions separate from display capture and cursor composition decisions.

## Physical-only idle topology

Persisting a physical-only idle topology must:

1. Run with no active Moonlight session.
2. Confirm the chosen physical target is currently attached and primary, or explicitly activate it first.
3. Save the pre-change topology.
4. Keep only the approved physical display path(s) active using `SetDisplayConfig`.
5. Save the result to the Windows display database.
6. Leave MTT VDD installed and started but detached from the desktop.

This avoids a hidden 800x600 fallback desktop and does not require a background helper.

## Backups

Create timestamped backups beside the original files or in an approved recovery directory:

- `sunshine.conf.bak-<purpose>-<timestamp>`
- `vdd_settings.xml.bak-<purpose>-<timestamp>`
- `display-topology-before-<purpose>-<timestamp>.json`

Report every path in the handoff.
