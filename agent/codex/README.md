# Codex CLI setup

Installs OpenAI Codex CLI and configures one of these Responses-compatible
providers:

| Provider | Default model | Other menu choices |
|---|---|---|
| OpenAI | `gpt-5.6` | `gpt-5.6-terra`, `gpt-5.6-luna` |
| OpenRouter | `openai/gpt-5.6` | `openrouter/auto`, custom model ID |
| Custom | user supplied | any Responses-compatible model |

Current Codex supports only `wire_api = "responses"` for custom providers.
The old script's `wire_api = "chat"` MiniMax configuration is no longer valid,
so Chat-Completions-only providers are intentionally absent instead of being
offered as broken presets.

Credentials are stored under `~/.codex/provider-keys/` with mode `0600`.
`config.toml` uses Codex's command-backed provider auth to read that file; it
does not require a permanent shell export and does not place the key directly
in TOML.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/silencoo/script-toolbox/main/agent/codex/setup.sh | bash
curl -fsSL https://raw.githubusercontent.com/silencoo/script-toolbox/main/agent/codex/mcp.sh | bash
```

Or from a clone:

```bash
cd agent/codex
./setup.sh
./mcp.sh
```

## Automation and custom providers

```bash
./setup.sh --list-providers

OPENAI_API_KEY=sk-... \
  ./setup.sh --provider openai --model gpt-5.6

OPENROUTER_API_KEY=sk-or-... \
  ./setup.sh --provider openrouter --model openai/gpt-5.6

./setup.sh --provider custom \
  --base-url https://gateway.example.com/v1 \
  --models-url https://gateway.example.com/v1/models \
  --model my-model --key-env MY_API_KEY
```

After setup:

```bash
codex --profile script_toolbox
```

Use `--skip-validate` for gateways without a models endpoint.

## MCP and uninstall

```bash
./mcp.sh
./uninstall.sh

# Or remove only one part:
./setup.sh --uninstall
./mcp.sh --uninstall
```

The setup block is bounded by explicit markers, so unrelated `config.toml`
settings and MCP entries are preserved.
