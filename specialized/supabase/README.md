# Supabase diagnostics

**Unsafe for production — temporary troubleshooting only.**

[rls-allow-all.sql](diagnostics/rls-allow-all.sql) demonstrates unrestricted row
access. It is a reference snippet, not an initializer or automatic migration.
It was moved unchanged from `resources/database/supabase-rls-allow-all.sql`.

Review both table grants and row-level security. Replace the example with
policies scoped to the actual role and row owner before production use.
Never run it against a live database merely to test this repository.
