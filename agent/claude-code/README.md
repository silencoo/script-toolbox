# Claude Code setup

Installs Claude Code and interactively configures an
Anthropic-Messages-compatible provider. Presets:

| Provider | Default model | Other menu choices |
|---|---|---|
| Anthropic | `claude-sonnet-4-6` | `claude-opus-4-8`, `claude-fable-5` |
| DeepSeek | `deepseek-v4-pro` | `deepseek-v4-flash` |
| OpenRouter | `~anthropic/claude-sonnet-latest` | Opus latest, `openrouter/auto` |
| MiniMax China/global | `MiniMax-M2.7` | M2.7 highspeed, M2.5 |
| Custom | user supplied | any model ID |

The script writes `~/.claude/settings.json`, uses `ANTHROPIC_API_KEY` for
standard Anthropic-style authentication and `ANTHROPIC_AUTH_TOKEN` for bearer
gateways such as OpenRouter and MiniMax, and preserves the file as mode `0600`.
It writes exactly one of those two credential fields, never both.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/silencoo/script-toolbox/main/agent/claude-code/setup.sh | bash
curl -fsSL https://raw.githubusercontent.com/silencoo/script-toolbox/main/agent/claude-code/mcp.sh | bash
```

The first command remains interactive even in a pipe because it reads answers
from `/dev/tty`.

From a clone:

```bash
cd agent/claude-code
./setup.sh
./mcp.sh
```

## Automation and custom providers

```bash
./setup.sh --list-providers

DEEPSEEK_API_KEY=... \
  ./setup.sh --provider deepseek --model deepseek-v4-pro

OPENROUTER_API_KEY=sk-or-... \
  ./setup.sh --provider openrouter

./setup.sh --provider custom \
  --base-url https://gateway.example.com/anthropic \
  --models-url https://gateway.example.com/v1/models \
  --model my-model --key-env MY_API_KEY --auth-mode auth-token
```

`--region china|global` is retained as a MiniMax compatibility shortcut.
Use `--skip-validate` when a custom gateway does not implement a models
endpoint.

Shell-level `ANTHROPIC_*` exports take precedence over `settings.json`. During
interactive setup the script offers to back up each affected shell startup file
and remove those duplicate exports. For automation, pass `--clean-shell-env`;
without it, non-interactive setup only reports the conflict. Open a new shell
after cleanup, or unset the three variables in the current shell.

When this agent is used through the repository's Docker sandbox shell kit,
`claude --dangerously-skip-permissions` is available from zsh completion and
history autosuggestions. It is never made the default; bypass mode removes
permission prompts and should stay inside an isolated sandbox.

## MCP and uninstall

```bash
./mcp.sh
./uninstall.sh

# Or remove only one part:
./setup.sh --uninstall
./mcp.sh --uninstall
```

Claude Code installation tries Anthropic's native installer first and falls
back to `npm install -g @anthropic-ai/claude-code`.
