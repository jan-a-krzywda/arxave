/*
 * The page must not make a shared throttle worse. Run with
 * `node tests/js/relay-retry.test.js`.
 *
 * arXiv is fetched by the relay, server-side, so arXiv's per-client rate limit
 * is shared by everyone on the page. Measured 2026-08-29, the day after the
 * filter page was shared: export.arxiv.org answered 429 "Rate exceeded" and
 * hauls failed for everyone. The relay now caches, which is the real fix; this
 * file covers the browser's half — pace calls that actually go upstream, retry
 * a throttle instead of surfacing it, and never pace a call the cache served.
 */
const fs = require('fs');
const path = require('path');

const JS = fs.readFileSync(path.join(__dirname, '../../docs/assets/filter.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

/* Lift the relay helper block out of the IIFE. It only needs relayUrl and
   fetch, both injectable, so it runs without a DOM. */
const start = JS.indexOf('  var RELAY_GAP_MS =');
const end = JS.indexOf('  /* A refusal, said in a way');
if (start === -1 || end === -1) {
  console.log('  FAIL could not locate the relay helper block');
  process.exit(1);
}
const BLOCK = JS.slice(start, end);

/* A fake clock, so a test of three-second pacing does not take nine seconds.
   setTimeout resolves immediately but records what it was asked to wait, and
   Date.now advances by exactly that much — which is what we assert on. */
function build(fetchImpl) {
  const waits = [];
  let clock = 1_000_000;
  const sandboxDate = {
    now: () => clock,
    parse: Date.parse,
  };
  const setTimeout_ = (fn, ms) => { waits.push(ms); clock += ms; fn(); };
  const make = new Function(
    'fetch', 'relayUrl', 'setTimeout', 'Date', 'Number',
    BLOCK + '\n  return fetchViaRelay;');
  const fetchViaRelay = make(fetchImpl, (u) => u, setTimeout_, sandboxDate, Number);
  return { fetchViaRelay, waits, now: () => clock };
}

function resp(status, cacheTag, retryAfter) {
  const h = { 'x-relay-cache': cacheTag, 'Retry-After': retryAfter };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => h[k] ?? h[k.toLowerCase()] ?? null },
    text: async () => 'body',
  };
}

(async () => {
  console.log('\n1. a relay hit costs arXiv nothing, so it is never paced');
  {
    const { fetchViaRelay, waits } = build(async () => resp(200, 'hit'));
    await fetchViaRelay('a');
    await fetchViaRelay('b');
    await fetchViaRelay('c');
    check('three cached calls wait zero times', waits.length === 0, JSON.stringify(waits));
  }

  console.log('\n2. calls that go upstream are spaced');
  {
    const { fetchViaRelay, waits } = build(async () => resp(200, 'miss'));
    await fetchViaRelay('a');
    await fetchViaRelay('b');
    await fetchViaRelay('c');
    check('the first call does not wait', waits.length === 2, JSON.stringify(waits));
    check('later ones wait the full gap', waits.every((w) => w === 3000), JSON.stringify(waits));
  }

  console.log('\n3. an unknown proxy is treated as upstream');
  {
    // A custom CORS proxy in the settings box sends no x-relay-cache header.
    const { fetchViaRelay, waits } = build(async () => resp(200, undefined));
    await fetchViaRelay('a');
    await fetchViaRelay('b');
    check('pacing still applies', waits.length === 1 && waits[0] === 3000, JSON.stringify(waits));
  }

  console.log('\n4. a 429 is retried, not surfaced');
  {
    let calls = 0;
    const { fetchViaRelay } = build(async () => {
      calls++;
      return calls < 3 ? resp(429, 'bypass') : resp(200, 'miss');
    });
    const r = await fetchViaRelay('a');
    check('it keeps asking until it gets through', calls === 3, 'calls=' + calls);
    check('and returns the success', r.status === 200, 'status=' + r.status);
  }

  console.log('\n5. the backoff grows, and Retry-After wins when it is sent');
  {
    const { fetchViaRelay, waits } = build(async () => resp(429, 'bypass'));
    await fetchViaRelay('a');
    // First attempt is unpaced; retries wait 3 s then 6 s.
    check('exponential when the server says nothing',
      JSON.stringify(waits) === JSON.stringify([3000, 6000]), JSON.stringify(waits));

    const withHeader = build(async () => resp(429, 'bypass', '12'));
    await withHeader.fetchViaRelay('a');
    check('Retry-After overrides the backoff',
      withHeader.waits.every((w) => w === 12000), JSON.stringify(withHeader.waits));
  }

  console.log('\n6. a verdict on the URL is not retried');
  {
    let calls = 0;
    const { fetchViaRelay } = build(async () => { calls++; return resp(403, 'bypass'); });
    const r = await fetchViaRelay('a');
    check('403 comes straight back', calls === 1 && r.status === 403, 'calls=' + calls);
  }

  console.log('\n7. out of attempts, the caller still sees the refusal');
  {
    let calls = 0;
    const { fetchViaRelay } = build(async () => { calls++; return resp(429, 'bypass'); });
    const r = await fetchViaRelay('a');
    check('three tries, then the 429 is returned', calls === 3 && r.status === 429,
      'calls=' + calls + ' status=' + r.status);
  }

  console.log('\n8. a dropped connection is retried, and rethrown if it never recovers');
  {
    let calls = 0;
    const flaky = build(async () => {
      calls++;
      if (calls < 2) throw new TypeError('Failed to fetch');
      return resp(200, 'miss');
    });
    const r = await flaky.fetchViaRelay('a');
    check('a transient network error recovers', calls === 2 && r.status === 200, 'calls=' + calls);

    const dead = build(async () => { throw new TypeError('Failed to fetch'); });
    let threw = null;
    await dead.fetchViaRelay('a').catch((e) => { threw = e; });
    check('a dead relay throws rather than resolving',
      threw && /Failed to fetch/.test(threw.message), String(threw));
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})();
