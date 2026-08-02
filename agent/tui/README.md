# Shared agent TUI

The four repository-backed controllers share one terminal dashboard built with
Node.js 22, Ink 7, and React 19. It is a view and action layer over the existing
controller operations, so the explicit CLI commands remain the automation API.

Launch the dashboard from any controller. Each command starts on its own view:

```bash
agentctl
mcpctl
skillsctl
promptctl

# Explicit equivalents
agentctl tui
mcpctl tui
skillsctl tui
promptctl tui
```

No-argument launch switches to the TUI only when standard input and output are
terminals. Pipes, test fixtures, and other non-interactive callers retain their
previous behavior. The older line-oriented guides remain available with the
explicit `interactive` command.

The dashboard combines redacted provider diagnostics, live MCP/Skills/Prompt
selections, development presets, and encrypted Workspace status. It refreshes
every 30 seconds or immediately with `r`. The Cloud-backed views are
remote-first: opening MCP, Skills, or Prompts lazily downloads and decrypts
only that child Store in process memory. The React view receives a secret-free
catalog, never a child capability or MCP Secret value.

Planning a remote Profile, Pack, Prompt, or Preset is read-only. Applying it
requires an in-TUI `y` confirmation and materializes only the selected item and
its inherited dependencies under the per-Workspace runtime directory. Prompt
Markdown is written only for the selected target because promptctl needs that
editable local source. The TUI deliberately has no whole-Workspace pull
action; the explicit bulk preset push/pull commands remain available for
automation and migration.

Cloud empty states distinguish local-only setup, incompatible Workspace data,
temporary connectivity failures, rejected capabilities, and invalid local
configuration. Recognized failures use short recovery guidance instead of raw
backend errors.

## Keys

| Key | Action |
| --- | --- |
| Tab / Shift+Tab, Left / Right | Change section |
| `t` | Switch between Codex and Claude |
| `r` | Refresh now |
| `j` / `k`, Up / Down | Select a cloud Profile, Pack, Prompt, or Preset |
| `p` / `a` | Inspect a read-only plan or apply the selected item |
| `u` | Roll back a preset transaction |
| `?` | Toggle keyboard help |
| `q` | Quit |

The interface uses standard terminal colors and symbols; it does not require a
Nerd Font.

## Development

The distributable is committed so controller users do not need an npm install.
Rebuild and validate it after changing `src/`:

```bash
cd agent/tui
npm ci
npm run validate
```

`dist/toolbox-tui.mjs` is a self-contained ESM bundle. Ink's optional React
DevTools package is replaced with an inert production stub, so it is not a
runtime dependency. The build also regenerates
`dist/THIRD_PARTY_LICENSES.txt` for every production dependency included in
the bundle.
