# codex (agent)

Install OpenAI Codex CLI and route it through **MiniMax** in China. Adds the
web/docs MCP servers Codex needs to keep Claude-class capabilities when it's
not talking to OpenAI directly.

## What this gives you

1. Codex CLI installed via `npm install -g @openai/codex`.
2. `~/.codex/config.toml` configured with a `[model_providers.minimax]`
   provider block and a `[profiles.minimax]` profile pointing at
   `MiniMax-M3` (configurable).
3. The same Brave / Exa / Context7 MCP pack as `claude-code`, written into
   the `[mcp_servers.*]` tables of `config.toml`.
4. A scrubber for stale `OPENAI_API_KEY` exports in `~/.zshrc` / `~/.bashrc`
   that would override `config.toml`.

## Why `wire_api = "chat"` matters

Codex CLI **defaults to the OpenAI Responses API** (`/v1/responses`), which
MiniMax does not implement. The provider block sets `wire_api = "chat"`
to force Codex to use `/v1/chat/completions`, which MiniMax does support.
Removing it will break Codex.

If MiniMax later adds a Responses-compatible endpoint, bump this default
and add a separate provider block for it.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/silencoo/script/main/agent/codex/setup.sh | bash
curl -fsSL https://raw.githubusercontent.com/silencoo/script/main/agent/codex/mcp.sh | bash
```

Or clone and run locally:

```bash
git clone https://github.com/silencoo/script.git
cd script/agent/codex
./setup.sh
./mcp.sh
```

## Files

| File | Purpose |
|---|---|
| [`setup.sh`](./setup.sh) | Install Node + Codex, write `config.toml`, validate against `/v1/models`, scrub `OPENAI_API_KEY`. |
| [`mcp.sh`](./mcp.sh) | Add Brave / Exa / Context7 as `[mcp_servers.*]` blocks in `config.toml`. |
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
./uninstall.sh                # removes provider/profile + MCP entries
./setup.sh --uninstall        # or just the provider/profile piece
./mcp.sh   --uninstall        # or just the MCP piece
```

## Notes / caveats

- **Region.** `--region china` (default) hits `api.minimaxi.com`. Use
  `--region global` for international accounts (`api.minimax.io`).
- **Key type.** Pay-as-You-Go key from
  [platform.minimaxi.com](https://platform.minimaxi.com) (China) or
  [platform.minimax.io](https://platform.minimax.io) (international).
  Token Plan / subscription keys silently 401 in coding tools.
- **Model id is case-sensitive.** `MiniMax-M3` exactly.
- **`OPENAI_API_KEY` overrides config.toml.** If you previously ran
  `codex /login`, your shell rc may contain an `OPENAI_API_KEY=…` export.
  `setup.sh` offers to scrub those lines.

## Requirements

- `bash` 4+, `curl`, `jq`
- `sudo` on Linux (only if Node.js needs installing)
- macOS users: Homebrew (only if Node.js needs installing)

## Provenance

Provider block shape lifted from
[MiniMax's own Codex docs](https://platform.minimax.io/docs/token-plan/codex-cli)
with `wire_api = "chat"` made explicit.