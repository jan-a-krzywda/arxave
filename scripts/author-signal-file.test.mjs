/**
 * `node --test scripts/author-signal-file.test.mjs` (no install needed).
 *
 * The one property under test: the file the page reads is worth its weight.
 * That means the cache actually saves the requests it claims to (a hit costs
 * nothing, a stale answer is re-asked, a "no" is asked again sooner), one
 * person signing ten papers costs one request, the burst stays inside the four
 * the polite pool tolerates, and a failure is a null rather than a dead warm.
 *
 * No network: `fetch` is a parameter, and every payload here is hand-built.
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

test('a failure is a null signal, never a thrown warm', async () => {
  const bodies = [
    { ok: false, status: 429, json: async () => ({}) },
    { ok: false, status: 500, json: async () => ({}) },
    { ok: true, status: 200, json: async () => { throw new Error('not JSON'); } },
  ];
  let i = 0;
  const fetch = async () => {
    const next = bodies[i++];
    if (!next) throw new Error('the network is down');
    return next;
  };
  const out = await buildSignals([
    stone('2611.00001', 'Ada Phys'), stone('2611.00002', 'Bob Stone'),
    stone('2611.00003', 'Cyd Ray'), stone('2611.00004', 'Dee Volt'),
  ], { fetch, today: '2026-11-19' });

  assert.deepEqual(out.signals, {
    '2611.00001': null, '2611.00002': null, '2611.00003': null, '2611.00004': null,
  });
  assert.deepEqual(out.cache.names['ada phys'], { h: null, at: '2026-11-19' },
    'a failure is cached as a no, so tomorrow retries soon');
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

