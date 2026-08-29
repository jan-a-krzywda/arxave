/* Run with `deno test supabase/functions/relay/cache.test.ts`. */
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  cacheControlFor,
  type CacheEntry,
  FRESH_MS,
  freshness,
  isCacheable,
  MAX_CACHE_BYTES,
  MemoryCache,
  SingleFlight,
  STALE_MS,
} from './cache.ts';

function entry(ageMs: number, status = 200): CacheEntry {
  return { status, contentType: 'text/xml', body: '<rss/>', fetchedAt: Date.now() - ageMs };
}

Deno.test('freshness walks fresh → stale → expired', () => {
  assertEquals(freshness(entry(0)), 'fresh');
  assertEquals(freshness(entry(FRESH_MS - 1_000)), 'fresh');
  assertEquals(freshness(entry(FRESH_MS + 1_000)), 'stale');
  assertEquals(freshness(entry(STALE_MS + 1_000)), 'expired');
});

Deno.test('a clock-skewed future entry is fresh, not expired', () => {
  // Two isolates can disagree by seconds; that must not evict a good entry.
  assertEquals(freshness(entry(-5_000)), 'fresh');
});

Deno.test('only 2xx is stored, and only under the size cap', () => {
  assert(isCacheable(200, 1_000));
  assert(isCacheable(206, 1_000));
  assert(!isCacheable(429, 1_000), 'a throttle is about this second, not this URL');
  assert(!isCacheable(500, 1_000));
  assert(!isCacheable(301, 1_000));
  assert(!isCacheable(200, MAX_CACHE_BYTES + 1));
});

Deno.test('the browser is told to re-ask after any error', () => {
  // The outage's second half: the old relay stamped max-age=300 on the 429 too,
  // so one throttled call replayed as a failure for five minutes.
  assertEquals(cacheControlFor(200), `public, max-age=${FRESH_MS / 1000}`);
  assertEquals(cacheControlFor(429), 'no-store');
  assertEquals(cacheControlFor(502), 'no-store');
});

Deno.test('MemoryCache evicts least-recently-used', () => {
  const c = new MemoryCache(2);
  c.set('a', entry(0));
  c.set('b', entry(0));
  c.get('a');                 // 'a' is now the recent one, so 'b' should go
  c.set('c', entry(0));
  assertEquals(c.size, 2);
  assert(c.get('a'));
  assert(!c.get('b'));
  assert(c.get('c'));
});

Deno.test('MemoryCache drops an entry past the stale window', () => {
  const c = new MemoryCache();
  c.set('a', entry(STALE_MS + 1_000));
  assertEquals(c.get('a'), undefined);
  assertEquals(c.size, 0);
});

Deno.test('MemoryCache keeps a stale entry — it is the 429 fallback', () => {
  const c = new MemoryCache();
  c.set('a', entry(FRESH_MS + 1_000));
  assertEquals(freshness(c.get('a')!), 'stale');
});

Deno.test('SingleFlight collapses a simultaneous crowd into one call', async () => {
  const flight = new SingleFlight<CacheEntry>();
  let calls = 0;
  const work = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return entry(0);
  };
  await Promise.all([1, 2, 3, 4, 5].map(() => flight.run('same', work)));
  assertEquals(calls, 1, 'ten presses must not be ten upstream fetches');
  assertEquals(flight.size, 0, 'the entry must be released when it settles');

  // A later press, after the first settled, does go upstream again.
  await flight.run('same', work);
  assertEquals(calls, 2);
});

Deno.test('SingleFlight releases the key when the work throws', async () => {
  const flight = new SingleFlight<CacheEntry>();
  const boom = () => Promise.reject(new Error('offline'));
  await flight.run('k', boom).catch(() => {});
  assertEquals(flight.size, 0, 'a failed fetch must not wedge the key forever');
});
