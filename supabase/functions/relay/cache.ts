/**
 * relay's cache policy — the pure half, so it can be tested without a network
 * or a database.
 *
 * WHY A CACHE AT ALL: the relay is one server with one egress IP, and arXiv
 * throttles per IP. Every visitor to the filter page therefore shares a single
 * budget. One person hauling is three upstream GETs (two announcement feeds and
 * one search call); ten people hauling the same night is thirty, for three
 * distinct answers. Measured 2026-08-29, the day after the page was shared:
 * export.arxiv.org replied 429 with the API-gateway body "Rate exceeded", and
 * the haul died on it.
 *
 * The listing those calls fetch is rebuilt once a night. So the honest fix is
 * to fetch each URL once and hand the same bytes to everyone else.
 */

/** How long a stored answer is served without asking upstream again.
 *
 * arXiv rebuilds the announcement RSS at 04:00 UTC and the search API's answer
 * for a fixed query moves no faster. Five minutes is short enough that a paper
 * announced mid-haul is at most five minutes late, and long enough that a
 * classroom's worth of people pressing the button costs one upstream call. */
export const FRESH_MS = 5 * 60 * 1000;

/** How long a stored answer is still worth serving when upstream is refusing.
 *
 * A throttled relay with yesterday's feed in hand has two options: hand over
 * bytes that are a few hours old, or hand over an error. For a listing that
 * changes once a night the stale copy is strictly better, and it is exactly
 * what breaks the pile-on: a 429 stops costing anyone their haul, so nobody
 * retries, so the limit recovers. */
export const STALE_MS = 12 * 60 * 60 * 1000;

/** Bodies above this are relayed but never stored — a cache entry big enough to
 * hurt Postgres is not worth the round trip it saves. */
export const MAX_CACHE_BYTES = 2 * 1024 * 1024;

export interface CacheEntry {
  status: number;
  contentType: string;
  body: string;
  fetchedAt: number;   // epoch ms
}

export type Freshness = 'fresh' | 'stale' | 'expired';

export function freshness(entry: CacheEntry, now = Date.now()): Freshness {
  const age = now - entry.fetchedAt;
  if (age < 0) return 'fresh';            // clock skew between isolates; trust it
  if (age < FRESH_MS) return 'fresh';
  if (age < STALE_MS) return 'stale';
  return 'expired';
}

/** Only a successful GET is worth remembering.
 *
 * Storing an error was the *other* half of the outage: the first relay stamped
 * `Cache-Control: public, max-age=300` onto whatever came back, 429s included,
 * so one throttled call taught every browser that saw it to replay the failure
 * for five minutes. A 429 is a statement about this second, not about the URL. */
export function isCacheable(status: number, byteLength: number): boolean {
  return status >= 200 && status < 300 && byteLength <= MAX_CACHE_BYTES;
}

/** What to tell the browser to do with this response.
 *
 * Successes may sit in the browser cache for the same window the relay uses;
 * everything else must be re-asked, because the reason it failed is temporary. */
export function cacheControlFor(status: number): string {
  return status >= 200 && status < 300
    ? `public, max-age=${Math.floor(FRESH_MS / 1000)}`
    : 'no-store';
}

/**
 * An isolate-local LRU in front of the database.
 *
 * Supabase keeps a warm isolate between calls, so the people who press the
 * button within a minute of each other usually land on the same one and never
 * reach Postgres. It is a bonus layer, not the mechanism: isolates are recycled
 * without warning and several can run at once, which is why the durable copy
 * exists underneath.
 */
export class MemoryCache {
  #max: number;
  #entries = new Map<string, CacheEntry>();

  constructor(max = 32) {
    this.#max = max;
  }

  get(url: string): CacheEntry | undefined {
    const hit = this.#entries.get(url);
    if (!hit) return undefined;
    if (freshness(hit) === 'expired') {
      this.#entries.delete(url);
      return undefined;
    }
    // Re-insert so the Map's insertion order is a recency order.
    this.#entries.delete(url);
    this.#entries.set(url, hit);
    return hit;
  }

  set(url: string, entry: CacheEntry): void {
    this.#entries.delete(url);
    this.#entries.set(url, entry);
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}

/**
 * Collapses concurrent identical work into one operation.
 *
 * The pile-on this whole file is about is not spread evenly: people open the
 * page and press the button at the same time of the morning. Without this, ten
 * simultaneous presses are ten upstream fetches that all miss the cache,
 * because none of them has finished writing it yet.
 */
export class SingleFlight<T> {
  #inflight = new Map<string, Promise<T>>();

  run(key: string, work: () => Promise<T>): Promise<T> {
    const running = this.#inflight.get(key);
    if (running) return running;
    const started = work().finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, started);
    return started;
  }

  get size(): number {
    return this.#inflight.size;
  }
}
