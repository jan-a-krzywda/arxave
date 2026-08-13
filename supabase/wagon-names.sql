-- The shared wagon-name cache, and the meter in front of it.
--
-- WHEN TO RUN THIS: before deploying the `wagon-name` edge function. Paste
-- into the Supabase SQL editor and run. It is idempotent — safe to re-run.
--
-- WHY THE METER IS IN POSTGRES AND NOT IN THE FUNCTION. `embed` keeps its
-- per-IP budget in an isolate-local Map, and says so honestly: an isolate
-- recycle resets it, which makes it a speed bump. That is an acceptable trade
-- for CPU on a function nobody is billed for by the call. `wagon-name` calls a
-- metered third-party API on the deployer's key, so its budget has to survive
-- an isolate recycle, a cold start, and two isolates running at once. A row
-- with a transactional increment does; a Map does not.
--
-- WHAT IS NOT STORED: IP addresses. The function hashes the caller's address
-- with a salt it holds as a secret (`WAGON_NAME_SALT`) and stores 32 hex
-- characters of that. Enough to count against, not enough to reverse.

-- ---------------------------------------------------------------------------
-- The cache
-- ---------------------------------------------------------------------------
-- wagon_key is sha256 over the wagon's sorted `id\ttitle` lines — see
-- `supabase/functions/wagon-name/naming.ts`, which is the shared definition
-- and carries the reasoning for folding titles into the key rather than
-- hashing ids alone.
create table if not exists wagon_names (
  wagon_key  text primary key,
  name       text not null,
  gloss      text not null default '',
  model      text not null default '',
  members    int  not null default 0,
  created_at timestamptz not null default now(),
  -- Last day someone asked for this name. The prune reads this, not
  -- created_at, so a wagon that re-forms every morning is generated once.
  seen       date not null default current_date
);

create index if not exists wagon_names_seen_idx on wagon_names (seen);

-- ---------------------------------------------------------------------------
-- The meter
-- ---------------------------------------------------------------------------
-- One row per (day, client). The global ceiling lives in the same table under
-- the reserved client '@global', so both limits are one table and one lock
-- order — which is what keeps the two checks from deadlocking against each
-- other under concurrency.
create table if not exists wagon_name_budget (
  day    date not null default current_date,
  client text not null,
  calls  int  not null default 0,
  primary key (day, client)
);

-- ---------------------------------------------------------------------------
-- Spend
-- ---------------------------------------------------------------------------
-- Grants up to `p_want` calls against both the per-client and the global daily
-- cap, and returns how many it actually granted — which may be fewer, and may
-- be zero. The caller must make no more calls than the number it gets back.
--
-- BOTH CAPS MOVE TOGETHER OR NEITHER DOES. Checking them in two round trips
-- would let a client be debited for calls the global cap then refuses, and
-- that drift is unrecoverable without a reconciliation pass. One function, one
-- transaction, `least()` of the two headrooms.
--
-- A NEGATIVE p_want IS A REFUND, and it is why this is not a plain increment.
-- A granted call that Gemini then refuses, blocks, or times out produced no
-- name; charging for it would let one bad afternoon at the provider burn a
-- caller's whole day. The refund is floored at zero so a double refund cannot
-- mint credit.
--
-- The global row is always touched before the client row. Consistent lock
-- order across every caller is the whole deadlock story here.
create or replace function public.wagon_name_spend(
  p_client     text,
  p_want       int,
  p_client_cap int,
  p_global_cap int
) returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  used_global int;
  used_client int;
  granted     int;
begin
  if p_want < 0 then
    update public.wagon_name_budget
       set calls = greatest(calls + p_want, 0)
     where day = current_date and client = '@global';
    update public.wagon_name_budget
       set calls = greatest(calls + p_want, 0)
     where day = current_date and client = p_client;
    return p_want;
  end if;

  if p_want = 0 then return 0; end if;

  insert into public.wagon_name_budget (day, client, calls)
  values (current_date, '@global', 0)
  on conflict (day, client) do nothing;

  insert into public.wagon_name_budget (day, client, calls)
  values (current_date, p_client, 0)
  on conflict (day, client) do nothing;

  select calls into used_global from public.wagon_name_budget
   where day = current_date and client = '@global' for update;

  select calls into used_client from public.wagon_name_budget
   where day = current_date and client = p_client for update;

  granted := least(
    p_want,
    greatest(p_global_cap - used_global, 0),
    greatest(p_client_cap - used_client, 0)
  );

  if granted > 0 then
    update public.wagon_name_budget set calls = calls + granted
     where day = current_date and client in ('@global', p_client);
  end if;

  return granted;
end;
$$;

-- A function in `public` is callable over PostgREST by anyone holding the anon
-- key, and that key is published in the static page. Without this revoke a
-- stranger could grant themselves the whole day's budget — or, more cheaply,
-- call it with a huge p_want and exhaust the global cap for everyone.
revoke all on function public.wagon_name_spend(text, int, int, int)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Prune
-- ---------------------------------------------------------------------------
-- Names nobody has asked for in 60 days, and budget rows older than a week.
-- The names table is tiny (a few hundred short rows a month) so this is about
-- staying honest rather than about space: a name generated from titles that
-- have since been revised should eventually be re-earned.
create or replace function public.wagon_name_prune()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.wagon_names where seen < current_date - 60;
  delete from public.wagon_name_budget where day < current_date - 7;
$$;

revoke all on function public.wagon_name_prune() from public, anon, authenticated;

-- pg_cron is already enabled by warm-cron.sql; this only adds a job.
select cron.unschedule('wagon-name-prune')
 where exists (select 1 from cron.job where jobname = 'wagon-name-prune');

select cron.schedule(
  'wagon-name-prune',
  '40 3 * * *',
  $job$ select public.wagon_name_prune(); $job$
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- No policies, on purpose, exactly as with dig_vectors: clients never touch
-- these tables directly, they go through the edge function, which holds the
-- service_role key and bypasses RLS. Enabling RLS with no policy is the
-- correct posture — deny-all for anon and authenticated, full access for the
-- function.
--
-- Here it matters more than it does for dig_vectors. A direct anon SELECT on
-- wagon_names would be harmless, but a direct anon UPDATE on wagon_name_budget
-- would zero the meter, and a direct anon INSERT on wagon_names would let
-- anyone write whatever text they liked under a key other people compute
-- honestly — which is the one poisoning route the key design does not close.
alter table wagon_names       enable row level security;
alter table wagon_name_budget enable row level security;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
--   -- the meter grants, then refuses past the cap:
--   select public.wagon_name_spend('test', 5, 10, 100);   -- 5
--   select public.wagon_name_spend('test', 8, 10, 100);   -- 5, capped
--   select public.wagon_name_spend('test', 1, 10, 100);   -- 0
--   select public.wagon_name_spend('test', -2, 10, 100);  -- refund
--   select public.wagon_name_spend('test', 1, 10, 100);   -- 1 again
--   select * from public.wagon_name_budget where day = current_date;
--   delete from public.wagon_name_budget where client in ('test', '@global');
--
--   -- the prune job registered:
--   select jobname, schedule, active from cron.job where jobname = 'wagon-name-prune';
