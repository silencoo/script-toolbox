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
with `r`. Every refresh is local-first: agent status, official-account labels,
local Providers, MCP, Skills, Prompt bindings, Snippets, and Presets render
without waiting for the network. A configured Workspace is shown as
`Connecting…` while cloud diagnostics and catalogs hydrate in the background.
Transient read failures receive one bounded retry. After the first successful
connection, the last public Workspace index stays visible as
`Cached · retrying` during later network interruptions; local state never
disappears, and remote writes still require a fresh live connection.
Opening Providers, MCP, Skills, Prompts, or Snippets lazily derives a
secret-free cloud display catalog from the encrypted Store in process memory.
The React view never receives a child capability or a Provider/MCP Secret value.

The Providers view presents one row per logical Provider. Matching local and
encrypted Workspace copies are merged instead of duplicated: `B` is an
unmaterialized built-in template, `L` is local-only, `W` is Workspace-only,
`L+W` is a local profile with a matching backup, and `L≠W` identifies safe
configuration metadata that needs reconciliation. Local configuration takes
precedence, while a Workspace-only profile remains directly applicable.
Providers incompatible with the selected client are hidden by default; `i`
temporarily reveals them for inspection. Built-ins render immediately even
when the local Store does not exist. The view resolves each selection for
Claude Code, Codex, OpenCode, or Pi using the current operating-system overlay,
then shows exact protocol, endpoint, requested/outbound model IDs, Secret
presence, compatibility, and device-local applied state. Each client has its
own target color. `p` plans and `a` applies only the selected profile and target.
For OpenCode, a `native auth` marker reports a matching credential from the
client's own auth store even when the portable agentctl Secret is absent.
`native-current` additionally means OpenCode's global model selects that
provider. This metadata is read-only and never copies or uploads the native
credential.
A Workspace-only apply exposes the selected profile and required Secret to the
existing provider controller through owner-only temporary files; they are
removed immediately after the action. Provider synchronization is also scoped
to the selected row: `u` chooses the local copy and replaces only its Workspace
counterpart, while `d` chooses the Workspace copy and replaces only its local
counterpart. Only Secret references used by that profile travel with it; all
other profiles, failover/pricing catalogs, generated configuration, and the
device-local applied selection remain untouched. Whole-bundle merge/exact
replacement remains available through the explicit CLI operations.

For Codex, Overview, Agents, and Providers show two simultaneous rows:
`Identity` is the current official ChatGPT login, while `Inference` is the
Provider and Model handling requests. A Codex Provider selection changes only
Inference and explicitly preserves the current Identity; the detail pane shows
that `auth.json` is untouched. Provider profiles therefore never silently bind
or switch an official account.

The Accounts section manages that separate Codex Identity layer. It displays
only local labels, the active marker, save timestamps, and owner-only permission
health. `a` or Enter confirms an atomic switch; `x` deletes a non-current saved
snapshot. New labels are captured explicitly with
`agentctl account save <name> --yes`. The outgoing snapshot is refreshed before
switching, while an unsafe, unrecognized, or unsaved live login fails closed.
OAuth tokens and account IDs never enter the TUI model, and account snapshots
are device-local rather than Workspace-backed.

The MCP view keeps Claude Code and Codex visible at the same time. It separates
shared servers, client-only servers, and explicitly disabled servers instead of
requiring the operator to switch targets and remember two lists. The active
target remains highlighted because Workspace plan/apply actions are scoped to
that client. Long Workspace catalogs use a bounded list pane beside a separate
detail pane so profile names cannot be mistaken for the selected profile's
metadata. When a named local profile reports `Drift`, `f` confirms a local
repair: it reapplies that current profile with mcpctl's bounded `--force`
adoption, replacing only conflicting same-name MCP entries while preserving
unrelated client configuration. This repair does not require or pull a
Workspace profile.

The Skills view uses the same local-only recovery contract for named packs.
When `Drift` is reported, `f` confirms reapplying the active pack to restore
missing managed links. Unrelated local skills are preserved and Workspace is
not required.

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

The Providers detail pane reports the resolved compaction behavior as one
plain-language value: `Remote · native`, `Messages · Anthropic beta`, or a
local fallback. This is derived from Provider Store schema 2 capability and
policy fields; it is not guessed from an endpoint or model name.
The adjacent Context row independently shows the verified model maximum and
client auto-compact trigger, or `Client default` when the Provider leaves both
values unmanaged.

The Agents view is actionable as well as diagnostic. Select Claude Code,
Codex, OpenCode, or Pi with Up/Down; `c`, `p`, or Enter opens the
same unified Providers section for that client. `x` removes only
agentctl-owned provider configuration after confirmation. There is no second
interactive setup catalog.

Cloud empty states distinguish local-only setup, incompatible Workspace data,
temporary connectivity failures, rejected capabilities, and invalid local
configuration. Recognized failures use short recovery guidance instead of raw
backend errors. The configured endpoint and Store ID remain visible even when
the remote snapshot itself cannot be opened.

## Keys

| Key | Action |
| --- | --- |
| `[` / `]`, Tab / Shift+Tab, Left / Right | Change top-level section |
| `t` | Switch Codex/Claude normally; cycle Claude/Codex/OpenCode/Pi in Providers and Skills |
| `r` | Refresh now |
| Up / Down | Select the previous / next Profile, Pack, Prompt, Snippet, or Preset inside the section |
| `p` / `a` | Inspect a read-only plan or apply the selected item |
| Providers: `u` / `d` | Keep the selected Local copy in Workspace / keep its Workspace copy locally |
| Providers: `i` | Show or hide profiles incompatible with the selected client |
| MCP: `l` / `w` | Focus target-specific Local server switches / Workspace profiles |
| MCP: `/` | Search by server name, category, or description; Enter keeps and Esc clears the query |
| MCP: `e` / `x` / `g` | Toggle enabled-only / readiness-problem filters / category grouping |
| MCP: Space | Preflight and confirm one target-specific toggle, or stage it while batch mode is active |
| MCP: `m` / `a` / `c` | Enter batch mode / preflight and atomically apply staged changes / clear staged changes |
| MCP: `s` / `S` / `u` | Save the exact selection / update only its current-target override / back up the portable encrypted MCP Store containing it |
| Skills: `l` / `w` | Focus target-specific Local Skill switches / Workspace Packs |
| Skills: `/` / `e` | Search the canonical Skill catalog / show only enabled Skills |
| Skills: Space | Confirm one target-specific link toggle, or stage it in batch mode |
| Skills: `m` / `a` / `c` | Enter batch mode / atomically apply staged links / clear staged changes |
| Skills: `s` / `S` / `u` | Save the exact selection / update only this client override / back up the portable Skills Store |
| MCP / Skills: `f` | Confirm repair of the current named local profile or pack when Drift is reported |
| Prompts: `v` / `V` | View the active local / selected Workspace Prompt on demand |
| Snippets: `c` | Copy the selected local snippet without rendering it |
| `u` | Roll back a preset transaction |
| Agents: `c` / `p` / Enter | Open unified Providers for the selected agent |
| Agents: `x` | Confirm removal of agentctl-owned provider configuration |
| Accounts: `a` / Enter | Confirm switch to the selected saved official account |
| Accounts: `x` | Delete the selected non-current account snapshot |
| `?` | Toggle keyboard help |
| `q` | Quit |

The interface uses standard terminal colors and symbols; it does not require a
Nerd Font. Green/yellow/red continue to communicate health where used in status
fields. Target badges are deliberately distinct: Claude Code yellow, Codex
cyan, OpenCode green, and Pi magenta. Provider availability always has a
textual `B/L/W/L+W/L≠W` cue in addition to color, and every active section gets
its own navigation accent instead of a single indistinguishable color. The MCP
server list likewise uses `●` active, `○` inactive, and `×` explicit disabled
override. `✓`, `!`, and `?` report ready, missing requirements, and unchecked
host state. Active servers are sorted first. Enable operations check platform,
executables or local services, and required Secret references before the final
confirmation. Batch changes are rendered by one `mcpctl server set` transaction.
Target switches preserve unchanged owned entries, render only changed servers,
and return their final local state in the same process; they do not wait for a
Workspace round trip. Whole-catalog host readiness is cached for five minutes
so the 30-second dashboard refresh cannot repeatedly launch every doctor check.
The Skills section provides the same local/Workspace split for Codex, Claude
Code, OpenCode, and Pi. Its enabled items sort first, other-client usage remains
visible, and batch changes use one rollback-protected `skillsctl skill set`
transaction. Disabling a Skill removes only the selected client's managed link;
the canonical Store copy and all other clients remain unchanged.

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
