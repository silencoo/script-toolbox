# VDD installation and upgrades

Use this branch only when MTT VDD is missing or the user explicitly approved an upgrade.

## Source and version

1. Browse the current official Virtual Display Driver project and release notes. Installation commands and package layout can change.
2. Use the publisher's official repository or release page. Do not use mirrors, repackaged archives, or identifiers copied from another host.
3. Record the selected release, download URL, driver version, and any published checksum or signing information.
4. Do not upgrade merely because a newer release exists. Explain the relevant fix or compatibility reason first.

## Before installation

- Confirm an elevated interactive session and a usable physical or alternate recovery path.
- Inventory all display adapters and indirect display drivers.
- Back up an existing `vdd_settings.xml` and the pre-change display topology.
- If replacing an existing installation, preserve its configuration separately from the installer directory.
- Warn that the desktop can flicker, rearrange, or disconnect during installation.

## Installation

Follow the exact instructions shipped with the approved release. Do not invent certificate, driver-store, or `pnputil` commands from memory.

Do not remove unrelated virtual display products as part of routine installation. If Windows selects a conflicting indirect display driver, report the evidence and ask before disabling it.

## After installation

1. Reboot if the release instructions require it.
2. Re-inventory the live PnP instance ID, dynamic `DISPLAYn`, driver version, and available Sunshine display devices.
3. Apply the approved VDD XML through `Set-VddSettings.ps1`.
4. Reload only the newly discovered MTT VDD instance when necessary.
5. Derive Sunshine's stable output GUID from its new display inventory or log. Never assume the pre-install GUID survived.
6. Continue with Sunshine configuration, the physical-only idle baseline, and the full connect/disconnect test.

Do not assume the MTT device instance is `ROOT\DISPLAY\...`; current installations commonly report `ROOT\MTTVDD\0000`. Always use the exact positively identified `MttVddPnpDevices[].InstanceId`. Keep the restorable pre-install topology snapshot and the config backup until the closed-loop test passes.
