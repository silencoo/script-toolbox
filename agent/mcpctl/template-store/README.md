# Personal MCP store

This directory is consumed by `mcpctl`.

- `catalog.json` defines servers without embedding secret values.
- `profiles/*.json` selects servers for tasks and targets.
- `secrets.sops.json`, when present, contains SOPS-encrypted secret values.
- `secrets.remote.enc`, when present after restore, is an AES-GCM-encrypted
  local cache derived from the remote recovery root.
- `.sops.yaml.example` is a recipient configuration template.
- `.gitignore` excludes common plaintext secret filenames.

The included `frontend`, `research`, `reverse`, and `off` profiles are starting
points. `reverse` intentionally contains no invented analysis server: add your
private reverse-engineering MCP definitions to `catalog.json`, then enable
their names in `profiles/reverse.json`.

See the main `agent/mcpctl/README.md` for the schema, SOPS setup, encrypted
remote backup, and commands.
