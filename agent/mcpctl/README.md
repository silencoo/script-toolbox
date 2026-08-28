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

Requirements are Bash 3.2+, `jq`, and Node.js 22+. Node powers the shared TUI,
existing-client import, and encrypted remote backup/restore. SOPS is
needed only when using a SOPS-encrypted secret file. Individual local MCP
servers retain their own runtime requirements, such as Node.js for Chrome
DevTools MCP.

When installed with `agent/install-commands.sh`, use `mcpctl update --check` to
inspect the latest suite revision or `mcpctl update --yes` to update all four
controllers atomically.

## Quick start

Run without arguments in a terminal to open the shared dashboard directly on
the MCP view:

```bash
./agent/mcpctl/mcpctl
```

Use `mcpctl tui` for the explicit form, or `mcpctl interactive` for the older
guided local workflow. The guide can initialize or safely update the starter
store, select Claude Code, Codex, or OpenCode, apply a complete profile, or
toggle individual MCP servers. A custom selection can be applied once or saved
as a target-specific child profile. Every client-config mutation first shows
the resolved add/remove plan and requires a separate confirmation. When
required Secrets are missing, the guide can accept them without echo for that
process only, open the encrypted SOPS editor, or cancel without writing client
configuration.

The standard controller installer and shared TUI initialize the default Store
automatically. For a custom path or standalone automation, initialize it
explicitly; repeating `init` validates and preserves an existing Store:

```bash
./agent/mcpctl/mcpctl init
```

The default location is `~/.config/mcpctl/store` on macOS/Linux and
`%APPDATA%\mcpctl\store` under Windows Git Bash. A different directory,
including a private Git clone, can be selected explicitly:

```bash
./agent/mcpctl/mcpctl init --store ~/private/mcp-store
```

If the store was initialized by an older toolbox checkout, merge in newly
bundled servers and profiles with:

```bash
./agent/mcpctl/mcpctl sync
```

`sync` adds missing catalog keys and profile files. Existing same-name personal
definitions remain intact. It can also attach lifecycle metadata and replace
an exact legacy `npx`/`uvx` launcher with the equivalent isolated-package
adapter when the upstream URL and pinned package still match; custom package
versions and commands are not migrated. The same operation is available as
“Add newly bundled servers and profiles” in the guided menu.

## Guided configuration

Choose “Configure store, Secrets, and encrypted remote backup” from the main
menu to:

- switch to or initialize another local store;
- inspect redacted Secret-source availability;
- select, create, and edit a SOPS-encrypted Secret file;
- create a `.sops.yaml` rule from a public age recipient;
- select the remote capability file, initialize its HTTPS endpoint, inspect
  status and versions, or run a backup.

When the selected local store does not exist, the initial guide also offers to
restore an encrypted remote backup directly into that path. If the capability
file is absent, the recovery code is requested without echo.

Selected paths are remembered in
`~/.config/mcpctl/preferences.json`. This mode-`0600` file contains only paths,
never Secret values, recovery roots, or store-creation tokens. Flags and
environment variables take precedence over saved preferences. An explicitly
selected different `--store` does not inherit another store's saved Secret
file.

The equivalent redacted inspection and encrypted editing commands are:

```bash
mcpctl secrets status
mcpctl secrets edit
```

`secrets edit` creates the encrypted file through SOPS when needed, launches
the SOPS editor, and validates the decrypted schema without printing values.
It requires an existing SOPS creation rule or recipient configuration.

Preview and apply the compact daily profiles:

```bash
./agent/mcpctl/mcpctl plan \
  --target claude --profile daily

./agent/mcpctl/mcpctl \
  --target claude --profile daily

BRAVE_API_KEY=... EXA_API_KEY=... \
  ./agent/mcpctl/mcpctl \
    --target codex --profile daily-search

./agent/mcpctl/mcpctl \
  --target codex --profile reverse-native
```

Supplying `--target` and `--profile` without a subcommand remains shorthand for
`apply`. The explicit form is also available:

```bash
mcpctl apply --target claude --profile daily
mcpctl current --target claude --json
```

`current --json` returns the named or custom selection, base profile, active
managed server set, any explicitly suppressed Codex servers, config path, and
drift health without resolving or printing Secret values. This is the stable
orchestration interface used by `agentctl preset` and `agentctl doctor`.

### Search-enhanced daily development

`daily` includes Context7, Fetch, standard Chrome DevTools, and CloakBrowser-
backed Chrome DevTools. Use standard Chrome to control a real browser profile
and CloakBrowser for the default isolated development browser.

Models without a built-in web-search tool can use `daily-search`, which adds
both Brave and Exa:

```bash
BRAVE_API_KEY=... EXA_API_KEY=... \
  mcpctl apply --target codex --profile daily-search
```

The keys can come from `BRAVE_API_KEY` and `EXA_API_KEY` or the corresponding
encrypted Secret entries. Keenable and Tavily remain available as catalog
servers for one-off customization, but authentication variants do not each
create another task profile:

```bash
mcpctl --target codex --profile daily --enable keenable
mcpctl --target codex --profile daily --enable tavily-keyless
TAVILY_API_KEY=... \
  mcpctl --target codex --profile daily --enable tavily-api
```

The three Tavily definitions share a mutually exclusive variant group. The
guided CLI and Worker UI automatically switch modes, while a hand-written
profile that enables more than one fails validation. API keys are sent only in
request headers, never in the MCP URL. See the official
[Keenable MCP documentation](https://docs.keenable.ai/mcp-server),
[Tavily keyless documentation](https://docs.tavily.com/documentation/keyless),
and [Tavily MCP documentation](https://docs.tavily.com/documentation/mcp) for
the current tools and service limits.

Use the `off` profile to remove all active entries currently owned by `mcpctl`
for a target. A Codex server marked `suppress_when_disabled` keeps a managed
`enabled = false` override so a plugin-provided default cannot turn itself back
on:

```bash
mcpctl --target claude --profile off
```

## Import existing user MCP configuration

Import currently supports Claude Code and Codex. It reads only user/global MCP
configuration; project-owned `.mcp.json` and `<project>/.codex/config.toml`
files remain outside the personal store.

An import is read-only by default:

```bash
mcpctl import --target claude
mcpctl import --target codex
```

Claude import reads the user-level `mcpServers` object from `~/.claude.json`.
Codex import runs `codex mcp list --json` from the home directory so the
official client parses its own TOML and project-local configuration is not
adopted accidentally. `--source` can instead select a Claude JSON file or a
previously saved Codex JSON export.

The redacted plan reports new, matching, and conflicting catalog entries; the
enabled set that will become the target-specific part of the `imported`
profile; and encrypted Secret reference names. It never prints Secret values.
An imported Codex entry reported by the client with `enabled: false` receives
`suppress_when_disabled: true` in its target definition. It remains unselected
in the profile, while apply writes a managed `enabled = false` TOML override.
Toggling that server through `mcpctl server enable|disable` therefore works even
when the same MCP is supplied and enabled by a Codex plugin.

To adopt different same-name definitions, first inspect the force-enabled
plan, then write it locally:

```bash
mcpctl import --target claude --force
mcpctl import --target claude --force --write

mcpctl import --target codex --force
mcpctl import --target codex --force --write
```

`--force` changes only that target's effective server definition. Other target
definitions and unrelated profiles remain intact. Re-running import updates
the importer-owned profile idempotently. A custom destination can be selected
with `--profile <name>`; an existing profile not owned by the importer is never
replaced without `--force`.

Static process-environment values, HTTP Headers, and credential-like command
arguments are removed from the catalog and written directly to
`secrets.remote.enc` using the remote recovery root. No plaintext staging file
is created. Importing a static value therefore requires an initialized
mode-`0600` `remote.json`; pure environment references can be imported without
capturing their current values. URLs containing credential-like query
parameters are refused instead of being copied into plaintext catalog data.

Import changes only the local store and encrypted cache. It does not modify the
source client and does not upload R2. Review the result, optionally adopt the
profile in each client, and then back it up:

```bash
mcpctl profile show imported --target claude
mcpctl profile show imported --target codex

# First adoption replaces only imported same-name user entries.
mcpctl --target claude --profile imported --force
mcpctl --target codex --profile imported --force

mcpctl backup
```

Claude profile application targets its user MCP store, `~/.claude.json`.
`~/.claude/settings.json` remains available for Claude Code provider and
behavior settings and is not treated as the user MCP registry.

## Encrypted remote backup

The optional remote mode does not use Git, Gist, or a GitHub login. A small
Cloudflare Worker stores opaque, versioned ciphertext in a private R2 bucket.
See the [Worker deployment guide](../../workers/toolbox-store/README.md) to deploy
the service and temporarily configure its `CREATE_TOKEN` bootstrap secret.

Create the personal remote store and upload the first snapshot:

```bash
mcpctl remote init \
  --endpoint https://toolbox-store.example.workers.dev
```

`remote init` prompts without echo for the deployment's store-creation token,
prints one recovery code, saves the local capability configuration with mode
`0600`, and immediately runs the first backup. In automation, keep the
bootstrap token in a mode-`0600` file and use:

```bash
mcpctl remote init \
  --endpoint https://toolbox-store.example.workers.dev \
  --create-token-file /secure/path/create-token
```

The creation token is not part of the recovery code and is not needed again.
After initialization, delete the Worker's `CREATE_TOKEN` secret to disable
public store creation while leaving the personal store operational.

Normal use is:

```bash
mcpctl backup
mcpctl remote status
mcpctl remote ui enable
mcpctl versions
```

Web UI access is disabled for a logical store by default. Use
`mcpctl remote ui status|enable|disable` to control browser access without
changing CLI backup, restore, or recovery behavior.

For the normal one-code Worker login, attach this Store to the master
Workspace. Its `mcpstore1_…` code remains valid for isolated recovery:

```bash
agentctl workspace attach mcp
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
  "name": "daily-search",
  "description": "Daily development plus Brave and Exa search",
  "extends": [
    "daily"
  ],
  "enable": [
    "brave",
    "exa"
  ],
  "disable": [],
  "target_overrides": {}
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
mcpctl profile show daily
mcpctl profile show daily-search --target codex
mcpctl server list
mcpctl server list --target codex --json
mcpctl server doctor --all --json
mcpctl server preflight exa --target codex --json
mcpctl server show brave
mcpctl current --target claude
```

The TUI uses the same explicit commands for safe local management. Multiple
switches can be committed in one configuration write, and the current exact
selection can be named without changing other clients:

```bash
mcpctl server set --target codex --enable exa --disable fetch
mcpctl profile save daily-search --target codex
mcpctl apply --target codex --profile daily-search
```

`server set --json` is the low-latency UI primitive: it updates only changed
owned entries, preserves unchanged rendered values (including Secret-backed
fields), writes config and state atomically, and returns the final target state
without requiring a second `current` process.

`profile save --force` updates only the specified target override of an
existing Profile; its global rules and other target overrides are preserved.

One-off changes do not modify the saved profile:

```bash
mcpctl --target codex --profile daily \
  --enable github --disable chrome-devtools
```

Reusable profiles can also be created non-interactively. With `--target`, the
selection is stored as an override for only that client:

```bash
mcpctl profile create native-codex \
  --extends reverse-native \
  --target codex \
  --enable lldb \
  --disable frida \
  --description "My Codex reverse workspace"
```

The guided customizer performs the same operation when “Save as a reusable
target-specific profile” is selected. Existing profile files are never
overwritten by `profile create`.

The starter Store exposes a small task-oriented set instead of one profile per
server or authentication mode:

| Profile | Enabled MCP servers |
| --- | --- |
| `daily` | Context7, Fetch, real Chrome DevTools, and CloakBrowser DevTools |
| `daily-search` | `daily` plus both Brave and Exa |
| `reverse-web` | `daily` plus persistent JS reverse debugging |
| `reverse-native` | Ghidra, IDALib, Radare2, and Frida |
| `reverse-mobile` | JADX, Apktool, and Frida |
| `reverse-headless` | PyGhidra, GDB, LLDB, Radare2, and headless Playwright |
| `reverse-windows` | x64dbg and Frida inside a Windows VM or VPS |
| `off` | No managed MCP servers |

GitHub, Docker, Computer Use, OpenAI developer docs, Burp, Anything Analyzer,
alternate JS runtimes, and alternate search providers stay in the catalog for
explicit `--enable` use instead of multiplying the default profile list.

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

The starter catalog pins Chrome DevTools, Playwright, and JS Reverse MCP to
concrete versions so restoring the same store is reproducible. Update those
versions deliberately in `catalog.json`; the original per-agent `mcp.sh`
scripts continue following their existing `@latest` behavior.

Server definitions may have their own `target_overrides` object. The matching
object is recursively merged into the base definition before rendering.
Optional `category`, `homepage`, `provider`, `auth_mode`, and `setup` metadata
improves the guided menu and Worker inspector but is not written into client
configuration. Definitions with the same non-empty `variant_group` represent
mutually exclusive ways to connect to one provider; `variant_label` supplies a
human-readable mode name.

The optional `host` object drives local lifecycle commands. It is declarative:
no catalog field is evaluated as a shell fragment. A package-backed entry can
declare an isolated installer and readiness requirements:

```json
{
  "host": {
    "lifecycle": "client",
    "install": {
      "type": "npm",
      "package": "example-mcp@1.2.3",
      "bin": "example-mcp"
    },
    "requirements": [
      {
        "type": "command",
        "name": "node",
        "label": "Node.js LTS"
      }
    ],
    "platforms": ["darwin", "linux", "windows"]
  }
}
```

Installer types are `npm`, `uv`, `manual`, and `none`. `manual` and `none`
never execute an installer. An optional `service` object can provide a
loopback `url` and `url_env` for reachability checks; non-loopback endpoints
are deliberately not probed by host lifecycle commands.

Packages that are not published to a registry can be kept as small portable
artifacts in `artifacts/`. Reference the file logically instead of embedding a
machine-specific absolute path, and pin its digest:

```json
{
  "command": [
    "@mcpctl/adapters/mcp-package",
    "uv",
    "private-analysis",
    "@mcpctl-store/artifacts/private_analysis-1.0.0-py3-none-any.whl",
    "private-analysis-mcp",
    "with:mcp<2",
    "sha256:<64 lowercase hex characters>",
    "--"
  ],
  "host": {
    "lifecycle": "client",
    "install": {
      "type": "uv",
      "package": "@mcpctl-store/artifacts/private_analysis-1.0.0-py3-none-any.whl",
      "bin": "private-analysis-mcp",
      "with": ["mcp<2"],
      "sha256": "<64 lowercase hex characters>"
    }
  }
}
```

Referenced artifacts are SHA-256 checked, included inside the end-to-end
encrypted remote snapshot, restored with mode `0600`, and resolved against the
active Store path on each machine. Individual files are limited to 2 MiB and
the raw artifact set to 2.5 MiB so the doubly encoded encrypted upload remains
within the default Worker limit. Large or public packages should remain pinned
registry/Git sources instead. Native wheels must also restrict `host.platforms`
to the platforms they actually support. Optional `host.install.with` entries
are rendered as `uvx --with` requirements and recorded in the ownership
manifest; use them when an upstream wheel omitted a necessary compatibility
bound such as `mcp<2`.

Imported stdio environment variables, HTTP Headers, and credential command
arguments use Secret descriptors instead of plaintext values. For example:

```json
{
  "environment": {
    "API_TOKEN": {
      "secret": "import_claude_private_env_api_token_...",
      "env": "API_TOKEN",
      "required": true
    }
  }
}
```

The same descriptor shape can appear in `headers` or in a non-executable
`command` array position. Optional `prefix` and `suffix` fields preserve forms
such as `Authorization: Bearer ...` and `--api-key=...` while encrypting only
the sensitive portion.

The special first-command prefix `@mcpctl/` resolves to this repository's
`agent/mcpctl/` directory at apply time. The starter catalog uses it for small
host adapters that give consistent stdio commands to GUI- or service-backed
tools without embedding a machine-specific repository path in the portable
store.

## Local server lifecycle

`mcpctl` distinguishes three separate states:

- **installed**: a package exists in mcpctl's isolated host root, or a required
  host application was installed independently;
- **enabled**: the server is present in one target client's managed config;
- **running**: a client-owned stdio process is active, or an external GUI/HTTP
  bridge is reachable.

Inspect requirements and state without changing anything:

```bash
mcpctl server doctor chrome-devtools
mcpctl server doctor --all
mcpctl server status chrome-devtools
mcpctl server status --all
```

Package-backed definitions can be installed without a global npm or Python
tool installation:

```bash
mcpctl server install chrome-devtools
mcpctl server install playwright-headless
mcpctl server install gdb
mcpctl server install frida
mcpctl server install ghidra-headless

# Preview without downloading or writing.
mcpctl server install chrome-devtools --dry-run
```

The default root is `~/.local/share/mcpctl/servers/<server>`. The generated MCP
command prefers that owned executable and falls back to the catalog's pinned
`npx` or `uvx` invocation when it is absent. Set `MCPCTL_HOST_ROOT` to choose an
absolute alternative. Package installation runs the selected upstream
package's installer code, so review the catalog's pinned package before using
`install`.

Uninstall never removes a system package, application, checkout, or directory
without a valid mcpctl ownership manifest. It moves an owned install into
recoverable trash instead of deleting it:

```bash
mcpctl server uninstall chrome-devtools
```

IDA Pro/IDALib, Burp, Ghidra, JADX, Apktool, Cutter, x64dbg, radare2, LLDB, and
Anything Analyzer remain manual host installations. `server install` refuses
to impersonate their vendor installer and prints the catalog setup guidance;
`server doctor` detects their command, environment, platform, and loopback
bridge requirements.

Enable or disable one server while preserving the target's other managed
servers:

```bash
mcpctl server enable gdb --target codex
mcpctl server disable gdb --target codex

# Show the exact add/remove plan only.
mcpctl server enable frida --target claude --dry-run
```

This records a `custom` selection based on the previously applied profile.
Enabling one member of a variant group, such as `playwright-headless`, removes
the currently enabled sibling automatically. Applying a named profile later
replaces the custom selection normally.

Most local MCPs use stdio, so there is intentionally no background daemon for
`mcpctl` to own: the agent client starts and stops them on demand. Consequently
`server start` performs readiness checks, while `server stop`/`restart` explain
that the client must be reloaded or the server disabled. GUI plugins and local
HTTP bridges remain externally owned and are only probed on loopback; mcpctl
does not kill IDA, Burp, Ghidra, Anything Analyzer, or debugger processes.

## Local research tool setup

Selecting or enabling a local server writes its MCP configuration; it does not
silently install or start third-party software. Installation happens only with
the explicit `server install` command above. The plan prints the relevant setup
note. The included integrations expect:

- `radare2`: install Radare2, then run `r2pm -Uci r2mcp`.
- `gdb`: install GDB and `uv`; the pinned `gdb-mcp` package uses the isolated
  installation when present and otherwise runs through `uvx`.
- `lldb`: install an LLVM build containing `lldb-mcp`.
- `ghidra`: install GhidraMCP 6.x, enable its GUI plugin, and install the
  released `bridge-mcp-ghidra` wheel. A source checkout can instead be selected
  with `GHIDRA_MCP_DIR`.
- `ghidra-headless`: install Ghidra and `uv`, then export
  `GHIDRA_INSTALL_DIR=/opt/ghidra` and an absolute writable
  `GHIDRA_MCP_PROJECT_PATH=/srv/reverse/ghidra-projects`.
- `jadx`: install the JADX plugin and put `jadx_mcp_server` on `PATH`.
- `apktool`: install `apktool`; either put `apktool_mcp_server` on `PATH` or
  export `APKTOOL_MCP_DIR=/absolute/path/to/apktool-mcp-server`.
- `idalib`: activate IDA Pro's idalib and install `idalib-mcp`. IDA Free is
  not supported by this integration.
- `frida`: install Node.js 20 or newer. Android targets additionally need
  `adb` and a matching `frida-server`.
- `js-reverse*`: install Node.js 20.19 or newer and Chrome. These are headed
  integrations; choose persistent, isolated, or CloakBrowser mode. Export an
  absolute `JS_REVERSE_ALLOWED_ROOT` to constrain local file reads and writes.
- `cutter`: install CutterMCP-plus, install its wrapper dependencies, copy its
  plugin into Cutter, and export `CUTTER_MCP_DIR=/absolute/path/CutterMCP-plus`.
- `x64dbg`: inside Windows, install the x64dbgMCP plugin and export
  `X64DBG_MCP_SCRIPT=C:\\absolute\\path\\to\\src\\x64dbg.py` in the shell
  that launches the MCP client.
- `burp`: load and enable PortSwigger's MCP extension, extract its stdio proxy
  JAR, and export `BURP_MCP_PROXY_JAR=/absolute/path/mcp-proxy-all.jar`.
- `anything-analyzer`: install the desktop app, enable its authenticated MCP
  Server on port `23816`, then provide the generated token through
  `ANYTHING_ANALYZER_MCP_TOKEN` or the encrypted
  `anything_analyzer_mcp_token` Secret. Block inbound port `23816` at the host
  firewall; the catalog connects only to `127.0.0.1`.

The full Debian Headless, Xvfb GUI, and Windows VM topology is documented in
[`REVERSE_LAB.md`](REVERSE_LAB.md). It also explains why JADX CLI and Rizin are
not represented as fake standalone MCP servers: the selected JADX integration
is GUI-plugin-backed, while Rizin is exposed through Cutter.

The Android command-line roles are intentionally kept distinct. JADX
decompiles Dex/APK content to readable Java; it does not rebuild edited smali.
Apktool decodes and rebuilds resources and smali, `apksigner` signs the rebuilt
APK, and `adb` installs it or connects to the device. They are host tools used
by the selected MCPs, not separate MCP endpoints in this catalog.

For the CloakBrowser presets, first run a CDP service bound only to localhost:

```bash
docker run -d --name cloak \
  -p 127.0.0.1:9222:9222 \
  cloakhq/cloakbrowser cloakserve
```

Both adapters default to `http://127.0.0.1:9222`. Override that with
`CLOAKBROWSER_CDP_ENDPOINT` when needed. CDP grants complete control of the
browser, so it must not be exposed publicly without a separate authenticated
boundary. CloakBrowser's wrapper-level `humanize` behavior is not inherited by
a separate MCP client connected over plain CDP.

Camoufox, Patchright, and Rebrowser remain browser runtimes rather than MCP
servers. They are intentionally not represented as fake selectable servers;
they need a dedicated adapter that preserves their own patched automation
layer.

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
    "context7_api_key": "...",
    "github_mcp_pat": "..."
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
mcpctl secrets edit
```

Keep every age private identity outside this repository. Each machine should
normally have a different identity; add its public recipient from an already
trusted machine. Keep a separate offline recovery identity.

The guided configuration center asks only for the public age recipient. Never
paste an `AGE-SECRET-KEY-...` identity into that prompt.

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
daily-search -> reverse-native

remove: brave, exa, context7, fetch, chrome-devtools, chrome-devtools-cloak
add:    ghidra, idalib, radare2, frida
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
MCPCTL_CLAUDE_CONFIG=/path/.claude.json
MCPCTL_CODEX_CONFIG=/path/config.toml
MCPCTL_OPENCODE_CONFIG=/path/opencode.json
```

## Test

```bash
./agent/mcpctl/test.sh
./agent/test.sh
```

The tests use an isolated temporary home, fake host commands, a fake SOPS
command, and an in-memory Worker/R2 binding. They do not contact MCP services,
Cloudflare, or real agent configuration.
