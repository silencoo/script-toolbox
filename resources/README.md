# Reference resources

Small rule sets and diagnostic snippets live here so they remain searchable and
navigable without being promoted to standalone tools.

| Resource | Format | Intended use | Important caveat |
| --- | --- | --- | --- |
| [`network/adobe-blocking/adobe-process-block-rules.yaml`](./network/adobe-blocking/adobe-process-block-rules.yaml) | Process rules | Local reference for blocking selected Adobe processes | May disrupt licensing, updates, fonts, libraries, or cloud features |
| [`network/adobe-blocking/adobe-activation-blocklist.hosts`](./network/adobe-blocking/adobe-activation-blocklist.hosts) | Hosts entries | Historical activation-domain blocklist | Provenance is incomplete; do not treat it as a maintained security list |
| [`database/supabase-rls-allow-all.sql`](./database/supabase-rls-allow-all.sql) | PostgreSQL SQL | Short-lived development or emergency diagnosis | Grants unrestricted row access and is unsafe for production |

## Supabase warning

The SQL example deliberately demonstrates an unrestricted RLS policy. Supabase
documents grants and RLS as separate access-control layers: grants determine
whether a Data API role can reach an object, while RLS determines which rows it
can access. Review both layers and replace the example with policies scoped to
the actual role and row owner.

## Maintenance

- Treat every file as an input requiring review, not an installer.
- Keep generated or copied rule data attributed in `NOTICE.md`.
- Validate YAML after editing and review domain/process removals in the same
  change that updates the list.
