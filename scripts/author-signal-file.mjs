/**
 * author-signal-file — the last author's h-index, as the static file the page
 * reads.
 *
 * THE LOOKUP IS A NIGHTLY JOB, NOT A REQUEST. The ranking page cannot ask
 * OpenAlex about ~700 last authors while a reader waits, and it should not:
 * one search per name, four in flight, a rate limit and a polite-pool delay is
 * a job with a clock. So the warmer asks once, turns each answer into the 0..1
 * signal the order key wants (`docs/assets/cave-affil.mjs`'s `authorSignal`),
 * and writes `feeds/author-signal/latest.json` — one same-origin file the page
 * fetches for free.
 *
 * THE FILE ACCUMULATES, THE CACHE EXPIRES. A reader on a quiet Sunday still
 * ranks a week of stones, so new ids merge over the previous file and the
 * oldest fall off at `cap`. The per-name cache is what keeps a night's cost at
 * one request per NEW name: an h-index moves by a point a year, so thirty days
 * is generous for an answer, and three is generous for a "no".
 *
 * NOTHING HERE THROWS. A 429, a timeout, a body that is not JSON — that name is
 * null, and null adds nothing to the order key. A lookup that never happened is
 * not evidence against a paper.
 *
 * Everything with a socket is a parameter (`fetch`, `today`, `cache`), so the
 * tests run the whole thing on hand-built payloads without leaving the process.
 */

import {
  AFFIL_PREFIX, affilKey, authorQueryUrl, authorSignal, lastAuthor, pickHIndex,
} from '../docs/assets/cave-affil.mjs';

/** Where the signal saturates — cave-affil's default, restated in the file. */
export const H_SATURATION = 60;

/** Requests in flight at once. OpenAlex's polite pool rewards no burst. */
export const MAX_IN_FLIGHT = 4;

/** The name-cache key: cave-affil's normalisation, its storage prefix cut off. */
const plainName = (name) => affilKey(name).slice(AFFIL_PREFIX.length);

const DAY_MS = 86_400_000;

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
 * The cached h for one name: a number, null (a cached "no such person"), or
 * undefined when the cache has no answer worth trusting — never asked, junk, or
 * older than its own TTL (a real answer stands `ttlDays`, a null `nullTtlDays`).
 */
function cachedH(names, key, today, ttlDays, nullTtlDays) {
  const entry = names[key];
  if (!entry || typeof entry !== 'object') return undefined;
  const h = entry.h === null ? null : (Number.isFinite(entry.h) ? entry.h : undefined);
  if (h === undefined) return undefined;
  return ageDays(entry.at, today) > (h === null ? nullTtlDays : ttlDays) ? undefined : h;
}

/**
 * One name's h-index from OpenAlex, or null. Every failure — a 429, a 5xx, a
 * timeout, a garbled body — answers null rather than throwing: one person
 * OpenAlex will not talk about is a blank chip, not a dead warm.
 *
 * The h itself, not the signal, because that is what the cache keeps: a
 * saturation changed next year must not leave yesterday's answers on the old
 * scale.
 */
async function fetchHIndex(fetchImpl, name, { mailto, apiKey }) {
  const url = authorQueryUrl(name) +
    '&mailto=' + encodeURIComponent(mailto || '') +
    (apiKey ? '&api_key=' + encodeURIComponent(apiKey) : '');
  try {
    const resp = await fetchImpl(url);
    if (!resp || !resp.ok) return null;
    return pickHIndex(await resp.json(), name);
  } catch (_) {
    return null;
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
 * returned cache is that plus tonight's answers, stamped `today`. `fetch` is
 * the global one unless a test says otherwise; `ttlDays` and `nullTtlDays` are
 * 30 and 3 (see the header).
 */
export async function buildSignals(stones, options = {}) {
  const {
    fetch: fetchImpl = fetch, mailto = '', apiKey = '', cache = null,
    today = new Date().toISOString().slice(0, 10),
    ttlDays = 30, nullTtlDays = 3,
  } = options;

  const prev = cache && cache.names && typeof cache.names === 'object' ? cache.names : {};
  /* A fresh object, so a caller's cache is not mutated under it. */
  const names = { ...prev };
  const list = Array.isArray(stones) ? stones : [];

  /* Cache hits settle now; only the unanswered names queue for a request. */
  const h = new Map();
  const queue = [];
  const asked = new Set();
  for (const stone of list) {
    const name = lastAuthor(stone && stone.authors);
    const key = plainName(name);
    if (!key || asked.has(key)) continue;
    asked.add(key);
    const hit = cachedH(prev, key, today, ttlDays, nullTtlDays);
    if (hit !== undefined) h.set(key, hit);
    else queue.push({ key, name });
  }

  /* At most MAX_IN_FLIGHT requests in the air: a shared pool, not a chunked
     Promise.all — a slow name must not hold back the rest of its batch. */
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const { key, name } = queue[next++];
      const answer = await fetchHIndex(fetchImpl, name, { mailto, apiKey });
      h.set(key, answer);
      names[key] = { h: answer, at: today };
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, queue.length) }, worker));

  const signals = {};
  for (const stone of list) {
    const id = String((stone && stone.arxivId) || '').trim();
    if (!id) continue;
    signals[id] = authorSignal(h.get(plainName(lastAuthor(stone.authors))));
  }
  return { signals, cache: { version: 1, names } };
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
