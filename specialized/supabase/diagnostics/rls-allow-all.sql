-- DANGER: development and emergency diagnostics only.
--
-- This policy gives every Postgres role covered by PUBLIC unrestricted
-- SELECT/INSERT/UPDATE/DELETE access to every row that its table grants allow.
-- It is not a production authorization policy. Supabase Data API grants and
-- RLS are separate layers, so review both before using this on any exposed
-- table: https://supabase.com/docs/guides/api/securing-your-api

-- 1. Enable RLS on the placeholder table.
ALTER TABLE "public"."your_table_name" ENABLE ROW LEVEL SECURITY;

-- 2. Allow all row operations. Replace this with role- and ownership-specific
-- policies immediately after the diagnostic session.
CREATE POLICY "Allow All Access"
ON "public"."your_table_name"
FOR ALL
TO public
USING (true)
WITH CHECK (true);
