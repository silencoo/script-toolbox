# agentctl

`agentctl` is the public Shell entrypoint for installing a supported coding
agent, configuring its provider/model/credential, and managing the optional
unified encrypted Toolbox Workspace.

Run it without arguments from the repository root:

```bash
./agent/agentctl/agentctl
```

The guide selects Claude Code, Codex, OpenCode, or Pi and then delegates to
that client's existing interactive setup implementation.

## Explicit commands

```bash
# Open the selected client's provider/model setup.
./agent/agentctl/agentctl setup claude

# Forward automation flags unchanged.
./agent/agentctl/agentctl setup codex \
  --provider openai --model gpt-5.6

# Resolve the provider/model and affected paths without a key or any changes.
./agent/agentctl/agentctl setup codex \
  --provider openai --model gpt-5.6 --dry-run

# Prefer a private file to putting a key in shell history.
./agent/agentctl/agentctl setup codex \
  --provider openai --model gpt-5.6 --key-file /secure/openai-api-key

# "init" and "configure" are setup aliases.
./agent/agentctl/agentctl init opencode

# Inspect installed CLIs and agentctl-owned provider state without secrets.
./agent/agentctl/agentctl status all
./agent/agentctl/agentctl status codex --json

# Inspect client-specific presets and options.
./agent/agentctl/agentctl providers pi
./agent/agentctl/agentctl help codex

# Remove only setup.sh-owned provider/model/credential state.
./agent/agentctl/agentctl uninstall codex
./agent/agentctl/agentctl uninstall codex --yes
```

Client aliases include `claude`/`claude-code` and
`opencode`/`open-code`.

`status` reports the CLI path/version, resolved provider/model, ownership
marker, config/state paths, and credential-file existence/mode. It never emits
a credential value. JSON status requires `jq`.

All four setup backends accept `--dry-run` and `--key-file PATH`. Dry-run exits
before validation requests, package installation, or filesystem changes, and
does not require a key. Key files must be regular, non-symlinked, owner-only
files containing exactly one non-empty line (normally mode `0600`).

## Development presets

A development preset binds one named MCP profile, Skills pack, and Prompt
profile. The catalog is local and contains names only; credentials remain in
their existing ctl-specific stores.

```bash
agentctl preset create web-research \
  --mcp browser-research \
  --skills frontend \
  --prompt research \
  --description "Browser-assisted frontend research" \
  --yes

agentctl preset plan web-research --target codex
agentctl preset apply web-research --target codex --yes
agentctl preset current --target codex
```

`plan` runs all three component plans without writing anything. `apply`
starts only after every plan succeeds. If a later component fails, agentctl
reconstructs the previous MCP and Skills selections—including target-local
custom enable/disable sets—and restores the previous Prompt profile. A
successful transaction can also be reverted explicitly:

```bash
agentctl preset rollback --target codex --yes
```

The default catalog is `~/.config/agentctl/presets.json`; the last 20 applied
transactions are kept in `~/.local/state/agentctl/presets.json`. Both formats
are schema-versioned JSON and contain no secret values. Presets currently
target Claude Code and Codex because those are the clients shared by all
three component controllers.

## Unified doctor

```bash
agentctl doctor codex
agentctl doctor all --json
```

Doctor combines redacted provider status with machine-readable MCP, Skills,
and Prompt selections. It reports preset drift, managed-link health, MCP
Secrets availability, remote-store reachability, and whether a new agent
session is recommended. An unreachable or unconfigured optional remote Store
is reported separately and does not make an otherwise healthy local setup
fail.

## Unified Workspace and isolated Stores

The default recovery experience uses one `toolbox1_…` Workspace code. Its
encrypted manifest contains the capabilities for attached MCP, Skills, and
Prompts Stores. Unlocking the Worker UI once then opens three tabs. Child
capabilities are never sent to the Worker in plaintext.

Existing isolated modes remain available for compartmentalization and
break-glass recovery:

- `mcpstore1_…` opens only an MCP Store;
- `skillstore1_…` opens only a Skills Store; and
- `promptstore1_…` opens only a Prompt Store.

Create a Workspace, then attach existing isolated Stores without copying or
deleting their data:

```bash
agentctl workspace init \
  --endpoint https://mcp-store.example.workers.dev \
  --create-token-file /secure/toolbox-create-token

agentctl workspace attach mcp
agentctl workspace attach skills
agentctl workspace attach prompts
agentctl workspace status
agentctl workspace ui enable
```

`attach` enables browser access for that child Store and records its private
capability only in a new encrypted Workspace version. `detach` removes only
the reference; the child Store, versions, local config, and isolated recovery
code stay intact.

```bash
agentctl workspace recovery
agentctl workspace versions
agentctl workspace ui status
agentctl workspace ui disable
```

The master capability is stored locally at
`~/.config/agentctl/workspace-remote.json` with owner-only permissions. A
fresh machine can recover it from a private one-line file:

```bash
agentctl workspace restore --recovery-file /secure/toolbox-recovery-code
```

## Optional PATH commands

Preview and then install repository-backed command symlinks:

```bash
./agent/install-commands.sh --prefix "$HOME/.local/bin"
./agent/install-commands.sh --prefix "$HOME/.local/bin" --yes

agentctl status all
agentctl workspace status
mcpctl current --target codex
promptctl status all
```

The installer refuses existing commands by default. `--force` first moves a
conflict to a tracked backup. Uninstall removes only matching managed links and
restores those backups:

```bash
./agent/install-commands.sh --prefix "$HOME/.local/bin" --uninstall
./agent/install-commands.sh --prefix "$HOME/.local/bin" --uninstall --yes
```

## Ownership boundary

`agentctl` controls the client/provider layer, local development-preset
transactions, and the optional master Workspace manifest:

- It can install a missing CLI through the selected setup backend.
- It configures provider, model, and owned credential state.
- Its `uninstall` command calls that backend's provider-only `--uninstall`.
- Its `workspace` commands attach or detach encrypted child Store capabilities;
  they do not rewrite the child snapshots.
- Its `preset` command deliberately invokes the three child controllers only
  for plan/apply/status/rollback; each controller retains ownership of its
  files and validation rules.

Outside an explicit preset or doctor command, it does not invoke `mcpctl`,
Promptctl, a per-client `mcp.sh`, or a full `uninstall.sh`. It also does not
remove an installed CLI binary. Use these independent entrypoints when needed:

```bash
./agent/mcpctl/mcpctl
./agent/promptctl/promptctl
./agent/skillsctl/skillsctl
```

## Compatibility entrypoints

The existing per-client scripts remain supported:

```text
agent/claude-code/setup.sh
agent/codex/setup.sh
agent/opencode/setup.sh
agent/pi/setup.sh
```

They are the implementation behind `agentctl` and remain available for
one-shot `curl | bash` use and existing automation. The per-client
`uninstall.sh` files are broader legacy/full-kit commands: where supported,
they remove both provider and simple MCP state.
