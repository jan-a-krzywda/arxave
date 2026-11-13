/**
 * `deno test supabase/functions/diamond/`
 *
 * The whole function lives behind two injected seams — `fetch` and the usage
 * meter — so every test here runs with no network and no database. That is the
 * point of diamond.ts being separate from index.ts: the failure modes worth
 * pinning are (1) the request caps and the arXiv id check, (2) the response
 * validation, because a reply with two takeaways renders as a broken panel,
 * (3) the shared budget and its refund, and (4) the one that is a security
 * property rather than a nicety: a BYO `x-llm-key` must spend nothing and
 * appear in nothing.
 */
import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import {
  bareArxivId,
  buildMessages,
  type Deps,
  type Diamond,
  type DiamondRequest,
  DiamondError,
  handleDiamond,
  isArxivId,
  MAX_ABSTRACT,
  MAX_ITEM,
  MAX_SUMMARY,
  MAX_TITLE,
  parseDiamond,
  promptFor,
  readRequest,
  SYSTEM,
  type UsageStore,
} from './diamond.ts';

const PAPER = {
  id: '2401.12345',
  title: 'A record two-qubit gate in Si/SiGe',
  abstract: 'We report a two-qubit gate fidelity of 99.9% in Si/SiGe.',
  authors: 'A. Author, B. Author',
};

/** A valid request; spread over it to break exactly one thing. */
function request(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { paper: PAPER, ...over };
}

/** A valid model reply; spread `over` to break exactly one field. */
function reply(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: 'They operate a two-qubit gate in silicon. The gate reaches 99.9% fidelity.',
    takeaways: [
      'A two-qubit gate in Si/SiGe reaches 99.9% fidelity.',
      'Fidelity is measured by randomized benchmarking.',
      'The improvement over the previous record is one order of magnitude in error.',
    ],
    questions: [
      'Does the fidelity survive a scaled-up array?',
      'What sets the residual charge-noise floor?',
      'Is the gate fast enough for error correction?',
    ],
    readIf: 'Anyone building silicon spin-qubit processors.',
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
  return new Request('https://diamond.test/', {
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
  bodies: string[];
  logs: string[];
  refunds: number;
  spends: number;
}

/** Deps wired to spies, with a provider that answers with a good reply. */
function harness(over: Partial<Deps> = {}): { deps: Deps; spy: Spy } {
  const spy: Spy = { urls: [], auth: [], bodies: [], logs: [], refunds: 0, spends: 0 };
  const deps: Deps = {
    fetch: (input, init) => {
      spy.urls.push(String(input));
      spy.auth.push(new Headers(init?.headers).get('authorization'));
      spy.bodies.push(String(init?.body ?? ''));
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

// ── The arXiv id. ──────────────────────────────────────────────────────────

Deno.test('bareArxivId strips a URL and a version suffix', () => {
  assertEquals(bareArxivId('https://arxiv.org/abs/2401.12345v2'), '2401.12345');
  assertEquals(bareArxivId('arXiv:quant-ph/9701055'), 'quant-ph/9701055');
  assertEquals(bareArxivId('  2401.12345  '), '2401.12345');
});

Deno.test('isArxivId accepts both id spellings and rejects everything else', () => {
  for (
    const good of [
      '2401.12345',
      '2101.12345',
      'quant-ph/9701055',
      'cond-mat.mes-hall/0212001',
      'math.GT/0309136',
    ]
  ) {
    assertEquals(isArxivId(good), true, good);
  }
  for (
    const bad of [
      '',
      'nope',
      '2401.123',
      '12345.1234',
      'quant-ph/97010',
      '2401.12345/extra',
      'https://example.com/paper',
    ]
  ) {
    assertEquals(isArxivId(bad), false, bad);
  }
});

// ── Request validation. ────────────────────────────────────────────────────

Deno.test('readRequest accepts a well-formed paper', () => {
  const got = readRequest(request()) as DiamondRequest;
  assertEquals(got.paper.id, '2401.12345');
  assertEquals(got.paper.title, PAPER.title);
  assertEquals(got.paper.abstract, PAPER.abstract);
  assertEquals(got.paper.authors, PAPER.authors);
});

Deno.test('readRequest takes the id out of a link and tolerates a missing author list', () => {
  const got = readRequest({
    paper: { id: 'https://arxiv.org/abs/2401.12345v1', title: 't', abstract: 'a' },
  }) as DiamondRequest;
  assertEquals(got.paper.id, '2401.12345');
  assertEquals(got.paper.authors, '');
});

Deno.test('readRequest takes authors as an array as happily as a string', () => {
  const got = readRequest({
    paper: { ...PAPER, authors: ['A. Author', 'B. Author'] },
  }) as DiamondRequest;
  assertEquals(got.paper.authors, 'A. Author, B. Author');
});

Deno.test('readRequest clips the title and the abstract rather than throwing', () => {
  const got = readRequest({
    paper: { ...PAPER, title: 't'.repeat(500), abstract: 'a'.repeat(5000) },
  }) as DiamondRequest;
  assertEquals(got.paper.title.length, MAX_TITLE);
  assertEquals(got.paper.abstract.length, MAX_ABSTRACT);
});

Deno.test('readRequest collapses whitespace like the prompt normalisation does', () => {
  const got = readRequest({
    paper: { ...PAPER, title: '  Valley   splitting\nin silicon ', abstract: 'a  b\nc' },
  }) as DiamondRequest;
  assertEquals(got.paper.title, 'Valley splitting in silicon');
  assertEquals(got.paper.abstract, 'a b c');
});

Deno.test('readRequest rejects everything malformed with a message', () => {
  for (
    const body of [
      {},
      { paper: null },
      { paper: [] },
      { paper: { ...PAPER, id: '' } },
      { paper: { ...PAPER, id: 'not-an-id' } },
      { paper: { ...PAPER, id: 2401 } },
      { paper: { id: PAPER.id, title: '', abstract: 'a' } },
      { paper: { id: PAPER.id, title: '   ', abstract: 'a' } },
      { paper: { id: PAPER.id, title: 't', abstract: '' } },
    ]
  ) {
    assertEquals(typeof readRequest(body as Record<string, unknown>), 'string');
  }
});

// ── The prompt. ────────────────────────────────────────────────────────────

Deno.test('the prompt carries the id, title, authors and abstract', () => {
  const prompt = promptFor(readRequest(request()) as DiamondRequest);
  assertEquals(prompt.includes(PAPER.id), true);
  assertEquals(prompt.includes(PAPER.title), true);
  assertEquals(prompt.includes(PAPER.authors), true);
  assertEquals(prompt.includes(PAPER.abstract), true);
});

Deno.test('the prompt says so when there are no authors', () => {
  const prompt = promptFor(
    readRequest({ paper: { ...PAPER, authors: '' } }) as DiamondRequest,
  );
  assertEquals(prompt.includes('(none given)'), true);
});

Deno.test('the system turn demands JSON and nothing else', () => {
  assertEquals(/Return ONLY a JSON object/i.test(SYSTEM), true);
  assertEquals(SYSTEM.includes('"summary"'), true);
  assertEquals(SYSTEM.includes('"takeaways"'), true);
  assertEquals(SYSTEM.includes('"questions"'), true);
  assertEquals(SYSTEM.includes('"readIf"'), true);
  const messages = buildMessages(readRequest(request()) as DiamondRequest);
  assertEquals(messages.map((m) => m.role), ['system', 'user']);
  assertEquals(messages[0].content, SYSTEM);
});

// ── Response validation. ───────────────────────────────────────────────────

const GOOD: Diamond = {
  summary: 'They operate a two-qubit gate in silicon. The gate reaches 99.9% fidelity.',
  takeaways: [
    'A two-qubit gate in Si/SiGe reaches 99.9% fidelity.',
    'Fidelity is measured by randomized benchmarking.',
    'The improvement over the previous record is one order of magnitude in error.',
  ],
  questions: [
    'Does the fidelity survive a scaled-up array?',
    'What sets the residual charge-noise floor?',
    'Is the gate fast enough for error correction?',
  ],
  readIf: 'Anyone building silicon spin-qubit processors.',
};

Deno.test('parseDiamond passes a good reply through', () => {
  assertEquals(parseDiamond(reply()), GOOD);
});

Deno.test('parseDiamond tolerates a ```json fence', () => {
  const fenced = '```json\n' + reply() + '\n```';
  assertEquals(parseDiamond(fenced).summary, GOOD.summary);
});

/* The counts are the contract: two takeaways is a reply that dodged the
   question, and the panel has three slots to fill. */
Deno.test('parseDiamond rejects a wrong number of takeaways or questions', () => {
  for (
    const over of [
      { takeaways: GOOD.takeaways.slice(0, 2) },
      { takeaways: [...GOOD.takeaways, 'a fourth'] },
      { takeaways: [] },
      { takeaways: GOOD.takeaways.join('; ') },
      { questions: GOOD.questions.slice(0, 2) },
      { questions: [...GOOD.questions, 'a fourth'] },
      { questions: [] },
      { questions: null },
    ]
  ) {
    assertThrows(() => parseDiamond(reply(over)), DiamondError);
  }
});

Deno.test('parseDiamond rejects an entry that is not a non-empty string', () => {
  for (
    const over of [
      { takeaways: [1, 'b', 'c'] },
      { takeaways: ['', 'b', 'c'] },
      { takeaways: ['   ', 'b', 'c'] },
      { questions: ['a', null, 'c'] },
      { questions: ['a', 'b', ' '] },
    ]
  ) {
    assertThrows(() => parseDiamond(reply(over)), DiamondError);
  }
});

Deno.test('parseDiamond rejects an empty summary or readIf', () => {
  for (const over of [{ summary: '' }, { summary: '   ' }, { readIf: '' }, { readIf: null }]) {
    assertThrows(() => parseDiamond(reply(over)), DiamondError);
  }
});

Deno.test('parseDiamond rejects a body that is not a JSON object', () => {
  for (const text of ['', 'not json', '[1, 2]', '42', '"a string"', '{"trunc']) {
    assertThrows(() => parseDiamond(text), DiamondError);
  }
});

Deno.test('parseDiamond clips over-long prose instead of throwing', () => {
  const long = 'x'.repeat(900);
  const got = parseDiamond(
    reply({
      summary: long,
      takeaways: [long, long, long],
      questions: [long, long, long],
      readIf: long,
    }),
  );
  assertEquals(got.summary.length, MAX_SUMMARY);
  for (const s of [...got.takeaways, ...got.questions, got.readIf]) {
    assertEquals(s.length, MAX_ITEM);
  }
});


// ── The handler: the happy path and every fault. ───────────────────────────

Deno.test('a good reply comes back as the diamond, with CORS', async () => {
  const { deps, spy } = harness();
  const resp = await handleDiamond(post(request()), deps);
  assertEquals(resp.status, 200);
  assertEquals(resp.headers.get('access-control-allow-origin'), '*');
  assertEquals(await resp.json(), GOOD);
  assertEquals(spy.urls, ['https://llm.invalid/v1/chat/completions']);
  assertEquals(spy.auth, ['Bearer deploy-key']);
  assertEquals(spy.spends, 1);
  const sent = JSON.parse(spy.bodies[0]);
  assertEquals(sent.model, 'test-model');
  assertEquals(sent.response_format, { type: 'json_object' });
  assertEquals(sent.messages[0].content, SYSTEM);
});

Deno.test('bad model output is a 502, never a 200', async () => {
  for (
    const content of [
      'not json',
      '',
      reply({ summary: '' }),
      reply({ takeaways: GOOD.takeaways.slice(0, 2) }),
      reply({ questions: [...GOOD.questions, 'extra'] }),
      reply({ readIf: '' }),
    ]
  ) {
    const { deps } = harness({ fetch: () => Promise.resolve(provider(content)) });
    const resp = await handleDiamond(post(request()), deps);
    assertEquals(resp.status, 502);
  }
});

Deno.test('invalid JSON from the model refunds the granted call', async () => {
  const { deps, spy } = harness({
    fetch: () => Promise.resolve(provider('I am afraid I cannot do that.')),
  });
  const resp = await handleDiamond(post(request()), deps);
  assertEquals(resp.status, 502);
  assertEquals(spy.spends, 1);
  assertEquals(spy.refunds, 1);
});

Deno.test('a provider error status is a 502 and the grant is refunded', async () => {
  const { deps, spy } = harness({
    fetch: () => Promise.resolve(new Response('upstream exploded', { status: 500 })),
  });
  const resp = await handleDiamond(post(request()), deps);
  assertEquals(resp.status, 502);
  assertEquals(spy.spends, 1);
  assertEquals(spy.refunds, 1);
});

Deno.test('no key anywhere is a 503, before anything is spent', async () => {
  const { deps, spy } = harness({ apiKey: '' });
  const resp = await handleDiamond(post(request()), deps);
  assertEquals(resp.status, 503);
  assertEquals(spy.spends, 0);
});

Deno.test('a malformed body is a 400 and costs nothing', async () => {
  const { deps, spy } = harness();
  assertEquals((await handleDiamond(post({}), deps)).status, 400);
  assertEquals((await handleDiamond(post('not json'), deps)).status, 400);
  const badId = await handleDiamond(post({ paper: { ...PAPER, id: 'x' } }), deps);
  assertEquals(badId.status, 400);
  assertEquals(spy.spends, 0);
  assertEquals(spy.urls, []);
});

Deno.test('OPTIONS is a 204 with CORS; anything but POST is a 405', async () => {
  const { deps } = harness();
  const opts = await handleDiamond(
    new Request('https://diamond.test/', { method: 'OPTIONS' }),
    deps,
  );
  assertEquals(opts.status, 204);
  assertEquals(opts.headers.get('access-control-allow-origin'), '*');
  assertEquals(opts.headers.get('access-control-allow-headers'), 'Content-Type, x-llm-key');
  const get = await handleDiamond(new Request('https://diamond.test/', { method: 'GET' }), deps);
  assertEquals(get.status, 405);
});

// ── The shared budget, per address and global. ─────────────────────────────

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
    assertEquals((await handleDiamond(post(request()), deps)).status, 200);
  }
  const over = await handleDiamond(post(request()), deps);
  assertEquals(over.status, 429);
  assertEquals(await over.json(), { error: 'budget' });
});

Deno.test('a budget refusal is a 429 and not a provider call', async () => {
  const { deps, spy } = harness({ usage: new BudgetMeter(0, 500) });
  const resp = await handleDiamond(post(request()), deps);
  assertEquals(resp.status, 429);
  assertEquals(await resp.json(), { error: 'budget' });
  assertEquals(spy.urls, []);
  assertEquals(spy.bodies, []);
});

Deno.test('a refunded call gives the allowance back', async () => {
  const meter = new BudgetMeter(1, 500);
  const { deps } = harness({
    usage: meter,
    fetch: () => Promise.resolve(new Response('upstream exploded', { status: 500 })),
  });
  assertEquals((await handleDiamond(post(request()), deps)).status, 502);
  const second = harness({ usage: meter });
  assertEquals((await handleDiamond(post(request()), second.deps)).status, 200);
});

Deno.test('the client key handed to the meter is a salted hash, not the address', async () => {
  /* Pinned because a different salt from refine's would quietly double every
     reader's daily allowance across the two functions. */
  const seen: string[] = [];
  const usage: UsageStore = {
    spend: (client) => {
      seen.push(client);
      return Promise.resolve(1);
    },
    refund: () => Promise.resolve(),
  };
  const { deps } = harness({ usage });
  await handleDiamond(post(request(), { 'x-forwarded-for': '198.51.100.4' }), deps);
  assertEquals(seen.length, 1);
  assertEquals(seen[0].length, 32);
  assertEquals(seen[0].includes('198.51.100.4'), false);
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
  const resp = await handleDiamond(post(request(), { 'x-llm-key': 'byo-key' }), deps);
  assertEquals(resp.status, 200);
  assertEquals(spends, 0);
});

Deno.test('a BYO key is used for the call and appears nowhere else', async () => {
  const { deps, spy } = harness();
  const KEY = 'sk-caller-secret-0123456789';
  const resp = await handleDiamond(post(request(), { 'x-llm-key': KEY }), deps);
  assertEquals(resp.status, 200);
  assertEquals(spy.auth, [`Bearer ${KEY}`]);                 // ...used for the call
  const text = await resp.text();
  assertEquals(text.includes(KEY), false);                   // ...not in the body
  for (const [name, value] of resp.headers) {
    assertEquals(`${name}:${value}`.includes(KEY), false);   // ...not in a header
  }
  for (const log of spy.logs) assertEquals(log.includes(KEY), false);   // ...not a log
});

Deno.test('a failed BYO call is not refunded and its key is still never logged', async () => {
  const KEY = 'sk-caller-secret-0123456789';
  const { deps, spy } = harness({
    fetch: () => Promise.resolve(new Response('upstream exploded', { status: 500 })),
  });
  const resp = await handleDiamond(post(request(), { 'x-llm-key': KEY }), deps);
  assertEquals(resp.status, 502);
  assertEquals(spy.spends, 0);     // never debited the deployment's meter
  assertEquals(spy.refunds, 0);
  for (const log of spy.logs) assertEquals(log.includes(KEY), false);
});

Deno.test('the deploy key never appears in a response or a log', async () => {
  const { deps, spy } = harness({
    fetch: () => Promise.resolve(new Response('upstream exploded', { status: 500 })),
  });
  const resp = await handleDiamond(post(request()), deps);
  const text = await resp.text();
  assertEquals(text.includes('deploy-key'), false);
  assertEquals(spy.logs.some((m) => m.includes('deploy-key')), false);
});
