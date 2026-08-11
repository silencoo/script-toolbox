# Pi setup

Installs the current
[`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi)
package and configures a mainstream or custom provider:

| Provider | Default model | Pi API adapter |
|---|---|---|
| Anthropic | `claude-sonnet-4-6` | Anthropic Messages |
| OpenAI | `gpt-5.6` | OpenAI Responses |
| Google Gemini | `gemini-3.6-flash` | Google Generative AI |
| DeepSeek | `deepseek-v4-pro` | OpenAI Chat Completions |
| OpenRouter | `openai/gpt-5.6` | OpenAI Chat Completions |
| MiniMax China/global | `MiniMax-M3` | Anthropic Messages |
| Custom | user supplied | Chat, Responses, Anthropic, or Google |

Pi currently requires Node.js `22.19.0` or newer. Setup installs the npm package
with `--ignore-scripts`, matching the upstream installation guidance.

## Install

```bash
./agent/install-commands.sh --yes
agentctl provider list --target pi
agentctl provider use openrouter --target pi \
  --secret-file /secure/openrouter-api-key --yes
```

`agent/pi/setup.sh` is the private renderer used by `provider use`.

## Automation and custom providers

```bash
agentctl provider list --target pi
agentctl provider plan google-gemini --target pi
agentctl provider use google-gemini --target pi \
  --model gemini-3.6-flash --secret-file /secure/gemini-api-key --yes

agentctl provider create work-gateway \
  --protocol openai_responses --base-url https://gateway.example.com/v1 \
  --model my-model --auth-mode bearer --secret work_gateway_key --yes
agentctl provider use work-gateway --target pi \
  --secret-file /secure/work-gateway-key --skip-validate --yes
```

The script writes a script-toolbox-owned entry to
`~/.pi/agent/models.json`, selects it in `~/.pi/agent/settings.json`, and
stores the key separately under `~/.pi/agent/provider-keys/` with mode `0600`.
Pi resolves that key through its documented command-backed `apiKey` syntax.

Secret files must be non-symlinked, owner-only, and contain exactly one
non-empty line.

## MCP and uninstall

Pi does not have a built-in MCP client. Its upstream documentation recommends
using an extension when MCP is needed, so this folder does not install an MCP
pack.

```bash
./agent/pi/uninstall.sh

# Or remove only the managed provider:
./agent/agentctl/agentctl uninstall pi
```

Uninstall preserves all unrelated providers, settings, sessions, packages,
skills, and extensions.
