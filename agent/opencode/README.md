# OpenCode setup

Installs OpenCode and configures a mainstream or custom provider:

| Provider | Default model | Other menu choices |
|---|---|---|
| Anthropic | `claude-sonnet-4-6` | Opus 4.8, Fable 5 |
| OpenAI | `gpt-5.6` | Terra, Luna |
| Google Gemini | `gemini-3.6-flash` | 3.1 Pro Preview, 3.5 Flash-Lite |
| DeepSeek | `deepseek-v4-pro` | V4 Flash |
| OpenRouter | `openai/gpt-5.6` | Claude Sonnet 4.6, Auto |
| MiniMax China/global | `MiniMax-M3` | M2.7, M2.7 highspeed, M2.5 |
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

From a clone, use the shared controller from the repository root:

```bash
./agent/agentctl/agentctl setup opencode
./agent/opencode/mcp.sh
```

The Raw URL above and `agent/opencode/setup.sh` remain supported compatibility
entrypoints.

No separate `opencode auth login` step is needed for keys configured by this
script.

## Automation and custom providers

```bash
./agent/agentctl/agentctl providers opencode

GEMINI_API_KEY=... \
  ./agent/agentctl/agentctl setup opencode \
    --provider google --model gemini-3.6-flash

DEEPSEEK_API_KEY=... \
  ./agent/agentctl/agentctl setup opencode \
    --provider deepseek --model deepseek-v4-pro

./agent/agentctl/agentctl setup opencode \
  --provider custom --protocol chat \
  --base-url https://gateway.example.com/v1 \
  --model my-model --key-env MY_API_KEY

./agent/agentctl/agentctl setup opencode \
  --provider custom --protocol anthropic \
  --base-url https://gateway.example.com/anthropic/v1 \
  --model my-model --key custom-secret
```

`--region china|global` remains a MiniMax compatibility shortcut. Use
`--skip-validate` for a custom gateway without a models endpoint.

## MCP and uninstall

The interactive MCP menu offers Brave Search, Exa, Context7, GitHub, and Chrome
DevTools. Chrome DevTools uses OpenCode's local MCP transport and passes
CloakBrowser's Chromium path to
`npx -y chrome-devtools-mcp@latest --executablePath ...`. The first setup can
download roughly 200 MB. Set `CLOAKBROWSER_BINARY_PATH`, pass
`--cloakbrowser-executable PATH`, or use `--stock-chrome` to opt out.

GitHub uses the hosted `https://api.githubcopilot.com/mcp/` endpoint. Its
header expands `{env:GITHUB_PERSONAL_ACCESS_TOKEN}` when OpenCode starts, with
OAuth disabled for the PAT connection; the PAT is not written into
`opencode.json`.

```bash
./agent/opencode/mcp.sh
./agent/opencode/mcp.sh --provider chrome-devtools
GITHUB_PERSONAL_ACCESS_TOKEN=github_pat... \
  ./agent/opencode/mcp.sh --provider github --provider chrome-devtools
./agent/opencode/uninstall.sh

# Or remove only one part:
./agent/agentctl/agentctl uninstall opencode
./agent/opencode/mcp.sh --uninstall
```

Use `/models` in OpenCode to switch away from the configured default.
