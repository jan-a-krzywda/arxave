/**
 * `cd supabase/functions/threads && deno test threads.test.ts`
 *
 * The function is a relay with an allow-list, so the failures worth pinning
 * are the refusals (a repo off the list would spend our token on a stranger's
 * Discussions), the id cleaning (a versioned or junk id must not reach the
 * search), the exact GraphQL string, the bracketed-id match — `2401.1234` is
 * a substring of `2401.12345` and must not borrow its thread — and the
 * promise the page relies on: a GitHub fault is `{ threads: {}, error }` at
 * 200, never a 5xx.
 *
 * No network and no token: `fetch` is injected, and the cache is reset between
 * tests because it lives as long as the module (an isolate) does.
 */
import { assertEquals } from 'jsr:@std/assert@1';
import {
  type Deps,
  DEFAULT_REPO,
  handleThreads,
  matchThreads,
  MAX_IDS,
  queryFor,
  readRequest,
  repoAllowList,
  resetCache,
  TTL_FOUND,
  TTL_MISS,
} from './threads.ts';

const ALLOW = repoAllowList(DEFAULT_REPO);
const REPO = DEFAULT_REPO;
const URL_2401 = `https://github.com/${REPO}/discussions/7`;

function post(body: unknown): Request {
  return new Request('https://threads.test/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** A GraphQL page carrying the given Discussion nodes. */
const page = (...nodes: { title: string; url: string }[]): Response =>
  jsonResponse({ data: { search: { nodes } } });

interface Spy {
  urls: string[];
  auth: (string | null)[];
  bodies: string[];
  logs: string[];
}

function harness(over: Partial<Deps> = {}): { deps: Deps; spy: Spy } {
  resetCache();
  const spy: Spy = { urls: [], auth: [], bodies: [], logs: [] };
  const { fetch: answer = () => Promise.resolve(page()), ...rest } = over;
  const deps: Deps = {
    token: 'gh-test-token',
    repos: ALLOW,
    log: (message) => spy.logs.push(message),
    ...rest,
    /* Every test's fetch goes through the spy, so "one call" and "the token
       went nowhere else" are checkable without each test rebuilding it. */
    fetch: (input, init) => {
      spy.urls.push(String(input));
      spy.auth.push(new Headers(init?.headers).get('authorization'));
      spy.bodies.push(String(init?.body ?? ''));
      return answer(input, init);
    },
  };
  return { deps, spy };
}

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `2401.${10_000 + i}`);
}

// ── readRequest: the allow-list and the id cleaning. ──────────────────────

Deno.test('a good request reads back as its repo and ids', () => {
  assertEquals(
    readRequest({ repo: REPO, ids: ['2401.12345', '2401.12346'] }, ALLOW),
    { repo: REPO, ids: ['2401.12345', '2401.12346'] },
  );
});

Deno.test('a repo that is not "owner/name" is refused', () => {
  for (const repo of ['', 'arxave', 'a/b/c', 'https://github.com/a/b', 'a b/c', 'a/b\n']) {
    const got = readRequest({ repo, ids: ['2401.12345'] }, ALLOW);
    assertEquals(typeof got, 'string', `repo ${JSON.stringify(repo)} should be refused`);
  }
});

Deno.test('a well-formed repo not on the allow-list is refused', () => {
  const got = readRequest({ repo: 'someone/else', ids: ['2401.12345'] }, ALLOW);
  assertEquals(typeof got, 'string');
  assertEquals((got as string).includes('allowed'), true);
});

Deno.test('the allow-list is case-insensitive and comes from a comma list', () => {
  const allow = repoAllowList('jan-a-krzywda/arxave-campfire, Fork/Other ');
  assertEquals(allow, ['jan-a-krzywda/arxave-campfire', 'fork/other']);
  assertEquals(readRequest({ repo: 'JAN-A-KRZYWDA/arxave-campfire', ids: [] }, allow), {
    repo: 'JAN-A-KRZYWDA/arxave-campfire',
    ids: [],
  });
});

Deno.test('a versioned id is stripped, duplicates collapse, junk is dropped', () => {
  assertEquals(
    readRequest({
      repo: REPO,
      ids: [
        '2401.12345v2',
        '2401.12345',
        ' 2401.12346V10 ',
        '2401.123',         // too few digits after the dot
        '2401.123456',      // too many
        'arxiv:2401.12347',
        'hep-th/9901001',   // old style, kept
        'math.GT/0309136',  // old style with a category
        'nonsense',
        42,
        null,
      ],
    }, ALLOW),
    { repo: REPO, ids: ['2401.12345', '2401.12346', 'hep-th/9901001', 'math.GT/0309136'] },
  );
});

Deno.test('more than 25 ids is refused, and 25 is accepted', () => {
  assertEquals(readRequest({ repo: REPO, ids: ids(MAX_IDS) }, ALLOW), {
    repo: REPO,
    ids: ids(MAX_IDS),
  });
  assertEquals(typeof readRequest({ repo: REPO, ids: ids(MAX_IDS + 1) }, ALLOW), 'string');
});

Deno.test('ids must be an array of the right shape', () => {
  assertEquals(typeof readRequest({ repo: REPO, ids: '2401.12345' }, ALLOW), 'string');
  assertEquals(typeof readRequest({ repo: REPO }, ALLOW), 'string');
  assertEquals(typeof readRequest('2401.12345', ALLOW), 'string');
  assertEquals(typeof readRequest(null, ALLOW), 'string');
});

// ── the query and the match. ──────────────────────────────────────────────

Deno.test('the GraphQL query is one Discussions search over the ids', () => {
  assertEquals(
    queryFor(REPO, ['2401.12345', '2401.12346']),
    'query { search(type: DISCUSSION, first: 50, query: ' +
      `"repo:${REPO} in:title 2401.12345 OR 2401.12346"` +
      ') { nodes { ... on Discussion { title url } } } }',
  );
});

Deno.test('the bracketed id in the title is the match, null otherwise', () => {
  const nodes = [
    { title: '[2401.12345] A record two-qubit gate', url: URL_2401 },
    { title: '[2401.123456] A different paper', url: 'https://github.com/x/y/discussions/9' },
  ];
  assertEquals(matchThreads(['2401.12345', '2401.12346', '2401.123456'], nodes), {
    '2401.12345': URL_2401,
    '2401.12346': null,
    '2401.123456': 'https://github.com/x/y/discussions/9',
  });
});

Deno.test("a shorter id does not match the longer id's thread", () => {
  const nodes = [{ title: '[2401.12345] A record two-qubit gate', url: URL_2401 }];
  assertEquals(matchThreads(['2401.1234'], nodes), { '2401.1234': null });
});

// ── the handler. ──────────────────────────────────────────────────────────

Deno.test('OPTIONS is a bare preflight and any other method is a 405', async () => {
  const { deps, spy } = harness();
  const pre = await handleThreads(
    new Request('https://threads.test/', { method: 'OPTIONS' }),
    deps,
  );
  assertEquals(pre.status, 204);
  assertEquals(pre.headers.get('access-control-allow-origin'), '*');

  assertEquals((await handleThreads(new Request('https://threads.test/'), deps)).status, 405);
  assertEquals(spy.urls, []);
});

Deno.test('a refused body is a 400 with a message, never a silent empty', async () => {
  const { deps, spy } = harness();
  for (const body of [
    'not json',
    { repo: 'attacker/repo', ids: ['2401.12345'] },
    { repo: REPO, ids: ids(MAX_IDS + 1) },
    { repo: REPO },
  ]) {
    const resp = await handleThreads(post(body), deps);
    assertEquals(resp.status, 400, `body ${JSON.stringify(body)} should be refused`);
    assertEquals(typeof (await resp.json()).error, 'string');
  }
  assertEquals(spy.urls, []);   // nothing reached GitHub
});

Deno.test('one GraphQL call answers every id, found or null', async () => {
  const { deps, spy } = harness({
    fetch: () => Promise.resolve(page({ title: '[2401.12345] A record gate', url: URL_2401 })),
  });
  const resp = await handleThreads(post({ repo: REPO, ids: ['2401.12345', '2401.12346'] }), deps);
  assertEquals(resp.status, 200);
  assertEquals(await resp.json(), {
    threads: { '2401.12345': URL_2401, '2401.12346': null },
  });
  assertEquals(spy.urls, ['https://api.github.com/graphql']);
  assertEquals(spy.auth, ['bearer gh-test-token']);
  assertEquals(JSON.parse(spy.bodies[0]), {
    query: queryFor(REPO, ['2401.12345', '2401.12346']),
  });
});

Deno.test('no GITHUB_TOKEN is an empty answer plus an error, not a 500', async () => {
  const { deps, spy } = harness({ token: '' });
  const resp = await handleThreads(post({ repo: REPO, ids: ['2401.12345'] }), deps);
  assertEquals(resp.status, 200);
  assertEquals(await resp.json(), { threads: {}, error: 'no GITHUB_TOKEN' });
  assertEquals(spy.urls, []);
});

Deno.test('an upstream fault is a 200 with no threads and an error', async () => {
  const failures = [
    () => Promise.resolve(new Response('boom', { status: 500 })),
    () => Promise.resolve(jsonResponse({ errors: [{ message: 'Bad credentials' }] })),
    () => Promise.resolve(jsonResponse({})),                    // no search in the page
    () => Promise.reject(new Error('The signal has timed out')),
  ];
  for (const fetch of failures) {
    const { deps, spy } = harness({ fetch });
    const resp = await handleThreads(post({ repo: REPO, ids: ['2401.12345'] }), deps);
    assertEquals(resp.status, 200);
    const body = await resp.json();
    assertEquals(body.threads, {});
    assertEquals(typeof body.error, 'string');
    /* The token is used for the call and appears nowhere else. */
    const seen = JSON.stringify(body) + spy.logs.join('\n');
    assertEquals(seen.includes('gh-test-token'), false);
  }
});

// ── the cache. ────────────────────────────────────────────────────────────

Deno.test('a found thread is remembered for ten minutes', async () => {
  let clock = 0;
  let calls = 0;
  const fetch = () => {
    calls++;
    return Promise.resolve(page({ title: '[2401.12345] A record gate', url: URL_2401 }));
  };
  const { deps } = harness({ fetch, now: () => clock });
  const ask = () => handleThreads(post({ repo: REPO, ids: ['2401.12345'] }), deps);

  await ask();
  clock = TTL_FOUND;
  assertEquals(await (await ask()).json(), { threads: { '2401.12345': URL_2401 } });
  assertEquals(calls, 1);

  clock = TTL_FOUND + 1;
  await ask();
  assertEquals(calls, 2);
});

Deno.test('a null is remembered for two minutes only', async () => {
  let clock = 0;
  let calls = 0;
  const fetch = () => {
    calls++;
    return Promise.resolve(page());
  };
  const { deps } = harness({ fetch, now: () => clock });
  const ask = () => handleThreads(post({ repo: REPO, ids: ['2401.12346'] }), deps);

  await ask();
  clock = TTL_MISS;
  assertEquals(await (await ask()).json(), { threads: { '2401.12346': null } });
  assertEquals(calls, 1);

  clock = TTL_MISS + 1;
  await ask();
  assertEquals(calls, 2);
});

Deno.test('only the uncached ids go to GitHub', async () => {
  const bodies: string[] = [];
  const { deps } = harness({
    fetch: (_input, init) => {
      bodies.push(String(init?.body));
      return Promise.resolve(page({ title: '[2401.12345] A record gate', url: URL_2401 }));
    },
  });
  await handleThreads(post({ repo: REPO, ids: ['2401.12345'] }), deps);
  const resp = await handleThreads(post({ repo: REPO, ids: ['2401.12345', '2401.12346'] }), deps);

  assertEquals(await resp.json(), {
    threads: { '2401.12345': URL_2401, '2401.12346': null },
  });
  assertEquals(bodies.length, 2);
  assertEquals(JSON.parse(bodies[1]), { query: queryFor(REPO, ['2401.12346']) });
});
