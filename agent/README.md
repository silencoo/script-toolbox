# agent/

Interactive installers for Claude Code, Codex CLI, OpenCode, and Pi. The setup
scripts install the client, let you choose a provider and model, validate the
key when the provider exposes a models endpoint, and preserve credentials with
mode `0600`.

- [`claude-code/`](./claude-code/README.md) — Anthropic, DeepSeek, OpenRouter,
  MiniMax China/global, or a custom Anthropic Messages endpoint.
- [`codex/`](./codex/README.md) — OpenAI, OpenRouter, or a custom OpenAI
  Responses endpoint.
- [`opencode/`](./opencode/README.md) — Anthropic, OpenAI, Google Gemini,
  DeepSeek, OpenRouter, MiniMax China/global, or a custom Chat Completions,
  Responses, or Anthropic endpoint.
- [`pi/`](./pi/README.md) — Anthropic, OpenAI, Google Gemini, DeepSeek,
  OpenRouter, MiniMax China/global, or a custom Chat Completions, Responses,
  Anthropic, or Google endpoint.
- [`mcpctl/`](./mcpctl/README.md) — personal, profile-oriented MCP management
  for switching task-specific server sets across Claude Code, Codex, and
  OpenCode without changing the existing per-agent MCP installers.
- [`promptctl/`](./promptctl/README.md) — shared persistent-instruction
  management for Claude Code and Codex, with direct and Agent-guided setup.

Promptctl is part of the `agent/` product family, but provider setup, MCP
configuration, and persistent instructions intentionally keep independent
install and uninstall lifecycles. For a clean environment, run
[`promptctl/promptctl.py`](./promptctl/promptctl.py) directly or let an agent
follow [`promptctl/AGENT_SETUP.md`](./promptctl/AGENT_SETUP.md).

Every model menu also has a custom model-ID entry. All selections can be
supplied as flags for automation:

```bash
./claude-code/setup.sh
./codex/setup.sh --provider openai --model gpt-5.6
./opencode/setup.sh --provider custom --protocol chat \
  --base-url https://gateway.example.com/v1 --model my-model --key-env MY_API_KEY
./pi/setup.sh --provider openrouter --model openai/gpt-5.6
```

Use `--list-providers` on any setup script to see its current built-in model
IDs without installing anything. `--region china|global` remains as a
backward-compatible shortcut for MiniMax where MiniMax is supported.

## Per-agent kit

| File | Required | Purpose |
|---|---:|---|
| `setup.sh` | yes | Install the client and configure a provider/model. |
| `mcp.sh` | when supported | Add the Brave / Exa / Context7 / GitHub / Chrome DevTools MCP pack. Pi has no built-in MCP client. |
| `uninstall.sh` | yes | Remove setup and MCP entries owned by these scripts. |
| `README.md` | yes | Usage and compatibility notes. |
| `CHANGELOG.md` | yes | Per-agent history. |

Run an MCP script without provider flags to open an interactive checklist for
Brave, Exa, Context7, GitHub, and Chrome DevTools. Prompts use `/dev/tty`, so
this also works with a one-shot `curl | bash` install. For automation, repeat
`--provider`, or use `--all`; each `--key NAME=value` applies only to that
named MCP. Missing CLI keys fall back to `BRAVE_API_KEY`, `EXA_API_KEY`,
`CONTEXT7_API_KEY`, or `GITHUB_PERSONAL_ACCESS_TOKEN`. Context7 can be used
anonymously:

```bash
./claude-code/mcp.sh

BRAVE_API_KEY=BSA... EXA_API_KEY=EXA... \
  GITHUB_PERSONAL_ACCESS_TOKEN=github_pat... \
  ./codex/mcp.sh --provider brave --provider exa \
    --provider context7 --provider github --provider chrome-devtools
```

[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
requires Node.js 20+ and npm. The scripts use its official
`--executablePath` option and default to
[CloakBrowser](https://github.com/CloakHQ/cloakbrowser), whose platform
Chromium binary is installed through `npx -y cloakbrowser@latest install`.
Set `CLOAKBROWSER_BINARY_PATH` or pass `--cloakbrowser-executable PATH` to use
an existing binary. Pass `--stock-chrome` to retain Chrome DevTools MCP's
stock-Chrome discovery. This path uses CloakBrowser's binary-level fingerprint
patches; its wrapper-only `humanize` option is not injected into
Chrome DevTools MCP actions.

The [remote GitHub MCP server](https://github.com/github/github-mcp-server)
uses `https://api.githubcopilot.com/mcp/`. The `${input:github_mcp_pat}`
prompt syntax from VS Code is host-specific, so these scripts generate each
agent's native environment-variable reference instead. Export
`GITHUB_PERSONAL_ACCESS_TOKEN` before starting the agent; the PAT is used for
setup validation but is never written into its MCP configuration.

The setup scripts share [`setup-lib.sh`](./setup-lib.sh). When a per-agent
script is run through `curl ... | bash`, it downloads that helper from the
same repository; prompts read from `/dev/tty`, so one-shot interactive use
still works. Scripts that update JSON install `jq` automatically through
apt, dnf/yum, Homebrew, or apk when it is missing.

## Credentials

- Claude Code stores its selected provider variables in
  `~/.claude/settings.json` with file mode `0600`.
- Codex stores keys separately under `~/.codex/provider-keys/` and uses the
  supported command-backed provider authentication mechanism.
- OpenCode stores keys separately under
  `~/.config/opencode/provider-keys/` and references them with OpenCode's
  `{file:...}` substitution.
- Pi stores keys separately under `~/.pi/agent/provider-keys/` and references
  them with Pi's command-backed `apiKey` substitution.

## Verify

```bash
./test.sh

bash -n claude-code/setup.sh
bash -n codex/setup.sh
bash -n opencode/setup.sh
bash -n pi/setup.sh
```

The scripts are compatible with macOS `/bin/bash` 3.2 and do not require
associative arrays or Bash lowercase expansion.

## Task-oriented MCP profiles

The per-agent `mcp.sh` files remain simple installers for the standard MCP
pack. For personal profiles and encrypted restoration, initialize a separate
`mcpctl` store:

```bash
./mcpctl/mcpctl init
./mcpctl/mcpctl plan --target claude --profile frontend
./mcpctl/mcpctl --target codex --profile reverse
./mcpctl/mcpctl remote init --endpoint https://mcp-store.example.workers.dev
./mcpctl/mcpctl backup
```

Profiles support inheritance, target-specific enable/disable operations, and
one-off CLI overrides. Its optional Worker/R2 backend restores the catalog,
profiles, and encrypted API-token cache from one recovery code without GitHub
configuration. See [`mcpctl/`](./mcpctl/README.md).
