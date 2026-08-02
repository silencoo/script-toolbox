# Troubleshooting

## Cursor missing or flickering

Determine whether the symptom affects one client or every client.

1. Confirm `mouse = enabled` in Sunshine.
2. Confirm Windows has an active pointing device and a normal cursor scheme.
3. Check whether the pointer is escaping into an attached idle VDD or another hidden desktop.
4. Keep MTT `<HardwareCursor>true</HardwareCursor>` unless running a controlled comparison. If `false` makes the cursor disappear completely, restore `true` and reload VDD.
5. Check Moonlight remote-desktop mouse mode only when the symptom is client-specific.
6. Inventory other active indirect display drivers and services. Treat them as possible conflicts, but do not disable them without permission.
7. Test the cursor on the physical display and the VDD separately to isolate capture from input.

Moonlight desktop-client shortcuts use `Ctrl+Alt+Shift`; on macOS, `Alt` is `Option`:

- `C`: toggle local cursor in remote-desktop mouse mode.
- `M`: toggle mouse mode.
- Sunshine `N`: hide or unhide the captured host cursor.

Avoid leaving both local and captured cursors visible when that produces a double/flickering cursor.

## Wrong stream resolution

Check all layers in order:

1. The approved Plan-mode resolution and refresh rate.
2. Moonlight's requested stream mode and its Optimize Game Settings option.
3. VDD-published modes after the last driver reload.
4. Sunshine `dd_resolution_option` and `dd_refresh_rate_option`.
5. Sunshine's captured output and actual mode in the log.

Do not add many fallback modes merely to hide a mismatch. Decide whether the workflow is fixed, automatic, or mixed and configure it consistently.

## VDD remains attached while idle

- Confirm all Moonlight clients have disconnected.
- Confirm `dd_config_revert_on_disconnect = enabled`.
- Remember that Sunshine restores the topology that existed before the connection. If that baseline was dual-screen, it will restore dual-screen.
- Save a new physical-only baseline with `Set-PhysicalOnlyTopology.ps1` while no stream is active.

## Physical monitor does not return

- Wait for normal no-signal wake latency.
- Confirm Windows restored the physical path even if the panel is dark.
- If a previous DDC/CI hard-off command was used, turn the monitor on physically once. Do not add DDC hard-off to the normal workflow.
- Use the recorded topology and safe-mode/device-manager recovery path if display enumeration is broken.

## UAC is invisible remotely

UAC uses the secure desktop and may not appear in a Moonlight capture. Before requesting elevation, ensure the user can approve it on the physical monitor or through an authorized alternate channel. Do not repeatedly create hidden UAC prompts.

## Logs

- Use normal Sunshine logging for verification.
- Enable VDD debug logging only for a short reproduction window.
- Record driver versions, Windows build, exact PnP instance IDs, Sunshine version, output GUID, and the before/after topology with every issue report.
