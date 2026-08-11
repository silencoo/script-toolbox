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
gateways such as DeepSeek, OpenRouter, and MiniMax, and preserves the file as
mode `0600`. All third-party presets use `ANTHROPIC_AUTH_TOKEN`; only direct
Anthropic API access uses `ANTHROPIC_API_KEY` and its required `x-api-key`
header. The script writes exactly one credential field, never both.

## Install

```bash
./agent/install-commands.sh --yes
agentctl provider list --target claude
agentctl provider use anthropic-api --target claude \
  --secret-file /secure/anthropic-api-key --yes
```

`agent/claude-code/setup.sh` is the private renderer used by `provider use`.

## Status-line preset

Provider switching leaves the independent status-line setting untouched.
Install or repair the managed preset explicitly with
`agentctl statusline install --yes`; existing external commands are preserved
unless explicitly adopted with `--force`. The renderer needs Python 3 and shows the current
directory, Git branch/dirty/upstream state, Claude session line changes, a
10-cell context bar, token usage, and the model ID or proxy alias.

Manage it independently through `agentctl`:

```bash
# Preview, apply, inspect, and remove.
agentctl statusline install
agentctl statusline install --yes
agentctl statusline status
agentctl statusline status --json
agentctl statusline uninstall --yes

# Preserve and temporarily replace an existing external statusLine.
agentctl statusline install --force --yes
```

The forced-install restore point is held in an owner-only state file and is
restored on uninstall. The manager refuses unrelated files at its dedicated
`~/.claude/scripts/script-toolbox-statusline.py` path and refuses uninstall if
the active setting has drifted. Provider uninstall does not remove the preset.

For a one-shot installation without the controller runtime:

```bash
curl -fsSL \
  https://raw.githubusercontent.com/silencoo/script-toolbox/main/agent/claude-code/statusline-setup.sh \
  | bash -s -- install --yes
```

The hot path uses [Claude Code's current status-line payload](https://code.claude.com/docs/en/statusline)
directly. It tails `transcript_path` once for third-party model aliases and
legacy context fallback, and runs one bounded, non-interactive
`git status --porcelain=v2 --branch` process. `+N -N` are Claude's session
line-change counters; `*` marks tracked working-tree changes. Empty progress
cells use explicit `░` glyphs. The preset leaves `refreshInterval` unset, so
Claude's event-driven refresh policy applies.

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
agentctl provider list --target claude
agentctl provider plan deepseek --target claude
agentctl provider use deepseek --target claude \
  --model deepseek-v4-pro --secret-file /secure/deepseek-api-key --yes
agentctl provider use openrouter --target claude \
  --secret-file /secure/openrouter-api-key --yes

agentctl provider create work-gateway \
  --protocol anthropic_messages \
  --base-url https://gateway.example.com/anthropic \
  --model my-model --auth-mode bearer --secret work_gateway_key --yes
agentctl provider use work-gateway --target claude \
  --secret-file /secure/work-gateway-key --skip-validate --yes
```

## Model context and auto-compact

Provider schema 2 stores the verified model maximum separately from the
client-side compact trigger. The MiniMax M3 built-ins resolve to 1,000,000
tokens with auto-compact at 500,000:

```bash
agentctl provider use minimax-cn --target claude \
  --context-window-tokens 1000000 \
  --auto-compact-tokens 500000 --yes
```

The Claude renderer writes `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and
`autoCompactWindow`. Passing `auto` for either CLI value releases that field
back to Claude Code or restores the exact value that existed before agentctl
took ownership. Ownership is recorded separately in
`~/.claude/.script-toolbox-provider-context.json`; it contains only setting
metadata, is mode `0600`, and participates in transactional provider rollback.
An external edit to an actively managed value blocks replacement until it is
reviewed and explicitly forced.

`--secret-file` refuses symlinks, group/other-readable files, empty files, and
multi-line values. Custom profiles skip an unknown models endpoint by default;
`--skip-validate` makes that policy explicit.

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

The full `uninstall.sh` also invokes the status-line manager when its ownership
state exists. The provider-only `agentctl uninstall claude` intentionally leaves
both MCP and status-line state untouched, while restoring any context values
captured by the Provider renderer.

Claude Code installation tries Anthropic's native installer first and falls
back to `npm install -g @anthropic-ai/claude-code`.
