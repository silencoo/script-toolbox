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

## Two-line Starship prompt

Opt in to the context-aware prompt without installing packages:

```bash
./shared/ghostty-setup.sh --config-only --prompt
```

Requires an installed `starship` and Python 3.11+ (Python is used only during
setup, never during prompt rendering). The default invocation remains Ghostty-only.
The helper merges `shared/starship-prompt.toml` into `$STARSHIP_CONFIG`, or
`${XDG_CONFIG_HOME:-$HOME/.config}/starship.toml`. It backs up changed files as
`*.bak.<timestamp>`, preserves symlinks, and leaves unrelated TOML keys/comments
intact. Prompt-owned layout/module keys are replaced; other module settings,
including directory truncation/colors and disabled AWS, remain unchanged.
Nonstandard TOML layouts that cannot be safely merged fail without changing the
Starship file. Existing custom modules remain configured but are not automatically
added to the new explicit layout.

Existing Starship initialization in `${ZDOTDIR:-$HOME}/.zshrc` is retained. If none
is found in that file, a guarded initialization block is appended with a backup.
If your initialization is in a sourced file instead, keep only one initialization.
No plugins, aliases, Ghostty theme, or font preferences are replaced.

```text
user@host ~/workspace
❯                                                       17:45:03

user@host project  main [!?] py v3.11.16 (api) took 3s
jobs:1 exit:1 ❯                                          17:45:09

user@host SSH ~/app docker:production
❯                                                       17:45:12
```

Names above are examples: username and hostname are detected, not hardcoded.
The first line shows directory, Git branch/status, package metadata, Python
version/environment, Node version, Docker context and container identity only
when detected. Python also activates in Python projects without a virtualenv;
Node uses Starship's project-file detection. Non-default Docker contexts or
explicit Docker environment overrides are shown even outside Docker projects
so a remote target is not hidden. Default/desktop-linux contexts stay hidden
unless explicitly overridden. Container identity is Starship's detected local
container name/hostname, not the name of an arbitrary remote Docker container;
it is absent when the runtime exposes no recognized container markers.

The second line shows `jobs:N` starting at one job, `exit:N` only on failure,
and a green/red prompt character for success/failure. Durations appear only
above 2 seconds. Local time uses Zsh's right prompt on the command line (updated
when a prompt renders, not a continuously ticking clock). SSH identification
applies on a remote host running this configuration; configuring your laptop
does not install Starship or this config on remote hosts.

Only built-in modules run, with a 30 ms scan timeout and 500 ms command timeout
(instead of waiting many seconds for runtime probes). These are per-operation
limits, not a hard total-prompt deadline; large repositories can still be slower.

Reload with `exec zsh`, or open a new Ghostty window. The existing Starship session
usually picks up TOML changes at its next prompt. Restore a printed backup by
copying it over the corresponding configuration file, then reload.

Validation (temporary homes/repos; no SSH connection or Docker daemon needed):

```bash
python3 -m unittest discover -s tests -p test_starship_prompt.py -v
```

Tests cover preservation, backups/symlinks, repeat-run idempotency, normal/Git/error/
jobs/SSH previews, duration boundaries, right-hand time, Python virtualenv and
Node detection, and an explicit Docker context. SSH is simulated via its environment.
Real container detection requires running the config inside a container.
See the [Starship module reference](https://starship.rs/config/) for detection rules.

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

## Default contrast shader (macOS and Linux)

The shared setup adds the bundled 1.4× contrast shader by default, including with
`--config-only`. It copies the shader to
`~/.config/ghostty/shaders/script-toolbox-contrast.glsl` and adds a
`custom-shader` entry. It does not change wallpaper, opacity, or titlebar settings.

Existing `custom-shader` settings (including an empty reset), included configs,
and modified destination shader files are preserved rather than stacking effects.
macOS-specific configuration locations are checked only on macOS.

Use `--no-contrast-shader` to skip adding this default; it does not remove a shader
already configured. To disable an installed shader persistently, replace its
configuration line with `custom-shader =`. Restart Ghostty to inspect the result.
