# Changelog — claude-code (agent)

## 2026-07-25 — reliable JSON updates

- Missing `jq` is installed automatically on supported package managers.
- Setup and MCP updates validate the existing JSON and atomically replace it;
  failed transforms leave the original settings untouched.
- Running `mcp.sh` without provider flags now opens an interactive MCP
  checklist, while named environment keys work without any CLI `--key` flag
  on Bash 3.2.

## 2026-07-25 — provider and model menus

- Added Anthropic, DeepSeek, OpenRouter, MiniMax China/global, and custom
  Anthropic-compatible providers.
- Added interactive current-model menus and `--provider`, `--base-url`,
  `--models-url`, `--key-env`, `--auth-mode`, and `--list-providers`.
- Updated MiniMax to the official `MiniMax-M3` default while retaining the
  M2.7 family as fallback choices, and updated DeepSeek to V4 Pro/Flash.
- Setup prompts now use `/dev/tty`, including one-shot `curl | bash` installs.
- Settings now retain exactly one Claude credential type; bearer providers no
  longer leave an empty `ANTHROPIC_API_KEY` beside `ANTHROPIC_AUTH_TOKEN`.
- Interactive setup can back up and clean conflicting shell exports, while
  automation can opt in explicitly with `--clean-shell-env`.
- The Docker sandbox zsh kit now completes and suggests
  `claude --dangerously-skip-permissions` without making bypass mode the
  default.

## 2026-07-20 — install strategy switched to native + npm fallback

- Claude Code install: try `curl -fsSL https://claude.ai/install.sh | bash`
  first (Anthropic's current recommendation); fall back to
  `npm install -g @anthropic-ai/claude-code` if the native path fails
  (network-blocked or sandboxed environments).
- Node.js install: still happens, but only as a prerequisite for the npm
  fallback. Wording adjusted so it's clear the native Claude Code binary
  itself does not require Node.js.
- Header comment and CHANGELOG updated accordingly.

## 2026-07-20 — initial migration into `agent/claude-code/`

- Moved `setup-minimax-claude.sh` → `setup.sh`. Header comment updated to
  `agent/claude-code/setup.sh — …`. Inlined the shared color/log helpers
  (no shared lib, per repo convention).
- Moved `setup-minimax-mcp.sh` → `mcp.sh`. Header updated to
  `agent/claude-code/mcp.sh — …`. **The `MANAGED_BY` marker in
  `~/.claude/settings.json` is now `agent/claude-code/mcp.sh`** — existing
  users will see their previous MCP entries marked as managed by the old
  string, but `mcp.sh --uninstall` only strips the new marker, so re-running
  the script with the same intent updates headers cleanly. To clean up the
  old marker, run `./mcp.sh` once (it merges without changing anything visible).
- Default model changed from `MiniMax-M2.5` → `MiniMax-M3`.
- Bash 3.2 (macOS `/bin/bash`) compatible — no associative arrays.
- Added `uninstall.sh` (new dispatcher) and this CHANGELOG + README.
