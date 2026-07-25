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
| MiniMax China/global | `MiniMax-M2.7` | Anthropic Messages |
| Custom | user supplied | Chat, Responses, Anthropic, or Google |

Pi currently requires Node.js `22.19.0` or newer. Setup installs the npm package
with `--ignore-scripts`, matching the upstream installation guidance.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/silencoo/script-toolbox/main/agent/pi/setup.sh | bash
```

Or from a clone:

```bash
cd agent/pi
./setup.sh
```

## Automation and custom providers

```bash
./setup.sh --list-providers

OPENAI_API_KEY=sk-... \
  ./setup.sh --provider openai --model gpt-5.6

./setup.sh --provider custom --protocol responses --auth-mode bearer \
  --base-url https://gateway.example.com/v1 \
  --model my-model --key-env MY_API_KEY

./setup.sh --provider custom --protocol google --auth-mode google-key \
  --base-url https://generativelanguage.googleapis.com/v1beta \
  --model my-model --key custom-secret
```

The script writes a script-toolbox-owned entry to
`~/.pi/agent/models.json`, selects it in `~/.pi/agent/settings.json`, and
stores the key separately under `~/.pi/agent/provider-keys/` with mode `0600`.
Pi resolves that key through its documented command-backed `apiKey` syntax.

Use `--skip-validate` for a custom gateway without a models endpoint.

## MCP and uninstall

Pi does not have a built-in MCP client. Its upstream documentation recommends
using an extension when MCP is needed, so this folder does not install an MCP
pack.

```bash
./uninstall.sh

# Or remove only the managed provider:
./setup.sh --uninstall
```

Uninstall preserves all unrelated providers, settings, sessions, packages,
skills, and extensions.
