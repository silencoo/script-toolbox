# Changelog — agent/

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
