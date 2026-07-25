# Ghostty Setup

`setup.sh` installs Ghostty on macOS or Linux and maintains one portable
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

```bash
chmod +x setup.sh
./setup.sh
```

Configure an existing Ghostty installation without installing a package:

```bash
./setup.sh --config-only
```

Use `--yes` for a non-interactive community Linux package-source confirmation:

```bash
./setup.sh --yes
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

Other options in `~/.config/ghostty/config.ghostty` are preserved. An existing
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
hosts where the shell wrapper is unavailable, `ssh-terminfo.sh` copies the
local `xterm-ghostty` entry to the remote user's `~/.terminfo`:

```bash
./ssh-terminfo.sh user@example.com
```

Install it system-wide as well when programs run through `sudo` need to resolve
`xterm-ghostty`:

```bash
./ssh-terminfo.sh --system user@example.com
```

The system mode first installs a per-user copy and then runs the equivalent of:

```bash
infocmp -x xterm-ghostty | sudo tic -x -
sudo infocmp -x xterm-ghostty >/dev/null
```

It uses `doas` when `sudo` is unavailable. You can also run the helper directly
inside an interactive Ghostty SSH session:

```bash
./ssh-terminfo.sh --system
```

Check an existing installation without changing it:

```bash
./ssh-terminfo.sh --check user@example.com
./ssh-terminfo.sh --check --system user@example.com
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
bash -n setup.sh ssh-terminfo.sh tests/setup-test.sh tests/ssh-terminfo-test.sh
./tests/setup-test.sh
./tests/ssh-terminfo-test.sh
```

Official references:

- [Ghostty installation](https://ghostty.org/docs/install/binary)
- [Configuration locations and precedence](https://ghostty.org/docs/config)
- [Shell integration](https://ghostty.org/docs/features/shell-integration)
- [SSH integration](https://ghostty.org/docs/features/ssh)
