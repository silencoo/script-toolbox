# Shared agent TUI

The four standalone or repository-backed controllers share one terminal dashboard built with
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

The dashboard combines a full portable Providers control plane, live
MCP/Skills/Prompt selections, a shared Snippets library, development presets,
and encrypted Workspace status. It refreshes every 30 seconds or immediately
with `r`. The Cloud-backed views are remote-first: opening Providers, MCP,
Skills, Prompts, or Snippets lazily derives a secret-free display catalog from
the encrypted Store in process memory. The React view never receives a child
capability or a Provider/MCP Secret value.

The Providers view keeps local and encrypted Workspace profiles in one bounded
list while marking every row `L` or `W`. It resolves the selected profile for
Claude Code, Codex, OpenCode, or Pi using the current operating-system overlay,
then shows exact protocol, endpoint, requested/outbound model IDs, Secret
presence, compatibility, and device-local applied state. Each client has its
own target color. `p` plans and `a` applies only the selected source/profile and
target. A Workspace-only apply exposes the selected profile and required Secret
to the existing provider controller through owner-only temporary files; they
are removed immediately after the action. `u` backs up the complete portable
local bundle and `d` merge-restores it, both behind confirmation. Exact
replacement remains the explicit CLI operation.

The MCP view keeps Claude Code and Codex visible at the same time. It separates
shared servers, client-only servers, and explicitly disabled servers instead of
requiring the operator to switch targets and remember two lists. The active
target remains highlighted because Workspace plan/apply actions are scoped to
that client. Long Workspace catalogs use a bounded list pane beside a separate
detail pane so profile names cannot be mistaken for the selected profile's
metadata.

The Prompts view likewise shows both clients' local Promptctl bindings before
the Workspace catalog: active profile, managed state, binding path,
instruction-file path, and file health. Prompt bodies stay outside the periodic
snapshot and catalog data. Press lowercase `v` to load the active local Prompt,
or uppercase `V` to decrypt the selected Workspace Prompt, into a bounded,
scrollable preview. Closing the preview, changing sections, or changing targets
clears its content from the React view. A field whitelist still drops any
unrecognized content-like data from background snapshots.

The Snippets view merges the shared local library with the encrypted Prompt
Store catalog. `L/C` markers distinguish local and cloud availability without
showing snippet bodies. `c` copies a local snippet directly to the clipboard;
`p` previews a cloud pull and `a` confirms it. Snippets are never injected into
an agent session automatically.

Planning a remote Provider, Profile, Pack, Prompt, Snippet, or Preset is
read-only. Applying it requires an in-TUI `y` confirmation and materializes only
the selected item and its inherited dependencies under the per-Workspace
runtime directory. Prompt Markdown is written only for the selected target
because promptctl needs that editable local source. Whole child-Store pulls
remain explicit CLI operations; the Providers view exposes only the bounded
agent-bundle upload and merge-restore operations described above.

The Agents view is actionable as well as diagnostic. Select Claude Code,
Codex, OpenCode, or Pi with `[`/`]` (or Up/Down); `p` shows its built-in
provider catalog, `c` or
Enter temporarily suspends Ink and opens the existing interactive setup/install
flow, and `x` removes only agentctl-owned provider configuration after
confirmation. When setup exits, the dashboard reopens on Agents with refreshed
status.

Cloud empty states distinguish local-only setup, incompatible Workspace data,
temporary connectivity failures, rejected capabilities, and invalid local
configuration. Recognized failures use short recovery guidance instead of raw
backend errors. The configured endpoint and Store ID remain visible even when
the remote snapshot itself cannot be opened.

## Keys

| Key | Action |
| --- | --- |
| Tab / Shift+Tab, Left / Right | Change section |
| `t` | Switch Codex/Claude normally; cycle Claude/Codex/OpenCode/Pi in Providers |
| `r` | Refresh now |
| `[` / `]`, Up / Down | Select the previous / next Profile, Pack, Prompt, Snippet, or Preset |
| `p` / `a` | Inspect a read-only plan or apply the selected item |
| Providers: `u` / `d` | Upload local catalogs / download and merge the encrypted Workspace bundle |
| Prompts: `v` / `V` | View the active local / selected Workspace Prompt on demand |
| Snippets: `c` | Copy the selected local snippet without rendering it |
| `u` | Roll back a preset transaction |
| Agents: `c` / Enter | Configure the selected agent, installing its CLI if needed |
| Agents: `p` | Show provider/model choices |
| Agents: `x` | Confirm removal of agentctl-owned provider configuration |
| `?` | Toggle keyboard help |
| `q` | Quit |

The interface uses standard terminal colors and symbols; it does not require a
Nerd Font. Green/yellow/red continue to communicate health where used in status
fields. Target badges are deliberately distinct: Claude Code yellow, Codex
cyan, OpenCode green, and Pi magenta. Local/Workspace sources use green/blue,
and every active section gets its own navigation accent instead of a single
indistinguishable color.

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
