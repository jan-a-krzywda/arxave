-- refine_usage — the daily meter in front of the `refine` edge function.
--
-- WHEN TO RUN THIS: before deploying `refine`. Paste into the Supabase SQL
-- editor and run. It is idempotent — safe to re-run.
--
-- WHY THE METER IS A TABLE AND NOT AN ISOLATE'S MEMORY. `embed` keeps its
-- per-IP bucket in an isolate-local Map and says so honestly: an isolate
-- recycle resets it, which makes it a speed bump. That is an acceptable trade
-- for CPU on a function nobody is billed for by the call. `refine` calls a
-- metered third-party API on the deployer's key, so its budget has to survive
-- an isolate recycle, a cold start, and two isolates running at once. A row
-- with a transactional increment does; a Map does not.
--
-- WHAT IS NOT STORED: IP addresses. The function hashes the caller's address
-- with a salt it holds as a secret (`REFINE_SALT`) and stores 32 hex characters
-- of that. Enough to count against, not enough to reverse. Nothing else about a
-- request is stored — least of all a BYO `x-llm-key`, which never reaches the
-- meter because a BYO call skips it.
--
-- One row per (day, client). The global ceiling lives in the same table under
-- the reserved client '@global', so both limits are one table and one lock
-- order — which is what keeps the two checks from deadlocking against each
-- other under concurrency. The game is identical to wagon_name_budget's; the
-- limits differ (30 per address, 500 across everyone, per UTC day).
create table if not exists refine_usage (
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
-- would let a client be debited for calls the global cap then refuses, and that
-- drift is unrecoverable without a reconciliation pass. One function, one
-- transaction, `least()` of the two headrooms.
--
-- A NEGATIVE p_want IS A REFUND, and it is why this is not a plain increment. A
-- granted call the provider then refuses, or answers with something that does
-- not validate, produced no refine; charging for it would let one bad afternoon
-- upstream burn a caller's whole day. The refund is floored at zero so a double
-- refund cannot mint credit.
--
-- The global row is always touched before the client row. Consistent lock order
-- across every caller is the whole deadlock story here.
create or replace function public.refine_usage_spend(
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
    update public.refine_usage
       set calls = greatest(calls + p_want, 0)
     where day = current_date and client = '@global';
    update public.refine_usage
       set calls = greatest(calls + p_want, 0)
     where day = current_date and client = p_client;
    return p_want;
  end if;

  if p_want = 0 then return 0; end if;

  insert into public.refine_usage (day, client, calls)
  values (current_date, '@global', 0)
  on conflict (day, client) do nothing;

  insert into public.refine_usage (day, client, calls)
  values (current_date, p_client, 0)
  on conflict (day, client) do nothing;

  select calls into used_global from public.refine_usage
   where day = current_date and client = '@global' for update;

  select calls into used_client from public.refine_usage
   where day = current_date and client = p_client for update;

  granted := least(
    p_want,
    greatest(p_global_cap - used_global, 0),
    greatest(p_client_cap - used_client, 0)
  );

  if granted > 0 then
    update public.refine_usage set calls = calls + granted
     where day = current_date and client in ('@global', p_client);
  end if;

  return granted;
end;
$$;

-- A function in `public` is callable over PostgREST by anyone holding the anon
-- key, and that key is published in the static page. Without this revoke a
-- stranger could grant themselves the whole day's budget — or, more cheaply,
-- call it with a huge p_want and exhaust the global cap for everyone.
revoke all on function public.refine_usage_spend(text, int, int, int)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Prune
-- ---------------------------------------------------------------------------
-- Budget rows older than a week. Tiny either way, but a day-keyed table that
-- only ever grows is a slow leak nobody notices until it is large.
create or replace function public.refine_usage_prune()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.refine_usage where day < current_date - 7;
$$;

revoke all on function public.refine_usage_prune() from public, anon, authenticated;

-- pg_cron is enabled by warm-cron.sql; this only adds a job.
select cron.unschedule('refine-usage-prune')
 where exists (select 1 from cron.job where jobname = 'refine-usage-prune');

select cron.schedule(
  'refine-usage-prune',
  '45 3 * * *',
  $job$ select public.refine_usage_prune(); $job$
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- No policies, on purpose, exactly as with dig_vectors and wagon_names:
-- clients never touch this table directly, they go through the edge function,
-- which holds the service_role key and bypasses RLS. Enabling RLS with no
-- policy is the correct posture — deny-all for anon and authenticated, full
-- access for the function. Here it matters: a direct anon UPDATE would zero the
-- meter.
alter table refine_usage enable row level security;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
--   -- the meter grants, then refuses past the cap:
--   select public.refine_usage_spend('test', 1, 2, 100);   -- 1
--   select public.refine_usage_spend('test', 1, 2, 100);   -- 1
--   select public.refine_usage_spend('test', 1, 2, 100);   -- 0, capped
--   select public.refine_usage_spend('test', -1, 2, 100);  -- refund
--   select public.refine_usage_spend('test', 1, 2, 100);   -- 1 again
--   select * from public.refine_usage where day = current_date;
--   delete from public.refine_usage where client in ('test', '@global');
--
--   -- the prune job registered:
--   select jobname, schedule, active from cron.job where jobname = 'refine-usage-prune';
