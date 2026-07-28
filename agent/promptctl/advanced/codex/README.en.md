<!-- markdownlint-disable MD013 MD033 MD041 -->

<h1 align="center">codex-keysmith</h1>

<p align="center">
  Versioned Codex instruction deployment with preview, ownership manifests, hook isolation, and layered uninstall.
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="#english">English</a> ·
  <a href="docs/reference.md">Reference</a> ·
  <a href="docs/agent-install.md">Agent install</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="LICENSE">License</a>
</p>

## English

### What this is

`codex-keysmith` is a zero-dependency, single-file Python script that deploys an instruction Markdown file into your Codex configuration directory (`~/.codex`) so every new Codex session loads it. It previews by default and only writes on explicit confirmation; every deployment can be undone.

**This changes Codex's global behavior, not a per-project setting**: deployment edits `model_instructions_file` in `~/.codex/config.toml`, so it affects every new session under that configuration, and by default it pauses your entire existing `hooks.json` until you explicitly restore it. This build ships no bundled prompt; installation requires an explicit Markdown file through `--file`. The tool safely deploys and reverses the file but does not endorse or validate its instructions. Read the complete file before deploying it.

### Lightweight entrypoint for a clean environment

For a clean workstation or disposable sandbox, run the shared bootstrap from
the script-toolbox root:

```bash
python3 agent/promptctl/promptctl.py install codex
python3 agent/promptctl/promptctl.py install codex --yes
python3 agent/promptctl/promptctl.py path codex
```

It owns only its marked block in `config.toml`. The instruction file it creates
once is user-owned: reruns never overwrite it and default uninstall preserves
it. An agent can read [`../../AGENT_SETUP.md`](../../AGENT_SETUP.md) and invoke the same
program.

Use this standalone `codex-keysmith` tool for fixed-source deployment,
migration, hook isolation, interruption recovery, and layered uninstall. Do
not let both tools manage the same `model_instructions_file`.

> [!WARNING]
> Do not use the published `v0.1.0` on Windows; it has a known cleanup defect (see Compatibility below). v0.1.1 and later provide the native recovery backend; Windows fresh deployment remains beta.

### Use it from script-toolbox (macOS / Linux)

```bash
# Run from the script-toolbox repository root.
script=agent/promptctl/advanced/codex/codex-instruct.py
prompt=/path/to/personal-rules.md

# 1. Inspect the version and current state.
python3 "$script" --version
python3 "$script" --codex-dir ~/.codex --status --lang en

# 2. Explicitly select an instruction file and preview.
python3 "$script" --file "$prompt" --codex-dir ~/.codex --dry-run --lang en

# 3. Apply only after reviewing the source hash, targets, and hook plan.
python3 "$script" --file "$prompt" --codex-dir ~/.codex --yes --lang en
```

[`examples/your-rules.md`](examples/your-rules.md) is only a neutral starting point; it is used only when you explicitly pass it to `--file`. **Close old tasks and start a new Codex session** after deployment—Codex loads configuration only at session start.

Omitting `--codex-dir` processes every auto-discovered directory; only do this for an intentional multi-directory deployment.

For an upstream standalone release, do not install from a floating `main` or
pipe `curl | python`. Download the script and `SHA256SUMS` from
[Jia-Ethan/codex-keysmith Releases](https://github.com/Jia-Ethan/codex-keysmith/releases),
verify them on disk, and still pass `--file` explicitly.

```bash
python3 codex-instruct-vX.Y.Z.py --codex-dir ~/.codex --status --lang en
python3 codex-instruct-vX.Y.Z.py --file /path/to/personal-rules.md \
  --codex-dir ~/.codex --dry-run --lang en
```

### Files it changes

| Path | What happens |
| --- | --- |
| `<codex-dir>/your-rules.md` (or custom `--name`) | Create, or back up and replace |
| `<codex-dir>/config.toml` | Owns and edits only top-level `model_instructions_file`; external rewrites of other fields do not block status/uninstall and survive uninstall |
| `<codex-dir>/hooks.json` | Isolated to `hooks.json.disabled` by default (backed up first) |
| `<codex-dir>/.codex-keysmith-manifest.json` | Records what this deployment changed, for later uninstall |

Full field list, transaction directories, and edge cases: [`docs/reference.md`](docs/reference.md).

### Undo

```bash
# Only restore hooks, leave instructions/config alone:
python3 agent/promptctl/advanced/codex/codex-instruct.py \
  --codex-dir ~/.codex --restore-hooks --lang en

# Fully undo this deployment (config, instruction, hooks together):
python3 agent/promptctl/advanced/codex/codex-instruct.py \
  --codex-dir ~/.codex --uninstall --lang en        # preview first
python3 agent/promptctl/advanced/codex/codex-instruct.py \
  --codex-dir ~/.codex --uninstall --yes --lang en  # confirm
```

Uninstall removes only the newest layer each run; repeat it to peel back earlier deployments. Long-lived config ownership covers only the top-level `model_instructions_file`: rewrites by CCSwitch or similar tools remain compatible while that field still references this layer's Markdown. Uninstall restores or removes only the pre-deployment field statement and preserves all other live content. A missing/different target reference, target-field ambiguity, or unsupported statement structure still fails closed.

### If something goes wrong

| Symptom | What to do |
| --- | --- |
| Hard interruption mid-deployment (`SIGKILL`, power loss) | Run `--status` first; if it reports `blocked`, preview `--recover`, then confirm with `--yes` |
| `--status` reports abnormal residue | Do not manually delete any `.codex-keysmith-transaction-*`, backup, or manifest; follow the `--recover` flow above, or see [`docs/hooks-transactions.md`](docs/hooks-transactions.md) |
| You want to clean up old backups | See the cleanup preconditions in [`docs/reference.md`](docs/reference.md); the tool never auto-deletes backups |

### Compatibility and limits

- Recommended Python 3.10–3.14; verified against `codex-cli 0.144.1`.
- macOS / Linux are the primary support range.
- **Windows**: the published `v0.1.0` has a known defect (`os.utime` failure followed by a second `PermissionError` that leaves a journal the old script can't recover). v0.1.1 and later include the rewritten Windows filesystem backend under `EXPLICIT_BETA` — usable, but not formally supported yet. If v0.1.0 left a journal on Windows, recover with the latest verified Release script in order: `--status` → `--recover` preview → `--recover --yes` → `--status`; never manually delete evidence.
- Single-file CLI, no `pip install` or auto-updater; backups and uninstall archives are not cleaned automatically.
- Full limits list, transaction guarantees, and maintainer verification: [`docs/reference.md`](docs/reference.md).

### Contributing and security reporting

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before submitting. Report vulnerabilities through the private channel in [`SECURITY.md`](SECURITY.md); do not paste credentials, complete configuration, or private paths into a public issue.

### Community

This project accepts monitoring and feedback from the LINUX DO community: [LINUX DO](https://linux.do)

Same series:

- [codex-keysmith](https://github.com/Jia-Ethan/codex-keysmith) - Codex CLI instruction-file deployment for local configuration.
- [claude-keysmith](https://github.com/Jia-Ethan/claude-keysmith) - Claude Code `CLAUDE.md` import-block installer for local instruction files.
- [grok-keysmith](https://github.com/Jia-Ethan/grok-keysmith) - Grok Build `AGENTS.md` installer with compat/hook isolation.
- [zcode-keysmith](https://github.com/Jia-Ethan/zcode-keysmith) - ZCode `AGENTS.md` installer for local instructions.

---

简体中文版: [`README.md`](README.md)。Agent install prompt: [`docs/agent-install.md`](docs/agent-install.md).
