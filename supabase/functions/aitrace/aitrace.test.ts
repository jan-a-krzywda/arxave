/**
 * `deno test supabase/functions/aitrace/`
 *
 * Same seams as story: `fetch` and the meter are injected, so nothing here
 * touches a network or a database. Pinned: the caps (a batch is one call, so
 * its size is the bill), the parse (an id nobody asked about is dropped, p is
 * clamped), the budget (a failed call is refunded) and the BYO key (spends
 * nothing).
 */
import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import {
  CALLS_PER_TRACE, type Deps, handleTrace, MAX_PAPERS, parseScores, promptFor,
  readRequest, TraceError, type UsageStore,
} from './aitrace.ts';

const paper = (id: string) => ({ id, title: `T ${id}`, abstract: `We measure ${id}.` });

function meter(grant = 99) {
  const log: string[] = [];
  const usage: UsageStore = {
    spend: (_c, want) => { log.push(`spend ${want}`); return Promise.resolve(Math.min(grant, want)); },
    refund: (_c, n) => { log.push(`refund ${n}`); return Promise.resolve(); },
  };
  return { usage, log };
}

function deps(content: string, usage: UsageStore, status = 200): Deps & { calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  return {
    calls,
    usage,
    apiKey: 'server-key',
    baseUrl: 'https://llm.test/v1',
    model: 'm',
    fetch: ((_url: string, init: RequestInit) => {
      calls.push(init);
      return Promise.resolve(new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
        { status },
      ));
    }) as typeof fetch,
  };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://fn.test/aitrace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

Deno.test('readRequest: caps, required fields, duplicate ids dropped', () => {
  assertEquals(typeof readRequest({}), 'string');
  assertEquals(typeof readRequest({ papers: [] }), 'string');
  const many = Array.from({ length: MAX_PAPERS + 1 }, (_, i) => paper(`a${i}`));
  assertEquals(typeof readRequest({ papers: many }), 'string');
  assertEquals(typeof readRequest({ papers: [{ id: 'x' }] }), 'string');
  const ok = readRequest({ papers: [paper('a'), paper('a'), paper('b')] });
  assertEquals(Array.isArray(ok) && ok.map((p) => p.id), ['a', 'b']);
});

Deno.test('promptFor: every id and abstract is in the prompt', () => {
  const text = promptFor([paper('a'), paper('b')]);
  for (const id of ['[a]', '[b]', 'We measure a.']) assertEquals(text.includes(id), true);
});

Deno.test('parseScores: clamps, rounds, drops strangers, tolerates a fence', () => {
  const text = '```json\n' + JSON.stringify({
    scores: [
      { id: 'a', p: 140.4, why: 'stock phrases' },
      { id: 'b', p: 12.6 },
      { id: 'zzz', p: 90 },
      { id: 'a', p: 1 },
    ],
  }) + '\n```';
  assertEquals(parseScores(text, ['a', 'b']), {
    a: { p: 100, why: 'stock phrases' },
    b: { p: 13, why: '' },
  });
  assertThrows(() => parseScores('nope', ['a']), TraceError);
  assertThrows(() => parseScores('{"scores":[]}', ['a']), TraceError);
});

Deno.test('handleTrace: one call per press, scores back', async () => {
  const { usage, log } = meter();
  const d = deps(JSON.stringify({ scores: [{ id: 'a', p: 70, why: 'w' }] }), usage);
  const resp = await handleTrace(post({ papers: [paper('a'), paper('b')] }), d);
  assertEquals(resp.status, 200);
  assertEquals(await resp.json(), { scores: { a: { p: 70, why: 'w' } } });
  assertEquals(log, [`spend ${CALLS_PER_TRACE}`]);
  assertEquals(d.calls.length, 1);
});

Deno.test('handleTrace: spent budget is a 429 and calls nothing', async () => {
  const { usage } = meter(0);
  const d = deps('{}', usage);
  const resp = await handleTrace(post({ papers: [paper('a')] }), d);
  assertEquals(resp.status, 429);
  assertEquals((await resp.json()).error, 'budget');
  assertEquals(d.calls.length, 0);
});

Deno.test('handleTrace: a failed call is refunded', async () => {
  const { usage, log } = meter();
  const resp = await handleTrace(post({ papers: [paper('a')] }), deps('', usage, 500));
  assertEquals(resp.status, 502);
  assertEquals(log, [`spend ${CALLS_PER_TRACE}`, `refund ${CALLS_PER_TRACE}`]);
});

Deno.test('handleTrace: a BYO key spends nothing and is the one sent', async () => {
  const { usage, log } = meter();
  const d = deps(JSON.stringify({ scores: [{ id: 'a', p: 5 }] }), usage);
  const resp = await handleTrace(post({ papers: [paper('a')] }, { 'x-llm-key': 'mine' }), d);
  assertEquals(resp.status, 200);
  assertEquals(log, []);
  assertEquals((d.calls[0].headers as Record<string, string>).Authorization, 'Bearer mine');
});
