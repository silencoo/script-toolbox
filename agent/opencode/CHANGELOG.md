# Changelog — opencode (agent)

## 2026-07-25 — failure-safe configuration updates

- Missing `jq` is installed automatically on supported package managers.
- Provider credentials are rotated only after a valid replacement config is
  ready, and setup/MCP transforms atomically replace `opencode.json`.
- Restored executable modes for the MCP and uninstall entry points.

## 2026-07-25 — mainstream and custom providers

- Added Anthropic, OpenAI, Google Gemini, DeepSeek, OpenRouter, MiniMax
  China/global, and custom Chat/Responses/Anthropic provider menus.
- Added current model presets and a custom model-ID entry for every provider.
- Moved the global config to the current `~/.config/opencode/opencode.json`
  path, with one-time migration from the old `config.json`.
- Keys now live in mode-`0600` files referenced with `{file:...}`; setup-owned
  providers use unique IDs so uninstall does not delete built-in settings.

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
