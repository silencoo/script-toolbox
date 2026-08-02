# Changelog — agent/

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
