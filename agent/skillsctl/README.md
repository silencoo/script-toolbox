# skillsctl

`skillsctl` keeps reusable agent skills in one canonical local store, groups
them into inherited packs, and safely exposes the selected pack to Codex,
Claude Code, OpenCode, or Pi.

It is deliberately separate from `mcpctl`: MCP profiles select running tools;
skill packs select instruction and asset directories. Both can use the same
Toolbox Store Worker for independent end-to-end encrypted backups.

Node.js 22 or newer is required. Run `skillsctl` in a terminal or use
`skillsctl tui` to open the shared dashboard directly on Skills. Explicit
commands remain the stable automation interface.

When installed with `agent/install-commands.sh`, use `skillsctl update --check`
to inspect the latest suite revision or `skillsctl update --yes` to update all
four controllers atomically.

## Quick start

```bash
skillsctl init --yes
skillsctl skill add /path/to/frontend-dev --yes
skillsctl pack add frontend frontend-dev --yes
skillsctl plan --target codex --pack frontend
skillsctl apply --target codex --pack frontend --yes
skillsctl current --target codex --json
```

The starter packs are:

- `base` — common skills;
- `frontend` and `backend` — focused packs extending `base`;
- `fullstack` — combines `frontend` and `backend`; and
- `off` — an empty pack for removing skillsctl-managed links.

Create and compose personal packs:

```bash
skillsctl pack create web-app --extends frontend \
  --description "Web application work" --yes
skillsctl pack add web-app turnstile-spin --yes
skillsctl pack disable web-app legacy-skill --yes
skillsctl pack show web-app --target codex
```

Pack documents support `extends`, `enable`, `disable`, and target-specific
overrides. Parent rules are resolved first, then the child and selected target
override.

Temporarily change only one agent's current managed selection without editing
the saved pack:

```bash
# Preview first; omit --yes to leave the target unchanged.
skillsctl skill disable frontend-dev --target codex
skillsctl skill disable frontend-dev --target codex --yes
skillsctl skill enable frontend-dev --target codex --yes
skillsctl skill set --target codex \
  --enable backend-dev --disable frontend-dev --yes --json
```

This records a target-local custom selection based on the last applied pack.
The canonical Skill remains installed in the Store; disabling only removes the
managed target link. Applying a named pack later replaces the custom selection.
`current` reports the named or custom selection, exact managed Skill names,
and link drift in a stable human or JSON form for orchestration.

`skill set` commits every repeated `--enable` / `--disable` flag through one
target plan, rolls completed link operations back if publication fails, and
with `--json` returns the final state without a second `current` process.
Disable wins when the same Skill appears in both lists.

`skillsctl list --json` returns each canonical Skill's name, description, and
SHA-256 file-tree checksum. The shared TUI uses that content-free metadata to
distinguish a same-name local Skill from a different encrypted Workspace copy;
it never sends Skill files into the React view.

Turn an exact custom selection into a reusable target-specific Pack without
changing other clients:

```bash
skillsctl pack save daily-web --target codex --yes
skillsctl pack save daily-web --target codex --force --yes
```

The first command creates a Pack based on the current named Pack; `--force`
updates only the selected target override and preserves global rules plus every
other target override.

## Store and targets

The default canonical store is `~/.config/skillsctl/store` on macOS/Linux and
`%APPDATA%\skillsctl\store` on Windows. `skillsctl` creates only links it owns
and records them under `store/state`; it refuses to replace unowned target
entries. Windows target links use directory junctions so they do not require a
Unix symlink implementation.

| Target | Default skill directory |
| --- | --- |
| Codex | `~/.agents/skills` |
| Claude Code | `~/.claude/skills` |
| OpenCode | `~/.config/opencode/skills` |
| Pi | `~/.pi/agent/skills` |

Use `--target all` with `plan` or `apply` to switch every supported agent.
Environment variables such as `SKILLSCTL_CODEX_DIR` can override a target for
testing or a nonstandard installation.

Project-scoped skills are intentionally not adopted automatically. Import a
user target in preview or write mode:

```bash
skillsctl import --target codex
skillsctl import --target codex --write
```

Preview reports both the Store action (`add`, `keep`, or `conflict`) and target
action (`adopt` or `managed`). On `--write`, every candidate is fully validated
and copied into the canonical Store before the user-level target entry is
replaced by a managed link. Original directories or links are moved into a
timestamped `store/backups/import-<target>-…/` directory with a manifest. A
failed target migration rolls back entries already moved. Content conflicts
still require an explicit `--force --write`; unrelated and project-scoped
entries remain untouched.

### Updating a managed Skill

Managed target entries are links to the canonical Store. Editing a Skill
through `~/.agents/skills`, `~/.claude/skills`, or another managed target
therefore changes the stored files immediately, but deliberately leaves the
catalog checksum stale until the change is explicitly accepted.

Review the diff, then preview and accept only that named Skill:

```bash
skillsctl skill accept frontend-dev
skillsctl skill accept frontend-dev --yes
skillsctl status
```

`skill accept` changes only that Skill's catalog description and checksum; it
does not rewrite its current files or accept any other name. If another Skill
also drifted, the next Store operation reports that name so it can be reviewed
and accepted separately. If the Skill is maintained in a separate source
directory, use `skill add <source> --name <name> --force --yes` instead to
replace the canonical copy and preserve the previous version under
`store/backups/`.

After the local Store is healthy, upload its encrypted snapshot:

```bash
skillsctl backup
skillsctl versions
```

When the Skills Store is already attached, the unified Workspace follows that
child Store's latest encrypted version automatically. Do not reattach it and
do not use `agentctl workspace agent push`, which synchronizes Provider,
Secret, failover, and pricing catalogs—not Skills.

## Safety and portability

A skill must contain `SKILL.md` with YAML frontmatter and a description.
Imports reject symlinks, private-key material, common credential filenames,
files over 2 MiB, and skills over 10 MiB. Stored checksums detect edits made
outside `skillsctl`.

Plaintext snapshots are useful for deliberate migration:

```bash
skillsctl export --output skills.json
skillsctl restore-file --input skills.json --yes
```

Those files are decrypted and may contain executable skill assets. Inspect and
protect them accordingly.

## Encrypted recovery

Deploy the shared Worker in
[`workers/toolbox-store/`](../../workers/toolbox-store/), then initialize and back up:

```bash
skillsctl remote init --endpoint https://toolbox-store.example.workers.dev
skillsctl backup
skillsctl versions
skillsctl recovery
skillsctl remote status
skillsctl remote ui enable
```

The remote configuration is mode `0600`. On a new machine, put the recovery
code in a private file and restore:

```bash
chmod 600 skills-recovery.txt
skillsctl restore --recovery-file skills-recovery.txt --yes
```

The recovery code grants decryption and update access. The Worker sees only a
derived capability and AES-GCM ciphertext. The same code can unlock the
browser Web UI without sending the root key to the Worker. Web access is
disabled for a new logical store until `skillsctl remote ui enable`; inspect
or revoke it with `skillsctl remote ui status|disable`. Disabling browser
access never disables CLI backup or recovery.

For the normal one-code Worker login, attach this Store to the master
Workspace. Its `skillstore1_…` code remains valid for isolated recovery:

```bash
agentctl workspace attach skills
```

## Verify

```bash
node agent/skillsctl/test.mjs
node agent/remote-store.test.mjs
```
