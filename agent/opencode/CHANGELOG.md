# Changelog — opencode (agent)

## 2026-07-20 — initial agent

- `setup.sh` installs Node.js 18+ and `opencode-ai`, validates the API key
  against `/v1/models`, writes `~/.config/opencode/config.json` with
  `provider.anthropic.options.baseURL` overridden to MiniMax's
  Anthropic-compatible endpoint.
- `mcp.sh` writes the same Brave / Exa / Context7 pack as `claude-code`,
  but under `mcp.<name>` (OpenCode's MCP shape) instead of `mcpServers`.
- `uninstall.sh` runs both `--uninstall` paths.
- `--uninstall` is jq-based, strips only this script's blocks via the
  `_managed_by` markers. Anything else in `config.json` is preserved.
- Scrubs stale `ANTHROPIC_*` / `OPENAI_API_KEY` exports from
  `~/.zshrc` / `~/.bashrc`.
- Bash 3.2 (macOS `/bin/bash`) compatible — no associative arrays.