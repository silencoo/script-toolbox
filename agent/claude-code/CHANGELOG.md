# Changelog — claude-code (agent)

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