# Changelog — agent/

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