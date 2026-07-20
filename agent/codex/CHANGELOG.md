# Changelog — codex (agent)

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