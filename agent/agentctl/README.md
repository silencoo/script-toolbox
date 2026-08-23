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

The dashboard starts on Overview and combines portable Providers, MCP, Skills,
Prompts, development presets, and encrypted Workspace state. It refreshes
automatically, publishes local state before connecting to Workspace in the
background, browses cloud catalogs on demand, and can plan/apply one selected
Provider, Profile, Pack, Prompt, or Preset without first restoring the whole
Store. The Providers view distinguishes built-in/local/Workspace sources,
reconciles one conflicting row at a time, and resolves Claude Code, Codex,
OpenCode, and Pi independently. The Agents section
opens that same Provider view or confirms removal of agentctl-owned
configuration. Node.js 22 or newer is required. `agentctl interactive` provides
a compact line-oriented view of the same catalog.

The same dashboard can be selected explicitly:

```bash
./agent/agentctl/agentctl tui
```

## Explicit commands

```bash
# Built-ins are visible immediately, even before a local Store exists.
./agent/agentctl/agentctl provider list --target claude

# Preview, then use one Provider. Use also installs the client when missing.
./agent/agentctl/agentctl provider plan deepseek --target claude
./agent/agentctl/agentctl provider use deepseek --target claude \
  --secret-file /secure/deepseek-api-key --yes

# The same catalog resolves independently for each client.
./agent/agentctl/agentctl provider list --target codex
./agent/agentctl/agentctl provider use openai-api --target codex \
  --model gpt-5.6 --secret-file /secure/openai-api-key --yes

# Inspect installed CLIs and provider state without secrets.
./agent/agentctl/agentctl status all
./agent/agentctl/agentctl status codex --json

# Preview/install and inspect the Claude Code status-line preset.
./agent/agentctl/agentctl statusline install
./agent/agentctl/agentctl statusline install --yes
./agent/agentctl/agentctl statusline status --json

# Remove only setup.sh-owned provider/model/credential state.
./agent/agentctl/agentctl uninstall codex
./agent/agentctl/agentctl uninstall codex --yes
```

Provider targets are `claude`, `codex`, `opencode`, and `pi`.

`status` reports the CLI path/version, resolved provider/model, configuration
source, ownership marker, config/state paths, and credential-file
existence/mode. Codex additionally reports nested `identity` and `inference`
objects: the Identity is the current official ChatGPT login, while inference is
the Provider and Model that actually handle requests. The old flat Provider
fields remain available for command compatibility. It never emits a credential
value. JSON status requires `jq`.

For OpenCode, status and the Provider catalog also discover safe metadata from
its native `auth.json`: provider ID, authentication type, and an explicitly
selected global model when present. Native credentials remain external and are
never copied, printed, uploaded, or treated as an agentctl Provider Secret.
Consequently a row may report `native-auth` or `native-current` while its
portable `gemini_api_key` (or equivalent reference) is still missing.

## Codex official accounts

`agentctl account` manages the official ChatGPT Identity independently from
inference Provider profiles. It stores complete local OAuth snapshots because
they are needed to switch accounts, but the Store directory is owner-only and
every snapshot is mode `0600` on Unix-like systems. Tokens and account IDs are
never printed, included in TUI state, or uploaded to the encrypted Workspace.

All mutations are preview-first:

```bash
# Inspect only labels, active state, timestamps, and permission health.
agentctl account status
agentctl account list --json

# Capture the currently active official login under a local label.
agentctl account save primary
agentctl account save primary --yes

# Preview, then run Codex login in an empty owner-only temporary CODEX_HOME.
# The verified credential is saved and activated without revoking primary.
agentctl account login secondary
agentctl account login secondary --yes

# Use the device-code flow instead of opening a local browser.
agentctl account login secondary --device-auth --yes

# Preview, then atomically switch auth.json. Provider/Model stay unchanged.
agentctl account use primary
agentctl account use primary --yes

# The active snapshot cannot be deleted.
agentctl account delete secondary --yes
```

Labels use lowercase letters, digits, and single hyphens. Before a switch,
agentctl refreshes the saved copy of the outgoing account so token rotations are
not lost. It refuses to overwrite an unsafe or unrecognized live `auth.json`,
or an official login that has not first been saved. Start a new Codex session
after switching; already-running processes may retain their in-memory session.
Use `agentctl account login` when adding or reauthenticating an account. It
forces file credential storage inside an empty temporary `CODEX_HOME`, validates
the result, writes the saved and live files atomically with rollback, and then
removes the temporary home without calling logout. A normal `codex login` in
the active home performs a server-side OAuth revocation first; copying the old
`auth.json` cannot make that revoked refresh token valid again. The currently
active official login must already have a saved label so agentctl can preserve
it before switching.
The Account Store is device-local by design and is separate from Provider
backup/restore.

Per-client setup scripts are private render backends. Public selection, model
choice, Secret import, installation, and switching all go through
`agentctl provider`. Secret input files must be regular, non-symlinked,
owner-only files containing exactly one non-empty line (normally mode `0600`).

Provider switching never changes Claude's independent status-line setting. The
`agentctl statusline` lifecycle previews mutations by default, can privately
preserve an external setting with `install --force --yes`, and restores that
setting on uninstall. It never prints the saved command.

## Unified Provider catalog

The public catalog always includes built-ins and merges materialized local
profiles with encrypted Workspace profiles in the TUI. The Provider Store
captures portable intent rather than a snapshot of one machine's generated
configuration. A profile contains one base endpoint and protocol, a Secret
reference, explicit model aliases, optional per-agent overrides, optional
Darwin/Linux/Windows target overlays, and an explicit compaction
capability/policy plus a separate client context policy. Its strict schema
has no fields for absolute config paths, PIDs, ports, logs, health state, or
generated client files.

Provider Store schema 2 separates what an upstream has been verified to
support from what a client should do:

- `compaction.upstream`: `responses_v2`, `responses_v1`,
  `anthropic_messages_beta`, or `none`.
- `compaction.policy`: `auto`, `remote`, or `local`.
- `context.window_tokens`: the selected model's verified maximum, or `null`
  to leave the client default in place.
- `context.auto_compact_tokens`: an independent client-side trigger, or
  `null` to leave the client default in place.

`auto` uses a native remote path only when both the target and declared
upstream match; otherwise compaction stays local. The exact `openai-api` and
`anthropic-api` built-ins carry native declarations. Custom and migrated
third-party profiles default to `none/auto` until explicitly verified—accepting
Responses traffic alone does not prove `/responses/compact` support.

Provider profiles describe inference only. They do not contain or bind an
official ChatGPT account. A Codex plan reports `official_identity.policy` as
`preserve`, so applying MiniMax, OpenRouter, or another Responses-compatible
profile changes `config.toml` and its separate Provider Secret while leaving the
current `~/.codex/auth.json` untouched. Consequently Remote Control can retain
the current official Identity while inference uses the selected third party.
The apply transaction verifies that protected file after the backend returns;
an unexpected change aborts the operation and restores its original bytes.

```bash
# Browse built-ins and local profiles without initialization.
agentctl provider list --target codex

# Create one reusable OpenAI Responses profile.
agentctl provider create work-gateway \
  --protocol openai_responses \
  --base-url https://gateway.example.com/v1 \
  --model daily \
  --alias daily=vendor-model-2026 \
  --auth-mode bearer \
  --secret work_gateway_key \
  --compaction-upstream none \
  --compaction-policy auto \
  --yes

# Disable an incompatible direct target, then specialize Windows without
# storing a Windows path.
agentctl provider target work-gateway claude --disable --yes
agentctl provider platform work-gateway windows codex \
  --model daily --yes

agentctl provider resolve work-gateway \
  --target codex --platform windows --json

# Persist a verified Claude model window and an independent compact trigger.
agentctl provider use minimax-cn --target claude \
  --context-window-tokens 1000000 \
  --auto-compact-tokens 500000 --yes
```

CCSwitch migration reads its SQLite database in read-only mode, imports only
third-party Claude/Codex Providers and their API keys, and deliberately skips
official OAuth identities. Values are written only to the owner-only Secret
Store and never printed:

```bash
agentctl provider migrate ccs
agentctl provider migrate ccs --yes
```

Upgrade an existing schema 1 Provider Store once after updating agentctl:

```bash
agentctl provider migrate schema
agentctl provider migrate schema --yes
```

The migration recognizes only exact official OpenAI/Anthropic built-ins.
Everything else receives `none/auto`; it never probes an endpoint or changes
the separate Secret Store. Legacy encrypted Workspace data is normalized in
memory and is written as schema 2 on the next explicit Workspace save.

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

Plan and use project the resolved profile through the ownership-safe
backend for each client. The model written to a native direct configuration is
the final outbound model after exact alias expansion:

```bash
agentctl provider plan work-gateway --target codex
agentctl provider use work-gateway --target codex --yes
agentctl provider current

# Apply every enabled and compatible target as one rollback-capable operation.
agentctl provider use work-gateway --target all --yes
```

Direct mode deliberately rejects protocol/auth combinations a client cannot
natively speak:

| Target | Direct protocols | Authentication |
| --- | --- | --- |
| Claude Code | `anthropic_messages` | `bearer`, `x-api-key` |
| Codex | `openai_responses` | `bearer` |
| OpenCode | all four Store protocols | Anthropic uses `x-api-key`; OpenAI uses `bearer`; Google uses `x-goog-api-key` |
| Pi | all four Store protocols | `bearer`, `x-api-key`, `x-goog-api-key`; loopback-only `none` |

Disable an incompatible target or give it an explicit
endpoint/protocol/auth/compaction/context override. Neither the native renderers nor
the optional proxy emulate one protocol through another. `use` passes each
Secret through a short-lived owner-only file and records only safe selection
metadata in device-local state. Claude profile apply does not alter the
separately managed status-line setting.

For Codex, an exact official OpenAI profile with `responses_v1` or
`responses_v2` in `auto`/`remote` mode is rendered with the `OpenAI` Provider
name Codex recognizes, enabling its native remote compact request. `local`
keeps the profile under its own name. Codex-specific thresholds such as
`model_auto_compact_token_limit` are not inferred from remote compaction
capability.

Claude Code is currently the direct renderer for the portable `context`
policy. It maps `window_tokens` to `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and
`auto_compact_tokens` to `autoCompactWindow`. Exact built-in model metadata is
applied when the model changes: DeepSeek V4 Pro/Flash use a 1,000,000-token
maximum while leaving the compact trigger to the client/user setting, MiniMax
M3 uses a 1,000,000-token maximum and a conservative 500,000-token trigger,
and MiniMax M2.7/M2.5 use their 204,800-token maximum. A separate owner-only
state file remembers any values that existed before agentctl took control;
switching to a profile with `null` context values or uninstalling restores
those originals. Changing to a model without exact catalog metadata clears
inherited context assumptions unless explicit context values are supplied with
the same command. Other targets reject a non-null managed context policy until
their native renderer implements an equivalent setting.

For a fresh machine, restore the Secret reference locally (or later through
the encrypted Workspace), then import and apply the portable catalog in one
operation:

```bash
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
exact model IDs, Standard/Fast service tiers, prompt-context intervals,
effective intervals, optional profile-specific overrides, and mandatory source
provenance. A bundled snapshot is explicitly dated and limited to the current
GPT-5.6 Sol/Terra/Luna family; it never auto-updates.

```bash
agentctl pricing init --preset openai-gpt-5.6 --yes
# Or: agentctl pricing init --version 2026.08 --currency USD --yes
agentctl pricing set work-model \
  --profile work-gateway \
  --model vendor-model-2026 \
  --service-tier standard \
  --context-min-tokens 0 --context-max-tokens unbounded \
  --input 3 --output 15 \
  --cache-read 0.3 --cache-write 3.75 \
  --effective-at 2026-08-01T00:00:00Z \
  --source "vendor price page captured 2026-08-01" \
  --yes
agentctl pricing calculate work-gateway vendor-model-2026 \
  --service-tier standard \
  --input-tokens 1000000 --output-tokens 250000 --json
```

Decimal strings are calculated with scaled `BigInt`, so neither catalog input
nor output cost passes through JavaScript floating point. Prompt context is
`input + cache read + cache write`; a matching context band prices the full
request. See
[`../pricing/`](../pricing/) for selection and precision rules.

## Optional native protocol proxy

The proxy is a separate Node process with an explicit lifecycle. It does not
run inside agentctl or start with the TUI. Starting it never modifies an agent;
Provider connection is a separate preview-first operation:

```bash
agentctl proxy plan work-gateway --target codex
agentctl proxy start work-gateway --target codex --yes
agentctl proxy connect codex
agentctl proxy connect codex --yes
agentctl proxy status --json
agentctl proxy disconnect codex --yes
agentctl proxy stop
agentctl proxy stop --yes
```

`connect` reuses the target's ownership-safe Provider renderer with the local
proxy URL and hidden capability. It snapshots every managed file, verifies that
Codex official Identity is unchanged, and makes `disconnect` an exact restore.
Target drift refuses disconnect rather than overwriting user edits; an external
target configuration requires `--force`. Stop and capability rotation are
blocked while a target remains connected.

Use `--instance <name>` on every command to run independent daemons with
instance-derived ports and separate capabilities, state, locks, logs,
attachments, and connection backups. Override `--port` if two names ever hash
to the same default. `status` also reports bounded admission counters and content-free
configuration drift. Changes to the selected Provider/Secret/failover/pricing
sources require an explicit restart and never hot-mutate the running snapshot.

### Pure observation for an official Codex subscription

The reserved `passthrough` profile observes Codex CLI traffic authenticated by
an official ChatGPT subscription. It does not need a Provider Store profile or
API key:

```bash
agentctl proxy plan passthrough --target codex
agentctl proxy start passthrough --target codex --yes
agentctl proxy attach
agentctl proxy attach --yes

# Inspect recent requests or aggregate retained metrics directly in agentctl.
agentctl proxy usage --last 20
agentctl proxy usage --summary
agentctl proxy usage --summary --last 100 --json

# Detach first so Codex never points at a stopped listener.
agentctl proxy detach --yes
agentctl proxy stop --yes
```

In this mode the default upstream remains
`https://chatgpt.com/backend-api/codex`. The daemon forwards Codex's official
OpenAI bearer, `ChatGPT-Account-ID`, request model, body, and response without
substituting a Provider Secret or alias. It disables failover and replay. The
HTTP path preserves Codex's `Accept-Encoding` and relays compressed upstream
response bytes unchanged while a streaming decompressor feeds only the bounded
in-memory usage collector. Request bytes are piped upstream with backpressure;
only a bounded, globally accounted side copy is inspected, so passthrough does
not require whole-body buffering. The WebSocket path forwards Codex's
`permessage-deflate` offer and the upstream negotiation, then relays compressed
frames unchanged. A bounded side observer inflates only its own frame-payload
copies, including fragmented messages and context takeover, to inspect
completion usage. A side-observer limit or decompression failure disables
inspection without changing or interrupting the proxied stream. Metadata and
usage logs still contain no headers, credentials, or request/response bodies.
Each WebSocket close record reports observation as `complete`, `degraded`, or
`not_started`, lists only fixed content-free failure reasons, and includes the
number of response turns that closed before usage was captured. This makes
partial accounting explicit without logging the missed content or decoder
errors verbatim.
HTTP and WebSocket traffic share a configurable concurrent-request admission
limit. Native body buffering also has a global byte limit and upload timeout.
RFC hop-by-hop fields and all fields nominated by `Connection` are stripped in
both directions.
Token counts come from the upstream response. Any catalog-derived dollar value
is an API-price estimate, not a ChatGPT subscription charge or authoritative
quota balance.

For OpenAI traffic, the proxy records both requested and returned
`service_tier`. Returned `priority` is normalized to Fast and returned
`auto`/`default` to Standard, and the returned value controls pricing. This matters
when ramp limits downgrade a requested Fast call to Standard billing.

The usage commands read active and rotated owner-only JSONL files and expose
only a fixed safe projection: model identities, requested/returned/pricing
tier, token classes, selected rate, cost, status, and duration. Summary mode
uses fixed-decimal monetary addition and groups requests by model and effective
pricing tier. Requested/effective Fast totals, response-confirmed downgrade
counts, and canonical tier transitions are reported separately; missing rates
remain explicit instead of being treated as zero cost. The daemon may be
running or stopped.

The TUI Providers section loads the same retained summary and shows an
**Observed usage** block beneath Pricing/Proxy: retained versus priced requests,
estimated API-equivalent cost, input/cache/output tokens, requested/effective/
downgraded Fast counts, and the usage window. Empty and unavailable states stay
explicit; the value is never labeled as a ChatGPT subscription invoice.
That section also labels official-account inference as `Subscription` and
renders the current request path separately from the local listener and
attachment states. Uppercase `S` confirms start/stop and uppercase `A`
confirms attach/detach. These controls preserve the CLI safety contract:
start is detached, attach requires a healthy running passthrough observer,
and an attached observer cannot be stopped.

`start` never edits Codex. `attach --yes` separately snapshots the exact
`$CODEX_HOME/config.toml` bytes and mode, then inserts a marked top-level
`model_provider = "openai"` plus the loopback `openai_base_url`. This keeps the
built-in OpenAI/ChatGPT authentication path; both HTTP and WebSocket Responses
pass through the observable local first hop and then the official upstream.
`detach --yes` restores the snapshot byte-for-byte when nothing else changed.
Normal Codex App additions outside the marked block, including per-project
trust records, remain attached and are preserved during detach. Detach refuses
only when the proxy-managed block or owner-only backup changed, rather than
discarding or overwriting ambiguous edits. `stop` likewise refuses until Codex
is detached.

The subscription attachment URL includes the synthetic local suffix
`/backend-api/codex/realtime`. Codex uses the `/backend-api` marker to retain
the ChatGPT backend request shape for App voice call creation; without it, the
same account session emits the public-API multipart `POST /live`, which cannot
be byte-forwarded to the ChatGPT backend. The proxy strips the local marker and
allowlists the resulting `POST /realtime/calls`, `POST /alpha/search`, Responses,
and Realtime WebSocket routes before forwarding. This keeps Codex App voice and
standalone web search working without introducing protocol conversion or a
general-purpose forward proxy.

It binds only to loopback and accepts only the selected native protocol's
allowlisted routes. The local base URL is reported after start: OpenAI
Responses/Chat use `/v1`, Google uses `/v1beta`, and Anthropic uses the listener
root. In Provider mode every request must present the hidden local capability as
`x-agentctl-proxy-token`, Bearer, `x-api-key`, or `x-goog-api-key`. The proxy
strips all of those client credentials before applying the real upstream
Secret in memory.

The subscription passthrough is the deliberate exception to credential
replacement: its data routes require and forward the official bearer. The
hidden local capability remains required for controller health checks and is
never exposed to Codex configuration.

For `openai_responses`, `/v1/responses/compact` is allowlisted only when every
backend in the selected single/failover route resolves to native Responses
compaction. Mixed or unverified routes remain local. Anthropic Messages stays
on `/v1/messages`; beta headers and `context_management` are passed through
natively rather than translated.

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

### Ordered failover and circuit breaking

Failover routes are portable policy layered over Provider profiles. They keep
an ordered list of 2–8 profiles plus retry and circuit settings, but never
contain Secret values, generated client files, runtime counters, or machine
paths:

```bash
agentctl failover init --yes
agentctl failover create daily-route \
  --profile work-primary \
  --profile work-backup \
  --failure-threshold 3 \
  --recovery-timeout-ms 30000 \
  --yes

agentctl proxy plan work-primary \
  --target codex --route daily-route
agentctl proxy start work-primary \
  --target codex --route daily-route --yes
```

Every route must resolve to one native protocol for the selected target and
platform. By default, a failed model POST is returned to its caller exactly as
received; it is never silently replayed. The failure opens or advances the
device-local circuit, so a later request can select the next healthy backend.
This makes failover useful without introducing hidden duplicate billing.

Same-request retry is available only as an explicit bounded policy:

```bash
agentctl failover create replay-route \
  --profile work-primary \
  --profile work-backup \
  --same-request-retry \
  --max-attempts 2 \
  --yes
```

That mode can replay and bill one logical request more than once, which both
the preview and stored route make visible. Circuit state is owner-only,
device-local, retained across daemon restarts, and excluded from portable
failover exports. Request metadata records backend names, outcomes, statuses,
and timings only. Logs retain a configurable number and maximum age via
`--retention-files` and `--retention-days`.

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
Prompts Stores, the shared development-preset catalog, and an optional agent
bundle: portable Provider profiles, Provider Secret values, failover routes,
and the versioned pricing catalog. Unlocking the Worker UI once opens
Providers, MCP, Skills, Prompts, and Presets tabs. Child capabilities and
Provider Secret values are never sent to the Worker in plaintext.

Workspace manifests are written as strict schema 3; child attachments and
development presets retain their schema 2 formats. Legacy Workspace schemas 1
and 2 are normalized to schema 3 in memory so recovery and read-only browsing
continue to work. The encrypted remote version remains untouched until an
explicit migration or another Workspace mutation creates a new schema 3
version.

Preview or explicitly persist that compatibility conversion as a new immutable
remote version:

```bash
agentctl workspace migrate
agentctl workspace migrate --yes
```

The preview is read-only. `--yes` uploads schema 3 while retaining the previous
schema 1 or 2 version in Workspace history.

Synchronize the portable agent catalogs independently of MCP, Skills, Prompts,
and Presets:

```bash
# Inspect redacted local/remote counts.
agentctl workspace agent status

# Reconcile one same-name Provider without touching any other profile or
# failover/pricing catalog. Both commands preview unless --yes is supplied.
agentctl workspace agent push --profile minimax-cn
agentctl workspace agent push --profile minimax-cn --yes
agentctl workspace agent pull --profile minimax-cn
agentctl workspace agent pull --profile minimax-cn --yes

# Preview, then replace only the remote agent bundle from this machine.
agentctl workspace agent push
agentctl workspace agent push --yes

# Preview, then merge remote catalogs into another machine.
agentctl workspace agent pull
agentctl workspace agent pull --yes

# Restore the exact remote catalog set, including removal of optional local
# failover/pricing files that are absent remotely.
agentctl workspace agent pull --replace --yes
```

For a same-name `L≠W` conflict, profile-scoped `push` means **Local wins** and
profile-scoped `pull` means **Workspace wins**. The selected profile and only
its referenced Secret values are upserted; unrelated Provider profiles,
failover/pricing catalogs, generated configuration, and the device-local
applied selection are preserved. `--replace` cannot be combined with
`--profile`.

The default whole-bundle pull is merge-safe and rejects conflicting profiles or Secret
references; `--replace` is the explicit exact-restore mode. Secret values are
end-to-end encrypted, restored to an owner-only local file, and never included
in status, previews, plans, or normal exports. Provider selections, rendered
Claude/Codex/OpenCode/Pi configuration, proxy capability/configuration, ports,
PIDs, logs, usage rows, and circuit counters stay device-local. After pulling,
run `agentctl provider plan/apply` for the chosen profile, target, and current
operating-system overlay.

Existing isolated modes remain available for compartmentalization and
break-glass recovery:

- `mcpstore1_…` opens only an MCP Store;
- `skillstore1_…` opens only a Skills Store; and
- `promptstore1_…` opens only a Prompt Store.

Create a Workspace, then attach existing isolated Stores without copying or
deleting their data:

```bash
agentctl workspace init \
  --endpoint https://toolbox-store.example.workers.dev \
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
copy MCP, Skills, Prompt, Preset, or Provider catalogs into their normal local
Stores. Use `agentctl workspace agent pull` explicitly for the portable agent
bundle.
After recovery, the TUI queries version metadata from the endpoint and lazily
decrypts a child Store only when its section is opened. Plans remain in memory;
an apply writes only the chosen selection and its dependencies to
`~/.local/share/agentctl/workspaces/<workspace-store-id>/` (or the platform data
directory on Windows), then invokes the existing controller transaction.
If the selected MCP or Skills component has no initialized local Store, the TUI
offers an explicit first-adoption choice: restore the full attached child Store
and its recovery capability locally so Local Switches work, continue with the
selected-only isolated runtime, or cancel. It never overwrites an existing
local Store through this shortcut.
If skillsctl reports that a named Skill changed outside its catalog, the TUI
offers a separate confirmation to keep those current files, refresh only that
Skill's checksum, and retry the original local or Workspace action. Multiple
changed Skills are confirmed one at a time, and Workspace-runtime repair stays
inside the isolated runtime.
Provider catalogs remain independently exportable local Stores even when they
are also backed up in Workspace; generated provider configuration always
remains device-local.

## Standalone PATH commands

Preview and then install the minimal standalone runtime and commands:

```bash
./agent/install-commands.sh --prefix "$HOME/.local/bin"
./agent/install-commands.sh --prefix "$HOME/.local/bin" --yes

agentctl status all
agentctl workspace status
mcpctl current --target codex
promptctl status all
```

From Windows PowerShell, preview and install the same Bash-backed runtime with
native `.cmd` shims:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\agent\install-commands.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\agent\install-commands.ps1 `
  -Yes -AddToPath

agentctl status all
```

The PowerShell installer requires Git for Windows or MSYS2 Bash. Its defaults
are `%LOCALAPPDATA%\script-toolbox\agent` and
`%LOCALAPPDATA%\script-toolbox\bin`; use `-BashPath`, `-Runtime`, or `-Prefix`
to override them. The controllers remain Bash programs, while the installer,
PowerShell/`cmd.exe` shims, conflict preservation, PATH ownership, and
uninstall flow are Windows-native.

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

On Git for Windows/MSYS2, an applying update first re-executes the updater body
in memory so the installed runtime script is no longer open when its directory
is atomically replaced. No administrator shell or manual permission change is
required for a user-owned installation.

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

The PowerShell equivalents use `-Force` and `-Uninstall -Yes`. A user PATH
entry is removed only when that installer originally added it:

```powershell
.\agent\install-commands.ps1 -Force -Yes -AddToPath
.\agent\install-commands.ps1 -Uninstall -Yes
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
