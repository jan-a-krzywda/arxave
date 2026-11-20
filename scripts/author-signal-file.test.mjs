/**
 * `node --test scripts/author-signal-file.test.mjs` (no install needed).
 *
 * The one property under test: the file the page reads is worth its weight.
 * That means the cache actually saves the requests it claims to (a hit costs
 * nothing, a stale answer is re-asked, and how long an answer stands depends on
 * what it said — months for a number, two for a "no", two weeks for a hit with
 * no number), one person signing ten papers costs one request, the burst stays
 * inside the two the polite pool tolerates, first tries keep a pace, a night
 * spends its cap of new names and no more, five dead lookups in a row end the
 * night instead of pounding a shut key, and a failure is a null rather than a
 * dead warm. A throttled 429 is a null only after three retries, only a real
 * answer is cached, and the first 429's body and Retry-After reach the log. A no
 * from the older Physics-only search is a question again, while a number it
 * found, and a hole in the data, still stand.
 *
 * No network and no waiting: `fetch`, `sleep` and `jitter` are parameters, and
 * every payload here is hand-built.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { authorSignal } from '../docs/assets/cave-affil.mjs';
import { BREAKER_ERRORS, buildSignals, H_SATURATION, MAX_IN_FLIGHT, mergeLatest }
  from './author-signal-file.mjs';

/** An OpenAlex answer for one name, as `pickHIndex` reads it. */
function answer(name, h) {
  return {
    results: [{
      display_name: name,
      works_count: 400,
      last_known_institutions: [{ display_name: 'Somewhere (United States)' }],
      summary_stats: { h_index: h },
    }],
  };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

/** A refusal as fetch reports it: a status, maybe a Retry-After, maybe a body. */
const bad = (status, headers = {}, text = null) => ({
  ok: false,
  status,
  headers,
  json: async () => ({}),
  ...(text === null ? {} : { text: async () => text }),
});

/** Run `fn` with `console.log` captured, and hand back the lines it printed. */
async function logged(fn) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

/** The name a request asked about, so one fake can serve any number of names. */
const askedName = (url) => new URL(url).searchParams.get('search');

/** A fetch that answers every name with the same h, and counts the calls. */
function counting(h, seen = []) {
  const fn = async (url) => {
    seen.push(url);
    return ok(answer(askedName(url), h));
  };
  fn.seen = seen;
  return fn;
}

const stone = (arxivId, ...authors) => ({ arxivId, authors });

test('a fresh cache entry answers without a request', async () => {
  const fetch = counting(99);
  const cache = { version: 1, names: { 'ada phys': { h: 83, at: '2026-11-18' } } };
  const out = await buildSignals([stone('2611.00001', 'B. One', 'Ada Phys')],
    { fetch, cache, today: '2026-11-19' });

  assert.equal(fetch.seen.length, 0, 'the cache hit must not be re-asked');
  assert.equal(out.signals['2611.00001'], authorSignal(83));
  assert.deepEqual(out.cache.names['ada phys'], { h: 83, at: '2026-11-18' }, 'a hit keeps its date');
});

test('an h stands 120 days, then is asked again', async () => {
  const fresh = counting(12);
  const young = { version: 1, names: { 'ada phys': { h: 83, at: '2026-08-11' } } };
  const hit = await buildSignals([stone('2611.00001', 'Ada Phys')],
    { fetch: fresh, cache: young, today: '2026-11-19' });
  assert.equal(fresh.seen.length, 0, '100 days old: still an answer');
  assert.equal(hit.signals['2611.00001'], authorSignal(83));

  const fetch = counting(12);
  const cache = { version: 1, names: { 'ada phys': { h: 83, at: '2026-07-01' } } };
  const out = await buildSignals([stone('2611.00001', 'Ada Phys')],
    { fetch, cache, today: '2026-11-19' });
  assert.equal(fetch.seen.length, 1, '141 days old: asked again');
  assert.equal(out.signals['2611.00001'], authorSignal(12));
  assert.deepEqual(out.cache.names['ada phys'], { h: 12, at: '2026-11-19' });
});

test('the TTL comes from the answer: 120 days for an h, 60 for a no, 14 for no-hindex',
  async () => {
    /* Every entry is dated for its own verdict: the two 100-day-old nulls are
       stale, the 100-day-old number is not, and a 20-day-old "no-hindex" is
       asked again while a 14-day-old one is still trusted. */
    const cache = { version: 2, names: {
      'ada phys': { h: 83, at: '2026-08-11' },
      'bob stone': { h: null, why: 'no-match', at: '2026-08-11' },
      'cyd ray': { h: null, why: 'ambiguous', at: '2026-08-11' },
      'dee volt': { h: null, why: 'no-hindex', at: '2026-10-30' },
      'eve watt': { h: null, why: 'no-hindex', at: '2026-11-05' },
    } };
    const fetch = counting(7);
    const out = await buildSignals([
      stone('2611.00001', 'Ada Phys'), stone('2611.00002', 'Bob Stone'),
      stone('2611.00003', 'Cyd Ray'), stone('2611.00004', 'Dee Volt'),
      stone('2611.00005', 'Eve Watt'),
    ], { fetch, cache, paceMs: 0, today: '2026-11-19' });

    assert.deepEqual(fetch.seen.map(askedName).sort(), ['Bob Stone', 'Cyd Ray', 'Dee Volt'],
      'the stale no-match, the stale ambiguous and the stale no-hindex, and nothing else');
    assert.equal(out.signals['2611.00001'], authorSignal(83), 'the old h still answers');
    assert.equal(out.signals['2611.00005'], null, 'the young no-hindex still answers');
    assert.deepEqual(out.cache.names['ada phys'], { h: 83, at: '2026-08-11' },
      'a hit keeps its date');
  });

test('one last author on many papers costs one request', async () => {
  const fetch = counting(40);
  const out = await buildSignals([
    stone('2611.00001', 'A. Phys', 'Ada Phys'),
    stone('2611.00002', 'C. Other', 'Ada  Phys'),
    stone('2611.00003', 'Ada Phys'),
  ], { fetch, today: '2026-11-19' });

  assert.equal(fetch.seen.length, 1);
  assert.equal(out.signals['2611.00001'], authorSignal(40));
  assert.equal(out.signals['2611.00002'], authorSignal(40));
  assert.equal(out.signals['2611.00003'], authorSignal(40));
  assert.equal(Object.keys(out.cache.names).length, 1);
});

test('the mailto and the key ride on the query', async () => {
  const fetch = counting(5);
  await buildSignals([stone('2611.00001', 'Ada Phys')],
    { fetch, mailto: 'me@example.org', apiKey: 'secret', today: '2026-11-19' });
  assert.ok(fetch.seen[0].includes('&mailto=me%40example.org'));
  assert.ok(fetch.seen[0].includes('&api_key=secret'));

  const anon = counting(5);
  await buildSignals([stone('2611.00001', 'Ada Phys')], { fetch: anon, today: '2026-11-19' });
  assert.ok(!anon.seen[0].includes('api_key'));
});

test('at most two requests are in the air', async () => {
  let inFlight = 0;
  let peak = 0;
  const fetch = async (url) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return ok(answer(askedName(url), 9));
  };
  const names = ['Ada Phys', 'Bob Stone', 'Cyd Ray', 'Dee Volt', 'Eve Watt', 'Fay Ohm',
    'Gus Amp', 'Hal Farad', 'Ivy Joule', 'Jon Gauss'];
  const out = await buildSignals(names.map((n, i) => stone(`2611.0000${i}`, n)),
    { fetch, paceMs: 0, today: '2026-11-19' });

  assert.equal(MAX_IN_FLIGHT, 2, 'the pool is two wide: the polite pool rewards no burst');
  assert.equal(peak, MAX_IN_FLIGHT, 'the pool fills, and no further');
  assert.equal(Object.keys(out.cache.names).length, names.length, 'every name was asked');
});

test('a 429, a 500, a garbled body and a dead socket are nulls, never a thrown warm', async () => {
  const seen = [];
  const fetch = async (url) => {
    const name = askedName(url);
    seen.push(name);
    if (name === 'Ada Phys') return bad(429);
    if (name === 'Bob Stone') return bad(500);
    if (name === 'Cyd Ray') return { ok: true, status: 200, json: async () => { throw new Error('not JSON'); } };
    throw new Error('the network is down');
  };
  const out = await buildSignals([
    stone('2611.00001', 'Ada Phys'), stone('2611.00002', 'Bob Stone'),
    stone('2611.00003', 'Cyd Ray'), stone('2611.00004', 'Dee Volt'),
  ], { fetch, sleep: async () => {}, jitter: () => 0, today: '2026-11-19' });

  assert.deepEqual(out.signals, {
    '2611.00001': null, '2611.00002': null, '2611.00003': null, '2611.00004': null,
  });
  /* Four tries for a retryable status or a dead socket; the garbled body is one
     try — the request worked, the answer did not. */
  assert.equal(seen.filter((n) => n === 'Ada Phys').length, 4, 'one try, three retries');
  assert.equal(seen.filter((n) => n === 'Cyd Ray').length, 1, 'a broken body is not retried');
  assert.deepEqual(out.cache.names, {},
    'a failure is not an answer, so nothing is cached and tomorrow asks again');
});

test('a null says why, and the night ends with the counts', async () => {
  const bodies = {
    'Ada Phys': answer('Ada Phys', 83),
    'Bob Stone': { results: [{ display_name: 'Xander Stone', works_count: 400, summary_stats: { h_index: 60 } }] },
    'Wei Zhang': { results: [
      { display_name: 'Wei Zhang', works_count: 724, summary_stats: { h_index: 71 },
        last_known_institutions: [{ display_name: 'Qinghai University' }] },
      { display_name: 'Wei Zhang', works_count: 364, summary_stats: { h_index: 50 },
        last_known_institutions: [{ display_name: 'Henan Normal University' }] },
    ] },
    'Cyd Ray': { results: [{ display_name: 'Cyd Ray', works_count: 3 }] },
  };
  const fetch = async (url) => {
    const name = askedName(url);
    if (name === 'Dee Volt') return bad(429);
    return ok(bodies[name]);
  };
  let out;
  const lines = await logged(async () => {
    out = await buildSignals([
      stone('2611.00001', 'Ada Phys'), stone('2611.00002', 'Bob Stone'),
      stone('2611.00003', 'Wei Zhang'), stone('2611.00004', 'Cyd Ray'),
      stone('2611.00005', 'Dee Volt'),
    ], { fetch, sleep: async () => {}, jitter: () => 0, today: '2026-11-19' });
  });

  assert.deepEqual(out.cache.names['ada phys'], { h: 83, at: '2026-11-19' });
  assert.deepEqual(out.cache.names['bob stone'], { h: null, why: 'no-match', at: '2026-11-19' });
  assert.deepEqual(out.cache.names['wei zhang'], { h: null, why: 'ambiguous', at: '2026-11-19' });
  assert.deepEqual(out.cache.names['cyd ray'], { h: null, why: 'no-hindex', at: '2026-11-19' });
  assert.ok(!('dee volt' in out.cache.names), 'a failure is not cached at all');
  assert.equal(out.signals['2611.00002'], null);
  assert.deepEqual(lines, [
    'author-signal: first 429: retry-after=none body=',
    'author-signal: 1 with signal, nulls: no-match 1, ambiguous 1, ' +
      'no-hindex 1, error 1; asked 5 new, skipped 0, stopped no; http: {"200":4,"429":4}',
  ]);
});

test('a 429 is asked again, and both statuses land in the log', async () => {
  let calls = 0;
  const fetch = async (url) => (++calls === 1 ? bad(429) : ok(answer(askedName(url), 42)));
  const slept = [];
  let out;
  const lines = await logged(async () => {
    out = await buildSignals([stone('2611.00001', 'Ada Phys')],
      { fetch, sleep: async (ms) => { slept.push(ms); }, jitter: () => 0, today: '2026-11-19' });
  });

  assert.equal(out.signals['2611.00001'], authorSignal(42), 'the retry answers, not the 429');
  assert.deepEqual(out.cache.names['ada phys'], { h: 42, at: '2026-11-19' });
  assert.deepEqual(slept, [1000], 'the first rung of the ladder');
  assert.deepEqual(lines, [
    'author-signal: first 429: retry-after=none body=',
    'author-signal: 1 with signal, nulls: no-match 0, ambiguous 0, ' +
      'no-hindex 0, error 0; asked 1 new, skipped 0, stopped no; http: {"200":1,"429":1}',
  ]);
});

test('Retry-After sets the wait in seconds, capped at 30 s', async () => {
  for (const [header, want] of [['2', 2000], ['600', 30000]]) {
    let calls = 0;
    const fetch = async (url) => (++calls === 1
      ? bad(429, new Headers({ 'retry-after': header }))
      : ok(answer(askedName(url), 5)));
    const slept = [];
    await logged(() => buildSignals([stone('2611.00001', 'Ada Phys')],
      { fetch, sleep: async (ms) => { slept.push(ms); }, jitter: () => 0, today: '2026-11-19' }));
    assert.deepEqual(slept, [want], `Retry-After: ${header}`);
  }
});

test('the ladder climbs 1 s, 2 s, 4 s and gives up after the fourth try', async () => {
  const slept = [];
  let calls = 0;
  const fetch = async () => { calls += 1; return bad(503); };
  await logged(() => buildSignals([stone('2611.00001', 'Ada Phys')],
    { fetch, sleep: async (ms) => { slept.push(ms); }, jitter: () => 0, today: '2026-11-19' }));

  assert.equal(calls, 4, 'one try and three retries');
  assert.deepEqual(slept, [1000, 2000, 4000]);
});

test('a 404 is about the request: one try, no wait, no cache', async () => {
  const slept = [];
  let calls = 0;
  const fetch = async () => { calls += 1; return bad(404); };
  let out;
  await logged(async () => {
    out = await buildSignals([stone('2611.00001', 'Ada Phys')],
      { fetch, sleep: async (ms) => { slept.push(ms); }, jitter: () => 0, today: '2026-11-19' });
  });

  assert.equal(calls, 1);
  assert.deepEqual(slept, []);
  assert.equal(out.signals['2611.00001'], null);
  assert.deepEqual(out.cache.names, {});
});

test('a name that stays a 429 is not cached, and a cached error is asked again', async () => {
  let calls = 0;
  const fetch = async () => { calls += 1; return bad(429); };
  /* A cache written by the old code: an error with today's date. It is not an
     answer, so tonight must ask rather than serve it for three days. */
  const cache = { version: 1, names: { 'ada phys': { h: null, why: 'error', at: '2026-11-19' } } };
  const slept = [];
  let out;
  await logged(async () => {
    out = await buildSignals([stone('2611.00001', 'Ada Phys')],
      { fetch, cache, sleep: async (ms) => { slept.push(ms); }, jitter: () => 0, today: '2026-11-19' });
  });

  assert.equal(calls, 4, 'a fresh error entry is a question, not an answer');
  assert.deepEqual(slept, [1000, 2000, 4000]);
  assert.equal(out.signals['2611.00001'], null);
  assert.deepEqual(out.cache.names, {}, 'the failure is dropped: tomorrow asks again');
});

test('a cached null with no reason is a legacy failure and is asked again', async () => {
  let calls = 0;
  const fetch = async () => { calls += 1; return ok({ results: [] }); };
  /* Written before the reasons existed: a throttled lookup cached as a plain no.
     A real no-match carries `why`, so it keeps standing. Version 2, because a no
     from the older Physics-only search is re-asked for a different reason — the
     next test. */
  const cache = { version: 2, names: {
    'ada phys': { h: null, at: '2026-11-19' },
    'bob nomatch': { h: null, why: 'no-match', at: '2026-11-19' },
  } };
  let out;
  await logged(async () => {
    out = await buildSignals([stone('2611.00001', 'Ada Phys'), stone('2611.00002', 'Bob Nomatch')],
      { fetch, cache, sleep: async () => {}, jitter: () => 0, paceMs: 0, today: '2026-11-19' });
  });

  assert.equal(calls, 1, 'only the reasonless null is re-asked');
  assert.equal(out.cache.names['ada phys'].why, 'no-match', 'and it now says why');
});
test('a no from the Physics-only cache is asked again; its numbers are not', async () => {
  const fetch = counting(33);
  /* Version 1 searched Physics & Astronomy alone, so a no there says nothing
     about a computer-science author (the field was widened 2026-11-20). The
     number was not narrowed by the filter and still answers. */
  const cache = { version: 1, names: {
    'ada phys': { h: 83, at: '2026-11-01' },
    'bob stone': { h: null, why: 'no-match', at: '2026-11-01' },
    'cid ray': { h: null, why: 'ambiguous', at: '2026-11-01' },
  } };
  const out = await buildSignals([
    stone('2611.00001', 'Ada Phys'), stone('2611.00002', 'Bob Stone'),
    stone('2611.00003', 'Cid Ray'),
  ], { fetch, cache, paceMs: 0, today: '2026-11-19' });

  assert.deepEqual(fetch.seen.map(askedName).sort(), ['Bob Stone', 'Cid Ray'],
    'both noes are asked again, the found h is not');
  assert.equal(out.signals['2611.00001'], authorSignal(83));
  assert.equal(out.cache.version, 2, 'tonight records which fields it searched');
});

test('a version-2 no stands; a cache with no version is asked about its noes', async () => {
  const fresh = counting(9);
  const widened = { version: 2, names: {
    'bob stone': { h: null, why: 'no-match', at: '2026-11-01' },
    'cyd ray': { h: null, why: 'no-hindex', at: '2026-11-10' },
  } };
  const kept = await buildSignals([stone('2611.00001', 'Bob Stone'), stone('2611.00002', 'Cyd Ray')],
    { fetch: fresh, cache: widened, today: '2026-11-19' });
  assert.equal(fresh.seen.length, 0, 'a no from the widened search stands');
  assert.equal(kept.signals['2611.00001'], null);

  /* No version at all reads as the old search: ask, do not believe the no. */
  const fetch = counting(9);
  const unversioned = { names: { 'bob stone': { h: null, why: 'no-match', at: '2026-11-01' } } };
  await buildSignals([stone('2611.00001', 'Bob Stone')],
    { fetch, cache: unversioned, paceMs: 0, today: '2026-11-19' });
  assert.equal(fetch.seen.length, 1);
});

test('a no-hindex from an older cache still stands', async () => {
  /* The widening says nothing about a hole in OpenAlex's data: the same fields
     would find the same author and the same missing number. */
  const fetch = counting(9);
  const cache = { version: 1, names: {
    'ada phys': { h: null, why: 'no-hindex', at: '2026-11-10' },
  } };
  const out = await buildSignals([stone('2611.00001', 'Ada Phys')],
    { fetch, cache, today: '2026-11-19' });
  assert.equal(fetch.seen.length, 0);
  assert.equal(out.signals['2611.00001'], null);
});



test('a dead socket is retried and counted as network', async () => {
  let calls = 0;
  const fetch = async (url) => {
    if (++calls === 1) throw new Error('ECONNRESET');
    return ok(answer(askedName(url), 30));
  };
  const slept = [];
  let out;
  const lines = await logged(async () => {
    out = await buildSignals([stone('2611.00001', 'Ada Phys')],
      { fetch, sleep: async (ms) => { slept.push(ms); }, jitter: () => 0, today: '2026-11-19' });
  });

  assert.equal(out.signals['2611.00001'], authorSignal(30));
  assert.deepEqual(slept, [1000]);
  assert.ok(lines[0].endsWith('; http: {"200":1,"network":1}'), lines[0]);
});

test('five errors in a row stop the night; the rest are neither asked nor cached', async () => {
  const asked = [];
  const fetch = async (url) => {
    asked.push(askedName(url));
    return bad(429);
  };
  const names = ('Ada Bob Cyd Dee Eve Fay Gus Hal Ivy Jon').split(' ').map((n) => n + ' Stone');
  let out;
  const lines = await logged(async () => {
    out = await buildSignals(names.map((n, i) => stone(`2611.000${i}`, n)),
      { fetch, sleep: async () => {}, jitter: () => 0, paceMs: 0, today: '2026-11-19' });
  });

  /* Five failures trip the breaker; the request already in the air lands, and
     nothing behind it is booked. */
  const distinct = [...new Set(asked)];
  assert.equal(distinct.length, BREAKER_ERRORS + 1, 'five failures plus the one in flight');
  assert.deepEqual(distinct, names.slice(0, distinct.length), 'the queue was walked in order');
  for (const name of names.slice(distinct.length)) {
    assert.ok(!asked.includes(name), `${name} was never asked`);
    assert.ok(!(name.toLowerCase() in out.cache.names), `${name} was not cached`);
  }
  assert.deepEqual(out.cache.names, {}, 'no failure was cached');
  assert.ok(lines.at(-1).includes(`asked ${distinct.length} new, ` +
    `skipped ${names.length - distinct.length}, stopped yes`), lines.at(-1));
});

test('the night asks at most maxNew names and leaves the rest for tomorrow', async () => {
  const fetch = counting(9);
  const names = ('Ada Bob Cyd Dee Eve Fay Gus Hal Ivy Jon').split(' ').map((n) => n + ' Stone');
  let out;
  const lines = await logged(async () => {
    out = await buildSignals(names.map((n, i) => stone(`2611.000${i}`, n)),
      { fetch, maxNew: 3, paceMs: 0, today: '2026-11-19' });
  });

  assert.deepEqual(fetch.seen.map(askedName), ['Ada Stone', 'Bob Stone', 'Cyd Stone'],
    'the first three unanswered names, in stone order');
  assert.deepEqual(Object.keys(out.cache.names).sort(), ['ada stone', 'bob stone', 'cyd stone'],
    'the skipped names are not cached: tomorrow asks them');
  assert.equal(out.signals['2611.0000'], authorSignal(9));
  assert.equal(out.signals['2611.0005'], null, 'a skipped name is a null tonight');
  assert.ok(lines.at(-1).includes('asked 3 new, skipped 7, stopped no'), lines.at(-1));
});

test('first tries are paced paceMs apart; retries are not paced', async () => {
  const slept = [];
  const startsAt = [];
  /* A fake sleep that moves a clock: the pacing is then visible in the starts,
     not in the wall time this test does not spend. */
  let clock = 0;
  const sleep = async (ms) => { slept.push(ms); clock += ms; };
  const fetch = async (url) => {
    startsAt.push(clock);
    return ok(answer(askedName(url), 9));
  };
  const names = ['Ada Phys', 'Bob Stone', 'Cyd Ray', 'Dee Volt'];
  await logged(() => buildSignals(names.map((n, i) => stone(`2611.0000${i}`, n)),
    { fetch, sleep, jitter: () => 0, paceMs: 300, today: '2026-11-19' }));

  assert.equal(startsAt.length, 4);
  assert.deepEqual(slept, [300, 300, 300], 'one beat before every first try but the first');
  for (let i = 1; i < startsAt.length; i += 1) {
    assert.ok(startsAt[i] - startsAt[i - 1] >= 300, `start ${i} is a beat after the last`);
  }
});

test('the first 429 prints its Retry-After and body once, whitespace collapsed', async () => {
  const body = 'Rate limit exceeded: 10 requests per second.\n\n  Try again later.';
  for (const [headers, after] of [
    [new Headers({ 'retry-after': '7' }), '7'],
    [{}, 'none'],
  ]) {
    const fetch = async (url) => (askedName(url) === 'Bob Stone'
      ? bad(429, headers, body)
      : ok(answer(askedName(url), 42)));
    const lines = await logged(() => buildSignals(
      [stone('2611.00001', 'Ada Phys'), stone('2611.00002', 'Bob Stone')],
      { fetch, sleep: async () => {}, jitter: () => 0, paceMs: 0, today: '2026-11-19' }));

    const first = lines.filter((line) => line.includes('first 429'));
    assert.deepEqual(first, ['author-signal: first 429: retry-after=' + after +
      ' body=Rate limit exceeded: 10 requests per second. Try again later.']);
  }
});

test('a night without a 429 says nothing about one', async () => {
  const lines = await logged(() => buildSignals([stone('2611.00001', 'Ada Phys')],
    { fetch: counting(5), today: '2026-11-19' }));
  assert.ok(!lines.some((line) => line.includes('first 429')), 'no 429, no evidence line');
});

test('a stone with no authors is null and asks nothing', async () => {
  const fetch = counting(3);
  const out = await buildSignals([stone('2611.00001')], { fetch, today: '2026-11-19' });
  assert.equal(fetch.seen.length, 0);
  assert.equal(out.signals['2611.00001'], null);
});

test('mergeLatest lays tonight over last night and stamps the day', () => {
  const prev = { version: 1, date: '2026-11-18', hSaturation: 60, signals: { a: 1, b: null } };
  const out = mergeLatest(prev, { b: 0.5, c: 0.7 }, { date: '2026-11-19' });
  assert.deepEqual(out, {
    version: 1, date: '2026-11-19', hSaturation: H_SATURATION,
    signals: { a: 1, b: 0.5, c: 0.7 },
  });
});

test('mergeLatest keeps the newest `cap` ids and drops the tail', () => {
  const prev = { signals: { a: 1, b: 1, c: 1 } };
  const out = mergeLatest(prev, { d: 1 }, { date: '2026-11-19', cap: 3 });
  assert.deepEqual(Object.keys(out.signals), ['b', 'c', 'd']);
  assert.deepEqual(Object.keys(mergeLatest(prev, { d: 1 }, { date: 'x', cap: 0 }).signals), []);
  /* A refreshed id was just answered, so it is newest, not old news. */
  assert.deepEqual(Object.keys(mergeLatest(prev, { a: 2 }, { date: 'x', cap: 3 }).signals),
    ['b', 'c', 'a']);
});

test('mergeLatest makes the first night out of nothing', () => {
  assert.deepEqual(mergeLatest(null, { '2611.00001': null }, { date: '2026-11-19' }), {
    version: 1, date: '2026-11-19', hSaturation: H_SATURATION, signals: { '2611.00001': null },
  });
});

