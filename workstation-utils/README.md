# Workstation utilities initializer

`workstation-utils` installs a deliberately separate set of everyday desktop
and maintenance utilities for Windows 10/11 and macOS. It complements
[`windows-dev-setup`](../windows-dev-setup/) without mixing frequently changing
personal utilities into the developer toolchain.

The default action is always `plan`. Installation is profile-based,
deduplicated, and rerunnable. The scripts install missing packages only; they
never delete data, clear caches, change security settings, or run any of the
installed cleanup tools. Uninstallation happens only through the explicit
menu described below.

See the [cross-platform package catalog](shared/packages.md) for every package
identifier, built-in alternative, opt-in choice, and safety note.

## Profiles

| Profile | Contents |
| --- | --- |
| `core` | KeePassXC, archives, local transfer, disk usage, search, media/PDF viewing, and window layout |
| `media` | yt-dlp, gallery-dl, FFmpeg, HandBrake, ImageMagick, ExifTool, aria2, and optional mpv |
| `maintenance` | Manual uninstall/duplicate inspection, qpdf, drive health, hardware monitoring, restic, and rclone |
| `desktop` | Screenshot or wake tools, LocalSend/layout tools, and opt-in launchers/clipboard history |
| `admin` | Explicit system/network inspection, private networking, Moonlight/Sunshine streaming, recovery, and encryption tools |

Profiles compose freely and duplicate packages are installed once. Optional
packages require an additional explicit switch.

Windows also offers `power-archive`, which replaces NanaZip in the selected
plan with the full 7-Zip Zstandard Edition. Do not combine archive applications
manually: their file associations and Explorer integration overlap.

## Windows

WinGet is supplied by Microsoft App Installer on supported Windows 10 and
Windows 11 systems. Open PowerShell in this directory and inspect a plan:

```powershell
.\windows\setup.ps1 plan -Profiles core,media
.\windows\setup.ps1 install -Profiles core,maintenance
```

Include opt-in alternatives and skip the initializer's confirmation:

```powershell
.\windows\setup.ps1 install `
  -Profiles desktop,admin `
  -IncludeOptional `
  -Yes
```

Preview the exact WinGet commands without changing the machine:

```powershell
.\windows\setup.ps1 install -Profiles core,media -DryRun
```

Use the power archive alternative:

```powershell
.\windows\setup.ps1 plan -Profiles core,power-archive
.\windows\setup.ps1 install -Profiles core,power-archive
```

The power archive selection removes NanaZip from the plan. If NanaZip or
standard 7-Zip is already installed, the initializer stops and asks you to
review and remove the conflicting application manually; it never performs the
uninstall as part of installation.

Additional switches:

```text
setup.ps1 [plan|install|uninstall|list]
  -Profiles core,media,maintenance,desktop,admin,power-archive
  -PackageIds ID1,ID2
  -ConfigFile PATH
  -IncludeOptional
  -Yes
  -DryRun
  -FailFast
```

By default, one package failure is recorded and the remaining independent
packages continue. `-FailFast` stops at the first failure. This is useful for
the admin profile, where a package may depend on system policy, elevation, or
current catalog availability.

## macOS

The macOS initializer requires [Homebrew](https://brew.sh/) for installation.
Planning remains available without Homebrew:

```sh
./macos/setup.sh plan core media
./macos/setup.sh install core desktop
```

Include opt-in applications:

```sh
./macos/setup.sh install maintenance desktop \
  --include-optional \
  --yes
```

Preview the Homebrew Bundle command without changing the machine:

```sh
./macos/setup.sh install core media --dry-run
```

The script reads the checked-in [`Brewfile`](macos/Brewfile), generates a
filtered Brewfile stream for the selected profiles, and runs Homebrew Bundle
with `--no-upgrade`. Passing the source catalog directly to `brew bundle`
installs nothing, so profile and optional-package safeguards cannot be
accidentally bypassed. Existing packages are retained, and unrelated packages
are neither upgraded nor removed.

Additional options:

```text
setup.sh [plan|install|uninstall|list] [profiles...]
  --include-optional
  --yes
  --dry-run
  --packages TOKEN1,TOKEN2
  --brewfile PATH
```

## Uninstall menu

Both platforms provide an explicit menu that detects installed applications
from this catalog. Nothing is selected in advance:

```powershell
.\windows\setup.ps1 uninstall
.\windows\setup.ps1 uninstall -Profiles media,desktop
```

```sh
./macos/setup.sh uninstall
./macos/setup.sh uninstall maintenance
```

Enter one or more displayed numbers, review the exact selection, then type
`UNINSTALL`. `-Yes` or `--yes` skips the final typed confirmation only after an
explicit menu or package selection.

Exact package selection is available for reviewed automation and dry runs:

```powershell
.\windows\setup.ps1 uninstall `
  -PackageIds KeePassXCTeam.KeePassXC,REALiX.HWiNFO `
  -DryRun
```

```sh
./macos/setup.sh uninstall \
  --packages keepassxc,stats \
  --dry-run
```

The uninstall command:

- removes only the selected WinGet packages or Homebrew formulae/casks;
- skips packages that are no longer installed;
- never uses Homebrew `--zap`, `autoremove`, or `cleanup`;
- does not issue commands to delete user files, password databases, or
  backups, and retains catalog taps;
- records independent Windows failures and continues unless `-FailFast` is
  specified.

Some third-party uninstallers may prompt for elevation or perform their own
application-specific service cleanup. The initializer does not add any
configuration or data-removal switches.

## Updating utilities

This initializer deliberately separates initial installation from upgrades.
Review available updates with the platform package manager, then apply them
when convenient:

```powershell
winget upgrade
```

```sh
brew outdated
```

yt-dlp and gallery-dl change frequently as supported sites evolve, so review
their updates regularly. Use them only for content you are allowed to download.

## Validation

The portable macOS planner tests can run from any Bash host:

```sh
./tests/macos-test.sh
```

On Windows, run the PowerShell parser and profile tests:

```powershell
.\tests\windows-test.ps1
```
