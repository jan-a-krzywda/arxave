/**
 * `node --test scripts/author-signal-file.test.mjs` (no install needed).
 *
 * The one property under test: the file the page reads is worth its weight.
 * That means the cache actually saves the requests it claims to (a hit costs
 * nothing, a stale answer is re-asked, a "no" is asked again sooner), one
 * person signing ten papers costs one request, the burst stays inside the four
 * the polite pool tolerates, and a failure is a null rather than a dead warm.
 * A throttled 429 is a null only after three retries, and only a real answer is
 * cached: a failure is asked again tomorrow, not remembered.
 *
 * No network and no waiting: `fetch`, `sleep` and `jitter` are parameters, and
 * every payload here is hand-built.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { authorSignal } from '../docs/assets/cave-affil.mjs';
import { buildSignals, H_SATURATION, MAX_IN_FLIGHT, mergeLatest } from './author-signal-file.mjs';

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

/** A refusal as fetch reports it: a status, maybe a Retry-After, no body. */
const bad = (status, headers = {}) => ({ ok: false, status, headers, json: async () => ({}) });

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

test('an entry older than 30 days is asked again', async () => {
  const fetch = counting(12);
  const cache = { version: 1, names: { 'ada phys': { h: 83, at: '2026-10-01' } } };
  const out = await buildSignals([stone('2611.00001', 'Ada Phys')],
    { fetch, cache, today: '2026-11-19' });

  assert.equal(fetch.seen.length, 1);
  assert.equal(out.signals['2611.00001'], authorSignal(12));
  assert.deepEqual(out.cache.names['ada phys'], { h: 12, at: '2026-11-19' });
});

test('a cached null stands three days, then is asked again', async () => {
  const cache = { version: 1, names: { 'ada phys': { h: null, at: '2026-11-17' } } };
  const young = counting(7);
  const fresh = await buildSignals([stone('2611.00001', 'Ada Phys')],
    { fetch: young, cache, today: '2026-11-19' });
  assert.equal(young.seen.length, 0, 'two days old: still cached');
  assert.equal(fresh.signals['2611.00001'], null);

  const old = counting(7);
  const stale = await buildSignals([stone('2611.00001', 'Ada Phys')],
    { fetch: old, cache, today: '2026-11-21' });
  assert.equal(old.seen.length, 1, 'four days old: asked again');
  assert.equal(stale.signals['2611.00001'], authorSignal(7));
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

test('at most four requests are in the air', async () => {
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
    { fetch, today: '2026-11-19' });

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

test('a null says why, and the night ends with one log line', async () => {
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
  assert.deepEqual(lines, ['author-signal: 1 with signal, nulls: no-match 1, ambiguous 1, ' +
    'no-hindex 1, error 1; http: {"200":4,"429":4}']);
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
  assert.deepEqual(lines, ['author-signal: 1 with signal, nulls: no-match 0, ambiguous 0, ' +
    'no-hindex 0, error 0; http: {"200":1,"429":1}']);
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

test('a key that throttles the first twenty names runs the rest one at a time', async () => {
  let inFlight = 0;
  const widths = [];
  const fetch = async () => {
    inFlight += 1;
    widths.push(inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return bad(429);
  };
  const names = ('Ada Bob Cyd Dee Eve Fay Gus Hal Ivy Jon Kim Lou Max Ned Oli ' +
    'Pam Quinn Ray Sam Tom Uma Vic Wes Xan Yul Zac Abe Ben Cal Dan Eli').split(' ').slice(0, 30);
  let out;
  await logged(async () => {
    out = await buildSignals(names.map((n, i) => stone(`2611.000${i}`, n)),
      { fetch, sleep: async () => {}, jitter: () => 0, today: '2026-11-19' });
  });

  assert.equal(widths.length, 30 * 4, 'every name was asked, four tries each');
  assert.equal(Math.max(...widths.slice(0, 4)), MAX_IN_FLIGHT, 'it starts at the full pool');
  assert.equal(Math.max(...widths.slice(-8)), 1,
    'twenty errors in the first twenty answers shrink the pool to one');
  assert.deepEqual(out.cache.names, {}, 'no failure was cached');
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

