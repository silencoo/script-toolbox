# agentctl

`agentctl` is the public Shell entrypoint for installing a supported coding
agent, configuring its provider/model/credential, managing reusable portable
provider profiles, managing Claude Code's optional status-line preset, and
managing the optional unified encrypted Toolbox Workspace.

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

# Preview/install and inspect the Claude Code status-line preset.
./agent/agentctl/agentctl statusline install
./agent/agentctl/agentctl statusline install --yes
./agent/agentctl/agentctl statusline status --json

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

Claude provider setup also installs the status-line preset when no external
`statusLine` exists. `--no-statusline` opts out. The independent
`agentctl statusline` lifecycle previews mutations by default, can privately
preserve an external setting with `install --force --yes`, and restores that
setting on uninstall. It never prints the saved command.

## Portable provider profiles

The Provider Store captures portable intent rather than a snapshot of one
machine's generated configuration. A profile contains one base endpoint and
protocol, a Secret reference, explicit model aliases, optional per-agent
overrides, and optional Darwin/Linux/Windows target overlays. Its strict schema
has no fields for absolute config paths, PIDs, ports, logs, health state, or
generated client files.

```bash
# Preview and initialize the two local Stores.
agentctl provider init
agentctl provider init --yes

# Create one reusable OpenAI Responses profile.
agentctl provider create work-gateway \
  --protocol openai_responses \
  --base-url https://gateway.example.com/v1 \
  --model daily \
  --alias daily=vendor-model-2026 \
  --auth-mode bearer \
  --secret work_gateway_key \
  --yes

# Disable an incompatible direct target, then specialize Windows without
# storing a Windows path.
agentctl provider target work-gateway claude --disable --yes
agentctl provider platform work-gateway windows codex \
  --model daily --yes

agentctl provider resolve work-gateway \
  --target codex --platform windows --json
```

Secret values live separately in
`~/.config/agentctl/provider-secrets.json` on Unix-like systems and the native
`%APPDATA%\\agentctl` directory on Windows. Set one from an owner-only,
single-line input file so the value does not enter shell history:

```bash
chmod 600 /secure/work-gateway-key
agentctl provider secret set work_gateway_key \
  --secret-file /secure/work-gateway-key --yes
agentctl provider secret list
```

Portable JSON export always excludes those values, while retaining the
reference names needed to report missing credentials on another machine:

```bash
agentctl provider export --output provider-profiles.json --yes
agentctl provider import --input provider-profiles.json --yes
```

Import merges non-conflicting profiles. A conflicting profile fails closed;
`--replace --yes` is required to replace the destination catalog. Target
resolution is deterministic: base profile, then target override, then the
selected platform overlay, then exact alias expansion. Alias cycles are
rejected.

Plan and apply project the resolved profile through the existing ownership-safe
backend for each client. The model written to a native direct configuration is
the final outbound model after exact alias expansion:

```bash
agentctl provider plan work-gateway --target codex
agentctl provider apply work-gateway --target codex --yes
agentctl provider current

# Apply every enabled and compatible target as one rollback-capable operation.
agentctl provider apply work-gateway --target all --yes
```

Direct mode deliberately rejects protocol/auth combinations a client cannot
natively speak:

| Target | Direct protocols | Authentication |
| --- | --- | --- |
| Claude Code | `anthropic_messages` | `bearer`, `x-api-key` |
| Codex | `openai_responses` | `bearer` |
| OpenCode | `anthropic_messages`, `openai_responses`, `openai_chat` | Anthropic uses `x-api-key`; OpenAI uses `bearer` |
| Pi | all four Store protocols | `bearer`, `x-api-key`, `x-goog-api-key`; loopback-only `none` |

Disable an incompatible target or give it an explicit endpoint/protocol/auth
override. Protocol conversion belongs to the optional proxy layer, not these
native renderers. `apply` passes each Secret through a short-lived owner-only
file and records only the profile, endpoint, protocol, requested/outbound
models, platform, and timestamp in device-local state. Claude profile apply
does not alter the separately managed status-line setting.

For a fresh machine, restore the Secret reference locally (or later through
the encrypted Workspace), then import and apply the portable catalog in one
operation:

```bash
agentctl provider init --yes
agentctl provider secret set work_gateway_key \
  --secret-file /secure/work-gateway-key --yes
agentctl provider restore work-gateway \
  --input provider-profiles.json --target codex --yes
```

The command merges by default and rolls back the catalog if native application
fails. Use `--replace` only when the imported catalog should replace every
local profile. A Windows overlay can be inspected from macOS or Linux with
`plan --platform windows`, but `apply` rejects it; copying a macOS absolute
path into Windows is therefore impossible through this schema. On the Windows
machine the same command automatically selects its Windows overlay and native
user-home paths.

## Versioned model pricing

Pricing is an independent catalog, not a field in Provider profiles. It uses
exact model IDs, effective intervals, optional profile-specific overrides, and
mandatory source provenance. No vendor price snapshot is hard-coded into this
repository.

```bash
agentctl pricing init --version 2026.08 --currency USD --yes
agentctl pricing set work-model \
  --profile work-gateway \
  --model vendor-model-2026 \
  --input 3 --output 15 \
  --cache-read 0.3 --cache-write 3.75 \
  --effective-at 2026-08-01T00:00:00Z \
  --source "vendor price page captured 2026-08-01" \
  --yes
agentctl pricing calculate work-gateway vendor-model-2026 \
  --input-tokens 1000000 --output-tokens 250000 --json
```

Decimal strings are calculated with scaled `BigInt`, so neither catalog input
nor output cost passes through JavaScript floating point. See
[`../pricing/`](../pricing/) for selection and precision rules.

## Optional native protocol proxy

The proxy is a separate Node process with an explicit lifecycle. It does not
run inside agentctl, start with the TUI, or modify an agent configuration:

```bash
agentctl proxy plan work-gateway --target codex
agentctl proxy start work-gateway --target codex --yes
agentctl proxy status --json
agentctl proxy stop
agentctl proxy stop --yes
```

It binds only to loopback and accepts only the selected native protocol's
allowlisted routes. The local base URL is reported after start: OpenAI
Responses/Chat use `/v1`, Google uses `/v1beta`, and Anthropic uses the listener
root. Every request must present the hidden local capability as
`x-agentctl-proxy-token`, Bearer, `x-api-key`, or `x-goog-api-key`. The proxy
strips all of those client credentials before applying the real upstream
Secret in memory.

Plans, runtime state, daemon arguments, and metadata logs never contain the
capability or upstream Secret value. Request/response bodies and headers are
not logged. Exact Provider aliases rewrite only the native JSON model field or
Google route component. A separate bounded collector normalizes Anthropic,
OpenAI Responses, OpenAI Chat, and Google usage without retaining content; its
JSONL preserves requested/outbound/response/pricing model identities, token
classes, and fixed-decimal estimate provenance. A missing pricing catalog or
rate does not block forwarding. The three independent timeout dimensions can
be set with
`--first-byte-timeout-ms`, `--stream-idle-timeout-ms`, and
`--request-timeout-ms`; request bodies and metadata logs also have explicit
byte limits.

Capability rotation requires a stopped daemon and remains redacted:

```bash
agentctl proxy token status
agentctl proxy token rotate --yes
```

Shutdown first verifies the authenticated health instance before signaling the
recorded PID. A stale dead runtime can be cleaned with `stop --yes`, while a
live but unverifiable process is preserved. See [`../proxy/`](../proxy/) for
the route matrix and complete security boundary.

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
directory on Windows), then invokes the existing controller transaction. At
this stage the Provider Store remains an independently exportable local Store;
generated provider configuration always remains device-local.

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

`agentctl` controls the client/provider layer, Claude's optional status-line
preset, local development-preset transactions, and the optional master
Workspace manifest:

- It can install a missing CLI through the selected setup backend.
- It configures provider, model, and owned credential state.
- It owns the portable Provider Store and its separate local Secret Store;
  normal exports never contain Secret values.
- It explicitly starts/stops the optional loopback proxy without implicitly
  binding or rewriting any client.
- It can install or remove a separately owned Claude status-line renderer while
  preserving an existing external setting.
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
