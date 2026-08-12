# Plan decisions

Use this checklist before any host mutation. If Plan mode is available, use structured questions and record the selected answers in the plan.

## Round 1: stream mode

Ask which policy Sunshine should use:

- **Fixed mode (recommended for a dedicated client):** require an exact `WIDTHxHEIGHT` and refresh rate.
- **Client-controlled:** use the resolution and FPS requested by each Moonlight client.
- **Mixed:** fix resolution but follow client FPS, or follow client resolution but fix refresh rate.

For client-controlled or mixed policies, also ask whether each Moonlight client will enable **Optimize game settings**. Record the expected client request instead of treating `auto` as a guarantee that the desired mode will be requested.

Then ask what VDD should publish:

- **Strict single mode:** one resolution and one refresh rate.
- **One resolution, compatibility refresh rates:** for example one resolution with `60, 90, 120`.
- **Multiple modes:** collect every resolution and refresh rate explicitly.

Never assume that a MacBook, iPad, TV, handheld, or monitor model implies a particular stream mode.

## Round 2: topology

Collect both states independently:

- Idle topology:
  - one selected physical display only;
  - selected physical displays only;
  - physical plus VDD;
  - headless/VDD only.
- Streaming topology:
  - VDD only;
  - VDD plus physical display;
  - preserve the current topology.

If more than one physical monitor exists, ask which monitor(s) must remain active while idle. Use friendly monitor identity plus live device data; do not rely only on `DISPLAYn`.

## Round 3: display features and recovery

Ask:

- SDR or HDR; 8-bit, SDR 10-bit, or VDD HDR+; whether a custom `user_edid.bin`, spoof prevention, or CEA override is required. Do not enable conflicting VDD `SDR10bit` and `HDRPlus` options.
- Mouse/keyboard only, or native pen/touch passthrough.
- Whether the user has a physical monitor, alternate remote-control path, or safe-mode access for recovery.
- Whether unrelated virtual-display products may be stopped or disabled if they conflict.

Then collect the two GPU choices independently:

- **Sunshine encoder adapter:** leave automatic unless live encoder testing identifies an exact adapter that must be pinned.
- **VDD render GPU:** use the exact live VDD-supported friendly name only when the driver configuration should pin it.

On hybrid-GPU systems, never copy the VDD GPU name into Sunshine or vice versa merely because both settings accept a friendly name.

Do not schedule a VDD restart, topology change, or driver install without a usable recovery path.

## Plan summary

Before implementation, show a compact summary containing:

```text
Stream policy:
Sunshine resolution:
Sunshine refresh rate:
VDD published resolutions:
VDD published refresh rates:
Sunshine encoder adapter:
VDD render GPU:
Idle topology:
Streaming topology:
HDR/SDR and color depth:
Custom EDID options:
Input requirements:
Recovery path:
Unknown-stream-state override approved: no/yes
Expected connection interruption:
```

Ask for confirmation if any entry remains inferred or ambiguous.
