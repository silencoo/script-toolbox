# macOS terminal setup

The macOS `terminal` profile provides the prompt, navigation, aliases, and Zsh
plugins used by the [Linux server toolkit](../../server-toolkit/), using
Homebrew packages and the Zsh already supplied by macOS. It manages a block in
your `.zshrc` and configures Ghostty for SSH and terminal icons.

Run from the repository root as your desktop user. Without arguments, the
initializer opens a menu: choose Install profiles, select `2` for Terminal
(or `1,2` for Core and Terminal), choose whether to include optional additions,
then review and confirm the plan:

```sh
./workstation/macos/setup.sh
```

Explicit commands are also available:

```sh
./workstation/macos/setup.sh plan terminal
./workstation/macos/setup.sh install terminal --dry-run
./workstation/macos/setup.sh install terminal
```

Combine this profile with `core` to install everyday applications too:

```sh
./workstation/macos/setup.sh install core terminal
```

## Packages and features

| Purpose | Packages |
| --- | --- |
| Terminal and icons | Ghostty, JetBrains Mono Nerd Font |
| Prompt | Starship |
| Navigation and fuzzy history/completion | zoxide, fzf |
| Zsh plugins and completion | zsh-autosuggestions, zsh-syntax-highlighting, zsh-completions |
| File listing, viewing, search, and navigation | eza, bat, ripgrep, fd, Yazi |
| Terminal editing and sessions | Neovim, tmux |
| Data and command help | jq, yq, git-delta, tealdeer (`tldr`) |
| Archives | 7-Zip CLI, Zstandard |
| Python project tooling and completion | uv |
| Optional monitors (`--include-optional`) | btop, ncdu, duf |

Starship uses its default prompt or your existing Starship configuration.
The Zsh block enables fuzzy history search through fzf, `z` navigation through
zoxide, autosuggestions, command highlighting, Homebrew completions, and uv
completion. History limits are raised to at least 10,000 entries, retaining an
existing history-file location or larger limits.

Run `yazi` to open the terminal file manager, or `y` to return to the directory
selected in Yazi when it exits. The `y` wrapper preserves an existing alias or
function, passes arguments through, and cleans up its temporary directory file
on success or failure. The Homebrew `yazi` formula supplies both `yazi` and `ya`.
The profile already includes the archive, JSON, search, fuzzy-navigation, and
font tools used by Yazi. Extra video/PDF/SVG/font previews depend on optional
external tools listed in [Yazi's installation guide](https://yazi-rs.github.io/docs/installation/).

These aliases are added only when their target tool exists and you have not
already defined that alias or function:

| Command | Behavior |
| --- | --- |
| `ls` | eza with icons |
| `ll` | Long listing including hidden files, directories first |
| `la` | Long listing including hidden files |
| `tree` | eza tree with icons |
| `cat` | bat with highlighting and paging disabled |
| `vim` | Neovim |

`EDITOR` defaults to `nvim` when Neovim is available and you have not selected
an editor. Homebrew-backed plugins are sourced directly; existing copies
already loaded by a shell framework are detected and preserved.

## Configuration and backups

The installer preserves content outside its marked `.zshrc` block, validates
the complete candidate with `zsh -n`, and replaces the file atomically. Changed
existing files receive timestamped `.bak.*` backups. Reruns leave an unchanged
configuration and its backups alone. Exported `ZDOTDIR` is respected; `.zshrc`
symlinks are preserved, with the actual target updated and backed up.

Ghostty receives the existing SSH environment/terminfo integration. When there
is no configured font or included config, it also receives:

```ini
font-family = JetBrainsMono Nerd Font
```

Font settings in either XDG or macOS configuration locations are preserved.
Settings from the older `~/.config/ghostty/config` filename are carried forward
when creating `config.ghostty`, with the old file retained. See
[Ghostty setup](ghostty.md) for configuration precedence and SSH repair.

Open a new Ghostty window after installation, or reload the shell with:

```sh
exec zsh -l
```

The profile configures the current user's Zsh environment without changing the
login shell. Installations use Homebrew Bundle with upgrades disabled. Planning
and dry runs do not install packages or write shell/Ghostty configuration.
Uninstalling terminal packages leaves your configuration and backups intact;
the shell block checks whether each executable/plugin is available at startup.

For configuration only after installing the tools yourself:

```sh
./workstation/macos/terminal-setup.sh
```

## Validation

The tests use temporary homes and a mocked package manager. They exercise real
Zsh startup with fixture tools and plugins, without installing packages or
changing the actual user's dotfiles:

```sh
./workstation/tests/macos-test.sh
python3 -B -m unittest discover -s workstation/tests -p 'test_macos*.py' -v
```

Upstream references: [Starship](https://starship.rs/guide/),
[Yazi installation](https://yazi-rs.github.io/docs/installation/),
[Yazi shell wrapper](https://yazi-rs.github.io/docs/quick-start/#shell-wrapper),
[fzf shell integration](https://github.com/junegunn/fzf#setting-up-shell-integration),
[Homebrew Zsh completions](https://formulae.brew.sh/formula/zsh-completions),
[autosuggestions](https://formulae.brew.sh/formula/zsh-autosuggestions),
[syntax highlighting](https://formulae.brew.sh/formula/zsh-syntax-highlighting),
and [JetBrains Mono Nerd Font](https://formulae.brew.sh/cask/font-jetbrains-mono-nerd-font).
