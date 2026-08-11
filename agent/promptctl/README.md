# promptctl

Persistent-instruction management for coding agents. Promptctl lives under
`agent/` alongside provider setup and `mcpctl`, but it keeps a separate install
and uninstall lifecycle so user-authored instructions are never removed as a
side effect of changing providers or MCP servers.

## Choose an entrypoint

Run Promptctl without arguments in a terminal to open the shared dashboard on
Prompts:

```bash
./agent/promptctl/promptctl
```

Node.js 22 or newer is required for the dashboard and encrypted Prompt Store
operations. Use `promptctl tui` for the explicit dashboard entrypoint or
`promptctl interactive` for the older Shell menu. The Shell menu lets you
configure, inspect, locate, or uninstall instructions.
Every write is previewed and requires a separate `y` confirmation.

When installed with `agent/install-commands.sh`, use `promptctl update --check`
to inspect the latest suite revision or `promptctl update --yes` to update all
four controllers atomically.

For automation or an Agent-guided workflow, use explicit commands:

```bash
# Preview; no writes.
./agent/promptctl/promptctl install all

# Apply after reviewing the paths and actions.
./agent/promptctl/promptctl install all --yes
```

To adopt existing local prompts without printing or replacing their content,
preview and then apply the dedicated blind migration:

```bash
./agent/promptctl/promptctl migrate --target all --profile personal
./agent/promptctl/promptctl migrate --target all --profile personal --yes
```

Migration copies Claude Code's `~/.claude/CLAUDE.md` and Codex's
`~/.codex/AGENTS.md` verbatim into their client-specific editable profile
files. It prints paths and actions only. The legacy files are backed up before
Claude's binding is replaced and Codex's legacy file is removed, preventing
the same instructions from loading twice. All targets are preflighted before
any write, and a failed multi-client apply restores the original files.

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
./agent/agentctl/agentctl setup codex --provider openai --model gpt-5.6
./agent/codex/mcp.sh --provider context7
./agent/promptctl/promptctl install codex --yes
```

## Commands

```bash
# Inspect or print editable paths.
./agent/promptctl/promptctl status all
./agent/promptctl/promptctl status all --json
./agent/promptctl/promptctl path all

# Create a complete clone, then preview and atomically switch both clients.
./agent/promptctl/promptctl profile create work --from personal --yes
./agent/promptctl/promptctl profile list
./agent/promptctl/promptctl plan --target all --profile work
./agent/promptctl/promptctl apply --target all --profile work --yes
./agent/promptctl/promptctl current --target all --json

# Active profiles cannot be deleted; switch first. Deletion creates backups.
./agent/promptctl/promptctl apply --target all --profile personal --yes
./agent/promptctl/promptctl profile delete work --yes

# Preview, then remove only Promptctl-owned links.
./agent/promptctl/promptctl uninstall all
./agent/promptctl/promptctl uninstall all --yes

# Explicitly back up and remove the editable Markdown too.
./agent/promptctl/promptctl uninstall all --remove-instructions
./agent/promptctl/promptctl uninstall all --remove-instructions --yes
```

## Reusable snippets

Snippets are short prompts you insert on demand. They are shared across agent
clients and are never loaded as persistent instructions. Local snippet files
live under `~/.local/share/script-toolbox/snippets`.

```bash
# Create an empty Markdown file, then edit the printed path.
promptctl snippet create review-code --yes
promptctl snippet path review-code

# Blind-copy an existing text/Markdown file without printing its content.
promptctl snippet create plan-first --from /path/to/phrase.md --yes

# Metadata-only listing and clipboard use.
promptctl snippet list
promptctl snippet copy plan-first

# Deletion is previewed and creates an adjacent backup.
promptctl snippet delete plan-first
promptctl snippet delete plan-first --yes
```

`promptctl backup` and `promptctl restore` include this shared library in the
same end-to-end encrypted Prompt Store as persistent profiles. Listing commands
and the Agentctl dashboard expose names, paths, and file state only.

The default profile name is `personal`. Profiles are independent Markdown
documents rather than inherited fragments: `profile create --from` makes a
complete clone that can be edited without hidden parent behavior. `plan` and
`apply` are the intentional switching interface and replace only a valid
Promptctl-owned block. Multi-client writes restore their pre-apply bytes if a
later write fails.

Use `--name NAME` with the legacy-compatible `install` commands or
`--template /path/to/file.md` to choose initial content for a missing
instruction file. A template is never copied over an existing file, and
`install --name` still refuses to replace a different active profile.
The Shell entrypoint delegates explicit commands to `promptctl.py`, which is
an internal, non-interactive engine rather than the user-facing guide.

## Encrypted backup and recovery

Promptctl can collect every regular `*.md` document under the Claude and Codex
instruction directories into a client-side encrypted Prompt Store. It never
backs up `CLAUDE.md`, `config.toml`, provider credentials, or unrelated files.

```bash
promptctl remote init \
  --endpoint https://toolbox-store.example.workers.dev \
  --create-token-file /secure/toolbox-create-token
promptctl backup
promptctl remote status
promptctl versions
promptctl remote ui enable
```

The isolated `promptstore1_…` recovery code remains usable directly. For the
normal one-login Web UI, attach it to the master Workspace:

```bash
agentctl workspace attach prompts
```

Web UI edits create a new encrypted remote version. Pull them back to local
editable files explicitly; conflicts fail closed unless `--force` is supplied:

```bash
promptctl restore --yes
promptctl restore --yes --version <version-id> --force
promptctl restore --yes --recovery-file /secure/prompt-recovery-code
```

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
