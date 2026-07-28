# promptctl

Persistent-instruction management for coding agents. Promptctl lives under
`agent/` alongside provider setup and `mcpctl`, but it keeps a separate install
and uninstall lifecycle so user-authored instructions are never removed as a
side effect of changing providers or MCP servers.

## Choose an entrypoint

For a clean workstation or disposable sandbox, use the shared lightweight
command:

```bash
# Preview; no writes.
python3 agent/promptctl/promptctl.py install all

# Apply after reviewing the paths and actions.
python3 agent/promptctl/promptctl.py install all --yes
```

It configures Claude Code and/or Codex, prints the resulting Markdown paths,
and leaves those files user-editable:

```text
~/.claude/instructions/personal.md
~/.codex/instructions/personal.md
```

Reruns preserve their content. Uninstall removes only Promptctl-owned
import/config blocks by default.

An agent can perform the same flow by reading
[`AGENT_SETUP.md`](./AGENT_SETUP.md). Direct and Agent-guided setup share one
implementation and one filesystem layout.

## Ownership boundary

Promptctl manages persistent instructions only. It does not install clients,
select providers, write credentials, configure MCP servers, modify binaries,
or change running sessions.

The adjacent agent installers do not automatically invoke Promptctl, and their
uninstallers do not remove Promptctl state. This makes these operations safe to
run independently:

```bash
./agent/codex/setup.sh --provider openai --model gpt-5.6
./agent/codex/mcp.sh --provider context7
python3 agent/promptctl/promptctl.py install codex --yes
```

## Commands

```bash
# Inspect or print editable paths.
python3 agent/promptctl/promptctl.py status all
python3 agent/promptctl/promptctl.py status all --json
python3 agent/promptctl/promptctl.py path all

# Preview, then remove only Promptctl-owned links.
python3 agent/promptctl/promptctl.py uninstall all
python3 agent/promptctl/promptctl.py uninstall all --yes

# Explicitly back up and remove the editable Markdown too.
python3 agent/promptctl/promptctl.py uninstall all --remove-instructions
python3 agent/promptctl/promptctl.py uninstall all --remove-instructions --yes
```

The default profile name is `personal`. Use `--name NAME` for another safe
filename and `--template /path/to/file.md` to choose initial content for a
missing instruction file. A template is never copied over an existing file.

## Advanced deployers

Use the imported advanced tools when an existing or complex environment needs
fixed-source deployment, migration, backups, recovery, Codex hook isolation,
or layered uninstall:

- [`advanced/claude/`](./advanced/claude/README.md) manages named instruction
  files and owned import blocks in Claude Code memory files.
- [`advanced/codex/`](./advanced/codex/README.md) deploys an explicitly
  selected Markdown file through Codex `model_instructions_file`, with
  manifests, hook isolation, recovery, and layered uninstall.

These tools retain their upstream persisted marker, manifest, journal, and
mutex identifiers so an existing advanced deployment remains recoverable.
That compatibility detail is not the name of the Promptctl product.

Do not manage the same instruction link with both the lightweight command and
an advanced deployer at the same time.

### Advanced Claude deployment

```bash
python3 agent/promptctl/advanced/claude/claude-instruct.py \
  install --scope user \
  --file /path/to/personal-rules.md \
  --name personal-rules \
  --yes
```

### Advanced Codex deployment

```bash
python3 agent/promptctl/advanced/codex/codex-instruct.py \
  --file /path/to/personal-rules.md \
  --codex-dir ~/.codex \
  --dry-run

python3 agent/promptctl/advanced/codex/codex-instruct.py \
  --file /path/to/personal-rules.md \
  --codex-dir ~/.codex \
  --yes
```

## Adding another client

1. Add its lightweight layout and neutral template when the client supports a
   simple persistent-instruction link.
2. Add ownership, conflict, round-trip, and uninstall tests under `tests/`.
3. Put a copied advanced implementation under `advanced/<client>/`, retaining
   its license and recovery compatibility.
4. Register copied-source provenance in the repository `NOTICE.md`.
5. Add its tests to the root validation workflow.

Nested workflow files inside copied projects are documentation only. GitHub
Actions runs workflows from the repository root `.github/workflows/`.
