# Claude Code setup

Installs Claude Code and interactively configures an
Anthropic-Messages-compatible provider. Presets:

| Provider | Default model | Other menu choices |
|---|---|---|
| Anthropic | `claude-sonnet-4-6` | `claude-opus-4-8`, `claude-fable-5` |
| DeepSeek | `deepseek-v4-pro` | `deepseek-v4-flash` |
| OpenRouter | `~anthropic/claude-sonnet-latest` | Opus latest, `openrouter/auto` |
| MiniMax China/global | `MiniMax-M3` | M2.7, M2.7 highspeed, M2.5 |
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

From a clone, use the shared controller from the repository root:

```bash
./agent/agentctl/agentctl setup claude
./agent/claude-code/mcp.sh
```

The Raw URL above and `agent/claude-code/setup.sh` remain supported
compatibility entrypoints.

## Persistent instructions

Claude Code `CLAUDE.md` instruction deployment is managed by Promptctl under
`agent/`, independently from provider and MCP state. For a clean machine or
sandbox, create a lightweight import and an editable user-owned Markdown file:

```bash
# Run from the script-toolbox repository root.
# Omit arguments for the guided menu, then choose Claude Code.
./agent/promptctl/promptctl

# Equivalent explicit workflow:
./agent/promptctl/promptctl install claude
./agent/promptctl/promptctl install claude --yes
./agent/promptctl/promptctl path claude
```

An agent can follow
[`../promptctl/AGENT_SETUP.md`](../promptctl/AGENT_SETUP.md) instead; it calls
the same Shell entrypoint and produces the same layout.

For fixed-source deployment or an existing environment that needs stricter
backup/restore ownership, use
[`../promptctl/advanced/claude/`](../promptctl/advanced/claude/):

```bash
# Preview only
python3 agent/promptctl/advanced/claude/claude-instruct.py \
  install --scope user --name personal-rules

# Apply after reviewing the preview
python3 agent/promptctl/advanced/claude/claude-instruct.py \
  install --scope user --name personal-rules \
  --file /path/to/personal-rules.md --yes
```

Both Promptctl ownership models remain independent of `uninstall.sh`.

## Automation and custom providers

```bash
./agent/agentctl/agentctl providers claude

DEEPSEEK_API_KEY=... \
  ./agent/agentctl/agentctl setup claude \
    --provider deepseek --model deepseek-v4-pro

OPENROUTER_API_KEY=sk-or-... \
  ./agent/agentctl/agentctl setup claude --provider openrouter

./agent/agentctl/agentctl setup claude --provider custom \
  --base-url https://gateway.example.com/anthropic \
  --models-url https://gateway.example.com/v1/models \
  --model my-model --key-env MY_API_KEY --auth-mode auth-token

# Preview without a key, validation request, install, or file change.
./agent/agentctl/agentctl setup claude \
  --provider anthropic --model claude-sonnet-4-6 --dry-run

# For automation, prefer a mode-0600 single-line file over --key.
./agent/agentctl/agentctl setup claude \
  --provider anthropic --model claude-sonnet-4-6 \
  --key-file /secure/anthropic-api-key
```

`--region china|global` is retained as a MiniMax compatibility shortcut.
Use `--skip-validate` when a custom gateway does not implement a models
endpoint. `--key-file` refuses symlinks, group/other-readable files, empty
files, and multi-line values.

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

The interactive MCP menu offers Brave Search, Exa, Context7, GitHub, and Chrome
DevTools. Chrome DevTools runs locally and passes CloakBrowser's Chromium path
to `npx -y chrome-devtools-mcp@latest --executablePath ...`. The first setup
can download roughly 200 MB. Set `CLOAKBROWSER_BINARY_PATH`, pass
`--cloakbrowser-executable PATH`, or use `--stock-chrome` to opt out.

GitHub uses the hosted `https://api.githubcopilot.com/mcp/` endpoint. Its
header expands `GITHUB_PERSONAL_ACCESS_TOKEN` when Claude Code starts; the PAT
is not written into `~/.claude.json`. MCP servers live in that official
user-scoped file, while provider/model settings remain in
`~/.claude/settings.json`.

```bash
./agent/claude-code/mcp.sh
./agent/claude-code/mcp.sh --provider chrome-devtools
GITHUB_PERSONAL_ACCESS_TOKEN=github_pat... \
  ./agent/claude-code/mcp.sh \
    --provider github --provider chrome-devtools
./agent/claude-code/uninstall.sh

# Or remove only one part:
./agent/agentctl/agentctl uninstall claude
./agent/claude-code/mcp.sh --uninstall
```

Claude Code installation tries Anthropic's native installer first and falls
back to `npm install -g @anthropic-ai/claude-code`.
