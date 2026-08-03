# agentctl

`agentctl` is the public Shell entrypoint for installing a supported coding
agent, configuring its provider/model/credential, and managing the optional
unified encrypted Toolbox Workspace.

Run it without arguments from the repository root to open the unified terminal
dashboard:

```bash
./agent/agentctl/agentctl
```

The dashboard starts on Overview and combines providers, MCP, Skills, Prompts,
development presets, and encrypted Workspace state. It refreshes automatically,
browses cloud catalogs on demand, and can plan/apply one selected remote
Profile, Pack, Prompt, or Preset without first restoring the whole Store.
The Agents section also selects a client for provider discovery, interactive
setup/install, or confirmed removal of agentctl-owned provider configuration.
Node.js 22 or newer is required. Use `agentctl interactive` for the older
line-oriented guide that selects Claude Code, Codex, OpenCode, or Pi and then
delegates to that client's setup implementation. Non-TTY no-argument callers
retain the guide for compatibility.

The same dashboard can be selected explicitly:

```bash
./agent/agentctl/agentctl tui
```

## Explicit commands

```bash
# Open the selected client's provider/model setup.
./agent/agentctl/agentctl setup claude

# Forward automation flags unchanged.
./agent/agentctl/agentctl setup codex \
  --provider openai --model gpt-5.6

# Resolve the provider/model and affected paths without a key or any changes.
./agent/agentctl/agentctl setup codex \
  --provider openai --model gpt-5.6 --dry-run

# Prefer a private file to putting a key in shell history.
./agent/agentctl/agentctl setup codex \
  --provider openai --model gpt-5.6 --key-file /secure/openai-api-key

# "init" and "configure" are setup aliases.
./agent/agentctl/agentctl init opencode

# Inspect installed CLIs and provider state without secrets.
./agent/agentctl/agentctl status all
./agent/agentctl/agentctl status codex --json

# Inspect client-specific presets and options.
./agent/agentctl/agentctl providers pi
./agent/agentctl/agentctl help codex

# Remove only setup.sh-owned provider/model/credential state.
./agent/agentctl/agentctl uninstall codex
./agent/agentctl/agentctl uninstall codex --yes
```

Client aliases include `claude`/`claude-code` and
`opencode`/`open-code`.

`status` reports the CLI path/version, resolved provider/model, configuration
source, ownership marker, config/state paths, and credential-file
existence/mode. The source distinguishes agentctl-owned settings, externally
managed Claude settings such as CC Switch, and Codex's official ChatGPT/API-key
login. It never emits a credential value. JSON status requires `jq`.

All four setup backends accept `--dry-run` and `--key-file PATH`. Dry-run exits
before validation requests, package installation, or filesystem changes, and
does not require a key. Key files must be regular, non-symlinked, owner-only
files containing exactly one non-empty line (normally mode `0600`).

## Development presets

A development preset binds one named MCP profile, Skills pack, and Prompt
profile. Presets contain names only; credentials remain in their existing
ctl-specific stores. The same catalog can be edited locally or inside the
encrypted Workspace Web UI.

```bash
agentctl preset create web-research \
  --mcp browser-research \
  --skills frontend \
  --prompt research \
  --description "Browser-assisted frontend research" \
  --yes

agentctl preset plan web-research --target codex
agentctl preset apply web-research --target codex --yes
agentctl preset current --target codex
```

Synchronize the whole local preset catalog with the encrypted Workspace:

```bash
# Replace Workspace presets with the local catalog.
agentctl preset push --yes

# Replace the local catalog with Workspace presets edited in the browser.
agentctl preset pull --yes
```

Both directions deliberately require `--yes` because they replace the
destination catalog. Use `--workspace-config PATH` or
`AGENTCTL_WORKSPACE_CONFIG` when the master capability is not at the default
`~/.config/agentctl/workspace-remote.json` path. The Web UI defines presets;
only local `agentctl preset plan/apply` writes agent configuration files.

`plan` runs all three component plans without writing anything. `apply`
starts only after every plan succeeds. If a later component fails, agentctl
reconstructs the previous MCP and Skills selections—including target-local
custom enable/disable sets—and restores the previous Prompt profile. A
successful transaction can also be reverted explicitly:

```bash
agentctl preset rollback --target codex --yes
```

The default catalog is `~/.config/agentctl/presets.json`; the last 20 applied
transactions are kept in `~/.local/state/agentctl/presets.json`. Both formats
use strict schema 2 JSON and contain no secret values. Presets currently
target Claude Code and Codex because those are the clients shared by all
three component controllers.

## Unified doctor

```bash
agentctl doctor codex
agentctl doctor all --json
```

Doctor combines redacted provider status with machine-readable MCP, Skills,
and Prompt selections. It reports preset drift, managed-link health, MCP
Secrets availability, remote-store reachability, and whether a new agent
session is recommended. An unreachable or unconfigured optional remote Store
is reported separately and does not make an otherwise healthy local setup
fail.

## Unified Workspace and isolated Stores

The default recovery experience uses one `toolbox1_…` Workspace code. Its
encrypted manifest contains the capabilities for attached MCP, Skills, and
Prompts Stores plus the shared development-preset catalog. Unlocking the
Worker UI once opens MCP, Skills, Prompts, and Presets tabs. Child
capabilities are never sent to the Worker in plaintext.

Workspace manifests and development-preset catalogs are written as strict
schema 2. Legacy schema 1 Workspace manifests are normalized to schema 2 in
memory so recovery and read-only browsing continue to work; the encrypted
remote version remains untouched until an explicit attach, detach, or preset
write creates a new schema 2 version.

Preview or explicitly persist that compatibility conversion as a new immutable
remote version:

```bash
agentctl workspace migrate
agentctl workspace migrate --yes
```

The preview is read-only. `--yes` uploads schema 2 while retaining the previous
schema 1 version in Workspace history.

Existing isolated modes remain available for compartmentalization and
break-glass recovery:

- `mcpstore1_…` opens only an MCP Store;
- `skillstore1_…` opens only a Skills Store; and
- `promptstore1_…` opens only a Prompt Store.

Create a Workspace, then attach existing isolated Stores without copying or
deleting their data:

```bash
agentctl workspace init \
  --endpoint https://mcp-store.example.workers.dev \
  --create-token-file /secure/toolbox-create-token

agentctl workspace attach mcp
agentctl workspace attach skills
agentctl workspace attach prompts
agentctl workspace status
agentctl workspace ui enable
```

`attach` enables browser access for that child Store and records its private
capability only in a new encrypted Workspace version. `detach` removes only
the reference; the child Store, versions, local config, and isolated recovery
code stay intact.

```bash
agentctl workspace recovery
agentctl workspace versions
agentctl workspace ui status
agentctl workspace ui disable
```

The master capability is stored locally at
`~/.config/agentctl/workspace-remote.json` with owner-only permissions. A
fresh machine can paste its recovery code into a hidden terminal prompt:

```bash
agentctl workspace restore
```

The code is not echoed and does not enter shell history. For automation, read
the same one-line code from a private file instead:

```bash
agentctl workspace restore --recovery-file /secure/toolbox-recovery-code
```

`workspace restore` restores only the local `toolbox1_` capability. It does not
copy MCP, Skills, Prompt, or Preset catalogs into their normal local Stores.
After recovery, the TUI queries version metadata from the endpoint and lazily
decrypts a child Store only when its section is opened. Plans remain in memory;
an apply writes only the chosen selection and its dependencies to
`~/.local/share/agentctl/workspaces/<workspace-store-id>/` (or the platform data
directory on Windows), then invokes the existing controller transaction. Agent
provider, model, and API-key configuration always remain local.

## Standalone PATH commands

Preview and then install the minimal standalone runtime and command links:

```bash
./agent/install-commands.sh --prefix "$HOME/.local/bin"
./agent/install-commands.sh --prefix "$HOME/.local/bin" --yes

agentctl status all
agentctl workspace status
mcpctl current --target codex
promptctl status all
```

The runtime lives at `~/.local/share/script-toolbox/agent` by default. It
contains only controller entrypoints, shared runtime modules, provider setup
backends, templates, adapters, and the built TUI; it excludes Git metadata,
tests, Worker sources, TUI sources, and unrelated toolbox utilities. The source
checkout can be moved or deleted after installation.

Check or install updates through any controller. Every entrypoint updates the
same suite atomically because the controllers share runtime modules:

```bash
agentctl update --check
mcpctl update --yes
promptctl update --yes
skillsctl update --yes
```

For development, `--link` keeps repository-backed links instead:

```bash
./agent/install-commands.sh --link --prefix "$HOME/.local/bin" --yes
```

The installer refuses existing commands or runtime directories by default.
`--force` first moves a conflict to a tracked backup. Uninstall removes only
matching managed links/runtime and restores tracked conflicts:

```bash
./agent/install-commands.sh --prefix "$HOME/.local/bin" --uninstall
./agent/install-commands.sh --prefix "$HOME/.local/bin" --uninstall --yes
```

## Ownership boundary

`agentctl` controls the client/provider layer, local development-preset
transactions, and the optional master Workspace manifest:

- It can install a missing CLI through the selected setup backend.
- It configures provider, model, and owned credential state.
- Its `uninstall` command calls that backend's provider-only `--uninstall`.
- Its `workspace` commands attach or detach encrypted child Store capabilities;
  they do not rewrite the child snapshots. The Workspace also owns the shared
  development-preset definitions.
- Its `preset` command deliberately invokes the three child controllers only
  for plan/apply/status/rollback, while `push` and `pull` replace only preset
  definitions in the encrypted Workspace; each controller retains ownership
  of its files and validation rules.

Outside an explicit preset or doctor command, it does not invoke `mcpctl`,
Promptctl, a per-client `mcp.sh`, or a full `uninstall.sh`. It also does not
remove an installed CLI binary. Use these independent entrypoints when needed:

```bash
./agent/mcpctl/mcpctl
./agent/promptctl/promptctl
./agent/skillsctl/skillsctl
```

## Compatibility entrypoints

The existing per-client scripts remain supported:

```text
agent/claude-code/setup.sh
agent/codex/setup.sh
agent/opencode/setup.sh
agent/pi/setup.sh
```

They are the implementation behind `agentctl` and remain available for
one-shot `curl | bash` use and existing automation. The per-client
`uninstall.sh` files are broader legacy/full-kit commands: where supported,
they remove both provider and simple MCP state.
