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

From a clone, use the shared controller from the repository root:

```bash
./agent/agentctl/agentctl setup codex
./agent/codex/mcp.sh
```

The Raw URL above and `agent/codex/setup.sh` remain supported compatibility
entrypoints.

## Automation and custom providers

```bash
./agent/agentctl/agentctl providers codex

OPENAI_API_KEY=sk-... \
  ./agent/agentctl/agentctl setup codex \
    --provider openai --model gpt-5.6

OPENROUTER_API_KEY=sk-or-... \
  ./agent/agentctl/agentctl setup codex \
    --provider openrouter --model openai/gpt-5.6

./agent/agentctl/agentctl setup codex --provider custom \
  --base-url https://gateway.example.com/v1 \
  --models-url https://gateway.example.com/v1/models \
  --model my-model --key-env MY_API_KEY
```

After setup:

```bash
codex --profile script_toolbox
```

Use `--skip-validate` for gateways without a models endpoint.

## Persistent instructions

Codex instruction-file deployment is managed by Promptctl under `agent/`,
independently from provider and MCP state. For a clean machine or sandbox,
create a lightweight config block and an editable user-owned Markdown file:

```bash
# Omit arguments for the guided menu, then choose Codex.
./agent/promptctl/promptctl

# Equivalent explicit workflow:
./agent/promptctl/promptctl install codex
./agent/promptctl/promptctl install codex --yes
./agent/promptctl/promptctl path codex
```

An agent can follow
[`../promptctl/AGENT_SETUP.md`](../promptctl/AGENT_SETUP.md) instead; it calls
the same Shell entrypoint and produces the same layout.

For fixed-source deployment, migration, hook isolation, recovery, or layered
uninstall, use the strict
[`../promptctl/advanced/codex/`](../promptctl/advanced/codex/) tool:

```bash
python3 agent/promptctl/advanced/codex/codex-instruct.py \
  --file /path/to/personal-rules.md \
  --codex-dir ~/.codex \
  --dry-run

python3 agent/promptctl/advanced/codex/codex-instruct.py \
  --file /path/to/personal-rules.md \
  --codex-dir ~/.codex \
  --yes
```

Both Promptctl ownership models remain independent of
`agent/codex/uninstall.sh`.

## MCP and uninstall

The interactive MCP menu offers Brave Search, Exa, Context7, GitHub, and Chrome
DevTools. Chrome DevTools uses Codex's local STDIO transport and passes
CloakBrowser's Chromium path to
`npx -y chrome-devtools-mcp@latest --executablePath ...`. The first setup can
download roughly 200 MB. Set `CLOAKBROWSER_BINARY_PATH`, pass
`--cloakbrowser-executable PATH`, or use `--stock-chrome` to opt out.

GitHub uses the hosted `https://api.githubcopilot.com/mcp/` endpoint. Codex's
config references `GITHUB_PERSONAL_ACCESS_TOKEN` through
`bearer_token_env_var`; the PAT is not written into `config.toml`.

```bash
./agent/codex/mcp.sh
./agent/codex/mcp.sh --provider chrome-devtools
GITHUB_PERSONAL_ACCESS_TOKEN=github_pat... \
  ./agent/codex/mcp.sh --provider github --provider chrome-devtools
./agent/codex/uninstall.sh

# Or remove only one part:
./agent/agentctl/agentctl uninstall codex
./agent/codex/mcp.sh --uninstall
```

The setup block is bounded by explicit markers, so unrelated `config.toml`
settings and MCP entries are preserved.
