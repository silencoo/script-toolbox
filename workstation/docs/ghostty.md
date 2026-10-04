# Ghostty Setup

`shared/ghostty-setup.sh` installs Ghostty on macOS or Linux and maintains one portable
configuration file:

```text
~/.config/ghostty/config.ghostty
```

The script preserves unrelated settings and idempotently manages:

```ini
shell-integration-features = cursor,no-sudo,title,ssh-env,ssh-terminfo,path
```

The `ssh-env` and `ssh-terminfo` features make interactive `ssh` a shell
function backed by Ghostty's SSH integration. It forwards Ghostty terminal
metadata, installs the remote terminfo entry when possible, and falls back to
`xterm-256color` when the remote host cannot install it. This prevents common
cursor, prompt, and full-screen application problems on otherwise unconfigured
SSH hosts.

## Quick start

Run from `workstation`. On macOS, use the `terminal` profile to install
Ghostty through the filtered Homebrew catalog and configure its SSH integration.
The same profile now adds a complete Zsh prompt/plugin environment and terminal
tools; see [macOS terminal setup](macos-terminal.md).

```bash
./macos/setup.sh plan terminal
./macos/setup.sh install terminal
```

Configure an existing Ghostty installation without installing a package or
changing Zsh configuration:

```bash
./shared/ghostty-setup.sh --config-only
```

The standalone helper retains Linux desktop installation support. Use
`--yes` for a non-interactive community Linux package-source confirmation:

```bash
./shared/ghostty-setup.sh --yes
```

The installer uses:

- macOS: the Homebrew `ghostty` cask
- Arch, Alpine, Gentoo, Solus, and Void: their distribution repositories
- Ubuntu and derivatives: the community `mkasberg/ghostty-ubuntu` PPA
- Fedora: the community `scottames/ghostty` COPR
- Debian Trixie/Forky: a configured distribution package when available,
  otherwise a SHA-256-verified `.deb` from `mkasberg/ghostty-ubuntu`
- otherwise unsupported Linux distributions: the community Snap package when
  Snap is already available

Ghostty only publishes official prebuilt binaries for macOS. Linux packages
are produced by distribution or community maintainers, so the script asks
before enabling a community source unless `--yes` is supplied.

## Existing configuration

Other options in `~/.config/ghostty/config.ghostty` are preserved. The macOS
terminal profile also requests JetBrains Mono Nerd Font only when no font or
included configuration is already present. The standalone helper accepts
`--font-if-unset "JetBrainsMono Nerd Font"` for that behavior. Settings in the
older XDG `config` filename are carried forward when creating `config.ghostty`. An existing
active `shell-integration-features` line is replaced by a marked managed block.
When the content changes, the previous file is copied to a timestamped
`config.ghostty.bak.*` backup.

macOS also supports:

```text
~/Library/Application Support/com.mitchellh.ghostty/config.ghostty
```

Ghostty loads that location after the XDG file. If a non-empty later file
exists, the script warns instead of deleting or merging it automatically.
Move any settings you want to retain into the XDG file and then rename the
later file so the setup has one authoritative configuration source.

## Verification

Open a completely new Ghostty window after setup and run:

```zsh
type ssh
```

An integrated zsh session should report:

```text
ssh is a shell function
```

Then connect normally:

```zsh
ssh user@example.com
```

## Manual SSH terminfo installation

Ghostty's automatic `ssh-terminfo` integration is the preferred option. For
hosts where the shell wrapper is unavailable, run `shared/ghostty-ssh-terminfo.sh` without
options to choose an action from an interactive menu:

```bash
./shared/ghostty-ssh-terminfo.sh
```

Choose the system-wide option when programs run through `sudo` need to resolve
`xterm-ghostty`. The menu also supports per-user installation and both
verification modes.

To skip the menu, use an explicit option. This copies the local
`xterm-ghostty` entry to a remote user's `~/.terminfo`:

```bash
./shared/ghostty-ssh-terminfo.sh --user user@example.com
```

Install it system-wide as well:

```bash
./shared/ghostty-ssh-terminfo.sh --system user@example.com
```

The system mode first installs a per-user copy and then runs the equivalent of:

```bash
infocmp -x xterm-ghostty | sudo tic -x -
sudo infocmp -x xterm-ghostty >/dev/null
```

It uses `doas` when `sudo` is unavailable. You can also run the helper directly
inside an interactive Ghostty SSH session:

```bash
./shared/ghostty-ssh-terminfo.sh --system
```

Check an existing installation without changing it:

```bash
./shared/ghostty-ssh-terminfo.sh --check user@example.com
./shared/ghostty-ssh-terminfo.sh --check --system user@example.com
```

The helper reports the current or remote `TERM` during verification. In an
interactive Ghostty SSH session, the expected value is:

```text
xterm-ghostty
```

Ghostty can validate the full configuration with:

```zsh
ghostty +validate-config
```

The macOS system Bash (`/bin/bash` 3.2) cannot use automatic Ghostty shell
integration. Use the default zsh, install a modern Bash, or follow Ghostty's
manual shell-integration instructions.

## Validation

The regression test only uses `--config-only`. It does not install Ghostty or
enable package repositories:

```bash
bash -n shared/ghostty-setup.sh shared/ghostty-ssh-terminfo.sh tests/ghostty-setup-test.sh tests/ghostty-ssh-terminfo-test.sh
./tests/ghostty-setup-test.sh
./tests/ghostty-ssh-terminfo-test.sh
```

Official references:

- [Ghostty installation](https://ghostty.org/docs/install/binary)
- [Configuration locations and precedence](https://ghostty.org/docs/config)
- [Shell integration](https://ghostty.org/docs/features/shell-integration)
- [SSH integration](https://ghostty.org/docs/features/ssh)
