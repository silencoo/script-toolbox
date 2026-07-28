# Promptctl Agent Setup

This is the Agent-guided entrypoint for clean workstations and disposable
sandboxes. It reaches exactly the same state as running `promptctl.py`
directly.

Promptctl owns one marked import/config block per client. It creates an
editable instruction file only when that file is missing and never replaces
its content on later runs.

## Direct use

Run from the `script-toolbox` repository root:

```bash
# Preview one client or both.
python3 agent/promptctl/promptctl.py install claude
python3 agent/promptctl/promptctl.py install codex
python3 agent/promptctl/promptctl.py install all

# Apply exactly the previewed configuration.
python3 agent/promptctl/promptctl.py install all --yes
```

After installation, edit the paths printed by the command:

```text
~/.claude/instructions/personal.md
~/.codex/instructions/personal.md
```

Print them again at any time:

```bash
python3 agent/promptctl/promptctl.py path all
```

New Claude Code or Codex sessions load the changes. Running sessions are not
rewritten.

## Copy this to an agent

```text
Configure persistent instructions from this script-toolbox checkout.

1. Read agent/promptctl/AGENT_SETUP.md and agent/promptctl/README.md completely.
2. Run `python3 agent/promptctl/promptctl.py status all`.
3. Run `python3 agent/promptctl/promptctl.py install all` without `--yes`.
4. Report the exact Claude/Codex link files, editable instruction files, and
   planned create/update/preserve actions.
5. If either client reports a conflict or an existing unowned instruction
   setting, stop and report it. Do not overwrite it manually.
6. Wait for my explicit confirmation.
7. After confirmation, rerun the same install command with `--yes`.
8. Show me the editable instruction paths printed by the command. Do not
   replace their content on later runs.
9. Remind me to edit those Markdown files and start new agent sessions.

Do not modify providers, MCP servers, credentials, binaries, network settings,
or running processes. Do not invoke an advanced deployer for the same profile
unless I explicitly request migration of an existing setup.
```

## Files and ownership

| Client | Promptctl-owned link | User-owned editable file |
| --- | --- | --- |
| Claude Code | marked block in `~/.claude/CLAUDE.md` importing `@instructions/personal.md` | `~/.claude/instructions/personal.md` |
| Codex | marked top-level block in `~/.codex/config.toml` setting `model_instructions_file = "./instructions/personal.md"` | `~/.codex/instructions/personal.md` |

Existing surrounding configuration is backed up before a change and otherwise
preserved. If an editable file already exists, install reports
`preserve user content` and does not read from or copy the template over it.

Use `--template /path/to/file.md` only to choose the initial content for a
missing instruction file.

## Status and uninstall

```bash
python3 agent/promptctl/promptctl.py status all
python3 agent/promptctl/promptctl.py status all --json

# Preview, then remove only Promptctl-owned links.
python3 agent/promptctl/promptctl.py uninstall all
python3 agent/promptctl/promptctl.py uninstall all --yes

# Explicitly back up and remove the editable Markdown too.
python3 agent/promptctl/promptctl.py uninstall all --remove-instructions
python3 agent/promptctl/promptctl.py uninstall all --remove-instructions --yes
```

`--dry-run` wins over `--yes`. A malformed marker, non-regular target,
different managed profile, or pre-existing unowned Codex
`model_instructions_file` fails closed before either client is changed.

## When to use advanced deployment

Use [`advanced/claude/`](./advanced/claude/README.md) or
[`advanced/codex/`](./advanced/codex/README.md) when you need fixed-source
deployment, migration, backup restoration, Codex hook isolation, interrupted
transaction recovery, or layered uninstall.

Do not manage the same link with both Promptctl and an advanced deployer.
Inspect status and migrate deliberately.
