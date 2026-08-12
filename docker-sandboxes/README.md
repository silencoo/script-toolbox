# Docker Sandboxes Manager

`sbx-manager.sh` and `sbx-manager.ps1` install, configure, diagnose, and
launch Docker Sandboxes from Bash or PowerShell. They wrap the official `sbx`
CLI with host checks, network-policy presets, daemon and proxy management,
template discovery, and shortcuts for supported coding agents.

## Supported hosts

- macOS 14 or newer on Apple silicon
- Windows 11 on 64-bit Intel or AMD with Windows Hypervisor Platform enabled
- Ubuntu 24.04 or newer with KVM
- Debian 13 or newer on an architecture for which Docker publishes a standalone
  Linux archive, as an explicitly enabled best-effort mode

Docker Sandboxes requires hardware virtualization. On Windows, the PowerShell
manager checks the Windows version, CPU architecture, and Hypervisor Platform
feature; when run as Administrator, `install` can enable the feature after
confirmation. A reboot may be required. Docker Desktop is not required.

On a new host, start with `setup balanced`. This is the recommended first
command: it installs `sbx` when needed, configures the initial network policy,
and signs in to Docker. Running either manager without a command remains
read-only; when `sbx` is missing, it displays the recommended setup command
before the general help.

On a Linux VPS, confirm that the provider exposes nested virtualization and that
`/dev/kvm` is available.

Ubuntu uses Docker's official APT package. Debian 13 uses Docker's official
standalone release archive, verifies its SHA-256 digest from the GitHub release
metadata, and installs it under `/usr/local`. Docker does not officially support
Debian as an SBX host, and standalone installs do not receive APT upgrades.
If setup newly adds the user to the `kvm` group, it pauses before starting the
daemon; open a fresh login or SSH session and rerun setup so the new group is
active.

On Linux, sandbox kit volumes also require `mkfs.ext4` from `e2fsprogs`.
The manager includes the system sbin directories when starting `sandboxd` and
repairs a daemon that previously disabled its block-volume driver because those
directories were absent from `PATH`.

## Usage on macOS and Linux

Make the script executable and display its built-in help:

```bash
chmod +x sbx-manager.sh
./sbx-manager.sh --help
```

Install and configure an open, balanced, or locked network-policy preset:

```bash
./sbx-manager.sh setup balanced
```

Setup initializes the requested policy before starting the daemon or checking
Docker authentication, so a fresh installation does not open a second,
interactive policy picker. If the requested preset is already active, setup
keeps its rules and continues. If a different local preset exists, setup asks
before resetting its rules; pass `--yes` only when that reset is intentional.

On Debian 13 or newer, explicitly enable the best-effort standalone path:

```bash
./sbx-manager.sh --experimental-debian setup balanced
```

## Usage on Windows

From PowerShell, display the built-in help and run setup:

```powershell
.\sbx-manager.ps1 --help
.\sbx-manager.ps1 setup balanced
```

The manager installs the official `Docker.sbx` WinGet package when `sbx` is not
already present. If Windows Hypervisor Platform is disabled, open PowerShell as
Administrator for the first setup. The feature can also be enabled directly:

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All
```

The PowerShell entry point has the same `install`, `setup`, `login`, `info`,
`doctor`, `templates`, `network`, `daemon`, and `run` command surface as the
Bash entry point. Windows workspace paths, including paths with spaces, are
passed to `sbx` without conversion:

```powershell
.\sbx-manager.ps1 run codex C:\src\project --name project-codex
.\sbx-manager.ps1 run claude 'C:\src\project with spaces' --name project-claude --clone
.\sbx-manager.ps1 run shell . --name project-shell
```

PowerShell consumes an unquoted `--` token while binding script parameters.
Quote the separator when forwarding arguments to an agent:

```powershell
.\sbx-manager.ps1 run claude . --name project-claude '--' --resume session-123
```

Inspect the host and diagnose an existing installation:

```bash
./sbx-manager.sh info
./sbx-manager.sh doctor
```

List supported templates, optionally including all currently published Docker
Hub tags:

```bash
./sbx-manager.sh templates
./sbx-manager.sh templates --remote
```

Launch a persistent shell workspace (recommended), or attach directly to an
agent when a shell is not needed:

```bash
./sbx-manager.sh run /path/to/project
./sbx-manager.sh run /path/to/project --name project-shell --clone
./sbx-manager.sh run codex /path/to/project --name project-codex
./sbx-manager.sh run claude /path/to/project --name project-claude --clone
```

Set the two independent disk sizes when creating a sandbox:

```bash
./sbx-manager.sh run shell /path/to/project --name large-project \
  --root-size 40g --docker-size 80g
```

`--root-size` configures the sandbox root filesystem (`/`) through
`DOCKER_SANDBOXES_ROOT_SIZE`. `--docker-size` configures the nested Docker data
disk (`/var/lib/docker`) through `DOCKER_SANDBOXES_DOCKER_SIZE`. Both options
apply only when a sandbox is first created. Docker sbx does not currently
support resizing an existing sandbox; the managers warn and ignore these
options when reattaching.

On macOS and Linux, `shell` is the default when the first argument after `run`
is a workspace path or an option. Write an agent name explicitly only when the
sandbox should attach directly to that agent.

Every new sandbox launched through the manager receives the bundled
`kits/zsh-shell` mixin by default. The kit installs zsh, a verified pinned
Starship binary, and a pinned Oh My Zsh toolchain with extended completions,
history-based autosuggestions, syntax highlighting, a selectable
case-insensitive completion menu, and Smart Tab behavior. Its Starship prompt
shows sandbox context, the working directory, Git state, active language
toolchains, command duration, and exit status without requiring a large theme
framework.

The same kit also installs:

- `zoxide` for frecency-based directory jumps (`z keyword`) and interactive
  selection (`zi`)
- `fzf` with `Ctrl-R` history search, `Ctrl-T` file insertion, `Alt-C`
  directory changes, and `**` + Tab fuzzy completion
- `eza` as the colorful `ls`, `l`, `ll`, `la`, and `lt` implementation
- `bat`, `fd`, `jq`, and `ripgrep` (`rg`) for structured data, highlighted file
  viewing, and fast file and content searches
- Neovim plus `tmux` for persistent terminal-native editing sessions
- `build-essential`, CMake, Ninja, pkg-config, and GDB for native builds and
  debugging
- ShellCheck and shfmt for checking and formatting shell scripts
- SQLite, `file`, `strace`, and netcat for data, artifact, process, and network
  inspection
- `btop` for an interactive CPU, memory, disk, network, and process dashboard
- ZIP and XZ tools for creating and extracting common development archives
- a UTF-8 locale for literal Chinese and other non-ASCII filename completion
- a Claude Code completion entry for
  `claude --dangerously-skip-permissions`, also seeded as an autosuggestion;
  it remains opt-in and is intended only for the isolated sandbox
- a sparse checkout containing only
  [`script-toolbox/agent`](https://github.com/silencoo/script-toolbox/tree/main/agent)
  under `~/.local/share/sbx-manager`, exposed through the short `~/agent` link
- global `agentctl`, `mcpctl`, `promptctl`, and `skillsctl` commands in
  `/usr/local/bin`,
  linked to that sparse checkout so they can be run from any directory

Every interactive entry through either `sbx-manager.sh` or `sbx-manager.ps1`
shows the same compact sandbox MOTD. It includes the current time, user and
host, OS and kernel, CPU/memory/disk summary, shell and terminal, workspace,
available toolbox commands, and the host Nerd Font reminder. Nested shells do
not repeat it, non-interactive commands stay quiet, and `touch ~/.hushlogin`
disables it for users who prefer a silent entry.

`fzf` uses `fd` for traversal and `bat`/`eza` for previews. The kit normalizes
Debian and Ubuntu's `batcat` and `fdfind` binary names to `bat` and `fd`.
`eza` icons look best when the host terminal uses a Nerd Font; pass
`--icons=never` if the current font lacks those glyphs. The original utilities
remain available as `command ls`, `cat`, and `find`.

The kit also makes zsh the UID 1000 user's login shell. The built-in `shell`
agent still starts through `bash -l`, so the kit adds an
interactive-only bridge that switches that login session to zsh; set
`SBX_KEEP_BASH=1` inside a sandbox when Bash is preferred.

Docker's credential proxy can expose `ANTHROPIC_API_KEY` as an opaque
placeholder inside a shell sandbox. If agentctl selects a Claude provider that
uses `ANTHROPIC_AUTH_TOKEN` instead, Claude Code would normally see both
credential types. The zsh kit wraps only the `claude` child process and removes
the credential type that conflicts with `~/.claude/settings.json`; switching
Provider profiles is detected dynamically. The host-side sbx Secret remains
available to other commands and its value is never read or removed.

The bundled kit targets the apt-based official sandbox templates. Disable it
for an incompatible custom image:

```bash
./sbx-manager.sh run shell /path/to/project --name custom-shell \
  --template example.com/custom/image:latest --no-shell-kit
```

Docker sbx mounts the primary workspace at its absolute host path and currently
does not expose a destination-path option. On first entry, the shell records
sbx's restored working directory, creates `~/workspace` as a stable link to it,
and switches the interactive zsh session to that logical path. This avoids both
startup commands and runtime `initFiles`, which the current `sbx kit add`
recreate flow cannot apply. As a result,
`run /path/to/project` opens at `~/workspace` without changing whether the
underlying workspace is a direct host mount or a private `--clone`.
If the base image already contains an empty `~/workspace` directory, the kit
replaces it safely; a non-empty directory is always preserved.

The hidden agent-helper checkout is created only when the kit is first
installed. Update it later from inside the sandbox with:

```bash
git -C ~/.local/share/sbx-manager/script-toolbox pull --ff-only
```

Docker applies `--kit` only while creating a sandbox. The current experimental
`sbx kit add` recreate flow does not replay static files, startup commands, or
runtime `initFiles`, so do not pass the full `zsh-shell` directory to it
manually. The managers handle an existing sandbox safely by applying a cached,
versioned, spec-only view with `kit add`, then copying the LF-only home payload
with `sbx cp` and correcting its ownership before reattaching. The cached view
remains available because sbx records kit sources for later recreations.

On Windows, the PowerShell manager detects CRLF in a checked-out shell kit and
passes `sbx` a temporary LF-only copy. This keeps `.zshrc` and the other Linux
dotfiles valid even when the repository was cloned with `core.autocrlf=true`.
When a named sandbox already exists, rerunning the same manager command checks
the installed kit version and runs this split refresh before reattaching if the
version is missing or stale. `--no-shell-kit` skips this repair.

When `--name` identifies an existing sandbox, the manager automatically switches
to sbx's reattach syntax and preserves the sandbox's original agent and
workspace. Before reconnecting, it checks the bundled shell-kit version inside
the sandbox and applies the install steps plus home files when the installed
copy is stale.
Pass `--no-shell-kit` to skip this refresh for a custom sandbox.
When `--name` is omitted, the manager now derives Docker's stable
`<agent>-<workspace>` name itself, so repeating the same path-only command can
also detect, refresh, and reconnect to the existing sandbox.

Run `./sbx-manager.sh --help` for all global, network, daemon, and launch
options.

## Network and proxy management

Examples:

```bash
./sbx-manager.sh network set locked
./sbx-manager.sh network allow github.com
./sbx-manager.sh network check https://github.com
./sbx-manager.sh network status
./sbx-manager.sh network proxy http://127.0.0.1:8080
./sbx-manager.sh network proxy off
```

Proxy settings managed by this script are saved under
`${XDG_CONFIG_HOME:-$HOME/.config}/sbx-manager/daemon.env` with restrictive
permissions on macOS/Linux, or
`%LOCALAPPDATA%\sbx-manager\daemon.json` with a restricted ACL on Windows.
Credentials embedded in proxy URLs are redacted from displayed status output.

## Non-interactive operation

Use `--yes` to accept destructive-policy prompts and `--skip-login` to omit
the interactive Docker OAuth flow:

```bash
./sbx-manager.sh --yes --skip-login setup balanced
```

```powershell
.\sbx-manager.ps1 --yes --skip-login setup balanced
```

Set `NO_COLOR=1` to disable terminal formatting.

## Validation

The script remains compatible with Bash 3.2 and can be syntax-checked with:

```bash
bash -n sbx-manager.sh
sbx kit validate kits/zsh-shell
./tests/sbx-manager-test.sh
```

The PowerShell manager can be parsed and regression-tested on Windows with:

```powershell
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path .\sbx-manager.ps1),
  [ref]$tokens,
  [ref]$errors
) | Out-Null
if ($errors.Count) { throw $errors }
.\tests\sbx-manager-test.ps1
```
