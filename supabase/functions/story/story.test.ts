/**
 * `deno test supabase/functions/story/`
 *
 * The whole function lives behind two injected seams — `fetch` and the usage
 * meter — so every test here runs with no network and no database. That is the
 * point of story.ts being separate from index.ts, and the failure modes worth
 * pinning are: (1) the request caps, because thirteen papers is a bigger bill
 * than the contract allows; (2) the response validation, because a readFirst or
 * a thread id the page cannot link renders as a dead reference; (3) the budget,
 * which is shared with refine and buys a story in two calls — a partial grant
 * must be refunded rather than charged; (4) the security property inherited
 * from refine: a BYO `x-llm-key` spends nothing and appears in nothing.
 */
import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import {
  buildMessages,
  CALLS_PER_STORY,
  type Deps,
  handleStory,
  MAX_ABSTRACT,
  MAX_CARE,
  MAX_PAPERS,
  MAX_STORY,
  MAX_THREADS,
  MAX_TITLE,
  MAX_WAGONS,
  MAX_WHY,
  parseStory,
  promptFor,
  readRequest,
  type StoryRequest,
  StoryError,
  SYSTEM,
  type UsageStore,
} from './story.ts';

const ID1 = '2401.00001';
const ID2 = '2401.00002';
const ID3 = '2401.00003';
const IDS = [ID1, ID2, ID3];

const PAPERS = [
  {
    id: ID1,
    title: 'A record two-qubit gate',
    abstract: 'We report a two-qubit gate fidelity of 99.9% in Si/SiGe.',
    wagon: 'Spin qubits',
    topic: 'Quantum computing',
  },
  {
    id: ID2,
    title: 'Charge noise in Si/SiGe double dots',
    abstract: 'We measure a 1/f charge-noise spectrum over four decades.',
    topic: 'Quantum computing',
  },
];

/** A valid request; spread over it to break exactly one thing. */
function request(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: '2026-11-13',
    papers: PAPERS,
    wagons: [{ name: 'Spin qubits', size: 4 }, { name: 'Sensors', size: 2 }],
    care: 'gate fidelity and noise in silicon spin qubits',
    ...over,
  };
}

/** A valid model reply; spread `over` to break exactly one field. */
function reply(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: 'The night silicon got quieter',
    story: `Tonight two papers pull the same thread. [${ID1}] sets a fidelity ` +
      `record, and [${ID2}] measures the noise that record has to beat.\n\n` +
      `Start with [${ID2}] if you want the floor before the ceiling.`,
    readFirst: ID2,
    threads: [{ ids: [ID1, ID2], why: 'The gate record is bounded by that noise floor.' }],
    ...over,
  });
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** An OpenAI-shaped reply body carrying `content` as the message. */
const provider = (content: string): Response =>
  jsonResponse({ choices: [{ message: { content } }] });

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://story.test/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '203.0.113.7',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

interface Spy {
  urls: string[];
  auth: (string | null)[];
  logs: string[];
  spends: number[];   // every grant asked for, in order
  refunds: number[];  // every refund, in order
}

/** Deps wired to spies, with a provider that answers with a good reply. */
function harness(over: Partial<Deps> = {}): { deps: Deps; spy: Spy } {
  const spy: Spy = { urls: [], auth: [], logs: [], spends: [], refunds: [] };
  const deps: Deps = {
    fetch: (input, init) => {
      spy.urls.push(String(input));
      spy.auth.push(new Headers(init?.headers).get('authorization'));
      return Promise.resolve(provider(reply()));
    },
    usage: {
      spend: (_client, want) => {
        spy.spends.push(want);
        return Promise.resolve(want);
      },
      refund: (_client, n) => {
        spy.refunds.push(n);
        return Promise.resolve();
      },
    },
    apiKey: 'deploy-key',
    baseUrl: 'https://llm.invalid/v1',
    model: 'test-model',
    log: (message) => spy.logs.push(message),
    ...over,
  };
  return { deps, spy };
}

// ── Request validation. ────────────────────────────────────────────────────

Deno.test('readRequest accepts a well-formed body', () => {
  const got = readRequest(request());
  assertEquals(typeof got === 'string', false);
  const req = got as StoryRequest;
  assertEquals(req.date, '2026-11-13');
  assertEquals(req.papers.length, 2);
  assertEquals(req.papers[0].wagon, 'Spin qubits');
  assertEquals(req.wagons.length, 2);
  assertEquals(req.care, 'gate fidelity and noise in silicon spin qubits');
});

Deno.test('readRequest accepts papers with only the three required fields', () => {
  const got = readRequest(request({
    papers: [{ id: ID1, title: 't', abstract: 'a' }],
    wagons: [],
    care: undefined,
  })) as StoryRequest;
  assertEquals(got.papers[0].wagon, undefined);
  assertEquals(got.papers[0].topic, undefined);
  assertEquals(got.wagons, []);
  assertEquals(got.care, '');
});

Deno.test('readRequest clips abstracts to 1200 and care to 500, not throws', () => {
  const got = readRequest(request({
    papers: [{ id: ID1, title: 't'.repeat(500), abstract: 'a'.repeat(5000) }],
    care: 'c'.repeat(900),
  })) as StoryRequest;
  assertEquals(got.papers[0].abstract.length, MAX_ABSTRACT);
  assertEquals(got.papers[0].title.length, 300);
  assertEquals(got.care.length, MAX_CARE);
});

Deno.test('readRequest collapses whitespace in the input fields', () => {
  const got = readRequest(request({
    papers: [{ id: `  ${ID1} `, title: '  Valley   splitting\nin silicon ', abstract: 'a  b\nc' }],
  })) as StoryRequest;
  assertEquals(got.papers[0].id, ID1);
  assertEquals(got.papers[0].title, 'Valley splitting in silicon');
  assertEquals(got.papers[0].abstract, 'a b c');
});

Deno.test('readRequest rejects everything malformed with a message', () => {
  const tooManyPapers = Array.from({ length: MAX_PAPERS + 1 }, (_, i) => ({
    id: `2401.${String(i).padStart(5, '0')}`,
    title: 't',
    abstract: 'a',
  }));
  const tooManyWagons = Array.from({ length: MAX_WAGONS + 1 }, (_, i) => ({
    name: `w${i}`,
    size: 1,
  }));
  for (
    const body of [
      {},
      { date: '13/11/2026', papers: PAPERS },
      { date: '2026-02-30', papers: PAPERS },
      { date: 20261113, papers: PAPERS },
      { date: '2026-11-13' },                       // no papers
      { date: '2026-11-13', papers: [] },
      { date: '2026-11-13', papers: 'nope' },
      { date: '2026-11-13', papers: [null] },
      { date: '2026-11-13', papers: [{ title: 't', abstract: 'a' }] },
      { date: '2026-11-13', papers: [{ id: '', title: 't', abstract: 'a' }] },
      { date: '2026-11-13', papers: [{ id: ID1, abstract: 'a' }] },
      { date: '2026-11-13', papers: [{ id: ID1, title: 't', abstract: '' }] },
      /* A duplicate id makes readFirst ∈ ids mean nothing: two cards would
         answer to the same handle. */
      { date: '2026-11-13', papers: [PAPERS[0], PAPERS[0]] },
      { date: '2026-11-13', papers: PAPERS, wagons: 'nope' },
      { date: '2026-11-13', papers: PAPERS, wagons: [{}] },
      { date: '2026-11-13', papers: PAPERS, wagons: [{ name: '', size: 2 }] },
      { date: '2026-11-13', papers: PAPERS, wagons: [{ name: 'w', size: 'many' }] },
      { date: '2026-11-13', papers: PAPERS, wagons: tooManyWagons },
      { date: '2026-11-13', papers: PAPERS, care: 42 },
      { date: '2026-11-13', papers: tooManyPapers },
    ]
  ) {
    assertEquals(typeof readRequest(body as Record<string, unknown>), 'string');
  }
});

Deno.test('readRequest keeps exactly the caps worth of papers and wagons', () => {
  const papers = Array.from({ length: MAX_PAPERS }, (_, i) => ({
    id: `2401.${String(i).padStart(5, '0')}`,
    title: 't',
    abstract: 'a',
  }));
  const wagons = Array.from({ length: MAX_WAGONS }, (_, i) => ({ name: `w${i}`, size: i }));
  const got = readRequest({ date: '2026-11-13', papers, wagons }) as StoryRequest;
  assertEquals(got.papers.length, MAX_PAPERS);
  assertEquals(got.wagons.length, MAX_WAGONS);
});


// ── The prompt. ────────────────────────────────────────────────────────────

Deno.test('the prompt carries the date, the ids, the wagons and the reader', () => {
  const req = readRequest(request()) as StoryRequest;
  const prompt = promptFor(req);
  assertEquals(prompt.includes('2026-11-13'), true);
  assertEquals(prompt.includes(`[${ID1}]`), true);
  assertEquals(prompt.includes(PAPERS[0].title), true);
  assertEquals(prompt.includes(PAPERS[0].abstract), true);
  assertEquals(prompt.includes('wagon: Spin qubits'), true);
  assertEquals(prompt.includes('topic: Quantum computing'), true);
  assertEquals(prompt.includes('- Spin qubits (4 papers)'), true);
  assertEquals(prompt.includes('gate fidelity and noise in silicon spin qubits'), true);
});

Deno.test('the prompt clips each abstract at 1200 characters', () => {
  const req = readRequest(request({
    papers: [{ id: ID1, title: 't', abstract: 'a'.repeat(2000) }],
  })) as StoryRequest;
  const prompt = promptFor(req);
  assertEquals(prompt.includes('a'.repeat(MAX_ABSTRACT)), true);
  assertEquals(prompt.includes('a'.repeat(MAX_ABSTRACT + 1)), false);
  assertEquals(prompt.includes('a'.repeat(2000)), false);
});

Deno.test('the prompt says so when there are no wagons or care', () => {
  const prompt = promptFor(readRequest(request({ wagons: [], care: '' })) as StoryRequest);
  assertEquals(prompt.includes('(none given)'), true);
  assertEquals(prompt.includes('(not named)'), true);
});

Deno.test('the system turn demands JSON, ids and no invention', () => {
  assertEquals(/Return ONLY a JSON object/i.test(SYSTEM), true);
  assertEquals(SYSTEM.includes('"readFirst"'), true);
  assertEquals(SYSTEM.includes('"threads"'), true);
  assertEquals(/do not invent/i.test(SYSTEM), true);
  const messages = buildMessages(readRequest(request()) as StoryRequest);
  assertEquals(messages.map((m) => m.role), ['system', 'user']);
  assertEquals(messages[0].content, SYSTEM);
});

// ── Response validation. ───────────────────────────────────────────────────

Deno.test('parseStory passes a good reply through', () => {
  const got = parseStory(reply(), IDS);
  assertEquals(got.title, 'The night silicon got quieter');
  assertEquals(got.readFirst, ID2);
  assertEquals(got.threads.length, 1);
  assertEquals(got.threads[0].ids, [ID1, ID2]);
  assertEquals(got.story.includes(`[${ID1}]`), true);
});

Deno.test('parseStory tolerates a ```json fence and a reply with no threads', () => {
  assertEquals(parseStory('```json\n' + reply() + '\n```', IDS).readFirst, ID2);
  const noThreads = parseStory(reply({ threads: [] }), IDS);
  assertEquals(noThreads.threads, []);
  const missingThreads = parseStory(reply({ threads: undefined }), IDS);
  assertEquals(missingThreads.threads, []);
});

Deno.test('parseStory clips the title, the story and a thread why', () => {
  const got = parseStory(
    reply({
      title: 't'.repeat(400),
      story: 's'.repeat(5000),
      threads: [{ ids: [ID1, ID2], why: 'w'.repeat(500) }],
    }),
    IDS,
  );
  assertEquals(got.title.length, MAX_TITLE);
  assertEquals(got.story.length, MAX_STORY);
  assertEquals(got.threads[0].why.length, MAX_WHY);
});

Deno.test('parseStory drops threads past the fourth rather than failing', () => {
  const threads = Array.from({ length: MAX_THREADS + 2 }, () => ({ ids: [ID1, ID2], why: 'w' }));
  assertEquals(parseStory(reply({ threads }), IDS).threads.length, MAX_THREADS);
});

/* The reference the page cannot link: readFirst or a thread id that is not one
   of tonight's picks is exactly the hallucination this validation exists for. */
Deno.test('parseStory rejects a readFirst or thread id that was not picked', () => {
  for (
    const over of [
      { readFirst: '2401.99999' },
      { readFirst: '' },
      { readFirst: null },
      { readFirst: undefined },
      { threads: [{ ids: [ID1, '2401.99999'], why: 'w' }] },
      { threads: [{ ids: ['2401.99999', '2401.88888'], why: 'w' }] },
    ]
  ) {
    assertThrows(() => parseStory(reply(over), IDS), StoryError);
  }
});

Deno.test('parseStory rejects a thread with fewer than two ids or an empty why', () => {
  for (
    const over of [
      { threads: [{ ids: [ID1], why: 'w' }] },
      { threads: [{ ids: [], why: 'w' }] },
      { threads: [{ ids: 'nope', why: 'w' }] },
      { threads: [{ ids: [ID1, ID2], why: '' }] },
      { threads: [{ ids: [ID1, ID2], why: '  ' }] },
      { threads: 'nope' },
      { threads: [null] },
    ]
  ) {
    assertThrows(() => parseStory(reply(over), IDS), StoryError);
  }
});

Deno.test('parseStory rejects an empty title or story, and non-object bodies', () => {
  for (
    const over of [{ title: '' }, { title: '   ' }, { story: '' }, { story: null }, {
      title: 42,
    }, { story: {} }]
  ) {
    assertThrows(() => parseStory(reply(over), IDS), StoryError);
  }
  for (const text of ['', 'not json', '[1, 2]', '42', '"a string"', '{"trunc']) {
    assertThrows(() => parseStory(text, IDS), StoryError);
  }
});


// ── The handler: the happy path and every fault. ───────────────────────────

Deno.test('a good reply comes back as the story, with CORS and a cost of two', async () => {
  const { deps, spy } = harness();
  const resp = await handleStory(post(request()), deps);
  assertEquals(resp.status, 200);
  assertEquals(resp.headers.get('access-control-allow-origin'), '*');
  assertEquals(await resp.json(), JSON.parse(reply()));
  assertEquals(spy.urls, ['https://llm.invalid/v1/chat/completions']);
  assertEquals(spy.auth, ['Bearer deploy-key']);
  assertEquals(spy.spends, [CALLS_PER_STORY]);
  assertEquals(spy.refunds, []);
});

Deno.test('a partial grant is refunded and refused, never half-charged', async () => {
  const { deps, spy } = harness({
    usage: {
      spend: (_client, want) => {
        spy.spends.push(want);
        return Promise.resolve(want - 1);   // only one of the two calls
      },
      refund: (_client, n) => {
        spy.refunds.push(n);
        return Promise.resolve();
      },
    },
  });
  const resp = await handleStory(post(request()), deps);
  assertEquals(resp.status, 429);
  assertEquals(await resp.json(), { error: 'budget' });
  assertEquals(spy.spends, [CALLS_PER_STORY]);
  assertEquals(spy.refunds, [1]);          // exactly what was granted, no more
  assertEquals(spy.urls, []);             // a refused story is not a provider call
});

Deno.test('a full refusal is a 429 with nothing to refund', async () => {
  const { deps, spy } = harness({
    usage: {
      spend: () => Promise.resolve(0),
      refund: (_client, n) => {
        spy.refunds.push(n);
        return Promise.resolve();
      },
    },
  });
  const resp = await handleStory(post(request()), deps);
  assertEquals(resp.status, 429);
  assertEquals(spy.refunds, []);
  assertEquals(spy.urls, []);
});

Deno.test('a provider failure refunds both calls and is a 502', async () => {
  const { deps, spy } = harness({
    fetch: () => Promise.resolve(new Response('upstream exploded', { status: 500 })),
  });
  const resp = await handleStory(post(request()), deps);
  assertEquals(resp.status, 502);
  assertEquals(spy.spends, [CALLS_PER_STORY]);
  assertEquals(spy.refunds, [CALLS_PER_STORY]);
});

Deno.test('bad model output is a 502 and a refund, never a 200', async () => {
  for (
    const content of [
      reply({ readFirst: '2401.99999' }),
      reply({ story: '' }),
      reply({ title: '' }),
      reply({ threads: [{ ids: [ID1, '2401.99999'], why: 'w' }] }),
      'not json',
      '',
    ]
  ) {
    const { deps, spy } = harness({ fetch: () => Promise.resolve(provider(content)) });
    const resp = await handleStory(post(request()), deps);
    assertEquals(resp.status, 502);
    assertEquals(spy.refunds, [CALLS_PER_STORY]);
  }
});

Deno.test('thirteen papers are a 400 before the meter or the provider', async () => {
  const { deps, spy } = harness();
  const papers = Array.from({ length: MAX_PAPERS + 1 }, (_, i) => ({
    id: `2401.${String(i).padStart(5, '0')}`,
    title: 't',
    abstract: 'a',
  }));
  const resp = await handleStory(post(request({ papers })), deps);
  assertEquals(resp.status, 400);
  assertEquals(spy.spends, []);   // no RPC call at all
  assertEquals(spy.urls, []);
});

Deno.test('a malformed body is a 400', async () => {
  const { deps, spy } = harness();
  assertEquals((await handleStory(post({}), deps)).status, 400);
  assertEquals((await handleStory(post('not json'), deps)).status, 400);
  assertEquals(spy.spends, []);
});

Deno.test('no key anywhere is a 503, before anything is spent', async () => {
  const { deps, spy } = harness({ apiKey: '' });
  const resp = await handleStory(post(request()), deps);
  assertEquals(resp.status, 503);
  assertEquals(spy.spends, []);
});

Deno.test('OPTIONS is a 204 with CORS; anything but POST is a 405', async () => {
  const { deps } = harness();
  const opts = await handleStory(
    new Request('https://story.test/', { method: 'OPTIONS' }),
    deps,
  );
  assertEquals(opts.status, 204);
  assertEquals(opts.headers.get('access-control-allow-origin'), '*');
  assertEquals(opts.headers.get('access-control-allow-headers'), 'Content-Type, x-llm-key');
  const get = await handleStory(new Request('https://story.test/', { method: 'GET' }), deps);
  assertEquals(get.status, 405);
});


// ── BYO: the caller's own key. ─────────────────────────────────────────────

Deno.test('a BYO key bypasses the meter entirely', async () => {
  let spends = 0;
  const usage: UsageStore = {
    spend: () => {
      spends++;
      return Promise.resolve(0);   // a meter that would refuse everyone
    },
    refund: () => Promise.resolve(),
  };
  const { deps } = harness({ usage, apiKey: '' });
  const resp = await handleStory(post(request(), { 'x-llm-key': 'byo-key' }), deps);
  assertEquals(resp.status, 200);
  assertEquals(spends, 0);
});

Deno.test('a BYO key is used for the call and appears nowhere else', async () => {
  const { deps, spy } = harness();
  const KEY = 'sk-caller-secret-0123456789';
  const resp = await handleStory(post(request(), { 'x-llm-key': KEY }), deps);
  assertEquals(resp.status, 200);
  assertEquals(spy.auth, [`Bearer ${KEY}`]);                 // ...used for the call
  assertEquals(spy.spends, []);                              // ...never metered
  const text = await resp.text();
  assertEquals(text.includes(KEY), false);                   // ...not in the body
  for (const [name, value] of resp.headers) {
    assertEquals(`${name}:${value}`.includes(KEY), false);   // ...not in a header
  }
  assertEquals(spy.logs.some((m) => m.includes(KEY)), false); // ...not in a log
});

Deno.test('a failed BYO call is not refunded and its key is still never logged', async () => {
  const KEY = 'sk-caller-secret-0123456789';
  const { deps, spy } = harness({
    fetch: () => Promise.resolve(new Response('upstream exploded', { status: 500 })),
  });
  const resp = await handleStory(post(request(), { 'x-llm-key': KEY }), deps);
  assertEquals(resp.status, 502);
  assertEquals(spy.spends, []);    // never debited the deployment's meter
  assertEquals(spy.refunds, []);
  assertEquals(spy.logs.some((m) => m.includes(KEY)), false);
});

Deno.test('the deploy key never appears in a response or a log', async () => {
  const { deps, spy } = harness({
    fetch: () => Promise.resolve(new Response('upstream exploded', { status: 500 })),
  });
  const resp = await handleStory(post(request()), deps);
  const text = await resp.text();
  assertEquals(text.includes('deploy-key'), false);
  assertEquals(spy.logs.some((m) => m.includes('deploy-key')), false);
});

