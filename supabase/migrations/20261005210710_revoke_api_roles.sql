-- Supabase grants its Data API roles (anon: the public key in the website's
-- JavaScript; authenticated: any signed-in user) full privileges on every
-- public table, and its default privileges do the same for every table
-- created later. RLS with no policies (LLD §2) is what keeps them out today,
-- so a future table that forgot `enable row level security` would be open to
-- anyone holding the public key. No data goes through the Data API in this
-- design (only the API function, as postgres, connects), so take the grants
-- away and make that the default for new objects too. service_role and
-- postgres are untouched.

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

-- Applies to objects created by the role running migrations (postgres, the
-- owner of every table here), locally and on a hosted project.
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
