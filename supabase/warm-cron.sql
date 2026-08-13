-- The clock for the Dig warmer.
--
-- WHY THIS EXISTS AT ALL: the warm job used to be scheduled by GitHub Actions
-- `on: schedule`, and that dispatcher is best-effort. Measured on this repo:
-- a `30 1` cron fired at 03:38 UTC (+2h08) and a `13 6` cron at 07:50 UTC
-- (+1h37). arXiv rebuilds its announcement RSS at 04:00 UTC (06:00 CEST), so a
-- warm that slips two hours lands at 08:00 CEST — after the morning it was
-- meant to serve. The work itself is fine where it is (a 32 MB model and ~750
-- embeddings do not belong in a cron container); it was only ever the *clock*
-- that was wrong.
--
-- `workflow_dispatch`, by contrast, starts immediately. Measured 2026-08-12:
-- created 06:50:44Z, started 06:50:44Z, finished 06:51:48Z. So pg_cron holds
-- the schedule and GitHub keeps doing the work.
--
-- WHEN TO RUN THIS: after creating the GitHub token below. Paste into the
-- Supabase SQL editor and run. It is idempotent — safe to re-run.
--
-- ---------------------------------------------------------------------------
-- Step 1 — the token (do this first, by hand, once)
-- ---------------------------------------------------------------------------
-- A fine-grained personal access token on jan-a-krzywda/arxave with exactly one
-- permission: **Actions: Read and write**. Nothing else — this token can start
-- a workflow and should not be able to do anything more if the database leaks.
--
--   https://github.com/settings/personal-access-tokens/new
--
-- Then store it in Vault, never in this file:
--
--   select vault.create_secret(
--     'github_pat_…',                 -- the token
--     'github_warm_dispatch_token',   -- the name this file looks up
--     'Starts warm-dig.yml via the Actions dispatch API'
--   );
--
-- To rotate it later, replace rather than re-create:
--
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'github_warm_dispatch_token'),
--     'github_pat_…new…'
--   );
--
-- Fine-grained tokens expire (a year at most). The expiry is the one failure
-- this whole path cannot detect on its own — see the health check at the
-- bottom, which is why it exists.

-- ---------------------------------------------------------------------------
-- Step 2 — extensions
-- ---------------------------------------------------------------------------
-- pg_cron is the schedule; pg_net makes the outbound POST. Both ship with
-- Supabase but are off until asked for. pg_cron must live in its own schema.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net  with schema extensions;

-- ---------------------------------------------------------------------------
-- Step 3 — the dispatcher
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because the cron job must read a Vault secret that the
-- calling role has no business reading directly. `search_path = ''` with every
-- name fully qualified is what keeps that safe: a definer function that
-- resolves an unqualified name can be hijacked by a schema on someone else's
-- search_path.
create or replace function public.dispatch_warm_dig()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  tok text;
  req bigint;
begin
  select decrypted_secret into tok
    from vault.decrypted_secrets
   where name = 'github_warm_dispatch_token';

  -- Loud, because the alternative is a silent no-op every morning. A raised
  -- exception lands in cron.job_run_details with status 'failed', which the
  -- health check below actually looks at.
  if tok is null or tok = '' then
    raise exception
      'vault secret github_warm_dispatch_token is missing — see supabase/warm-cron.sql step 1';
  end if;

  -- GitHub answers 204 with an empty body on success. pg_net is fire-and-
  -- forget: this returns a request id, and the response lands in
  -- net._http_response a moment later. Nothing here can see the status, which
  -- is the other reason for the health check.
  select net.http_post(
    url := 'https://api.github.com/repos/jan-a-krzywda/arxave'
           || '/actions/workflows/warm-dig.yml/dispatches',
    body := jsonb_build_object('ref', 'main'),
    headers := jsonb_build_object(
      'Authorization',        'Bearer ' || tok,
      'Accept',               'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent',           'arxave-warm-cron',
      'Content-Type',         'application/json'
    ),
    timeout_milliseconds := 10000
  ) into req;

  return req;
end;
$$;

-- A function in `public` is reachable over PostgREST by anyone holding the anon
-- key — which is published in the static page. Without this revoke, a stranger
-- could start the workflow at will.
revoke all on function public.dispatch_warm_dig() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Step 4 — the schedule
-- ---------------------------------------------------------------------------
-- pg_cron reads the cluster timezone, which is UTC on Supabase. These are UTC,
-- and like GitHub's cron they do not follow DST — in winter they are 05:10 and
-- 07:13 CET. The offset from arXiv's 04:00 UTC rebuild is what matters, not the
-- local clock, so leave them alone unless arXiv moves.
--
--   04:10 UTC (06:10 CEST) — the morning run. Ten minutes after the measured
--   04:00:21 rebuild, and the run takes ~1 min, so the cache is warm by about
--   06:12 CEST.
--
--   06:13 UTC (08:13 CEST) — the catch-up, for mornings arXiv rebuilds late.
--   The warmer only embeds what is not already cached, so on a normal day this
--   costs a minute and writes nothing. It refuses a stale feed (exit 3) rather
--   than reporting a healthy-looking run over yesterday's papers.
--
-- arXiv posts Mon–Fri UTC (the feed carries <skipDays>Sat, Sun</skipDays>).
--
-- cron.schedule() on an existing jobname updates it in place, but only since
-- pg_cron 1.4 — unschedule first so this file behaves the same on any version.
select cron.unschedule('warm-dig-morning')
 where exists (select 1 from cron.job where jobname = 'warm-dig-morning');

select cron.unschedule('warm-dig-catchup')
 where exists (select 1 from cron.job where jobname = 'warm-dig-catchup');

select cron.schedule(
  'warm-dig-morning',
  '10 4 * * 1-5',
  $job$ select public.dispatch_warm_dig(); $job$
);

select cron.schedule(
  'warm-dig-catchup',
  '13 6 * * 1-5',
  $job$ select public.dispatch_warm_dig(); $job$
);

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- Both jobs registered, and the timezone they will actually fire in:
--
--   select jobname, schedule, active from cron.job
--    where jobname like 'warm-dig-%';
--   show timezone;                      -- expect UTC
--
-- Fire one by hand and watch it land. GitHub answers 204 with no body:
--
--   select public.dispatch_warm_dig();  -- note the request id
--   select id, status_code, error_msg, created
--     from net._http_response order by id desc limit 5;
--
-- Then confirm a run actually started:
--
--   gh run list --workflow warm-dig.yml --limit 3
--
-- ---------------------------------------------------------------------------
-- Test the schedule (not just the function)
-- ---------------------------------------------------------------------------
-- `select public.dispatch_warm_dig();` proves the token and the POST work. It
-- does NOT prove pg_cron fires — which is the thing GitHub got wrong, so it is
-- the thing worth testing. This schedules a real run five minutes from whenever
-- you paste it; the format() computes the minute and hour so the expression is
-- never stale:
--
--   select cron.schedule(
--     'warm-dig-test',
--     format('%s %s * * *',
--       extract(minute from (now() + interval '5 minutes') at time zone 'UTC')::int,
--       extract(hour   from (now() + interval '5 minutes') at time zone 'UTC')::int),
--     $job$ select public.dispatch_warm_dig(); $job$
--   );
--
--   select jobname, schedule, active from cron.job where jobname = 'warm-dig-test';
--
-- Five minutes later, in order — did cron fire, did GitHub accept, did a run start:
--
--   select jobid, status, return_message, start_time
--     from cron.job_run_details order by runid desc limit 5;
--   select id, status_code, error_msg, created
--     from net._http_response order by id desc limit 5;   -- expect 204
--   -- gh run list --workflow warm-dig.yml --limit 3
--
-- THEN REMOVE IT. Left alone it fires every day at that minute, forever:
--
--   select cron.unschedule('warm-dig-test');
--
-- ---------------------------------------------------------------------------
-- Health check
-- ---------------------------------------------------------------------------
-- The failure this path cannot feel: the token expires, GitHub answers 401,
-- pg_cron records a *successful* run (the POST was made; nobody read the
-- reply), and the cache quietly stops being warm in the morning. There is no
-- GitHub cron behind it any more to cover that.
--
-- So check the reply, not the run. Anything other than 204 in the last week:
--
--   select r.id, r.status_code, r.content, r.created
--     from net._http_response r
--    where r.created > now() - interval '7 days'
--      and r.status_code is distinct from 204
--    order by r.id desc;
--
-- pg_net prunes _http_response after ~6 hours by default, so run that in the
-- morning or raise the retention. The cheaper daily tell is simply whether the
-- feed moved:
--
--   git log -1 --format=%ci origin/main -- docs/feeds/
