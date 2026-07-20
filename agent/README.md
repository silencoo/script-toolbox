# agent/

Setup scripts for AI coding agents that lose built-in tools when routed
through third-party providers (e.g. Claude Code's `WebSearch` / `WebFetch`
no-ops when you point it at MiniMax instead of Anthropic).

Each subfolder is a self-contained agent:

- [`claude-code/`](./claude-code/README.md) — Claude Code + MiniMax (China) + web/docs MCP servers.
- [`codex/`](./codex/README.md) — OpenAI Codex CLI + MiniMax (China) + web/docs MCP servers.
- [`opencode/`](./opencode/README.md) — OpenCode + MiniMax (China) + web/docs MCP servers.

## Per-agent kit

Every agent folder ships the same surface area so future agents (codex, opencode, gemini, …) drop in without inventing new conventions:

| File | Required | Purpose |
|---|---|---|
| `setup.sh`     | yes | Install the agent's binary, write its settings, validate against the upstream model listing. |
| `mcp.sh`       | yes | Add web/docs MCP servers that restore the agent's lost built-in tools. |
| `uninstall.sh` | yes | Run both `--uninstall` paths and print manual cleanup hints. |
| `README.md`    | yes | One-paragraph purpose, install, usage, uninstall, caveats. |
| `CHANGELOG.md` | yes | Per-agent changelog. |

## Verifying

```bash
# Run all agents' syntax check (mirrors the spirit of the repo's JS CI).
./test.sh

# Or just one agent.
bash -n claude-code/setup.sh
bash -n claude-code/mcp.sh
bash -n claude-code/uninstall.sh
```

## Adding a new agent

1. Create `agent/<your-agent>/` with the five files above.
2. Header comment of each script starts with the path: `# agent/<your-agent>/<script>.sh — …`.
3. Use a `_managed_by: "<full script path>"` marker for any state you write
   into `~/.<agent>/` so `--uninstall` only strips your own entries.
4. Inline your helpers — there is no shared lib, by convention.
5. Add the agent to the bullet list at the top of this file.
6. Run `./test.sh` before pushing.