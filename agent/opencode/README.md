# opencode (agent)

Install OpenCode and route it through **MiniMax** in China. Adds the web/docs
MCP servers OpenCode needs to keep Claude-class capabilities when it's not
talking to Anthropic directly.

## What this gives you

1. OpenCode installed via `npm install -g opencode-ai`.
2. `~/.config/opencode/config.json` with `provider.anthropic.options.baseURL`
   overridden to MiniMax's Anthropic-compatible endpoint.
3. The same Brave / Exa / Context7 MCP pack as `claude-code`, written into
   the `mcp.<name>` block of `config.json`.
4. A scrubber for stale `ANTHROPIC_*` / `OPENAI_API_KEY` exports in
   `~/.zshrc` / `~/.bashrc` that would override `config.json`.

## Why `provider.anthropic.options.baseURL` instead of a new provider

OpenCode ships with a built-in Anthropic provider. The cleanest way to
point it at MiniMax is to override the `baseURL` of the existing
`anthropic` provider, rather than registering a new one. That way OpenCode's
native Anthropic tooling (tool use, streaming, thinking blocks) keeps
working unchanged — only the host changes.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/silencoo/script-toolbox/main/agent/opencode/setup.sh | bash
curl -fsSL https://raw.githubusercontent.com/silencoo/script-toolbox/main/agent/opencode/mcp.sh | bash
```

Or clone and run locally:

```bash
git clone https://github.com/silencoo/script-toolbox.git
cd script/agent/opencode
./setup.sh
./mcp.sh
```

## Files

| File | Purpose |
|---|---|
| [`setup.sh`](./setup.sh) | Install Node + OpenCode, write `config.json`, validate against `/v1/models`, scrub env exports. |
| [`mcp.sh`](./mcp.sh) | Add Brave / Exa / Context7 as `mcp.<name>` entries in `config.json`. |
| [`uninstall.sh`](./uninstall.sh) | Run both `--uninstall` paths and print manual cleanup hints. |
| [`CHANGELOG.md`](./CHANGELOG.md) | Per-agent changelog. |

## Usage

### `setup.sh`

```bash
# Interactive
./setup.sh

# Non-interactive
MINIMAX_API_KEY=sk-... ./setup.sh

# International account
./setup.sh --region global --model MiniMax-M3

# Skip the /v1/models probe
./setup.sh --skip-validate
```

After `setup.sh` runs, **authenticate OpenCode once**:

```bash
opencode auth login   # pick "Anthropic" - base URL is already overridden
```

### `mcp.sh`

```bash
# Interactive
./mcp.sh

# All three providers, keys supplied via flags
./mcp.sh --all \
  --key brave=BSA... --key exa=EXA... --key context7=CT7...

# Just brave + exa, keys from env
BRAVE_API_KEY=BSA... EXA_API_KEY=EXA... \
  ./mcp.sh --provider brave --provider exa

# Preview without writing
./mcp.sh --dry-run
```

## Uninstall

```bash
./uninstall.sh                # removes provider + MCP entries
./setup.sh --uninstall        # or just the provider piece
./mcp.sh   --uninstall        # or just the MCP piece
```

## Notes / caveats

- **Region.** `--region china` (default) hits `api.minimaxi.com`. Use
  `--region global` for international accounts (`api.minimax.io`).
- **Key type.** Pay-as-You-Go key from
  [platform.minimaxi.com](https://platform.minimaxi.com) (China) or
  [platform.minimax.io](https://platform.minimax.io) (international).
- **Model id is case-sensitive.** `MiniMax-M3` exactly.
- **Auth is two-step.** `setup.sh` writes the base URL into `config.json`
  but OpenCode still needs `opencode auth login` to store the API key in
  `~/.local/share/opencode/auth.json`. The script does this automatically
  if `MINIMAX_API_KEY` is in the env; otherwise it prints the instruction.

## Requirements

- `bash` 4+, `curl`, `jq`
- `sudo` on Linux (only if Node.js needs installing)
- macOS users: Homebrew (only if Node.js needs installing)
