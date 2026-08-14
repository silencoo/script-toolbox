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

The included profiles are deliberately compact. `daily` combines Context7,
Fetch, standard Chrome DevTools for a real browser, and CloakBrowser-backed
Chrome DevTools for the default isolated development browser. `daily-search`
adds both Brave and Exa for models without native web search. Reverse work is
grouped by task into web, native, mobile, headless, and Windows profiles, plus
an `off` profile.

Keenable and the three mutually exclusive Tavily authentication modes remain
available as catalog servers for one-off customization. They do not each add
another task profile. Their API keys use Secret descriptors and request
headers rather than URL parameters. OAuth tokens stay in the MCP client and
are not part of this Store.

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
