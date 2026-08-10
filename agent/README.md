# agent/

Interactive installers for Claude Code, Codex CLI, OpenCode, and Pi. The setup
scripts install the client, let you choose a provider and model, validate the
key when the provider exposes a models endpoint, and preserve credentials with
mode `0600`.

- [`agentctl/`](./agentctl/README.md) — shared public Shell entrypoint for
  installing a client, configuring its provider/model, and managing portable
  provider profiles with platform-specific target overlays.
- [`claude-code/`](./claude-code/README.md) — Anthropic, DeepSeek, OpenRouter,
  MiniMax China/global, a custom Anthropic Messages endpoint, and the managed
  low-overhead status-line preset.
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
- [`skillsctl/`](./skillsctl/README.md) — canonical portable skill storage,
  inherited frontend/backend packs, safe target links, and encrypted recovery.
- [`proxy/`](./proxy/README.md) — optional loopback-only native protocol
  forwarder with explicit lifecycle, capability authentication, and metadata-
  only logs.
- [`pricing/`](./pricing/README.md) — independent exact-model, effective-dated
  price catalog with fixed-decimal calculation and source provenance.
- [`recipes/`](./recipes/) — focused integration examples that complement the
  controllers without becoming part of their install or credential lifecycle.

Client/provider setup, MCP configuration, skills, and persistent instructions
keep independent install and uninstall lifecycles. `agentctl workspace` can
optionally bind their encrypted remote Stores behind one master recovery code
without merging those lifecycles or deleting the isolated recovery paths.

The public controllers can be called directly:

```bash
./agentctl/agentctl
./mcpctl/mcpctl
./promptctl/promptctl
./skillsctl/skillsctl --help
./agentctl/agentctl statusline status
./agentctl/agentctl provider status
./agentctl/agentctl provider plan work-gateway --target codex
./agentctl/agentctl pricing status
./agentctl/agentctl proxy status
```

Node.js 22 or newer powers the shared Ink 7 / React 19 terminal dashboard and
the controllers' structured orchestration clients. Run any controller without
arguments in a terminal, or use its explicit `tui` command, to open the same
dashboard on the relevant section. Use `interactive` when you want the older
line-oriented guided flow. See [`tui/`](./tui/) for the views, keys, safety
confirmations, and build contract.

To make those names available from any directory, preview and apply the
standalone installer:

```bash
./install-commands.sh --prefix "$HOME/.local/bin"
./install-commands.sh --prefix "$HOME/.local/bin" --yes
```

It copies a minimal runtime—not the repository—to
`~/.local/share/script-toolbox/agent`, then creates reversible command links.
The checkout can be removed afterward. `--link` retains the old
repository-backed development mode.

All controllers expose the same atomic suite updater, so any one of these
commands updates all four entrypoints without mixing runtime revisions:

```bash
agentctl update --check
mcpctl update --yes
promptctl update --yes
skillsctl update --yes
```

Every model menu also has a custom model-ID entry. All selections can be
supplied as flags for automation:

```bash
./agentctl/agentctl setup claude
./agentctl/agentctl setup codex --provider openai --model gpt-5.6
./agentctl/agentctl setup opencode --provider custom --protocol chat \
  --base-url https://gateway.example.com/v1 --model my-model --key-env MY_API_KEY
./agentctl/agentctl setup pi --provider openrouter --model openai/gpt-5.6
```

Provider setup can be inspected without a credential or any mutation, and a
private file avoids exposing a key in shell history:

```bash
./agentctl/agentctl setup codex \
  --provider openai --model gpt-5.6 --dry-run
./agentctl/agentctl setup codex \
  --provider openai --model gpt-5.6 --key-file /secure/openai-api-key
./agentctl/agentctl status all
./agentctl/agentctl status codex --json
./agentctl/agentctl statusline install --yes
```

Use `./agentctl/agentctl providers <client>` to see current built-in model IDs
without installing anything. `--region china|global` remains as a
backward-compatible setup option for MiniMax where MiniMax is supported.

## Controller boundaries

| Controller | Owns | Does not own |
| --- | --- | --- |
| `agentctl` | Client installation, portable provider profiles, local provider Secrets, exact-model pricing, provider/model configuration, the optional local proxy lifecycle, Claude's status-line preset, and the optional encrypted Workspace manifest | Child MCP/Skills/Prompt snapshots, prompt files, CLI removal |
| `mcpctl` | Task-oriented MCP profiles and their encrypted backup state | Providers, models, persistent instructions |
| `promptctl` | Persistent instruction links and initial editable Markdown | Clients, providers, credentials, MCP state |
| `skillsctl` | Portable skill directories, inherited packs, managed target links, encrypted backups | Providers, MCP state, project-scoped skills |

`agentctl uninstall <client>` calls only the selected `setup.sh --uninstall`.
It intentionally does not call the broader per-client `uninstall.sh`.

## Per-agent backend kit

| File | Required | Purpose |
|---|---:|---|
| `setup.sh` | yes | `agentctl` backend and compatible one-shot setup entrypoint. |
| `statusline-setup.sh` | Claude only | Reversible status-line preset manager; `statusline.py` is its renderer. |
| `mcp.sh` | when supported | Add the Brave / Exa / Context7 / GitHub / Chrome DevTools MCP pack. Pi has no built-in MCP client. |
| `uninstall.sh` | yes | Remove setup, MCP, and any separately owned client extras. |
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

The standalone and repository-backed `agentctl`, `mcpctl`, `promptctl`, and
`skillsctl` frontends share [`ctl-lib.sh`](./ctl-lib.sh) for consistent launch
checks, menus, confirmations, and terminal messages, plus the committed
[`tui/dist/toolbox-tui.mjs`](./tui/dist/toolbox-tui.mjs) dashboard. This does
not add a repository dependency to Raw URL setup scripts.

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

bash -n agentctl/agentctl
bash -n claude-code/setup.sh
bash -n codex/setup.sh
bash -n opencode/setup.sh
bash -n pi/setup.sh
```

The scripts are compatible with macOS `/bin/bash` 3.2 and do not require
associative arrays or Bash lowercase expansion. CI runs the complete
`agent/test.sh` suite through the macOS system Bash 3.2 binary.

## Task-oriented MCP profiles

The per-agent `mcp.sh` files remain simple installers for the standard MCP
pack. For personal profiles and encrypted restoration, initialize a separate
`mcpctl` store:

```bash
./mcpctl/mcpctl

# Equivalent explicit commands for automation:
./mcpctl/mcpctl init
./mcpctl/mcpctl sync
./mcpctl/mcpctl import --target claude
./mcpctl/mcpctl import --target codex
./mcpctl/mcpctl plan --target claude --profile frontend
./mcpctl/mcpctl --target codex --profile reverse
./mcpctl/mcpctl server doctor --all
./mcpctl/mcpctl server install gdb
./mcpctl/mcpctl server enable gdb --target codex
./mcpctl/mcpctl remote init --endpoint https://mcp-store.example.workers.dev
./mcpctl/mcpctl backup
```

Profiles support inheritance, target-specific enable/disable operations, and
one-off CLI overrides. The guided menu can also toggle individual servers and
save the result as a reusable child profile. Its configuration center remembers
store/Secret/remote paths, launches encrypted SOPS editing, accepts missing
Secrets without echo for one run, and manages remote backup actions without
placing credentials in preferences. The safe-by-default importer reads
Claude/Codex user MCP configuration, extracts static values directly into the
encrypted cache, and creates one target-aware `imported` profile without
uploading until `backup` is requested. `sync` safely adds new starter entries
to an older personal store. Starter presets cover GitHub, standard and
CloakBrowser-backed browser control, Radare2/LLDB, Ghidra, JADX/Apktool, IDA
Pro, and Burp. Its optional Worker/R2 backend restores the catalog, profiles,
and encrypted API-token cache from one recovery code without GitHub
configuration. See [`mcpctl/`](./mcpctl/README.md).
