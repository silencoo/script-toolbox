# Docker Sandboxes Manager

`sbx-manager.sh` installs, configures, diagnoses, and launches Docker
Sandboxes from one Bash entry point. It wraps the official `sbx` CLI with
host checks, network-policy presets, daemon and proxy management, template
discovery, and shortcuts for supported coding agents.

## Supported hosts

- macOS 14 or newer on Apple silicon
- Ubuntu 24.04 or newer with KVM
- Debian 13 or newer as an explicitly enabled, best-effort mode

Docker Sandboxes requires hardware virtualization. On a VPS, confirm that the
provider exposes nested virtualization and that `/dev/kvm` is available.

## Usage

Make the script executable and display its built-in help:

```bash
chmod +x sbx-manager.sh
./sbx-manager.sh --help
```

Install and configure an open, balanced, or locked network-policy preset:

```bash
./sbx-manager.sh setup balanced
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

Launch an agent in a workspace:

```bash
./sbx-manager.sh run codex /path/to/project --name project-codex
./sbx-manager.sh run claude /path/to/project --name project-claude --clone
./sbx-manager.sh run shell /path/to/project --name project-shell
```

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
permissions. Credentials embedded in proxy URLs are redacted from displayed
status output.

## Non-interactive operation

Use `--yes` to accept destructive-policy prompts and `--skip-login` to omit
the interactive Docker OAuth flow:

```bash
./sbx-manager.sh --yes --skip-login setup balanced
```

Set `NO_COLOR=1` to disable terminal formatting.

## Validation

The script remains compatible with Bash 3.2 and can be syntax-checked with:

```bash
bash -n sbx-manager.sh
```
