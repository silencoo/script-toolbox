# Changelog — opencode (agent)

## 2026-07-28 — CloakBrowser and GitHub MCP

- Chrome DevTools now resolves CloakBrowser's platform Chromium binary and
  passes it through `--executablePath`; `--stock-chrome` retains the previous
  discovery behavior.
- Added the hosted GitHub MCP provider with OpenCode's
  `{env:GITHUB_PERSONAL_ACCESS_TOKEN}` interpolation and PAT-mode OAuth
  disabled.
- Remote MCP entries now use OpenCode's documented `type: "remote"`.

## 2026-07-26 — Chrome DevTools MCP

- Added keyless Chrome DevTools to the interactive MCP checklist,
  `--provider chrome-devtools`, and `--all`.
- The generated entry uses OpenCode's native `type: "local"` command-array
  configuration.

## 2026-07-25 — failure-safe configuration updates

- Missing `jq` is installed automatically on supported package managers.
- Provider credentials are rotated only after a valid replacement config is
  ready, and setup/MCP transforms atomically replace `opencode.json`.
- Running `mcp.sh` without provider flags now opens an interactive MCP
  checklist, while named environment keys work without any CLI `--key` flag
  on Bash 3.2.
- Restored executable modes for the MCP and uninstall entry points.

## 2026-07-25 — mainstream and custom providers

- Added Anthropic, OpenAI, Google Gemini, DeepSeek, OpenRouter, MiniMax
  China/global, and custom Chat/Responses/Anthropic provider menus.
- Added current model presets and a custom model-ID entry for every provider.
- MiniMax China/global now default to the official `MiniMax-M3`, with M2.7,
  M2.7 Highspeed, and M2.5 retained as fallback choices.
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
