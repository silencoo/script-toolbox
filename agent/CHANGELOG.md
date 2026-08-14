# Changelog — agent/

## 2026-08-14 — observable Codex subscription passthrough

- Added a loopback-only `passthrough` proxy mode for official
  ChatGPT-subscription Codex sessions. It preserves the OpenAI bearer, account
  header, model, and request/response bytes across current WebSocket and
  compressed HTTP transports while collecting bounded token metadata. HTTP
  content negotiation and compressed response bytes stay end-to-end; only a
  streaming side branch is decompressed for usage inspection. Provider Secret
  replacement, aliases, failover, and replay are disabled.
- Added response-authoritative OpenAI service-tier pricing. Usage rows now
  distinguish requested versus returned `service_tier`, normalize
  `priority`/`fast` and `auto`/`default`/Standard, and select non-overlapping prompt
  context bands. Added an explicitly dated bundled catalog for only GPT-5.6
  Sol/Terra/Luna Standard/Fast short/long rates and documented the exact cost
  formula.
- Added `agentctl proxy usage` for recent safe per-request metrics and
  `--summary` for retained token/cost totals grouped by exact model and
  effective service tier. The reader includes rotation files, uses exact
  fixed-decimal aggregation, surfaces unpriced rows, bounds total input, and
  refuses symlinked or non-owner-only logs.
- Surfaced that same calculation in the TUI Providers section as an
  `Observed usage` block with estimated API cost, token classes, pricing
  coverage, Fast request/effective/downgrade counts, and the retained window.
- Added confirmed TUI controls for the complete observation lifecycle:
  uppercase `S` starts/stops the Codex subscription observer and uppercase
  `A` attaches/detaches Codex, with the same start-before-attach and
  detach-before-stop safety guards as the CLI.
- Made official subscription inference unmistakable across Overview, Agents,
  and Providers with `ChatGPT` Identity, `Subscription` Inference, and a
  separate live request-path row. Bumped `agentctl` to 0.17.1.
- Added preview-first `agentctl proxy attach/detach` with owner-only backups,
  hash-bound state, byte-for-byte Codex config restoration, and stop guards.
  Restricted passthrough upstreams to the official ChatGPT Codex endpoint or
  literal loopback addresses and bumped `agentctl` to 0.17.0.

## 2026-08-13 — compact MCP task profiles

- Reduced the bundled MCP profile catalog from 32 overlapping presets and
  fragments to eight task profiles: `daily`, `daily-search`, five focused
  reverse-engineering profiles, and `off`. The daily browser suite now keeps
  both CloakBrowser-backed DevTools and real Chrome DevTools, while Brave and
  Exa are isolated in the optional search-enhanced daily profile.
- Added the portable Fetch server to the starter catalog, made `daily` the
  guided default, and updated profile, remote-restore, and end-to-end tests for
  the consolidated layout. Specialized servers remain available through
  one-off `--enable` customization.

## 2026-08-13 — managed Skill update recovery

- Fixed the documented Skills checksum-recovery loop: an intentionally edited
  managed Skill can now be previewed and force re-added from its canonical
  directory, while unrelated Store drift continues to fail closed. Documented
  the explicit re-add → validate → encrypted backup flow for an attached
  Workspace. Bumped `skillsctl` to 0.4.2.

## 2026-08-12 — incremental MCP target switches

- Expanded the platform contract beyond macOS. Linux CI is now named
  explicitly and continues to run the complete agent suite. Windows CI now
  exercises the portable Node backends, real Skills junction transactions,
  Provider/Preset flows, TUI launch, and a Git Bash MCP apply using isolated
  paths containing spaces and non-ASCII characters.
- Added shared Windows-safe Bash-controller invocation and platform config,
  state, and data path resolution. The TUI, Provider backend, and Preset
  orchestrator now route Bash scripts through Git for Windows/MSYS2 Bash;
  portable catalogs use roaming AppData and device state uses local AppData.
  Bumped `agentctl` to 0.16.9 and `skillsctl` to 0.4.1.

- Made TUI MCP enable/disable and staged batch writes incremental. `mcpctl
  server set --json` now preserves unchanged owned entries, renders only
  changed servers, and returns the final target state in the same process.
  This avoids resolving unrelated Secret-backed MCPs and removes the TUI's
  second `mcpctl current` subprocess.
- Cached whole-catalog MCP host readiness for five minutes so the 30-second
  local dashboard refresh does not repeatedly launch every doctor check.
  Added explicit in-progress copy and regression coverage for direct JSON
  state return, readiness caching, Codex suppression, and unchanged Secret
  preservation.
- Added four-client local Skill management to the TUI. Skills now have
  Local/Workspace panes, search, enabled-only filtering, active-first sorting,
  per-client usage badges, direct toggles, staged batch writes, Pack
  save/update, encrypted Store backup, and target cycling across Codex, Claude
  Code, OpenCode, and Pi.
- Added rollback-protected `skillsctl skill set`, machine-readable final state,
  safe JSON catalog metadata, and `skillsctl pack save`. Updating a saved Pack
  replaces only the selected target override and preserves every other client.
  Bumped `skillsctl` to 0.4.0 and `agentctl` to 0.16.8.

## 2026-08-11 — native compaction capabilities

- Added the same local-only drift repair flow to Skills. In the Skills section,
  `f` now confirms reapplying the current named pack for the highlighted
  client, restoring missing managed links without requiring Workspace or
  touching unrelated local skills. Bumped `agentctl` to 0.16.7.
- Added an actionable MCP drift repair to the TUI. `f` now confirms reapplying
  the current named local profile for the highlighted client with mcpctl's
  bounded `--force` behavior: only conflicting same-name MCP entries are
  adopted, unrelated client configuration remains untouched, and Workspace is
  not required. Bumped `agentctl` to 0.16.6.
- Corrected the navigation contract: `[` / `]` now move between top-level TUI
  sections (with Tab/Shift+Tab and Left/Right as aliases), while Up/Down move
  within the current list or Prompt preview. Switching away also clears an
  open Prompt preview. Updated every inline/help/doc hint and bumped
  `agentctl` to 0.16.5.
- Fixed a hydrated TUI snapshot regression where a successful Workspace index
  replaced the small `configured` connection record. The header could show
  `Online` while Provider `u` / `d` incorrectly claimed that no Workspace was
  connected. Hydration now preserves capability metadata, and the write guard
  also recognizes a validated live Workspace index. Bumped `agentctl` to
  0.16.4.
- Added profile-scoped Workspace reconciliation. In the Providers TUI, `u`
  now means the selected Local profile wins and `d` means its Workspace copy
  wins; only that profile and its referenced encrypted Secret values are
  upserted. The CLI exposes the same safe operation through
  `workspace agent push|pull --profile <name>`, preserving every unrelated
  Provider, failover/pricing catalog, generated config, and applied selection.
  Bumped `agentctl` to 0.16.3.
- Hardened background Workspace refreshes against transient network failures:
  one safe read retry is attempted, overlapping index refreshes are coalesced,
  and the TUI retains the last successful public Workspace index as
  `Cached · retrying` instead of collapsing a usable dashboard to `Offline`.
- Fixed OpenCode native credential discovery: `agentctl status` and the
  Provider catalog now surface provider/type metadata from OpenCode's local
  auth store without copying credentials into the agentctl Secret Store or
  exposing values. The TUI distinguishes native auth/current selection from
  an agentctl-applied Provider. Bumped `agentctl` to 0.16.2.
- Extended Provider schema 2 before publication with a distinct portable
  `context.window_tokens` / `context.auto_compact_tokens` policy. Claude Code
  renders these as `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and `autoCompactWindow`;
  exact model metadata now follows switches between DeepSeek V4 Pro/Flash,
  MiniMax M3, and MiniMax M2.7/M2.5 instead of inheriting a Provider-wide
  guess. Unknown or dynamically routed models retain client/user defaults.
- Added owner-only Claude context state so Provider switches and uninstall
  restore pre-agentctl values exactly. Externally changed managed values fail
  closed unless context replacement is explicitly forced.
- Upgraded portable Provider profiles and Stores to schema 2 with separate
  `compaction.upstream` capability and `compaction.policy` intent. The exact
  OpenAI and Anthropic built-ins declare their native APIs; migrated or custom
  third-party profiles default to `none/auto` until explicitly verified.
- Added a preview-first one-time `agentctl provider migrate schema` command.
  Loading an old encrypted Workspace remains safe in memory, while the next
  local/Workspace save emits schema 2. Provider Secret Stores remain schema 1
  because their format did not change.
- Made Codex's official OpenAI projection use the Provider display name it
  recognizes for native remote compaction. A forced-local policy avoids that
  gate, and TUI/CLI plans show the effective result rather than implying every
  Responses-compatible gateway supports compaction.
- Upgraded the loopback proxy config to schema 4 and conditionally allowlisted
  `/v1/responses/compact` only when every backend in the selected route has a
  native Responses compaction capability. Anthropic beta headers and
  `context_management` bodies continue through unchanged; no cross-protocol
  emulation was added.
- Added migration, renderer, native-route, Anthropic pass-through, proxy
  lifecycle, context ownership, and safe UI projection coverage.

## 2026-08-11 — unified Provider catalog and CCS migration

- Replaced the separate `agentctl providers <client>` preset view and public
  per-client setup flow with one target-aware `agentctl provider` catalog.
  Built-ins render without a local Store; `provider use` materializes the
  selection, imports an owner-only Secret file, installs/configures one client,
  and rolls back catalog, Secret, native config, and selection state together.
- Added built-in Anthropic API, OpenAI API, Gemini, DeepSeek, OpenRouter, and
  regional MiniMax profiles with per-client protocol/endpoints, model choices,
  and exact validation URLs. Custom profiles skip guessed validation endpoints.
- Added read-only CCS SQLite migration for Claude and Codex third-party
  Providers and API keys. Official Claude/ChatGPT OAuth identities are skipped
  and Secret values never enter output.
- Updated the TUI to consume resolved CLI rows directly, mark Built-in/Local/
  Workspace as `B/L/W`, show Needs-key guidance, and route Agents `c/p/Enter`
  into the same Providers section. Bumped `agentctl` to 0.15.0.
- Merged matching local and Workspace Provider rows into one local-first entry,
  added `L+W` backup and `L≠W` metadata-conflict states, and hid profiles that
  cannot serve the selected client by default with an explicit `i` reveal.

## 2026-08-11 — official-account switching and local-first dashboard

- Added a preview-first, owner-only Codex Account Store for saving multiple
  official ChatGPT logins under explicit local labels and atomically switching
  `auth.json` without changing the selected inference Provider or Model.
- Refresh the outgoing account snapshot before every switch and fail closed for
  unsafe, unmanaged, or unsaved live credentials. Status and TUI models expose
  labels and file-safety metadata only; OAuth tokens and account IDs never enter
  output, and account snapshots are not uploaded to Workspace.
- Added a dedicated Accounts TUI section with confirmed switch/delete actions.
  The initial dashboard snapshot now publishes all local state first, marks a
  configured Workspace as `Connecting…`, and hydrates cloud diagnostics and
  catalogs in the background without clearing usable local Provider profiles.

## 2026-08-11 — Codex Identity and Inference separation

- Split Codex diagnostics into an official ChatGPT Identity and an independent
  inference Provider/Model while retaining the previous flat Provider fields
  for command compatibility.
- Made every direct Codex Provider plan explicitly preserve the current
  official login. Provider apply, rollback, and managed-path discovery never
  include `~/.codex/auth.json`; integration tests verify its bytes and private
  mode remain unchanged. Apply also aborts and transactionally restores the
  file if a backend ever violates that read-only boundary.
- Updated Overview, Agents, and Providers views to show the active Identity and
  inference route separately. Provider profiles remain inference-only and do
  not bind or switch a ChatGPT account.

## 2026-08-11 — completed Toolbox Store cloud migration

- Copied and byte-verified every opaque R2 object into the product-neutral
  `toolbox-store` bucket, deployed the renamed Worker, updated all four local
  capabilities, and rewrote the encrypted Workspace attachments as schema 3.
- Removed the retired `mcp-store` Worker and bucket after recovery and Web UI
  verification, then removed the legacy Wrangler target and `MCP_STORE`
  runtime fallback.
- Standardized MCP remote requests on the same product-neutral Toolbox headers
  used by Skills, Prompts, and Workspace. The `mcpstore1_` prefix remains the
  current type marker for an independent logical MCP Store, not a deployment
  compatibility path.
- Bumped the standalone controller suite to `agentctl 0.13.0`; older MCP
  clients must update before writing to the migrated Toolbox Store.

## 2026-08-11 — product-neutral Toolbox Store defaults

- Renamed the shared Worker source directory from `workers/mcp-store` to
  `workers/toolbox-store` now that the service backs Providers, MCP, Skills,
  Prompts, Snippets, Presets, and the unified encrypted Workspace.
- Changed new deployments to the `toolbox-store` Worker, `toolbox-store` R2
  bucket, and `TOOLBOX_STORE` binding, including product-neutral endpoint
  examples and CI paths.
- Added `wrangler.mcp-store.jsonc` plus `dev:mcp-store` and
  `deploy:mcp-store` commands for no-migration upgrades of existing deployments.
  Legacy MCP recovery codes, request headers, compatibility identifiers, and
  the old R2 binding remain supported.

## 2026-08-11 — four-client Providers terminal control plane

- Added a dedicated Providers TUI section that combines local and encrypted
  Workspace catalogs with explicit `L/W` source markers and separately colored
  Claude Code, Codex, OpenCode, and Pi target badges.
- Added exact target/platform resolution, compatibility and Secret-presence
  status, requested/outbound model identity, device-local current selection,
  plus local failover, pricing, and proxy summaries without Secret values.
- Added read-only Provider plans, confirmed single-target apply, confirmed
  encrypted upload, and merge-safe download. Remote apply uses only the selected
  profile and required Secret in owner-only temporary files that are removed
  immediately after the controller returns.
- Assigned `[`/`]` to top-level section navigation (with Tab/Shift+Tab and
  Left/Right aliases), kept list movement on Up/Down, and replaced the uniform navigation color
  with distinct section, source, and four-client accents.

## 2026-08-11 — encrypted Provider Workspace and browser control plane

- Upgraded the encrypted Workspace manifest to schema 3 with an optional agent
  bundle for portable Provider/Secret Stores, failover routes, and versioned
  pricing while retaining schema 2 child attachments and development presets.
- Added preview-first `agentctl workspace agent status/push/pull`, merge-safe
  restore by default, explicit exact replacement, transactional owner-only
  local writes, and optimistic remote-version checks that reject stale writers.
- Kept Secret values hidden from all status/plan output and excluded generated
  client configuration, provider selection state, proxy capabilities, process
  state, logs, usage rows, and circuit counters from encrypted synchronization.
- Added a five-view Worker UI with a dedicated Providers surface, strict
  catalog validation, masked Secret editing, local schema 1/2 compatibility,
  encrypted saves, and concurrency protection. No deployment is automatic.
- Updated the terminal Workspace reader to accept schema 3 and expose only
  redacted Provider catalog metadata for the dedicated Providers control
  surface.

## 2026-08-11 — guarded provider failover and persistent circuits

- Added strict preview-first `agentctl failover` Stores for ordered 2–8
  Provider routes, bounded retry statuses, and Closed/Open/HalfOpen circuit
  policy. Routes are portable; counters and timers are device-local.
- Integrated multi-backend routes into the native loopback proxy while
  requiring one resolved protocol per target/platform and independent local
  Secret references per backend.
- Made `next_request` the safe default: a failed model POST is not replayed,
  while its persisted circuit influences later requests. Same-request replay
  requires an explicit policy and carries a duplicate-execution/billing warning.
- Persisted owner-only circuit state across daemon restarts, added bounded
  half-open probes and state expiry, and kept client disconnects neutral rather
  than treating them as upstream successes or failures.
- Added count- and age-bounded metadata/usage log retention plus integration
  tests for no-replay defaults, explicit replay, restart persistence, native
  model mapping on backup providers, and content/Secret-free observability.

## 2026-08-11 — exact model usage and versioned pricing

- Added the independent preview-first `agentctl pricing` catalog with exact
  model/profile/effective-time selection, mandatory source provenance, and
  scaled-BigInt decimal cost calculation. No stale vendor prices are bundled.
- Added exact native request model projection for Anthropic, OpenAI Responses,
  OpenAI Chat, and Google model routes. Requested, outbound, response, and
  priced model IDs remain distinct; substring guessing and all alias cycles
  fail closed.
- Added bounded JSON/SSE usage extraction with protocol-correct cache handling:
  OpenAI/Google cached input is separated from total input, while Anthropic
  input/cache-read/cache-creation classes remain independent.
- Added a separate owner-only usage/cost JSONL with catalog/rate provenance and
  response-model fallback reasons. Neither request/response content nor
  credentials enter request metadata, usage metadata, plans, or status output.
- Kept pricing optional: an absent catalog or exact active rate is recorded as
  unavailable and never blocks native proxy forwarding.

## 2026-08-11 — explicit loopback provider proxy

- Added the independent `agentproxyd` process and preview-first `agentctl proxy`
  plan/start/status/stop/token lifecycle. Opening agentctl never starts it and
  no client configuration is automatically taken over.
- Added native Anthropic Messages, OpenAI Responses, OpenAI Chat, and Google
  Generative pass-through with protocol route allowlists, endpoint-prefix
  preservation, and upstream authentication replacement.
- Enforced loopback-only binding and a hidden 256-bit local capability accepted
  through the common client auth headers. Upstream Secrets remain in the local
  owner-only Store and never enter daemon arguments or generated proxy config.
- Added separate first-byte, streaming-idle, and non-streaming total timeouts;
  streaming request-size enforcement; verified PID/instance shutdown; stale
  lock cleanup; and metadata-only bounded logs without bodies or headers.
- Added real detached-daemon integration tests for all four protocols,
  capability rejection, auth stripping, timeout and body-size failures,
  secret-free logs, lifecycle previews, clean shutdown, and token rotation.

## 2026-08-11 — native provider profile projection

- Added `agentctl provider plan/apply/current` renderers for Claude Code,
  Codex, OpenCode, and Pi. Direct protocol/auth compatibility is checked from
  explicit profile metadata instead of guessed from provider URLs.
- Reused each client's owned setup backend while passing Secret values through
  short-lived mode-`0600` files. Values never enter argv, environment variables,
  plans, selection state, or controller output.
- Added multi-target transaction snapshots and rollback for every exact managed
  config/state/key path. Applying a later target failure restores earlier
  targets and leaves selection state unchanged.
- Added `provider restore` to merge or replace one portable catalog and apply a
  selected profile in one guarded operation. Non-native overlays can be planned
  anywhere but can only be applied on their matching operating system.
- Added end-to-end native config tests for all four clients, cross-platform
  guards, Secret-free portable recovery, and failed-transaction rollback.

## 2026-08-11 — portable provider profiles

- Added a strict, preview-first `agentctl provider` Store for reusable OpenAI,
  Anthropic, and Google-compatible endpoints, explicit model aliases, per-agent
  target overrides, and whitelisted Darwin/Linux/Windows overlays.
- Split API-key values into a separate owner-only Secret Store. Status and
  normal exports expose reference names and presence only; plaintext portable
  exports can never include Secret values.
- Added deterministic base → target → platform resolution, alias-cycle
  rejection, HTTPS-by-default endpoint validation, atomic writes, safe import
  conflict handling, and standalone-runtime packaging.
- Added isolated tests proving that machine paths/runtime fields are rejected,
  Windows uses its native config root, unsafe Secret files fail closed, and
  portable exports remain secret-free.

## 2026-08-10 — managed Claude Code status line

- Added `agentctl statusline install/status/uninstall` with preview-first
  mutation, redacted JSON status, external-setting preservation, drift checks,
  and reversible owner-only state.
- Claude provider setup now installs the preset only when no external
  `statusLine` exists; `--no-statusline` keeps provider-only automation and
  provider uninstall leaves the independent preset intact.
- Added a Python renderer that consumes the current Claude payload, tails the
  supplied transcript once for proxy aliases/legacy fallback, and obtains
  branch, tracked-dirty, and divergence metadata with one bounded Git process.
- Moved `+/-` to Claude's session line counters, added an explicit dirty marker,
  forced `░` empty progress cells, removed obsolete output/regex handling and
  hard-coded project paths, and added standalone plus performance tests.

## 2026-08-04 — standalone controller runtime and self-update

- Replaced the default repository-backed PATH installation with a minimal
  standalone runtime under `~/.local/share/script-toolbox/agent`. The package
  contains only controller entrypoints, provider backends, shared modules,
  templates/adapters, and the built TUI; it excludes the rest of the toolbox,
  development dependencies, sources, tests, and Git metadata.
- Added `update` to `agentctl`, `mcpctl`, `promptctl`, and `skillsctl`. Every
  entrypoint checks or transactionally replaces the same shared suite so an
  update cannot leave controllers on mixed runtime revisions.
- Kept `install-commands.sh --link` as an explicit development mode, added
  migration from the previous v1 link manifest, and extended reversible
  uninstall to remove only a verified managed runtime while restoring tracked
  command or runtime conflicts.

## 2026-08-03 — unified Node 22 terminal dashboard

- Added one Ink 7 / React 19 TUI shared by `agentctl`, `mcpctl`, `skillsctl`,
  and `promptctl`, with Overview, Agents, MCP, Skills, Prompts, Presets, and
  Cloud views plus target switching and 30-second live refresh.
- Added remote-first Workspace catalogs for MCP Profiles, Skill Packs, Prompt
  profiles, and development Presets. Child Stores are fetched lazily, decrypted
  only in process memory, and projected into a secret-free UI model.
- Added read-only selection plans and confirmed, selective apply. Only the
  chosen selection and inherited dependencies enter a per-Workspace runtime;
  MCP Secret values remain encrypted outside the private controller adapter.
  The TUI no longer exposes a whole-catalog pull action.
- Added hidden interactive `toolbox1_` entry to `agentctl workspace restore`.
  `--recovery-file` remains available for non-interactive automation, while a
  non-TTY invocation without it fails without reading or exposing the code.
- Restored legacy schema 1 Workspace access through a non-mutating in-memory
  schema 2 conversion. Read-only restore/status/TUI access does not create a
  remote version. Added previewable `agentctl workspace migrate [--yes]` for an
  explicit immutable schema 2 version; Cloud error views retain the configured
  endpoint and Store ID.
- Made the Agents TUI view operational: select a client, inspect providers,
  enter the existing interactive setup/install flow with inherited terminal
  I/O, return automatically to the dashboard, or confirm an owned-config-only
  uninstall.
- Separated provider readiness from agentctl ownership in Agent status. Claude
  settings managed by tools such as CC Switch and Codex official ChatGPT/API-key
  authentication now appear as configured with an explicit source instead of
  being misreported as not configured.
- Corrected remote Skill digest verification to preserve the canonical
  depth-first snapshot order produced by `skillsctl`; large nested Skills such
  as `cloudflare` no longer fail after an incorrect global path re-sort.
- Made no-argument TTY launches open the dashboard while preserving legacy
  non-TTY behavior and the explicit `interactive` Shell guides.
- Standardized the repository-backed controller runtime on Node.js 22 and
  committed a self-contained production bundle so end users do not install npm
  packages. Added Linux/macOS build validation and Windows bundle/model tests.
- Reworked the Cloud empty state to distinguish local-only, incompatible,
  offline, unauthorized, and invalid-capability conditions. Known backend
  errors are translated into safe recovery guidance. Child Store version
  metadata invalidates stale in-memory catalogs without restoring them locally.

## 2026-08-02 — denser Toolbox Workspace UI

- Added a fourth Presets view that composes MCP profiles, Skills packs, and
  Prompt profiles, validates live child-Store references, and writes versioned
  encrypted Workspace updates. `agentctl preset push/pull` synchronizes the
  strict schema 2 catalog without exposing credentials or applying local files.
- Removed the repeated MCP, Skills, and Prompts title/summary banners from the
  unlocked Worker UI.
- Moved Versions and Lock beside the section tabs and tightened the surrounding
  vertical spacing so profiles, packs, and editors appear immediately.
- Kept unlocked recovery material in current-tab session storage so a refresh
  restores the latest encrypted Workspace automatically. Locking clears the
  stored code, failed restoration falls back safely, and unsaved edits now
  trigger a leave-page warning.
- Added target-local `skillsctl skill enable/disable` custom selections so an
  installed Skill can be hidden from one agent without changing its saved pack
  or canonical Store copy.
- Made `skillsctl import --write` safely adopt existing user-level Skills: the
  original target entries move to a manifested, recoverable backup before
  managed links replace them, with rollback on partial migration failure.

## 2026-08-01 — unified Toolbox Workspace and Prompt Store

- Added a `toolbox1_` master Workspace protocol and `agentctl workspace`
  commands for initialization, status, attach/detach, recovery, versions, and
  one-switch Web UI access across MCP, Skills, and Prompts.
- Preserved the existing isolated `mcpstore1_` and `skillstore1_` modes and
  added `promptstore1_`; attaching a Store never migrates or deletes its data,
  versions, local capability file, or isolated recovery route.
- Added Promptctl encrypted backup/restore for per-client editable Markdown,
  including conflict-safe local restoration and per-Store Web UI controls.
- Refactored the deployed Worker UI into a real three-tab Workspace with
  profile, pack, and Markdown editors, while retaining direct isolated-Store
  login, JSON import/export, and immutable version restore.
- Added Keenable anonymous/optional-key search plus Tavily keyless, API-key,
  and client-owned OAuth profiles. Tavily auth variants are mutually exclusive
  in both the guided CLI and Worker editor.
- Added masked MCP Secret editing to the real Worker UI. MCP JSON export now
  removes Secret values by default, and redacted imports preserve credentials
  already held in the encrypted browser snapshot.
- Extended Worker media-type allowlisting, browser/CLI crypto compatibility
  tests, and end-to-end Workspace tests for all four encrypted protocols.
- Expanded the reverse-engineering catalog with display-free PyGhidra,
  headless Playwright, GDB, Frida, Cutter/Rizin, and Windows x64dbg adapters.
  Added separate Debian Headless, Xvfb GUI, Android/Frida, and Windows VM
  profiles while keeping the existing narrow presets compatible.
- Added authenticated Anything Analyzer capture plus persistent, isolated, and
  CloakBrowser JS Reverse MCP variants. Documented the separate JADX, Apktool,
  ADB/apksigner, Frida, and Radare2 host CLI roles without inventing fake MCP
  endpoints.
- Added `mcpctl server doctor/install/uninstall/status/start/stop/restart` and
  target-aware `server enable/disable`. Supported npm/uv MCP packages now use
  isolated, ownership-marked installs with lazy-runner fallback and recoverable
  uninstall, while licensed, GUI, debugger, and system tools remain externally
  owned and detection-only.

## 2026-07-31 — portable skill packs and shared Toolbox Store

- Added `skillsctl` with a checksummed canonical store, safe skill adoption,
  inherited frontend/backend/fullstack packs, target-specific rules, and
  owned-link application across Codex, Claude Code, OpenCode, and Pi.
- Added guarded plaintext export/restore plus client-side encrypted backup,
  immutable versions, and one-code recovery through the existing Worker/R2
  deployment.
- Generalized the Worker into a backward-compatible Toolbox Store that keeps
  legacy MCP headers and data while accepting independent skills stores.
- Added a same-origin Web UI for local browser decryption, searching, sorting,
  pack/profile editing, JSON import/export, encrypted saves, and version
  restore.
- Added `skillsctl` to the reversible command installer and Docker sandbox
  `/usr/local/bin` command links.

## 2026-07-30 — interactive MCP selection and research presets

- Added a guided per-server MCP selector with repeatable toggles, a redacted
  plan, one-time overrides, and reusable target-specific child profiles.
- Added an interactive configuration center for remembered store/Secret/remote
  paths, redacted Secret status, SOPS editing and age-recipient setup, plus
  remote initialization, status, backup, and version actions.
- Missing required Secrets can now be entered without echo for one apply
  process; values are never written to preferences or printed by the plan.
- Added `mcpctl profile create` for the same saved-profile workflow in
  automation.
- Added `mcpctl sync` and a matching menu action to merge newly bundled
  servers and profiles into an older store without overwriting personal
  same-name entries.
- Expanded the starter catalog with GitHub, Playwright, CloakBrowser-backed
  DevTools and Playwright, Radare2, LLDB, Ghidra, JADX, Apktool, IDA/idalib,
  and the official Burp MCP bridge.
- Added narrow browser, native/Ghidra/Android/IDA reverse-engineering, coding,
  and web-reverse presets instead of one oversized research profile.
- Added repository-relative host adapters for CloakBrowser CDP, Ghidra,
  JADX/Apktool, and Burp, plus setup notes that remain outside generated client
  configuration.
- Added safe-by-default Claude/Codex user MCP import. Static environment,
  Header, and credential-argument values are replaced by Secret references and
  written directly to the AES-encrypted cache without plaintext staging.
- Added the target-aware importer-owned `imported` profile, redacted conflict
  plans, explicit `--write`/`--force` adoption, and idempotent repeated import.
- Claude profile application now uses the actual user MCP registry at
  `~/.claude.json`; Codex import delegates TOML parsing to
  `codex mcp list --json` and generated HTTP configuration uses the official
  `http_headers` table.

## 2026-07-29 — controller status and safe automation

- Added redacted `agentctl status <client|all>` output, including a JSON mode
  for CLI version, provider/model, ownership, config, and credential-file
  metadata.
- Added mutation-free `--dry-run` provider plans and private one-line
  `--key-file` input to the Claude Code, Codex, OpenCode, and Pi backends.
- Added a reversible `install-commands.sh` symlink installer for `agentctl`,
  `mcpctl`, and `promptctl`, with tracked conflict backups and guarded
  uninstall.
- Extracted the repository-backed controllers' menus and confirmations into
  `ctl-lib.sh` while leaving Raw URL setup backends independent.
- Added isolated tests for redaction, dry-run purity, key-file permissions,
  symlink recovery, and a macOS CI job that runs the agent suite with system
  Bash 3.2.

## 2026-07-29 — Promptctl persistent instructions

- Added `agentctl` as the no-extension Shell frontend for selecting Claude
  Code, Codex, OpenCode, or Pi and delegating provider/model setup.
- Added guided setup, provider listing, provider-only uninstall confirmation,
  client aliases, and explicit command passthrough while retaining every
  existing `setup.sh` as a compatibility backend.
- Added `promptctl` as the shared persistent-instruction manager for Claude
  Code and Codex.
- Added direct and Agent-guided entrypoints that share one filesystem layout,
  create user-editable Markdown once, and preserve it on reruns and default
  uninstall.
- Added no-argument Shell-guided menus to Promptctl and `mcpctl`; both preview
  planned writes and require a separate confirmation before applying.
- Kept Promptctl's Python module as a non-interactive configuration engine
  behind the public `promptctl` Shell entrypoint.
- Moved the imported advanced Claude and Codex deployers under
  `promptctl/advanced/` while preserving their upstream recovery identifiers.
- Kept Promptctl state independent from provider and MCP install/uninstall
  lifecycles.

## 2026-07-28 — task-oriented MCP profiles

- Added `mcpctl`, a separate profile manager that leaves every existing
  per-agent `mcp.sh` workflow unchanged.
- Added inherited profiles, target-specific enable/disable overrides, CLI
  overrides, redacted plans, safe switching, and adapters for Claude Code,
  Codex, and OpenCode.
- Added environment-first and SOPS-backed secret resolution. Encrypted values
  are resolved only for enabled servers; target configs are replaced
  atomically with mode `0600`.
- Added an optional opaque Worker/R2 backup service, AES-256-GCM client-side
  snapshots, one-code recovery, immutable versions, conditional latest-pointer
  updates, and a locally encrypted restored-secret cache.
- Store creation uses a separate removable bootstrap secret so a public Worker
  cannot be used anonymously to consume R2 storage. Existing stores continue
  after creation is disabled.
- Added ownership conflict protection, local applied-state tracking, starter
  profiles, and isolated tests covering all three targets plus a fresh-machine
  encrypted backup/restore simulation.

## 2026-07-26 — Chrome DevTools MCP

- Added the official local `chrome-devtools-mcp` server to the interactive and
  automated MCP flows for Claude Code, Codex, and OpenCode.
- MCP registries now distinguish keyless local STDIO servers from authenticated
  remote HTTP servers and serialize each agent's native local-server shape.
- Expanded isolated tests to cover Chrome DevTools configuration and uninstall.

## 2026-07-25 — failure-safe configuration updates

- JSON-based setup and MCP scripts now install `jq` automatically instead of
  failing after the client has already been installed.
- Configuration changes use validated, same-directory temporary files and
  stop without reporting success when a transform fails.
- OpenCode, Codex, and Pi keep the previous credential until the replacement
  configuration is ready; Pi stages both JSON files before replacing either.
- Codex MCP blocks now have explicit ownership boundaries. Refresh and
  uninstall preserve user-managed MCP tables.
- MCP scripts now open an interactive Brave/Exa/Context7 checklist when no
  provider flags are supplied, including when stdin is occupied by `curl`.
- Fixed Bash 3.2 handling when no CLI `--key` flags are supplied; each selected
  MCP can independently use its named flag, environment variable, prompt, or
  anonymous access where supported.
- Restored executable modes for all setup, MCP, and uninstall entry points.
- Expanded isolated tests for dependency installation, invalid-JSON rollback,
  MCP ownership, provider setup, and uninstall.

## 2026-07-25 — interactive multi-provider setup

- Replaced MiniMax-China defaults with protocol-aware interactive provider and
  model menus.
- Updated MiniMax China/global presets to the official `MiniMax-M3` default,
  retaining M2.7, M2.7 Highspeed, and M2.5 as fallback choices.
- Added current presets for Anthropic, OpenAI, Google Gemini, DeepSeek,
  OpenRouter, and MiniMax China/global, plus custom URL/key/model flows.
- Added `setup-lib.sh` so local and `curl | bash` installs share TTY-safe
  prompts, Node installation, validation, and secret-file handling.
- Codex now emits Responses-only provider blocks, matching the current Codex
  configuration schema; the obsolete `wire_api = "chat"` path was removed.
- OpenCode now writes the current global `opencode.json` filename and migrates
  the previous `config.json` once.
- Added a Pi kit for the current `@earendil-works/pi-coding-agent`, including
  Pi-native provider adapters and mode-`0600` command-backed credentials.
- Fixed Bash 3.2-incompatible `${value,,}` usage in all MCP scripts.

## 2026-07-20 — `codex/` and `opencode/` agents added

- `agent/codex/` — OpenAI Codex CLI installer.
  - `setup.sh` writes `~/.codex/config.toml` with `[model_providers.minimax]`
    (`wire_api = "chat"`) + `[profiles.minimax]`. Scrubs `OPENAI_API_KEY`.
  - `mcp.sh` writes the MCP pack into `[mcp_servers.*]` tables (Codex's MCP
    shape, TOML).
  - Uninstaller is awk-based because config.toml is TOML, not JSON.
- `agent/opencode/` — OpenCode installer.
  - `setup.sh` writes `~/.config/opencode/config.json` with
    `provider.anthropic.options.baseURL` overridden to MiniMax. Scrubs
    `ANTHROPIC_*` / `OPENAI_API_KEY`.
  - `mcp.sh` writes the MCP pack into the `mcp.<name>` block.
- agent/README.md updated with the two new agents.
- root README.md updated with the two new agents.

## 2026-07-20 — `agent/` folder created

- New top-level folder hosting per-agent bash installers.
- Established convention (see `README.md`) for future agents: every agent
  ships `setup.sh` + `mcp.sh` + `uninstall.sh` + `README.md` + `CHANGELOG.md`.
- First agent: [`claude-code/`](./claude-code/README.md).
- Added `test.sh` — `bash -n` walker for every `*.sh` under `agent/`.
