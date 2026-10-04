# Workstation utilities initializer

`workstation-utils` sets up desktop applications, everyday utilities, and
development tools. It includes a unified Windows 10/11 menu for utility
profiles, developer environments, and WSL 2; macOS utility and Zsh/Ghostty terminal setup;
and desktop application installation for Debian 13.

The Windows and macOS entry points open menus when invoked without arguments.
Explicit `plan` commands and the Linux default action only show plans.
Installation is profile-based, deduplicated, and rerunnable. The scripts install missing packages only; they
never delete user data or run the installed cleanup tools. Windows developer
setup also configures Git and PowerShell profiles; WSL and the Windows long-path
setting remain explicit choices. Uninstallation happens only through the
explicit utility menu described below.

On macOS, the `terminal` profile configures a Starship-powered Zsh environment
and Ghostty's SSH/font settings for the current user, preserving unrelated
settings and backing up changes.

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
| `terminal` | Ghostty, Starship, Zsh plugins, Yazi file manager, navigation, completion, CLI tools, and Nerd Font on macOS |

Profiles compose freely and duplicate packages are installed once. Optional
packages require an additional explicit switch. Linux currently supports `core`,
`desktop`, `admin`, and `apps`; its catalog is limited to the seven applications
in the `apps` row. macOS supports `terminal` and does not include `apps`.

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
Windows 11 systems. Open PowerShell in this directory and start the menu:

```powershell
.\windows\setup.ps1
```

Choose everyday utility profiles, developer core, developer standard, developer
full, WSL 2 setup, or the utility uninstall menu. Utility profiles can be
combined by entering numbers separated by commas. Each installer shows its
plan and asks before applying it; enter `0` or leave the menu input blank to
cancel. `-DryRun` previews the chosen operation without applying it.

The developer choices are:

| Choice | Contents |
| --- | --- |
| Core | VSCodium, PowerShell 7, Windows Terminal, Git, GitHub CLI, NanaZip, and modern shell/CLI tools |
| Standard (`default`) | Core plus Python, uv, Node.js, Java, Go, Rust, .NET, and native build tools |
| Full | Standard plus Docker Desktop, Kubernetes tools, Terraform, and developer applications |

Developer setup configures Starship, zoxide, history suggestions, `eza`
shortcuts, and `codium --wait` editor commands in PowerShell, preserving existing
profile content and its first backup. It also applies Git defaults. Use
`-NoShellConfig` or `-NoGitConfig` to skip those layers. WSL integration requires
`-IncludeWSL`; installing the developer full profile alone does not enable it.
See [Windows developer setup and WSL management](docs/windows-developer.md)
for the runtime pins, configuration details, and WSL commands.

The former top-level `windows-dev-setup/` is now maintained under `windows/`.
The unified entry point delegates utility installation to `utilities.ps1`,
developer setup to `developer.ps1`, and WSL management to `wsl.ps1`.

Command-line use remains available:

```powershell
.\windows\setup.ps1 plan -Mode developer -Profile core
.\windows\setup.ps1 install -Mode developer -Profile default
.\windows\setup.ps1 doctor -Mode developer -Profile default
.\windows\wsl.ps1 info
```

VSCodium and NanaZip are shared by the developer and utility catalogs. Both
installers skip those packages when already installed. The `core` developer
profile is separate from the utility `core` profile; use `-Mode developer` and
`-Profile` for developer commands, or `-Profiles` for utility selections.

Inspect an everyday utility plan:

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
setup.ps1 [menu|plan|install|uninstall|list|setup|doctor]
  -Mode utilities|developer
  -Profiles apps,core,media,maintenance,desktop,admin,power-archive
  -Profile core|default|full  (developer mode)
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

The macOS initializer opens an interactive menu when run without arguments:

```sh
./macos/setup.sh
```

Choose Install, Preview, or Uninstall. Install and Preview offer a numbered
profile picker; enter multiple numbers separated by commas or spaces. Empty
profile input selects `core`, and `0` cancels. Optional additions from the
selected profiles are listed with a separate yes/no prompt. Installation shows
the complete selected package plan and asks before applying it; Homebrew skips
packages already installed. Empty action input or end-of-input cancels safely.
Uninstall opens the existing installed-package picker and confirmation.

Use `menu --dry-run` to walk through the menu and preview operations. Explicit
commands remain available for automation; `plan` and `install` with no profile
arguments select `core` without the profile picker.

The initializer requires [Homebrew](https://brew.sh/) for installation.
Previewing and explicit planning remain available without Homebrew:

```sh
./macos/setup.sh plan core media
./macos/setup.sh install core desktop
```

Set up the Zsh prompt, plugins, terminal tools, and Ghostty with the `terminal`
profile:

```sh
./macos/setup.sh plan terminal
./macos/setup.sh install terminal --dry-run
./macos/setup.sh install terminal
```

The installer runs the selected Homebrew catalog with `--no-upgrade`, then
enables `ssh-env` and `ssh-terminfo` in `~/.config/ghostty/config.ghostty` for
the user running the script. It also creates or updates a managed `.zshrc`
block for Starship, fzf, zoxide, autosuggestions, syntax highlighting,
completions, history, and modern file aliases. Run it as your desktop user.
Existing settings are preserved, changed configurations are backed up, and
reruns are idempotent.
Planning and dry runs never write configuration. A later macOS configuration
file that can override these settings produces a warning. Open a new Ghostty
window after installation to load the integration.

The profile includes Ghostty, JetBrains Mono Nerd Font, Starship, zoxide, fzf,
eza, bat, ripgrep, fd, Yazi, tmux, Neovim, uv, jq, yq, git-delta, tealdeer, 7-Zip,
Zstandard, and the Homebrew Zsh plugins/completions. `--include-optional` adds
btop, ncdu, and duf. An existing Ghostty font choice is retained; otherwise
JetBrains Mono Nerd Font is selected when no included config supplies settings.
The `.zshrc` block respects exported `ZDOTDIR`, preserves symlinks and user
aliases/editor choices, and is validated before replacement.
Run `yazi` to browse files, or `y` to return to the selected directory on exit;
an existing `y` alias or function is preserved.

See [macOS terminal setup](docs/macos-terminal.md) for packages, aliases, and
configuration behavior, and
[Ghostty setup and manual SSH terminfo repair](docs/ghostty.md) for SSH details,
including the relocated `shared/ghostty-setup.sh` Linux desktop installer and
`shared/ghostty-ssh-terminfo.sh` repair helper. These replace the former
top-level `ghostty/` directory. Server terminfo installation remains in
[`linux-server-toolkit`](../linux-server-toolkit/).

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
  profiles: core,media,maintenance,desktop,admin,terminal
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
python3 -B -m unittest discover -s tests -p 'test_macos*.py' -v
./tests/ghostty-setup-test.sh
./tests/ghostty-ssh-terminfo-test.sh
```

On Windows, run the PowerShell parser and profile tests:

```powershell
.\tests\windows-test.ps1
.\tests\windows-menu-test.ps1
.\tests\windows-developer-test.ps1
.\tests\wsl-test.ps1
```
