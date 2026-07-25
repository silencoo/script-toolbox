# OpenCode setup

Installs OpenCode and configures a mainstream or custom provider:

| Provider | Default model | Other menu choices |
|---|---|---|
| Anthropic | `claude-sonnet-4-6` | Opus 4.8, Fable 5 |
| OpenAI | `gpt-5.6` | Terra, Luna |
| Google Gemini | `gemini-3.6-flash` | 3.1 Pro Preview, 3.5 Flash-Lite |
| DeepSeek | `deepseek-v4-pro` | V4 Flash |
| OpenRouter | `openai/gpt-5.6` | Claude Sonnet 4.6, Auto |
| MiniMax China/global | `MiniMax-M2.7` | M2.7 highspeed, M2.5 |
| Custom | user supplied | Chat Completions, Responses, or Anthropic |

The current global configuration path is
`~/.config/opencode/opencode.json`. If the previous script created
`config.json`, setup and MCP scripts copy it to the current path once.

Each setup preset is registered as a script-toolbox-owned custom provider, so
uninstalling it cannot delete a user's built-in provider configuration. The API
key is stored separately under `~/.config/opencode/provider-keys/` with mode
`0600` and referenced through OpenCode's `{file:...}` syntax.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/silencoo/script-toolbox/main/agent/opencode/setup.sh | bash
curl -fsSL https://raw.githubusercontent.com/silencoo/script-toolbox/main/agent/opencode/mcp.sh | bash
```

Or from a clone:

```bash
cd agent/opencode
./setup.sh
./mcp.sh
```

No separate `opencode auth login` step is needed for keys configured by this
script.

## Automation and custom providers

```bash
./setup.sh --list-providers

GEMINI_API_KEY=... \
  ./setup.sh --provider google --model gemini-3.6-flash

DEEPSEEK_API_KEY=... \
  ./setup.sh --provider deepseek --model deepseek-v4-pro

./setup.sh --provider custom --protocol chat \
  --base-url https://gateway.example.com/v1 \
  --model my-model --key-env MY_API_KEY

./setup.sh --provider custom --protocol anthropic \
  --base-url https://gateway.example.com/anthropic/v1 \
  --model my-model --key custom-secret
```

`--region china|global` remains a MiniMax compatibility shortcut. Use
`--skip-validate` for a custom gateway without a models endpoint.

## MCP and uninstall

```bash
./mcp.sh
./uninstall.sh

# Or remove only one part:
./setup.sh --uninstall
./mcp.sh --uninstall
```

Use `/models` in OpenCode to switch away from the configured default.
