# Script usage

Run every mutating script once without `-Apply`. Review the resulting object before repeating the command with `-Apply`.

Resolve paths relative to this skill directory. The values below are placeholders; substitute values approved in the plan and discovered on the live host.

## Inventory

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\Get-SunshineVddState.ps1
```

Use `-AsObject` when another PowerShell script needs the structured result.

## VDD XML

Strict fixed mode:

```powershell
.\scripts\Set-VddSettings.ps1 -Resolutions 'WIDTHxHEIGHT' -RefreshRates RATE -PreferredRefreshRate RATE -GpuFriendlyName 'EXACT LIVE GPU NAME'
```

Compatibility refresh list:

```powershell
.\scripts\Set-VddSettings.ps1 -Resolutions 'WIDTHxHEIGHT' -RefreshRates 60,90,120 -PreferredRefreshRate 120
```

Inspect `ProposedXml`, then repeat the exact command with `-Apply`. The script makes a timestamped backup before writing.

## Sunshine

Fixed VDD-only streaming:

```powershell
.\scripts\Set-SunshineDisplayConfig.ps1 -AdapterName 'EXACT LIVE GPU NAME' -OutputName '{LIVE-SUNSHINE-DISPLAY-GUID}' -Topology ensure_only_display -ResolutionMode manual -ManualResolution 'WIDTHxHEIGHT' -RefreshRateMode manual -ManualRefreshRate RATE -RevertOnDisconnect $true
```

Client-driven resolution and refresh:

```powershell
.\scripts\Set-SunshineDisplayConfig.ps1 -AdapterName 'EXACT LIVE GPU NAME' -OutputName '{LIVE-SUNSHINE-DISPLAY-GUID}' -Topology ensure_only_display -ResolutionMode auto -RefreshRateMode auto -RevertOnDisconnect $true
```

The script preserves unrelated lines and removes stale manual resolution or refresh keys when the corresponding mode is `auto` or `disabled`.

## Reload VDD

First preview the exact PnP instance:

```powershell
.\scripts\Restart-VddDevice.ps1 -InstanceId 'ROOT\DISPLAY\NNNN'
```

Only after the preview positively identifies MTT VDD and recovery access is confirmed:

```powershell
.\scripts\Restart-VddDevice.ps1 -InstanceId 'ROOT\DISPLAY\NNNN' -RecoveryConfirmed -Apply
```

Do not add `-AllowDisableEnableFallback` unless an ordinary device restart has failed and the user approved the more disruptive fallback.

## Save physical-only idle topology

Preview:

```powershell
.\scripts\Set-PhysicalOnlyTopology.ps1 -PhysicalDisplayName '\\.\DISPLAYN'
```

Apply from an elevated session after disconnecting Moonlight:

```powershell
.\scripts\Set-PhysicalOnlyTopology.ps1 -PhysicalDisplayName '\\.\DISPLAYN' -ConfirmNoActiveStream -RecoveryConfirmed -Apply
```

`DISPLAYN` is dynamic. Re-inventory immediately before this command.

## Closed-loop test

Check the idle state without waiting:

```powershell
.\scripts\Test-SunshineVddCycle.ps1 -ExpectedPhysicalDisplay '\\.\DISPLAYN' -ExpectedVirtualResolution 'WIDTHxHEIGHT' -ExpectedVirtualRefreshRate RATE -IdleOnly
```

Run the interactive connect/disconnect test:

```powershell
.\scripts\Test-SunshineVddCycle.ps1 -ExpectedPhysicalDisplay '\\.\DISPLAYN' -ExpectedVirtualResolution 'WIDTHxHEIGHT' -ExpectedVirtualRefreshRate RATE
```
