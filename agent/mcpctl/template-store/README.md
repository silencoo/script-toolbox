# Personal MCP store

This directory is consumed by `mcpctl`.

- `catalog.json` defines servers without embedding secret values.
- `profiles/*.json` selects servers for tasks and targets.
- `secrets.sops.json`, when present, contains SOPS-encrypted secret values.
- `secrets.remote.enc`, when present after restore, is an AES-GCM-encrypted
  local cache derived from the remote recovery root.
- `.sops.yaml.example` is a recipient configuration template.
- `.gitignore` excludes common plaintext secret filenames.

The `mcpctl` configuration menu can create `.sops.yaml` from a public age
recipient and launch `mcpctl secrets edit`. Never enter or store the matching
private age identity in this directory.

The included profiles cover coding, standard, headless, and CloakBrowser-backed
browser work; native, Ghidra, Android, IDA, Frida, Cutter, JavaScript, Debian
Headless, and Windows reverse engineering; Burp- and Anything
Analyzer-assisted web analysis; search; and an `off` profile. Most profiles
stay intentionally narrow so unrelated MCP schemas are not loaded into every
agent session. The broader `reverse-headless`, `reverse-debian-headless`,
`reverse-gui`, and `web-reverse-full` profiles are explicit lab bundles.

The search presets include Keenable anonymous/optional-key access and three
mutually exclusive Tavily modes: keyless, API key, and client-owned OAuth.
Their API keys use Secret descriptors and request headers rather than URL
parameters. OAuth tokens stay in the MCP client and are not part of this
Store.

Local research entries describe human guidance in `setup` and machine-readable
installation, platform, dependency, and service checks in `host`. Applying a
profile writes client configuration but does not install or start third-party
software. Explicit `mcpctl server install` commands place supported npm/uv
packages in mcpctl's isolated host root; manual applications such as IDA,
Burp, Ghidra, and x64dbg remain externally owned. Commands beginning with
`@mcpctl/` are portable store references that resolve to the active toolbox
checkout when applied. After upgrading the toolbox, `mcpctl sync` adds missing
bundled servers and profiles and can migrate exact recognized legacy package
launchers, without changing custom package versions.

Unpublished Python MCPs may be stored as small wheels under `artifacts/` and
referenced with `@mcpctl-store/artifacts/<wheel>` plus a pinned SHA-256 in the
server's `host.install` object. Only referenced artifacts are included in the
end-to-end encrypted backup; absolute local binary paths are not portable.

`mcpctl import --target claude|codex --write` can add existing user MCP
definitions and creates an importer-owned `imported` profile with a separate
enabled set for each target. Static environment, Header, and credential
argument values are stored in `secrets.remote.enc`, never in `catalog.json`.
Import does not upload a backup; run `mcpctl backup` after reviewing it.

See the main `agent/mcpctl/README.md` for the schema, SOPS setup, encrypted
remote backup, commands, and the reverse-lab deployment guide.
