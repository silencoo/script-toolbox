# claude-code (agent)

Two bash scripts that route Claude Code through **MiniMax** in China and add the
web/docs MCP servers it loses when bypassing Anthropic's hosted tools.

## What this gives you

1. Claude Code installed — tries Anthropic's native installer first
   (`curl https://claude.ai/install.sh | bash`); falls back to
   `npm install -g @anthropic-ai/claude-code` if the native path fails
   (sandboxed / network-blocked environments).
2. `~/.claude/settings.json` pointed at `https://api.minimaxi.com/anthropic`
   with model `MiniMax-M3` (configurable).
3. Web search via Brave, semantic search via Exa, live library docs via
   Context7 — all as remote MCP servers.
4. A scrubber for stale `ANTHROPIC_*` exports in `~/.zshrc` / `~/.bashrc`
   that would otherwise silently override `settings.json`.

## Install

One shot from anywhere on Linux or macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/silencoo/script/main/agent/claude-code/setup.sh | bash
```

Then add the MCP pack (interactive — will prompt for which providers you want
and for their API keys):

```bash
curl -fsSL https://raw.githubusercontent.com/silencoo/script/main/agent/claude-code/mcp.sh | bash
```

Or clone the repo and run them locally:

```bash
git clone https://github.com/silencoo/script.git
cd script/agent/claude-code
./setup.sh
./mcp.sh
```

## Files

| File | Purpose |
|---|---|
| [`setup.sh`](./setup.sh) | Install Node + Claude Code, point at MiniMax, scrub stale exports. |
| [`mcp.sh`](./mcp.sh) | Add Brave / Exa / Context7 as remote MCP servers. |
| [`uninstall.sh`](./uninstall.sh) | Run both `--uninstall` paths and print manual cleanup hints. |
| [`CHANGELOG.md`](./CHANGELOG.md) | Per-agent changelog. |

## Usage

### `setup.sh`

```bash
# Interactive - prompts for the API key
./setup.sh

# Non-interactive
MINIMAX_API_KEY=sk-... ./setup.sh

# International account + a specific model
./setup.sh --region global --model MiniMax-M3

# Skip the /v1/models probe (offline / sandboxed)
./setup.sh --skip-validate
```

### `mcp.sh`

```bash
# Interactive - prompts for which providers + their keys
./mcp.sh

# All three providers, keys supplied via flags
./mcp.sh --all \
  --key brave=BSA... --key exa=EXA... --key context7=CT7...

# Just brave + exa, keys from env
BRAVE_API_KEY=BSA... EXA_API_KEY=EXA... \
  ./mcp.sh --provider brave --provider exa

# Preview the would-be JSON without writing
./mcp.sh --dry-run
```

## Uninstall

```bash
./uninstall.sh                # removes env + MCP entries, prints hints
./setup.sh --uninstall        # or just the env/model piece
./mcp.sh   --uninstall        # or just the MCP piece
```

## Notes / caveats

- **Region.** `--region china` (default) hits `api.minimaxi.com`. Use
  `--region global` for international accounts (`api.minimax.io`).
- **Key type.** Use a **Pay-as-You-Go** key from
  [platform.minimaxi.com](https://platform.minimaxi.com) (China) or
  [platform.minimax.io](https://platform.minimax.io) (international). Token Plan
  / subscription keys silently 401 in coding tools.
- **Model id is case-sensitive.** `MiniMax-M3` exactly. Other valid ids as of
  this writing: `MiniMax-M2.7`, `MiniMax-M2.5`. Use `--model` to pick one.
- **Stale exports.** If `~/.zshrc` or `~/.bashrc` still contains
  `export ANTHROPIC_API_KEY=…` from a previous `claude /login`, Claude Code
  warns `Both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY set · auth may not
  work as expected`. `setup.sh` offers to scrub those lines (with a `.bak`
  backup); re-running it is the fix.

## Requirements

- `bash` 4+, `curl`, `jq`
- `sudo` on Linux (only if Node.js needs installing)
- macOS users: Homebrew (only if Node.js needs installing)