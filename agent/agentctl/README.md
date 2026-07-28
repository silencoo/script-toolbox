# agentctl

`agentctl` is the public Shell entrypoint for installing a supported coding
agent and configuring its provider, model, and credential.

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

# "init" and "configure" are setup aliases.
./agent/agentctl/agentctl init opencode

# Inspect client-specific presets and options.
./agent/agentctl/agentctl providers pi
./agent/agentctl/agentctl help codex

# Remove only setup.sh-owned provider/model/credential state.
./agent/agentctl/agentctl uninstall codex
./agent/agentctl/agentctl uninstall codex --yes
```

Client aliases include `claude`/`claude-code` and
`opencode`/`open-code`.

## Ownership boundary

`agentctl` controls only the client/provider layer:

- It can install a missing CLI through the selected setup backend.
- It configures provider, model, and owned credential state.
- Its `uninstall` command calls that backend's provider-only `--uninstall`.

It does not invoke `mcpctl`, Promptctl, a per-client `mcp.sh`, or a full
`uninstall.sh`. It also does not remove an installed CLI binary. Use these
independent entrypoints when needed:

```bash
./agent/mcpctl/mcpctl
./agent/promptctl/promptctl
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
