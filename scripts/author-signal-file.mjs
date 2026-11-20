/**
 * author-signal-file — the last author's h-index, as the static file the page
 * reads.
 *
 * THE LOOKUP IS A NIGHTLY JOB, NOT A REQUEST. The ranking page cannot ask
 * OpenAlex about ~700 last authors while a reader waits, and it should not:
 * one search per name, two in flight and a beat apart, a rate limit and a
 * polite-pool delay is a job with a clock. So the warmer asks once, turns each
 * answer into the 0..1 signal the order key wants
 * (`docs/assets/cave-affil.mjs`'s `authorSignal`), and writes
 * `feeds/author-signal/latest.json` — one same-origin file the page fetches for
 * free.
 *
 * THE FILE ACCUMULATES, THE CACHE EXPIRES. A reader on a quiet Sunday still
 * ranks a week of stones, so new ids merge over the previous file and the
 * oldest fall off at `cap`. The per-name cache is what keeps a night's cost
 * bounded: it is a database, filled once and asked only about NEW names after
 * that. How long an answer stands depends on what it said — an h-index moves by
 * a point a year, so 120 days is generous for a number, 60 for a "no such
 * person", and 14 for a hit that carried no number: that gap is a hole in
 * OpenAlex's data, which fills in weeks, not a fact about the author.
 *
 * A NARROW SEARCH'S NO IS ASKED AGAIN. Until 2026-11-20 the lookup filtered
 * OpenAlex to Physics & Astronomy alone, which hid most computer-science and ML
 * authors: of 24 cached nulls, 6 resolved under that filter and 15 once Computer
 * Science was included. The cache now says `version: 2`, and a cached no
 * (`no-match` or `ambiguous`) from an older or unversioned file is not trusted —
 * it is asked again. A number is a number under any filter, and `no-hindex` is a
 * hole in the data, so both still stand.
 *
 * A NIGHT HAS A BUDGET. The run asks at most `maxNew` names (300), two at a
 * time, each first try `paceMs` (300 ms) after the last — because the live
 * nights could not tell a per-second limit from a daily allowance, so we ask as
 * if it were both. Whatever the cap leaves over is skipped, NOT cached, so
 * tomorrow's night asks it; it is null tonight, and null adds nothing.
 *
 * NOTHING HERE THROWS. A 429, a timeout, a body that is not JSON — that name is
 * null, and null adds nothing to the order key. A lookup that never happened is
 * not evidence against a paper.
 *
 * A 429 IS ASKED AGAIN, NOT BELIEVED. The first night with a fresh key answered
 * error for 376 of 486 names, and the log said nothing more: every status was
 * thrown away. So a throttled or wobbling answer is retried — three more tries,
 * the server's `Retry-After` when it gives one, a 1/2/4 s ladder otherwise —
 * the night counts its statuses on the last line (`http:`), keeps the FIRST 429
 * response body and Retry-After (the only evidence of which limit we hit), and
 * a name that is still an error is not written to the cache at all: tomorrow
 * asks again. Five errors in a row say the key is shut for the night, not that
 * these five names are bad: the run stops asking and the rest wait for
 * tomorrow, while requests already in the air still land.
 *
 * Everything with a socket or a clock is a parameter (`fetch`, `today`, `cache`,
 * `sleep`, `jitter`), so the tests run the whole thing on hand-built payloads
 * without leaving the process.
 */

import {
  AFFIL_PREFIX, affilKey, authorQueryUrl, authorSignal, explainHIndex, lastAuthor,
} from '../docs/assets/cave-affil.mjs';

/** Where the signal saturates — cave-affil's default, restated in the file. */
export const H_SATURATION = 60;

/** Requests in flight at once. OpenAlex's polite pool rewards no burst: two,
    with `paceMs` between the starts. */
export const MAX_IN_FLIGHT = 2;

/** Failed lookups in a row, after their retries, that end the night: five is a
    shut key, not five unlucky names. */
export const BREAKER_ERRORS = 5;

/** The name-cache key: cave-affil's normalisation, its storage prefix cut off. */
const plainName = (name) => affilKey(name).slice(AFFIL_PREFIX.length);

const DAY_MS = 86_400_000;

/** The wait after a failed try with no Retry-After: 1 s, 2 s, 4 s — and that
    is also the number of retries, so four tries before a name is an error. */
const RETRY_WAITS_MS = [1000, 2000, 4000];

/** A server saying `Retry-After: 600` is asking for a night, not our evening. */
const RETRY_AFTER_CAP_MS = 30_000;

/** Spread concurrent retries, so the two in flight do not return in lockstep. */
const jitterMs = () => Math.floor(Math.random() * 250);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* A 429 is the allowance and a 5xx a wobble; both clear. The other 4xx are
   about this request, and asking twice gets the same no. */
const retryable = (status) => status === 429 || status >= 500;

/**
 * One response header's raw value, trimmed, or null: the `Retry-After` the
 * night's log prints is the server's own words, not our parse of them.
 */
function headerValue(resp, name) {
  const headers = resp && resp.headers;
  if (!headers) return null;
  const raw = typeof headers.get === 'function'
    ? headers.get(name)
    : headers[name] ?? headers[name.replace(/\b[a-z]/g, (c) => c.toUpperCase())];
  const text = String(raw ?? '').trim();
  return text || null;
}

/**
 * A response's `Retry-After` in ms, or null when it gave none worth trusting:
 * the header is seconds, so an HTTP date (or junk) falls back to the ladder.
 */
function retryAfterMs(resp) {
  const text = headerValue(resp, 'retry-after');
  if (!text) return null;
  const seconds = Number(text);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * 1000, RETRY_AFTER_CAP_MS) : null;
}

/** A 429's body as one log line can hold it: whitespace collapsed, 200 chars.
    Never throws — a body is evidence, and a missing one is not a failure. */
async function bodySnippet(resp) {
  try {
    if (typeof resp.text !== 'function') return '';
    return String(await resp.text()).replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch (_) {
    return '';
  }
}

/**
 * How many whole days between `at` and `today`; Infinity when either is junk,
 * which reads as "stale, ask again".
 */
function ageDays(at, today) {
  const then = Date.parse(at);
  const now = Date.parse(today);
  return Number.isFinite(then) && Number.isFinite(now) ? Math.floor((now - then) / DAY_MS) : Infinity;
}

/**
 * How long one cache entry stands, by what it said: a number for `ttlDays`, a
 * no-hindex for `noHIndexTtlDays` (a hole in OpenAlex's data fills in weeks),
 * and any other null — no-match or ambiguous — for `nullTtlDays`.
 */
function ttlFor(entry, { ttlDays, nullTtlDays, noHIndexTtlDays }) {
  if (entry.h !== null) return ttlDays;
  return entry.why === 'no-hindex' ? noHIndexTtlDays : nullTtlDays;
}

/**
 * The cached h for one name: a number, null (a cached "no such person"), or
 * undefined when the cache has no answer worth trusting — never asked, junk, or
 * older than the TTL its own answer earns (see `ttlFor`).
 *
 * A cached `error` is not an answer, so it always reads as "ask again": tonight
 * writes no error entries, and a file from before that rule must not answer a
 * name with a failure. A null with NO `why` is the same thing from earlier still:
 * before the reasons were recorded, a throttled lookup was cached as a plain no,
 * and 448 of 530 names in the first live cache were such entries. A real no
 * always carries its reason, so a null without one is asked again.
 *
 * A cached `no-match` or `ambiguous` is trusted only when the file that wrote it
 * searched the same fields we search now (`version` 2 or later): a no from the
 * Physics-only filter says nothing about a computer-science author, so under an
 * older or missing version it is asked again (see the header). A number, and a
 * `no-hindex`, were not widened by the filter and stand under any version.
 */
function cachedH(names, key, today, ttls, version = 0) {
  const entry = names[key];
  if (!entry || typeof entry !== 'object') return undefined;
  const h = entry.h === null ? null : (Number.isFinite(entry.h) ? entry.h : undefined);
  if (h === undefined) return undefined;
  if (h === null && (!entry.why || entry.why === 'error')) return undefined;
  if (h === null && entry.why !== 'no-hindex' && !(version >= 2)) return undefined;
  return ageDays(entry.at, today) > ttlFor(entry, ttls) ? undefined : h;
}

/**
 * One name's h-index from OpenAlex, as `{ h, why }`: a number with `why` null,
 * or null with the reason.
 *
 * A 429, a 5xx, a dead socket and a timeout are tried three more times: a
 * throttled key answers the second time. The wait is the server's `Retry-After`
 * when it gave one (capped at 30 s), else 1 s, 2 s, 4 s, plus a little jitter
 * so the requests in flight do not come back together. A 404 or another 4xx is
 * a no about the request, and is not repeated. A body that is not JSON is a
 * broken answer, not a broken socket, so it is not repeated either.
 *
 * Every response's status lands in `stats.status` — `'network'` for a fetch
 * that threw — so the night's last line can say `429` instead of a bare `376`.
 * The FIRST 429's body and Retry-After land in `stats.first429`: if the night
 * is capped by a limit we do not understand, the server's own words are the
 * only evidence of which one.
 * Sleep and jitter are parameters, so the tests run the ladder without waiting.
 *
 * The h itself, not the signal, because that is what the cache keeps: a
 * saturation changed next year must not leave yesterday's answers on the old
 * scale. The `why` is kept beside it so a null night can be read from the log
 * instead of re-run.
 */
async function fetchHIndex(fetchImpl, name, {
  mailto, apiKey, sleep = wait, jitter = jitterMs, stats = { status: {} },
}) {
  const url = authorQueryUrl(name) +
    '&mailto=' + encodeURIComponent(mailto || '') +
    (apiKey ? '&api_key=' + encodeURIComponent(apiKey) : '');
  const count = (status) => { stats.status[status] = (stats.status[status] || 0) + 1; };
  for (let attempt = 0; ; attempt += 1) {
    let resp;
    try {
      resp = await fetchImpl(url);
    } catch (_) {
      resp = null;
    }
    count(resp ? String(resp.status) : 'network');
    if (resp && resp.status === 429 && !stats.first429) {
      stats.first429 = {
        retryAfter: headerValue(resp, 'retry-after'),
        body: await bodySnippet(resp),
      };
    }
    if (resp && resp.ok) {
      try {
        return explainHIndex(await resp.json(), name);
      } catch (_) {
        return { h: null, why: 'error' };
      }
    }
    if (attempt >= RETRY_WAITS_MS.length || (resp && !retryable(resp.status))) {
      return { h: null, why: 'error' };
    }
    await sleep((retryAfterMs(resp) ?? RETRY_WAITS_MS[attempt]) + jitter());
  }
}

/**
 * Tonight's signals and the name cache that paid for them.
 *
 * `stones` is the warmer's own list (`{ arxivId, authors }`). Each stone's LAST
 * author is looked up once however many papers they signed — the same name
 * spelled the same way is one request — and the answer lands under the stone's
 * bare arXiv id as the 0..1 signal, or null.
 *
 * `cache` is the previous `author-h-cache.json` (`{ version, names }`); the
 * returned cache is that plus tonight's answers, stamped `today`, and always
 * `version: 2` — the version says the search covered Physics and Computer
 * Science, so a no it holds is about both fields. A null carries the `why` that
 * explains it, so the log can be read back, unless that why is `error`: a lookup
 * that never got an answer is not an answer, and tomorrow asks again. The
 * knobs: `ttlDays` (120, a found h), `nullTtlDays` (60,
 * no-match and ambiguous), `noHIndexTtlDays` (14), `maxNew` (300 names a
 * night), `paceMs` (300 ms between first tries), plus `fetch`, `sleep`,
 * `jitter`. A name the cap or the breaker skips is not cached: tomorrow asks it.
 * Ends with one `author-signal:` line for the log, statuses included — and,
 * when the night met a 429, the first one's Retry-After and body just above it.
 */
export async function buildSignals(stones, options = {}) {
  const {
    fetch: fetchImpl = fetch, mailto = '', apiKey = '', cache = null,
    today = new Date().toISOString().slice(0, 10),
    ttlDays = 120, nullTtlDays = 60, noHIndexTtlDays = 14,
    maxNew = 300, paceMs = 300, sleep = wait, jitter = jitterMs,
  } = options;

  const ttls = { ttlDays, nullTtlDays, noHIndexTtlDays };
  const cap = Number.isFinite(maxNew) ? Math.max(0, Math.floor(maxNew)) : 300;
  const pace = Number.isFinite(paceMs) ? Math.max(0, paceMs) : 300;

  const prev = cache && cache.names && typeof cache.names === 'object' ? cache.names : {};
  /* The version that WROTE those entries: a no under the old Physics-only filter
     is not a no under today's (see `cachedH`). Junk reads as 0 — ask again. */
  const version = Number(cache && cache.version) || 0;
  /* A fresh object, so a caller's cache is not mutated under it. */
  const names = { ...prev };
  const list = Array.isArray(stones) ? stones : [];

  /* Cache hits settle now; only the unanswered names queue for a request, in
     stone order — so a capped or stopped night asks the same names first
     however often it runs, and the rest are tomorrow's turn. */
  const h = new Map();
  const queue = [];
  const seen = new Set();
  for (const stone of list) {
    const name = lastAuthor(stone && stone.authors);
    const key = plainName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const hit = cachedH(prev, key, today, ttls, version);
    if (hit !== undefined) h.set(key, hit);
    else queue.push({ key, name });
  }

  /* At most MAX_IN_FLIGHT requests in the air — a shared pool, not a chunked
     Promise.all, so a slow name does not hold back the rest — and first tries
     `paceMs` apart, so the width is a ceiling and the pace is the rate. Retries
     are not paced: the ladder and the server's Retry-After are already the
     slower clock. */
  const stats = { status: {}, first429: null };
  let asked = 0;       /* names this night put on the wire */
  let streak = 0;      /* lookups that ended in error since the last answer */
  let stopped = false; /* the breaker tripped: the key is shut for tonight */
  let next = 0;

  const lookup = async ({ key, name }) => {
    const answer = await fetchHIndex(fetchImpl, name,
      { mailto, apiKey, sleep, jitter, stats });
    h.set(key, answer.h);
    if (answer.h === null && answer.why === 'error') {
      /* Not an answer, so not cached — not even as a short no: tomorrow asks
         again. A stale entry from an earlier night goes with it. Five in a row
         is not five bad names but a shut key: stop asking and keep the rest of
         the queue for tomorrow. */
      delete names[key];
      streak += 1;
      if (streak >= BREAKER_ERRORS) stopped = true;
    } else {
      streak = 0;
      if (answer.h === null) {
        /* A null keeps its reason, so tomorrow's log says why; a number only
           the number. */
        names[key] = { h: null, why: answer.why, at: today };
      } else {
        names[key] = { h: answer.h, at: today };
      }
    }
  };

  /* The pump: fill the pool, wait for one landing, repeat — never a third
     request while two are out, and never one the cap or the breaker has taken
     away. A stopped run still drains what it already booked. */
  const inFlight = new Set();
  while (inFlight.size || (!stopped && next < queue.length && asked < cap)) {
    while (!stopped && inFlight.size < MAX_IN_FLIGHT && next < queue.length && asked < cap) {
      if (pace && asked) await sleep(pace);
      if (stopped) break;
      const task = lookup(queue[next++]).finally(() => inFlight.delete(task));
      inFlight.add(task);
      asked += 1;
    }
    if (inFlight.size) await Promise.race(inFlight);
  }

  const signals = {};
  for (const stone of list) {
    const id = String((stone && stone.arxivId) || '').trim();
    if (!id) continue;
    signals[id] = authorSignal(h.get(plainName(lastAuthor(stone.authors))));
  }

  /* One line per night, for the CI log: how many papers earned a signal, why
     the names that came back empty did, and what the budget did — a name the
     cap or the breaker skipped is null tonight and asked tomorrow. Nulls are
     counted per distinct name — a reason is a fact about the name, not the
     paper that signed it. */
  const why = { 'no-match': 0, ambiguous: 0, 'no-hindex': 0, error: 0 };
  for (const key of seen) {
    if (h.get(key) !== null) continue;
    const reason = names[key] && names[key].why;
    why[Object.hasOwn(why, reason) ? reason : 'error'] += 1;
  }
  const withSignal = Object.values(signals).filter((value) => value !== null).length;
  /* Sorted keys, so last night's log can be diffed against tonight's. */
  const http = Object.fromEntries(Object.keys(stats.status).sort()
    .map((status) => [status, stats.status[status]]));
  /* The server's own words, once, when it said 429: which limit we hit is the
     one fact the counts cannot give. */
  if (stats.first429) {
    console.log('author-signal: first 429: retry-after=' +
      (stats.first429.retryAfter || 'none') + ' body=' + stats.first429.body);
  }
  console.log('author-signal: ' + withSignal + ' with signal, nulls: ' +
    'no-match ' + why['no-match'] + ', ambiguous ' + why.ambiguous +
    ', no-hindex ' + why['no-hindex'] + ', error ' + why.error +
    '; asked ' + asked + ' new, skipped ' + (queue.length - asked) +
    ', stopped ' + (stopped ? 'yes' : 'no') + '; http: ' + JSON.stringify(http));

  return { signals, cache: { version: 2, names } };
}

/**
 * The file the page reads: `prev`'s signals under tonight's, `date` stamped, cut
 * to the `cap` most recently added ids. New ids go on the end, so the tail is
 * the newest and a long-ago paper's signal falls off first — the page only ever
 * ranks recent stones, and an unbounded file is fetched by every reader.
 *
 * Pure, and silent about a missing `prev`: the first run has no file, and that
 * is an ordinary night, not an error.
 */
export function mergeLatest(prev, newSignals, { date, cap = 3000 } = {}) {
  const base = prev && prev.signals && typeof prev.signals === 'object' ? prev.signals : {};
  const fresh = newSignals && typeof newSignals === 'object' ? newSignals : {};
  /* Tonight's keys go last even when they overwrite an old value, so the cap
     drops the ids nobody has refreshed, not the ones just answered. */
  const merged = [
    ...Object.entries(base).filter(([id]) => !Object.hasOwn(fresh, id)),
    ...Object.entries(fresh),
  ];
  const keep = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 3000;
  const entries = keep === 0 ? [] : merged.slice(-keep);
  return {
    version: 1,
    date: date || '',
    hSaturation: H_SATURATION,
    signals: Object.fromEntries(entries),
  };
}
