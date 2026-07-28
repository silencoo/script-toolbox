# Utility catalog

This catalog records the choices made by the platform installers. Package
identifiers were checked against the WinGet community manifests and the
Homebrew Formulae API on 2026-07-28.

Built-in operating-system tools are preferred when they already cover the
need. An entry marked **optional** is installed only when the caller explicitly
adds `-IncludeOptional` on Windows or `--include-optional` on macOS.

## Core

| Purpose | Windows | macOS |
| --- | --- | --- |
| Password management | KeePassXC (`KeePassXCTeam.KeePassXC`) | KeePassXC (`keepassxc`) |
| GUI archives | NanaZip (`M2Team.NanaZip`) | Keka (`keka`) |
| Archive CLI | Zstandard (`Meta.Zstandard`) | 7-Zip (`sevenzip`) and Zstandard (`zstd`) |
| Disk usage | WinDirStat (`WinDirStat.WinDirStat`) | GrandPerspective (`grandperspective`) |
| Fast file search | Everything (`voidtools.Everything`) | Spotlight and `mdfind` (built in) |
| Local transfer | LocalSend (`LocalSend.LocalSend`) | LocalSend (`localsend`) |
| Media player | VLC (`VideoLAN.VLC`) | IINA (`iina`) |
| PDF viewing | SumatraPDF (`SumatraPDF.SumatraPDF`) | Preview (built in) |
| Window layout | PowerToys (`Microsoft.PowerToys`) | Rectangle (`rectangle`) |

The Windows `power-archive` profile substitutes
`mcmilk.7zip-zstd` for NanaZip. The installer refuses to silently combine
NanaZip, standard 7-Zip, and 7-Zip ZS because their associations and Explorer
integrations overlap.

## Media

| Purpose | Windows WinGet ID | macOS Homebrew token |
| --- | --- | --- |
| Media download | `yt-dlp.yt-dlp` | `yt-dlp` |
| Media conversion | `Gyan.FFmpeg` | `ffmpeg` |
| Video conversion | `HandBrake.HandBrake` | `handbrake-app` |
| Image conversion | `ImageMagick.ImageMagick` | `imagemagick` |
| Metadata | `OliverBetz.ExifTool` | `exiftool` |
| Transfer CLI | `aria2.aria2` | `aria2` |
| Alternative player (**optional**) | `mpv.net` | `mpv` |

Use yt-dlp only where downloading is permitted by the content owner,
applicable law, and the service's terms.

## Maintenance

| Purpose | Windows WinGet ID | macOS Homebrew token |
| --- | --- | --- |
| Manual application removal | `Klocman.BulkCrapUninstaller` | `appcleaner` (**optional**) |
| Disk usage | `WinDirStat.WinDirStat` | GrandPerspective from `core` |
| Duplicate inspection | `qarmin.krokiet` | `czkawka` |
| PDF inspection | `QPDF.QPDF` | `qpdf` |
| Drive health | `smartmontools.smartmontools` | `smartmontools` |
| Hardware and sensor monitoring | HWiNFO (`REALiX.HWiNFO`) | Stats (`stats`) |
| Encrypted backups | `restic.restic` | `restic` |
| Storage copy/sync | `Rclone.Rclone` | `rclone` |
| System backup | — | Time Machine (built in) |

The duplicate finders are installed as inspection tools. Neither initializer
runs them or deletes duplicate files. Homebrew-managed macOS applications
should normally be removed with `brew uninstall --cask <application>`;
AppCleaner is reserved for manually installed applications.

HWiNFO supports Windows, while Stats is the macOS menu-bar counterpart. HWiNFO
is freeware for non-commercial use. The initializer installs these monitors
but does not start them, enable launch-at-login, or configure sensor polling.

KeePassXC is installed by `core`, but the initializer never creates or opens a
password database, installs its browser extension, or changes clipboard
settings.

## Desktop

| Purpose | Windows | macOS |
| --- | --- | --- |
| Screenshots | ShareX (`ShareX.ShareX`) | Screenshot (built in) |
| Window layout | PowerToys | Rectangle |
| Keep awake | — | KeepingYouAwake (`keepingyouawake`) |
| Clipboard manager | — | Maccy (`maccy`, **optional**) |
| Launcher | Flow Launcher (`Flow-Launcher.Flow-Launcher`, **optional**) | Raycast (`raycast`, **optional**) |

Clipboard history is never enabled implicitly. It can retain passwords,
tokens, recovery codes, and other sensitive text.

## Admin

| Purpose | Windows WinGet ID | macOS Homebrew token |
| --- | --- | --- |
| System inspection | `Microsoft.Sysinternals.Suite` | Activity Monitor (built in) |
| Bootable media | `Rufus.Rufus`; `Ventoy.Ventoy` (**optional**) | — |
| Packet inspection | `WiresharkFoundation.Wireshark` | `wireshark-app` |
| Network inspection | `Insecure.Nmap` | `nmap` |
| Private networking | `Tailscale.Tailscale` | `tailscale-app` |
| Game-streaming client | `MoonlightGameStreamingProject.Moonlight` | `moonlight` |
| Game-streaming host | `LizardByte.Sunshine` | `lizardbyte/homebrew/sunshine` from the official `LizardByte/homebrew` tap |
| Encrypted storage | `Cryptomator.Cryptomator`; `IDRIX.VeraCrypt` (**optional**) | `cryptomator`; `veracrypt` (**optional**) |

Moonlight is the client and Sunshine is the self-hosted streaming server.
Sunshine's macOS package comes from the project's official Homebrew tap because
it is not in Homebrew's core cask catalog.

The complete admin profile is explicit because some packages require
elevation, a network extension or driver, firewall approval, or account
configuration. The initializer installs packages only and does not configure
streaming access, VPN membership, capture permissions, or encryption volumes.

## Deliberate exclusions

The catalog does not include registry cleaners, RAM optimizers, automatic
driver updaters, broad "debloat" scripts, all-in-one cleaners, or tools that
disable Defender, Gatekeeper, SIP, telemetry, or operating-system updates.

The initializers never:

- delete duplicates, caches, browser data, or user files;
- edit file associations;
- weaken Windows or macOS security settings;
- run cleanup, backup, remote-access, or disk-writing utilities.

Applications can be removed only through the explicit uninstall command. Its
menu starts with nothing selected, shows an exact review step, and removes
only the selected catalog packages. It never requests Homebrew zap, dependency
autoremove, cleanup, or direct deletion of application data. Homebrew taps
are retained.
