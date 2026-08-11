-- Row Level Security for arxave's hosted store.
--
-- WHEN TO RUN THIS: after the pipeline has connected to the database at least
-- once (the first `arxave run` against $SUPABASE_DB_URL creates the tables via
-- CREATE TABLE IF NOT EXISTS). Then paste this file into the Supabase SQL
-- editor and run it. It is idempotent — safe to re-run.
--
-- THE MODEL:
--   * papers, refs, embeddings  — shared, read by everyone, written only by the
--     5am batch. The batch connects with the service_role key, which BYPASSES
--     RLS, so no write policy is needed (or wanted) for regular users.
--   * summaries                 — the shared baseline row (user_id = '') is
--     readable by all; a signed-in user reads/writes only their own rows.
--   * user_filters              — fully private: a user sees only their own.
--
-- auth.uid() is the id Supabase assigns on sign-in (including ANONYMOUS
-- sign-in). It is a uuid; user_id is TEXT, so we compare against its ::text.

-- ---------------------------------------------------------------------------
-- Shared, read-only-to-clients tables
-- ---------------------------------------------------------------------------
alter table papers      enable row level security;
alter table refs        enable row level security;
alter table embeddings  enable row level security;

drop policy if exists papers_read_all on papers;
create policy papers_read_all on papers
  for select using (true);

drop policy if exists refs_read_all on refs;
create policy refs_read_all on refs
  for select using (true);

drop policy if exists embeddings_read_all on embeddings;
create policy embeddings_read_all on embeddings
  for select using (true);

-- ---------------------------------------------------------------------------
-- summaries — shared baseline readable by all; own rows read/write
-- ---------------------------------------------------------------------------
alter table summaries enable row level security;

drop policy if exists summaries_read on summaries;
create policy summaries_read on summaries
  for select using (user_id = '' or user_id = auth.uid()::text);

drop policy if exists summaries_write_own on summaries;
create policy summaries_write_own on summaries
  for all
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- user_filters — strictly private per user
-- ---------------------------------------------------------------------------
alter table user_filters enable row level security;

drop policy if exists user_filters_own on user_filters;
create policy user_filters_own on user_filters
  for all
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- dig_vectors — the Dig's shared vector cache
--
-- No policies, on purpose. Clients never touch this table directly: they go
-- through the `dig-cache` edge function, which holds the service_role key and
-- so bypasses RLS. Enabling RLS with no policy is therefore the correct
-- posture — deny-all for anon and authenticated, full access for the function.
-- A direct anon SELECT would be harmless, but a direct anon INSERT would let
-- anyone plant a vector nobody can verify, so the table stays closed and the
-- function stays the only door.
-- ---------------------------------------------------------------------------
alter table dig_vectors enable row level security;

-- Note: the runs table is batch-internal bookkeeping. Leave RLS off (default
-- deny for anon, full access for service_role) — clients never read it.
