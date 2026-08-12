# Script usage

Run every mutating script once without `-Apply`. Review the resulting object before repeating the command with `-Apply`.

Resolve paths relative to this skill directory. The values below are placeholders; substitute values approved in the plan and discovered on the live host.

## Inventory

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\Get-SunshineVddState.ps1
```

Use `-AsObject` when another PowerShell script needs the structured result.

Before any disruptive command, inspect `Sunshine.Streaming.Status`, `Sunshine.Streaming.LastRelevantEvents`, and `MttVddPnpDevices`. `Inactive` is a positive check; `Unknown` requires independent confirmation plus the command's explicit unknown-state override.

## VDD XML

Strict fixed mode:

```powershell
.\scripts\Set-VddSettings.ps1 -Resolutions 'WIDTHxHEIGHT' -RefreshRates RATE -PreferredRefreshRate RATE -GpuFriendlyName 'EXACT LIVE VDD RENDER GPU NAME' -Sdr10Bit disabled -HdrPlus disabled
```

Compatibility refresh list:

```powershell
.\scripts\Set-VddSettings.ps1 -Resolutions 'WIDTHxHEIGHT' -RefreshRates 60,90,120 -PreferredRefreshRate 120
```

Inspect `ProposedXml`, then repeat the exact command with `-Apply`. The script makes a timestamped backup before writing.

For an approved custom EDID, first place the reviewed file at `user_edid.bin` beside `vdd_settings.xml`, then preview with `-CustomEdid enabled` and the approved `-PreventSpoof`/`-EdidCeaOverride` values. Never enable `Sdr10Bit` and `HdrPlus` together.

## Sunshine

Fixed VDD-only streaming:

```powershell
.\scripts\Set-SunshineDisplayConfig.ps1 -OutputName '{LIVE-SUNSHINE-DISPLAY-GUID}' -Topology ensure_only_display -ResolutionMode manual -ManualResolution 'WIDTHxHEIGHT' -RefreshRateMode manual -ManualRefreshRate RATE -HdrMode disabled -RevertOnDisconnect $true
```

Client-driven resolution and refresh:

```powershell
.\scripts\Set-SunshineDisplayConfig.ps1 -OutputName '{LIVE-SUNSHINE-DISPLAY-GUID}' -Topology ensure_only_display -ResolutionMode auto -RefreshRateMode auto -HdrMode auto -RevertOnDisconnect $true
```

Omitting `-AdapterName` preserves Sunshine's current automatic or pinned encoder choice. Supply `-AdapterName 'EXACT LIVE SUNSHINE ENCODER ADAPTER'` only when the plan independently approved it. The script preserves unrelated lines and removes stale manual resolution or refresh keys when the corresponding mode is `auto` or `disabled`. `-HdrToggleDelay 500` is an opt-in workaround for a reproduced HDR-color issue, not a default.

## Reload VDD

First preview the exact PnP instance:

```powershell
.\scripts\Restart-VddDevice.ps1 -InstanceId 'ROOT\MTTVDD\0000'
```

Only after the preview positively identifies MTT VDD and recovery access is confirmed:

```powershell
.\scripts\Restart-VddDevice.ps1 -InstanceId 'ROOT\MTTVDD\0000' -ConfirmNoActiveStream -RecoveryConfirmed -Apply
```

Use the exact current `MttVddPnpDevices[].InstanceId`; `ROOT\DISPLAY\NNNN` remains accepted only when live inventory positively identifies that exact instance as MTT VDD. The script refuses an active stream and writes a restorable topology snapshot before restart. Do not add `-AllowDisableEnableFallback` unless an ordinary device restart has failed and the user approved the more disruptive fallback. Add `-AllowUnknownStreamState` only after log inspection and independent confirmation that every client is disconnected.

## Save physical-only idle topology

Preview:

```powershell
.\scripts\Set-PhysicalOnlyTopology.ps1 -PhysicalDisplayNames '\\.\DISPLAYN'
```

For multiple idle physical displays, pass an array such as `-PhysicalDisplayNames '\\.\DISPLAY1','\\.\DISPLAY2'`. The selected set must include the current primary display.

Apply from an elevated session after disconnecting Moonlight:

```powershell
.\scripts\Set-PhysicalOnlyTopology.ps1 -PhysicalDisplayNames '\\.\DISPLAYN' -ConfirmNoActiveStream -RecoveryConfirmed -Apply
```

`DISPLAYN` is dynamic. Re-inventory immediately before this command. The script refuses an active stream, saves a restorable snapshot, verifies the exact attached set, and attempts automatic rollback on failure. An unknown stream state requires the same narrowly scoped `-AllowUnknownStreamState` override described above.

## Restore a saved topology

Preview the reported snapshot:

```powershell
.\scripts\Restore-DisplayTopology.ps1 -SnapshotPath 'C:\VirtualDisplayDriver\display-topology-before-PURPOSE-TIMESTAMP.json'
```

Apply only with recovery access from an elevated session:

```powershell
.\scripts\Restore-DisplayTopology.ps1 -SnapshotPath 'C:\VirtualDisplayDriver\display-topology-before-PURPOSE-TIMESTAMP.json' -RecoveryConfirmed -Apply
```

The restore script first saves the current topology, so the recovery action is itself reversible.

## Closed-loop test

Check the idle state without waiting:

```powershell
.\scripts\Test-SunshineVddCycle.ps1 -ExpectedIdlePhysicalDisplays '\\.\DISPLAYN' -ExpectedVirtualResolution 'WIDTHxHEIGHT' -ExpectedVirtualRefreshRate RATE -IdleOnly
```

Run the interactive connect/disconnect test:

```powershell
.\scripts\Test-SunshineVddCycle.ps1 -ExpectedIdlePhysicalDisplays '\\.\DISPLAYN' -ExpectedStreamPhysicalCount 0 -ExpectedStreamMttVddCount 1 -ExpectedVirtualResolution 'WIDTHxHEIGHT' -ExpectedVirtualRefreshRate RATE
```

For a different approved topology, set the idle/stream physical names or counts and the idle/stream MTT/other-virtual counts explicitly. The test compares the exact attached categories rather than assuming a single-monitor VDD-only design. Fractional refresh rates use `-RefreshRateTolerance` because the GDI inventory may expose a rounded integer.
