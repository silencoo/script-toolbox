# mcpctl

`mcpctl` applies task-oriented MCP profiles to Claude Code, Codex, and
OpenCode. It is separate from the existing per-agent `mcp.sh` scripts:

- `agent/*/mcp.sh` remains the simple public installer for the standard MCP
  pack.
- `mcpctl` manages a personal catalog, inherited task profiles, target
  overrides, and encrypted secret references.

It never removes an MCP entry unless that entry is marked as owned by
`agent/mcpctl`. A same-name entry created manually or by an existing `mcp.sh`
is reported as a conflict. `--force` replaces only the conflicting names.

Requirements are Bash 3.2+ and `jq`. Node.js 20+ is required for encrypted
remote backup and restore. SOPS is needed only when using a SOPS-encrypted
secret file. Individual local MCP servers retain their own runtime
requirements, such as Node.js for Chrome DevTools MCP.

## Quick start

Initialize a personal store:

```bash
./agent/mcpctl/mcpctl init
```

The default location is `~/.config/mcpctl/store`. A different directory,
including a private Git clone, can be selected explicitly:

```bash
./agent/mcpctl/mcpctl init --store ~/private/mcp-store
```

Preview and apply profiles:

```bash
BRAVE_API_KEY=... \
  ./agent/mcpctl/mcpctl plan \
    --target claude --profile frontend

BRAVE_API_KEY=... \
  ./agent/mcpctl/mcpctl \
    --target claude --profile frontend

EXA_API_KEY=... \
  ./agent/mcpctl/mcpctl \
    --target codex --profile frontend

./agent/mcpctl/mcpctl \
  --target codex --profile reverse
```

The command with no subcommand is shorthand for `apply`. The explicit form is
also available:

```bash
mcpctl apply --target claude --profile frontend
```

Use the `off` profile to remove all entries currently owned by `mcpctl` for a
target:

```bash
mcpctl --target claude --profile off
```

## Encrypted remote backup

The optional remote mode does not use Git, Gist, or a GitHub login. A small
Cloudflare Worker stores opaque, versioned ciphertext in a private R2 bucket.
See the [Worker deployment guide](../../workers/mcp-store/README.md) to deploy
the service and temporarily configure its `CREATE_TOKEN` bootstrap secret.

Create the personal remote store and upload the first snapshot:

```bash
mcpctl remote init \
  --endpoint https://mcp-store.example.workers.dev
```

`remote init` prompts without echo for the deployment's store-creation token,
prints one recovery code, saves the local capability configuration with mode
`0600`, and immediately runs the first backup. In automation, keep the
bootstrap token in a mode-`0600` file and use:

```bash
mcpctl remote init \
  --endpoint https://mcp-store.example.workers.dev \
  --create-token-file /secure/path/create-token
```

The creation token is not part of the recovery code and is not needed again.
After initialization, delete the Worker's `CREATE_TOKEN` secret to disable
public store creation while leaving the personal store operational.

Normal use is:

```bash
mcpctl backup
mcpctl remote status
mcpctl versions
```

On a fresh machine, install this toolbox and restore with the single recovery
code:

```bash
mcpctl restore
```

If no local remote configuration exists, `restore` prompts for the code
without echo. A non-interactive restore can read it from a protected file:

```bash
chmod 600 /secure/path/mcpctl-recovery
mcpctl restore --recovery-file /secure/path/mcpctl-recovery
```

Restoring over an initialized local store requires explicit confirmation:

```bash
mcpctl restore --force
mcpctl restore --version <version-id> --force
```

The restored store contains `catalog.json`, its profiles, and
`secrets.remote.enc`. The latter remains encrypted and is used automatically
as the final secret source during `plan`/`apply`. SOPS identities, target
client configuration, and unrelated files are intentionally not included.

The recovery code contains the endpoint, a random store identifier, and a
256-bit recovery root. The client uses HKDF-SHA256 to derive independent
authentication and AES-256-GCM encryption keys. Only the derived
authentication capability crosses TLS; the Worker stores its SHA-256 digest.
The recovery root and plaintext snapshot never reach the Worker, and plaintext
secrets are not written to a backup staging file.

This model has clear boundaries:

- anyone with the recovery code can decrypt, restore, and upload versions;
- stealing both `remote.json` and `secrets.remote.enc` from an unlocked device
  is equivalent to stealing the recovery code;
- the service operator can delete data, deny access, observe ciphertext size
  and timing, or replay an older valid snapshot, but cannot decrypt it;
- AES-GCM detects modified or cross-store ciphertext, but a brand-new machine
  cannot cryptographically distinguish a server-replayed old valid version;
- agent target files may still contain resolved API headers in mode-`0600`
  plaintext, as described below; and
- versions are not automatically pruned.

Use `mcpctl remote recovery` only when intentionally reprinting the sensitive
recovery code. Keep at least one offline copy; losing every copy of the
recovery code and local `remote.json` makes the encrypted backup unrecoverable.

## Profiles

Profiles are JSON files under `profiles/`. They describe task-level server
selection rather than client-specific configuration:

```json
{
  "schema": 1,
  "name": "frontend",
  "description": "Frontend development and browser debugging",
  "extends": [
    "base"
  ],
  "enable": [
    "chrome-devtools"
  ],
  "disable": [],
  "target_overrides": {
    "claude": {
      "enable": [
        "brave"
      ],
      "disable": []
    },
    "codex": {
      "enable": [
        "exa"
      ],
      "disable": []
    }
  }
}
```

Resolution is deterministic:

1. Resolve inherited profiles from parent to child.
2. Apply each profile's common `enable` and `disable` operations.
3. Apply the matching target override at that layer.
4. Apply CLI `--enable` operations.
5. Apply CLI `--disable` operations; disable wins.
6. Validate every resulting server against the target.

Inheritance cycles, unknown server names, invalid schemas, and unsupported
targets fail before any target config is changed.

Useful inspection commands:

```bash
mcpctl profile list
mcpctl profile show frontend
mcpctl profile show frontend --target codex
mcpctl server list
mcpctl server show brave
mcpctl current --target claude
```

One-off changes do not modify the saved profile:

```bash
mcpctl --target codex --profile frontend \
  --enable github --disable chrome-devtools
```

## Catalog

`catalog.json` is the normalized source of truth. An authenticated HTTP server
looks like:

```json
{
  "brave": {
    "transport": "http",
    "url": "https://api.search.brave.com/mcp",
    "auth": {
      "type": "header",
      "header": "X-Subscription-Token",
      "prefix": "",
      "secret": "brave_api_key",
      "env": "BRAVE_API_KEY",
      "required": true
    },
    "supported_targets": [
      "claude",
      "codex",
      "opencode"
    ]
  }
}
```

A local server uses a command array:

```json
{
  "private-analysis": {
    "transport": "stdio",
    "command": [
      "/absolute/path/to/private-analysis-mcp",
      "--stdio"
    ],
    "supported_targets": [
      "claude",
      "codex"
    ]
  }
}
```

The starter catalog pins Chrome DevTools MCP to a concrete version so restoring
the same store is reproducible. Update that version deliberately in
`catalog.json`; the original per-agent `mcp.sh` scripts continue following
their existing `@latest` behavior.

Server definitions may have their own `target_overrides` object. The matching
object is recursively merged into the base definition before rendering.

## Encrypted secrets

Environment variables are convenient for one-off use, but the store can use a
SOPS-encrypted JSON file for restoration and synchronization. The default path
is:

```text
<store>/secrets.sops.json
```

Its decrypted structure must be:

```json
{
  "schema": 1,
  "secrets": {
    "brave_api_key": "...",
    "exa_api_key": "...",
    "context7_api_key": "..."
  }
}
```

Configure SOPS with one or more age recipients, then create/edit the encrypted
file:

```yaml
# <store>/.sops.yaml
creation_rules:
  - path_regex: secrets\.sops\.json$
    age:
      - age1-device-public-recipient...
      - age1-offline-recovery-recipient...
```

```bash
cd ~/.config/mcpctl/store
sops edit secrets.sops.json
```

Keep every age private identity outside this repository. Each machine should
normally have a different identity; add its public recipient from an already
trusted machine. Keep a separate offline recovery identity.

For an enabled server, secret resolution is:

1. The catalog's environment variable, when set.
2. The named key in `secrets.sops.json`.
3. The named key in `secrets.remote.enc`, when restored.
4. Anonymous access when `required` is `false`.
5. A failure before configuration is written.

`plan` reports only the source and availability—it never decrypts or prints a
value. During `apply`, the decrypted SOPS document is retained in process
memory. The remote encrypted cache is handled the same way. Resolved values
can briefly exist in mode-`0600` temporary render files, which are removed
when the command exits.

Some clients require the resolved HTTP header to be materialized in their
local config. Those target files are written atomically with mode `0600`, but
they are not encrypted. Encryption protects the portable store and backup; it
does not protect a compromised, already-unlocked workstation.

## Switching and state

Applying a new profile reconciles the target's actual managed entries:

```text
frontend -> reverse

remove: brave, chrome-devtools
keep:   context7
add:    private-analysis
```

Unrelated entries and non-MCP configuration remain untouched. Local
informational state is stored in:

```text
~/.local/state/mcpctl/applied.json
```

The state contains the profile and server names, never secret values. The
ownership markers inside the real target config remain authoritative for
reconciliation.

Target configuration paths can be overridden for testing or unusual
installations:

```bash
MCPCTL_CLAUDE_CONFIG=/path/settings.json
MCPCTL_CODEX_CONFIG=/path/config.toml
MCPCTL_OPENCODE_CONFIG=/path/opencode.json
```

## Test

```bash
./agent/mcpctl/test.sh
./agent/test.sh
```

The tests use an isolated temporary home, a fake SOPS command, and an in-memory
Worker/R2 binding. They do not contact MCP services, Cloudflare, or real agent
configuration.
