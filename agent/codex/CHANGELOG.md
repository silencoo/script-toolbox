# Changelog — codex (agent)

## 2026-07-25 — ownership-safe updates

- Setup stages the complete TOML update before rotating credentials.
- MCP refresh and uninstall now remove only explicitly marked script-owned
  blocks, preserving user-managed MCP tables and unrelated section headers.
- Restored executable modes for the MCP and uninstall entry points.

## 2026-07-25 — Responses-compatible provider setup

- Replaced the obsolete MiniMax Chat Completions block with OpenAI,
  OpenRouter, and custom Responses-compatible provider choices.
- Added GPT-5.6 family presets and custom URL/key/model input.
- Credentials now live in a separate mode-`0600` file and are supplied through
  Codex's command-backed provider authentication.
- Setup-owned TOML is bounded by explicit markers and legacy MiniMax blocks
  are migrated on the next run.

## 2026-07-20 — initial agent

- `setup.sh` installs Node.js 18+ and `@openai/codex`, validates the API key
  against `/v1/models`, writes `~/.codex/config.toml` with a
  `[model_providers.minimax]` block (`wire_api = "chat"`) and a
  `[profiles.minimax]` block pointing at `MiniMax-M3`.
- `mcp.sh` writes the same Brave / Exa / Context7 pack as `claude-code`,
  but into `[mcp_servers.*]` tables of `config.toml` (Codex's MCP shape).
- `uninstall.sh` runs both `--uninstall` paths.
- `--uninstall` is awk-based (TOML, not JSON), strips only this script's
  blocks via the `agent/codex/{setup,mcp}.sh` markers. Anything else in
  `config.toml` is preserved.
- Scrubs stale `OPENAI_API_KEY` exports from `~/.zshrc` / `~/.bashrc`.
- Bash 3.2 (macOS `/bin/bash`) compatible — no associative arrays.
