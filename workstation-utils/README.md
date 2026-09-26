# Workstation utilities initializer

`workstation-utils` installs a deliberately separate set of everyday desktop
and maintenance utilities for Windows 10/11 and macOS, plus desktop applications
for Debian 13. It complements
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
| `apps` | Firefox, VSCodium, LocalSend, KeePassXC, Moonlight, and Discord on Linux/Windows; Linux also includes Loupe |
| `core` | KeePassXC, VSCodium (macOS), archives, local transfer, disk usage, search, media/PDF viewing, and window layout |
| `media` | yt-dlp, gallery-dl, FFmpeg, HandBrake, ImageMagick, ExifTool, aria2, and optional mpv |
| `maintenance` | Manual uninstall/duplicate inspection, Mole, qpdf, drive health, hardware monitoring, restic, and rclone |
| `desktop` | Screenshot or wake tools, LocalSend/layout tools, and opt-in launchers/clipboard history |
| `admin` | Explicit system/network inspection, private networking, Moonlight/Sunshine streaming, recovery, and encryption tools |

Profiles compose freely and duplicate packages are installed once. Optional
packages require an additional explicit switch. Linux currently supports `core`,
`desktop`, `admin`, and `apps`; its catalog is limited to the seven applications
in the `apps` row. The macOS profiles are unchanged and do not include `apps`.

The Linux and Windows application installers formerly in `desktop-dotfiles`
are maintained here. `desktop-dotfiles` retains desktop components and their
installation, application preferences, file associations, the Linux `codium`
launcher, and i3 integration. Installing applications here does not deploy those
settings or require a sibling checkout.

Windows also offers `power-archive`, which replaces NanaZip in the selected
plan with the full 7-Zip Zstandard Edition. Do not combine archive applications
manually: their file associations and Explorer integration overlap.

## Linux (Debian 13)

Run with Python 3.9+ from `workstation-utils`:

```sh
python3 linux/setup.py plan apps
python3 linux/setup.py install apps --dry-run
python3 linux/setup.py install apps
```

`plan` is the default and works without APT or Flatpak, including on macOS and
Windows. `install --dry-run` also makes no package queries or network requests.
Real installation requires Debian 13 and checks for missing packages first.
Firefox ESR comes from the configured Debian APT repositories. The other six
applications come from Flathub. The installer bootstraps Flatpak through APT
when needed, installs new Flatpaks with `--user`, and skips apps already present
in either user or system installations. Run it as your desktop user; only APT
commands use `sudo`. APT uses `--no-upgrade` for requested installed packages;
dependency changes remain subject to the normal APT confirmation.

Profiles: `core` contains Firefox ESR, VSCodium, KeePassXC, LocalSend, and Loupe;
`desktop` contains LocalSend, Discord, and Loupe; `admin` contains only Moonlight.
`apps` restores the complete application set previously installed by
`desktop-dotfiles`. All four profiles may be combined without duplicate installs.

```sh
python3 linux/setup.py list
python3 linux/setup.py plan core desktop
python3 linux/setup.py install apps --manager flatpak
```

`--manager apt|flatpak|all` filters application selection. Flatpak selections can
still require APT to install the Flatpak runtime. `--yes` skips this script's
confirmation only; APT and Flatpak keep their normal prompts. Failures stop the
installer with a nonzero exit code. Linux currently provides installation and
planning; use the package managers directly for upgrades and uninstallation.
Application IDs live in [`linux/packages.json`](linux/packages.json).

## Windows

WinGet is supplied by Microsoft App Installer on supported Windows 10 and
Windows 11 systems. Open PowerShell in this directory and inspect a plan:

```powershell
.\windows\setup.ps1 plan -Profiles core,media
.\windows\setup.ps1 install -Profiles core,maintenance
```

To install the six applications formerly in `desktop-dotfiles/windows`, select
`apps`. This does not select the larger `core` or `admin` profiles:

```powershell
.\windows\setup.ps1 plan -Profiles apps
.\windows\setup.ps1 install -Profiles apps
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
  -Profiles apps,core,media,maintenance,desktop,admin,power-archive
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

The macOS `core` profile includes [VSCodium](https://formulae.brew.sh/cask/vscodium).
Homebrew also provides the `codium` command, so `codium .` opens the current
directory. To use `code` in interactive Zsh sessions, add this alias to your
managed `~/.zshrc` and reload it with `source ~/.zshrc`:

```zsh
alias code='codium'
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

Windows and macOS provide an explicit menu that detects installed applications
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

The Linux installer tests use mocked package managers and run on any Python
3.9+ host without installing software:

```sh
python3 -m unittest discover -s tests -p 'test_linux.py' -v
```

The portable macOS planner tests can run from any Bash host:

```sh
./tests/macos-test.sh
```

On Windows, run the PowerShell parser and profile tests:

```powershell
.\tests\windows-test.ps1
```
