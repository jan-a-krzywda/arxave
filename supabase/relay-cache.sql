-- relay_cache — the shared copy of what arXiv already told us once.
--
-- WHY THIS EXISTS: the relay edge function fetches arXiv server-side, so arXiv
-- sees one client no matter how many people have the filter page open, and it
-- throttles per client. One haul is three upstream GETs; ten people hauling the
-- same night was thirty GETs for three distinct answers. Measured 2026-08-29,
-- the day after the page was shared: export.arxiv.org replied 429 "Rate
-- exceeded" and hauls started failing for everyone at once.
--
-- The announcement listing is rebuilt once a night, so the fix is to fetch each
-- URL once and hand the same bytes to everybody. The function keeps an
-- in-isolate copy too; this table is what survives an isolate being recycled
-- and what lets two isolates share one upstream call.
--
-- WHEN TO RUN THIS: before deploying the caching relay. Paste into the Supabase
-- SQL editor and run. It is idempotent — safe to re-run.

create table if not exists relay_cache (
  -- The absolute upstream URL, normalized by `new URL(...).toString()` so two
  -- people spelling the same query differently share one row.
  url          text primary key,
  status       smallint     not null,
  content_type text         not null default 'application/octet-stream',
  -- Every allowlisted host answers XML or JSON, so text is the honest type.
  -- The function refuses to store anything over 2 MB.
  body         text         not null,
  fetched_at   timestamptz  not null default now()
);

create index if not exists relay_cache_fetched_at_idx on relay_cache (fetched_at);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- No policies, on purpose — the same posture as dig_vectors. Clients never
-- touch this table directly; they go through the relay, which holds the
-- service_role key and so bypasses RLS. An anon SELECT here would be harmless
-- (it is public arXiv XML), but an anon INSERT would let anyone plant a fake
-- announcement feed that the page cannot tell from the real one. So the table
-- stays closed and the function stays the only door.
alter table relay_cache enable row level security;

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------
-- The relay serves a stored answer for 5 minutes (fresh) and will fall back to
-- one up to 12 hours old when arXiv is refusing. Past that it is dead weight:
-- a distinct URL per category per lookback per day adds up, and every row is a
-- feed-sized blob. A day of slack past the stale window is plenty.
create or replace function prune_relay_cache() returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  delete from public.relay_cache
   where fetched_at < now() - interval '36 hours';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- Hourly. pg_cron is already enabled by supabase/warm-cron.sql; this only needs
-- the extension, not that file's Vault secret.
create extension if not exists pg_cron with schema pg_catalog;

select cron.unschedule('prune-relay-cache')
 where exists (select 1 from cron.job where jobname = 'prune-relay-cache');

select cron.schedule('prune-relay-cache', '17 * * * *', $$select public.prune_relay_cache()$$);

-- ---------------------------------------------------------------------------
-- Health check
-- ---------------------------------------------------------------------------
-- What the cache is actually holding, newest first. An empty table after a
-- morning of hauls means the relay could not reach Postgres — it degrades to
-- fetching upstream every time rather than failing, so the symptom is 429s
-- coming back, not errors here.
--
--   select url, status, pg_size_pretty(length(body)::bigint) as size,
--          now() - fetched_at as age
--     from relay_cache
--    order by fetched_at desc;
