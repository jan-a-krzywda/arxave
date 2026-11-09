/**
 * `deno test supabase/functions/refine/`
 *
 * The whole function lives behind two injected seams — `fetch` and the usage
 * meter — so every test here runs with no network and no database. That is the
 * point of refine.ts being separate from index.ts: the failure modes worth
 * pinning are (1) the request caps, (2) the response validation, because a
 * reply with a relevance of 0 reaches the card as nothing, (3) the budget, and
 * (4) the one that is a security property rather than a nicety: a BYO
 * `x-llm-key` must spend nothing and appear in nothing.
 */
import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import {
  buildMessages,
  type Deps,
  handleRefine,
  MAX_ABSTRACT,
  MAX_FIELD,
  MAX_NEIGHBOURS,
  MAX_TITLE,
  MAX_TOUCHSTONES,
  parseRefine,
  promptFor,
  readRequest,
  type RefineRequest,
  RefineError,
  SYSTEM,
  type UsageStore,
} from './refine.ts';

const PAPER = {
  title: 'A record two-qubit gate',
  abstract: 'We report a two-qubit gate fidelity of 99.9% in Si/SiGe.',
};

/** A valid request; spread over it to break exactly one thing. */
function request(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paper: PAPER,
    neighbours: [{ title: 'Exchange gates in silicon', pct: 0.9 }],
    touchstones: ['charge noise in Si/SiGe double dots'],
    ...over,
  };
}

/** A valid model reply; spread `over` to break exactly one field. */
function reply(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    relevance: 5,
    novelty: 4,
    why: 'It fits the touchstone and reports a record.',
    adds: 'A higher fidelity than the neighbours report.',
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
  return new Request('https://refine.test/', {
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
  refunds: number;
  spends: number;
}

/** Deps wired to spies, with a provider that answers with a good reply. */
function harness(over: Partial<Deps> = {}): { deps: Deps; spy: Spy } {
  const spy: Spy = { urls: [], auth: [], logs: [], refunds: 0, spends: 0 };
  const deps: Deps = {
    fetch: (input, init) => {
      spy.urls.push(String(input));
      spy.auth.push(new Headers(init?.headers).get('authorization'));
      return Promise.resolve(provider(reply()));
    },
    usage: {
      spend: () => {
        spy.spends++;
        return Promise.resolve(1);
      },
      refund: () => {
        spy.refunds++;
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
  assertEquals((got as RefineRequest).paper.title, PAPER.title);
  assertEquals((got as RefineRequest).neighbours.length, 1);
  assertEquals((got as RefineRequest).touchstones.length, 1);
});

Deno.test('readRequest accepts a paper with no neighbours or touchstones', () => {
  const got = readRequest({ paper: PAPER }) as RefineRequest;
  assertEquals(got.neighbours, []);
  assertEquals(got.touchstones, []);
});

Deno.test('readRequest clips the title and the abstract rather than throwing', () => {
  const got = readRequest({
    paper: { title: 't'.repeat(500), abstract: 'a'.repeat(5000) },
  }) as RefineRequest;
  assertEquals(got.paper.title.length, MAX_TITLE);
  assertEquals(got.paper.abstract.length, MAX_ABSTRACT);
});

Deno.test('readRequest collapses whitespace like the prompt normalisation does', () => {
  const got = readRequest({
    paper: { title: '  Valley   splitting\nin silicon ', abstract: 'a  b\nc' },
  }) as RefineRequest;
  assertEquals(got.paper.title, 'Valley splitting in silicon');
  assertEquals(got.paper.abstract, 'a b c');
});

Deno.test('readRequest drops a blank touchstone instead of failing', () => {
  const got = readRequest({ paper: PAPER, touchstones: ['', '  ', 'real'] }) as RefineRequest;
  assertEquals(got.touchstones, ['real']);
});

Deno.test('readRequest rejects everything malformed with a message', () => {
  const tooManyNeighbours = Array.from({ length: MAX_NEIGHBOURS + 1 }, () => ({
    title: 'x',
    pct: 0.5,
  }));
  const tooManyTouchstones = Array.from({ length: MAX_TOUCHSTONES + 1 }, () => 'x');
  for (
    const body of [
      {},
      { paper: null },
      { paper: [] },
      { paper: { title: '', abstract: 'a' } },
      { paper: { title: '   ', abstract: 'a' } },
      { paper: { title: 't', abstract: '' } },
      { paper: PAPER, neighbours: 'nope' },
      { paper: PAPER, neighbours: [{}] },
      { paper: PAPER, neighbours: [{ title: '', pct: 0.5 }] },
      { paper: PAPER, neighbours: [{ title: 'x', pct: 'high' }] },
      { paper: PAPER, neighbours: [{ title: 'x' }] },
      { paper: PAPER, neighbours: tooManyNeighbours },
      { paper: PAPER, touchstones: 'nope' },
      { paper: PAPER, touchstones: [1] },
      { paper: PAPER, touchstones: tooManyTouchstones },
    ]
  ) {
    assertEquals(typeof readRequest(body as Record<string, unknown>), 'string');
  }
});

Deno.test('readRequest keeps exactly the caps worth of neighbours and touchstones', () => {
  const n = Array.from({ length: MAX_NEIGHBOURS }, (_, i) => ({ title: `t${i}`, pct: i / 10 }));
  const t = Array.from({ length: MAX_TOUCHSTONES }, (_, i) => `touchstone ${i}`);
  assertEquals(typeof readRequest({ paper: PAPER, neighbours: n, touchstones: t }), 'object');
});

// ── The prompt. ────────────────────────────────────────────────────────────

Deno.test('the prompt carries the paper, its neighbours and the touchstones', () => {
  const req = readRequest(request()) as RefineRequest;
  const prompt = promptFor(req);
  assertEquals(prompt.includes(PAPER.title), true);
  assertEquals(prompt.includes(PAPER.abstract), true);
  assertEquals(prompt.includes('Exchange gates in silicon'), true);
  assertEquals(prompt.includes('0.9'), true);
  assertEquals(prompt.includes('charge noise in Si/SiGe double dots'), true);
});

Deno.test('the prompt says so when there are no neighbours or touchstones', () => {
  const prompt = promptFor(readRequest({ paper: PAPER }) as RefineRequest);
  assertEquals(prompt.includes('(none given)'), true);
});

Deno.test('the system turn demands JSON and nothing else', () => {
  assertEquals(/Return ONLY a JSON object/i.test(SYSTEM), true);
  assertEquals(SYSTEM.includes('"relevance"'), true);
  assertEquals(SYSTEM.includes('"adds"'), true);
  const messages = buildMessages(readRequest(request()) as RefineRequest);
  assertEquals(messages.map((m) => m.role), ['system', 'user']);
  assertEquals(messages[0].content, SYSTEM);
});

// ── Response validation. ───────────────────────────────────────────────────

Deno.test('parseRefine passes a good reply through', () => {
  assertEquals(parseRefine(reply()), {
    relevance: 5,
    novelty: 4,
    why: 'It fits the touchstone and reports a record.',
    adds: 'A higher fidelity than the neighbours report.',
  });
});

Deno.test('parseRefine tolerates a ```json fence', () => {
  const fenced = '```json\n' + reply() + '\n```';
  assertEquals(parseRefine(fenced).relevance, 5);
});

/* The loop that a wrong number would slip through: 0, 6 and a float are all
   "calls made" and none of them is a relevance the card can render. */
Deno.test('parseRefine rejects a field that is not a 1..5 integer', () => {
  for (
    const over of [
      { relevance: 0 },
      { relevance: 6 },
      { relevance: 2.5 },
      { relevance: '5' },
      { relevance: null },
      { novelty: 0 },
      { novelty: 6 },
      { novelty: 1.2 },
      { novelty: '4' },
    ]
  ) {
    assertThrows(() => parseRefine(reply(over)), RefineError);
  }
});

Deno.test('parseRefine rejects an empty prose field', () => {
  for (const over of [{ why: '' }, { why: '   ' }, { adds: '' }, { adds: null }]) {
    assertThrows(() => parseRefine(reply(over)), RefineError);
  }
});

Deno.test('parseRefine rejects a body that is not a JSON object', () => {
  for (const text of ['', 'not json', '[1, 2]', '42', '"a string"', '{"trunc']) {
    assertThrows(() => parseRefine(text), RefineError);
  }
});

Deno.test('parseRefine clips why and adds to 240 characters, not throws', () => {
  const long = 'x'.repeat(400);
  const got = parseRefine(reply({ why: long, adds: long }));
  assertEquals(got.why.length, MAX_FIELD);
  assertEquals(got.adds.length, MAX_FIELD);
});

// ── The handler: the happy path and every fault. ───────────────────────────

Deno.test('a good reply comes back as the refine, with CORS', async () => {
  const { deps, spy } = harness();
  const resp = await handleRefine(post(request()), deps);
  assertEquals(resp.status, 200);
  assertEquals(resp.headers.get('access-control-allow-origin'), '*');
  assertEquals(await resp.json(), JSON.parse(reply()));
  assertEquals(spy.urls, ['https://llm.invalid/v1/chat/completions']);
  assertEquals(spy.auth, ['Bearer deploy-key']);
});

Deno.test('bad model output is a 502, never a 200', async () => {
  for (
    const content of [
      reply({ relevance: 0 }),
      reply({ novelty: 9 }),
      reply({ why: '' }),
      reply({ adds: '' }),
      'not json',
      '',
    ]
  ) {
    const { deps } = harness({ fetch: () => Promise.resolve(provider(content)) });
    const resp = await handleRefine(post(request()), deps);
    assertEquals(resp.status, 502);
  }
});

Deno.test('a provider error status is a 502 and the grant is refunded', async () => {
  const { deps, spy } = harness({
    fetch: () => Promise.resolve(new Response('upstream exploded', { status: 500 })),
  });
  const resp = await handleRefine(post(request()), deps);
  assertEquals(resp.status, 502);
  assertEquals(spy.spends, 1);
  assertEquals(spy.refunds, 1);
});

Deno.test('no key anywhere is a 503, before anything is spent', async () => {
  const { deps, spy } = harness({ apiKey: '' });
  const resp = await handleRefine(post(request()), deps);
  assertEquals(resp.status, 503);
  assertEquals(spy.spends, 0);
});

Deno.test('a malformed body is a 400', async () => {
  const { deps, spy } = harness();
  assertEquals((await handleRefine(post({}), deps)).status, 400);
  assertEquals((await handleRefine(post('not json'), deps)).status, 400);
  assertEquals(spy.spends, 0);
});

Deno.test('OPTIONS is a 204 with CORS; anything but POST is a 405', async () => {
  const { deps } = harness();
  const opts = await handleRefine(
    new Request('https://refine.test/', { method: 'OPTIONS' }),
    deps,
  );
  assertEquals(opts.status, 204);
  assertEquals(opts.headers.get('access-control-allow-headers'), 'Content-Type, x-llm-key');
  const get = await handleRefine(new Request('https://refine.test/', { method: 'GET' }), deps);
  assertEquals(get.status, 405);
});

// ── The budget, per address and global. ────────────────────────────────────

/**
 * The SQL meter in miniature: both caps moved together, one increment, and
 * refunds floored at zero. The real one is `refine_usage_spend`; this is what
 * the handler's contract with it has to look like.
 */
class BudgetMeter implements UsageStore {
  private used = new Map<string, number>();
  constructor(private perIp: number, private global: number) {}
  spend(client: string, want: number): Promise<number> {
    const ip = this.used.get(client) ?? 0;
    const glob = this.used.get('@global') ?? 0;
    const granted = Math.min(
      want,
      Math.max(this.perIp - ip, 0),
      Math.max(this.global - glob, 0),
    );
    if (granted > 0) {
      this.used.set(client, ip + granted);
      this.used.set('@global', glob + granted);
    }
    return Promise.resolve(granted);
  }
  refund(client: string, n: number): Promise<void> {
    this.used.set(client, Math.max((this.used.get(client) ?? 0) - n, 0));
    this.used.set('@global', Math.max((this.used.get('@global') ?? 0) - n, 0));
    return Promise.resolve();
  }
}

Deno.test('the per-address meter grants 30 a day and refuses the 31st', async () => {
  const { deps } = harness({ usage: new BudgetMeter(30, 500) });
  for (let i = 0; i < 30; i++) {
    assertEquals((await handleRefine(post(request()), deps)).status, 200);
  }
  const over = await handleRefine(post(request()), deps);
  assertEquals(over.status, 429);
  assertEquals(await over.json(), { error: 'budget' });
});

Deno.test('the global meter refuses the next address once the day is full', async () => {
  const { deps } = harness({ usage: new BudgetMeter(30, 3) });
  for (let i = 0; i < 3; i++) {
    const ip = `203.0.113.${i}`;
    assertEquals(
      (await handleRefine(post(request(), { 'x-forwarded-for': ip }), deps)).status,
      200,
    );
  }
  const over = await handleRefine(post(request(), { 'x-forwarded-for': '203.0.113.99' }), deps);
  assertEquals(over.status, 429);
  assertEquals(await over.json(), { error: 'budget' });
});

Deno.test('two addresses get separate allowances on the same day', async () => {
  const { deps } = harness({ usage: new BudgetMeter(1, 500) });
  assertEquals((await handleRefine(post(request()), deps)).status, 200);
  assertEquals((await handleRefine(post(request()), deps)).status, 429);   // same address
  assertEquals(
    (await handleRefine(post(request(), { 'x-forwarded-for': '198.51.100.9' }), deps)).status,
    200,
  );
});

Deno.test('a refused call is not a provider call', async () => {
  const { deps, spy } = harness({ usage: new BudgetMeter(0, 500) });
  assertEquals((await handleRefine(post(request()), deps)).status, 429);
  assertEquals(spy.urls, []);
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
  const resp = await handleRefine(post(request(), { 'x-llm-key': 'byo-key' }), deps);
  assertEquals(resp.status, 200);
  assertEquals(spends, 0);
});

Deno.test('a BYO key is used for the call and appears nowhere else', async () => {
  const { deps, spy } = harness();
  const KEY = 'sk-caller-secret-0123456789';
  const resp = await handleRefine(post(request(), { 'x-llm-key': KEY }), deps);
  assertEquals(resp.status, 200);
  assertEquals(spy.auth, [`Bearer ${KEY}`]);                 // ...used for the call
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
  const resp = await handleRefine(post(request(), { 'x-llm-key': KEY }), deps);
  assertEquals(resp.status, 502);
  assertEquals(spy.spends, 0);     // never debited the deployment's meter
  assertEquals(spy.refunds, 0);
  assertEquals(spy.logs.some((m) => m.includes(KEY)), false);
});

Deno.test('the deploy key never appears in a response or a log', async () => {
  const { deps, spy } = harness({
    fetch: () => Promise.resolve(new Response('upstream exploded', { status: 500 })),
  });
  const resp = await handleRefine(post(request()), deps);
  const text = await resp.text();
  assertEquals(text.includes('deploy-key'), false);
  assertEquals(spy.logs.some((m) => m.includes('deploy-key')), false);
});
