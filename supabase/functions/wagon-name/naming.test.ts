/**
 * `deno test supabase/functions/wagon-name/`
 *
 * The cache key is what these mostly pin. It is the one contract the browser
 * and the server compute independently, and a divergence does not throw — it
 * files every name under a hash the other side never looks up, so naming just
 * quietly stops hitting cache and starts costing money on every haul.
 */
import { assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import {
  generationConfig,
  LADDER,
  ladderFrom,
  MAX_LOOKUP_WAGONS,
  MAX_MEMBERS,
  MAX_TITLES,
  type Member,
  normalizeTitle,
  parseResponse,
  promptFor,
  readWagons,
  retryAfterSeconds,
  wagonKey,
} from './naming.ts';

const A: Member = { id: '2608.01234', title: 'Valley splitting in Si/SiGe quantum wells' };
const B: Member = { id: '2608.05678', title: 'Charge noise in silicon double quantum dots' };

Deno.test('the key is order-independent — a wagon is a set', async () => {
  assertEquals(await wagonKey([A, B]), await wagonKey([B, A]));
});

Deno.test('the key ignores cosmetic whitespace in a title', async () => {
  const spaced = { id: A.id, title: '  Valley   splitting in Si/SiGe\nquantum wells ' };
  assertEquals(await wagonKey([spaced, B]), await wagonKey([A, B]));
});

Deno.test('a different membership is a different key', async () => {
  const C = { id: '2608.09999', title: 'Exchange gates in GaAs' };
  assertNotEquals(await wagonKey([A, B]), await wagonKey([A, B, C]));
  assertNotEquals(await wagonKey([A, B]), await wagonKey([A]));
});

/* The poisoning guard. Real ids with fabricated titles must not collide with
   the honest wagon, or a liar renames it for everyone downstream. */
Deno.test('same ids with different titles do not share a key', async () => {
  const lying = { id: A.id, title: 'Free money, click here' };
  assertNotEquals(await wagonKey([lying, B]), await wagonKey([A, B]));
});

Deno.test('the key is a lowercase sha256 hex string', async () => {
  const key = await wagonKey([A, B]);
  assertEquals(/^[0-9a-f]{64}$/.test(key), true);
});

/**
 * THE GOLDEN VALUE. This same hex is written into `wagonKeyLocal` in
 * docs/assets/filter.js, which computes the key independently in the browser.
 * The two implementations sharing a test file is not possible — one is a Deno
 * module, the other is inside an IIFE in a script with no bundler — so a fixed
 * digest over a fixed input is what holds them together.
 *
 * If this test fails, the key definition changed and the browser's copy has to
 * change with it. If it passes and naming still never hits cache, the browser's
 * copy is what drifted. The input is deliberately dirty (double space, newline,
 * trailing space) so the normalization is inside the fixture, not beside it.
 */
Deno.test('the key matches the browser\'s wagonKeyLocal on a known wagon', async () => {
  const key = await wagonKey([
    { id: '2608.01234', title: 'Valley  splitting in\nSi/SiGe quantum wells ' },
    { id: '2608.05678', title: 'Charge noise in silicon double quantum dots' },
  ]);
  assertEquals(key, '0cf357c0a944ef663d75fd37e3acd4fc8978aa386e05f90ea2a33e3725b578fb');
});

Deno.test('normalizeTitle truncates rather than throwing', () => {
  assertEquals(normalizeTitle('x'.repeat(1000)).length, 400);
  assertEquals(normalizeTitle(undefined as unknown as string), '');
});

Deno.test('the prompt carries every wagon as its own numbered group', () => {
  const prompt = promptFor([[A], [B], [A, B]]);
  assertEquals(prompt.includes('group 1 (1 preprint)'), true);
  assertEquals(prompt.includes('group 2 (1 preprint)'), true);
  assertEquals(prompt.includes('group 3 (2 preprints)'), true);
  assertEquals(prompt.includes('group 4'), false);
  assertEquals(prompt.includes(A.title), true);
  assertEquals(prompt.includes(B.title), true);
});

/* A big wagon is summarized, not transcribed: the topic of a thirty-paper
   cluster is in the first dozen titles. The count is still stated, so the model
   knows it is naming more than it can see. */
Deno.test('the prompt shows at most MAX_TITLES per group and says so', () => {
  const many = Array.from({ length: MAX_MEMBERS }, (_, i) => ({
    id: `id${i}`,
    title: `Title ${i}`,
  }));
  const prompt = promptFor([many]);
  assertEquals(prompt.includes(`group 1 (${MAX_MEMBERS} preprints, ${MAX_TITLES} shown)`), true);
  assertEquals(prompt.includes(`Title ${MAX_TITLES - 1}`), true);
  assertEquals(prompt.includes(`Title ${MAX_TITLES}`), false);
});

const reply = (groups: unknown) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify({ groups }) }] } }],
});

Deno.test('parseResponse keys names by the group number, not by position', () => {
  /* Out of order and with group 2 missing — the shape that would silently
     misfile every name if positions were trusted. */
  const got = parseResponse(
    reply([
      { group: 3, name: 'Magic states', gloss: 'Distillation.' },
      { group: 1, name: 'Valley splitting', gloss: 'All Si/SiGe.' },
    ]),
    3,
  );
  assertEquals(got, {
    0: { name: 'Valley splitting', gloss: 'All Si/SiGe.' },
    2: { name: 'Magic states', gloss: 'Distillation.' },
  });
});

Deno.test('parseResponse drops a group number the request never asked for', () => {
  const got = parseResponse(reply([
    { group: 0, name: 'Off by one', gloss: 'x' },      // the prompt numbers from 1
    { group: 9, name: 'Invented', gloss: 'x' },        // no such wagon
    { group: 2, name: 'Real', gloss: 'x' },
  ]), 3);
  assertEquals(got, { 1: { name: 'Real', gloss: 'x' } });
});

Deno.test('parseResponse keeps the first answer when a group is named twice', () => {
  const got = parseResponse(reply([
    { group: 1, name: 'First', gloss: 'a' },
    { group: 1, name: 'Second', gloss: 'b' },
  ]), 1);
  assertEquals(got, { 0: { name: 'First', gloss: 'a' } });
});

Deno.test('parseResponse returns an empty map for every shape of failure', () => {
  assertEquals(parseResponse(null, 2), {});
  assertEquals(parseResponse({}, 2), {});
  assertEquals(parseResponse({ candidates: [] }, 2), {});           // safety block
  assertEquals(parseResponse({ candidates: [{ content: { parts: [] } }] }, 2), {});
  assertEquals(
    parseResponse({ candidates: [{ content: { parts: [{ text: '{ trunc' }] } }] }, 2),
    {},
  );
  assertEquals(parseResponse(reply('not an array'), 2), {});
  // A reply that validates but carries no name is no name.
  assertEquals(parseResponse(reply([{ group: 1, name: '', gloss: 'x' }]), 2), {});
});

/* The real body Gemini returned on 2026-08-13 when this project's key hit its
   free-tier limit of 5 requests/min. Trimmed, but the phrasing is verbatim —
   the wait is in the prose, not in a Retry-After header, which is the whole
   reason retryAfterSeconds reads both. */
const REAL_429 = 'You exceeded your current quota, please check your plan and billing ' +
  'details. * Quota exceeded for metric: ' +
  'generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, ' +
  'model: gemini-2.5-flash\nPlease retry in 49.711726874s.';

Deno.test('retryAfterSeconds reads the wait out of a real Gemini 429 body', () => {
  assertEquals(retryAfterSeconds(null, REAL_429), 50);   // rounded up, never down
});

Deno.test('retryAfterSeconds prefers a Retry-After header when there is one', () => {
  assertEquals(retryAfterSeconds('12', REAL_429), 12);
  assertEquals(retryAfterSeconds('0.5', ''), 1);
});

Deno.test('retryAfterSeconds falls back to a minute when told nothing usable', () => {
  assertEquals(retryAfterSeconds(null, 'slow down'), 60);
  assertEquals(retryAfterSeconds('', ''), 60);
  assertEquals(retryAfterSeconds('not-a-number', ''), 60);
  assertEquals(retryAfterSeconds('-5', ''), 60);       // never a negative wait
});

/* ── The ladder. ──────────────────────────────────────────────────────────
   These pin the one thing that is not obvious from reading the call site: the
   thinking field is per-model, and sending the wrong one is a 400 that would
   take out every wagon on that rung. */

Deno.test('every rung carries the thinking field that model accepts', () => {
  const spelling = Object.fromEntries(
    LADDER.map((r) => [r.model, r.thinking && Object.keys(r.thinking)[0]]),
  );
  assertEquals(spelling['gemini-3.5-flash-lite'], 'thinkingLevel');
  assertEquals(spelling['gemini-3.1-flash-lite'], 'thinkingBudget');
  assertEquals(spelling['gemma-4-31b-it'], null);       // any thinkingConfig is a 400
  assertEquals(spelling['gemma-4-26b-a4b-it'], null);
});

Deno.test('generationConfig omits thinkingConfig entirely for a rung without one', () => {
  const withNone = generationConfig({ model: 'gemma-4-31b-it', thinking: null });
  assertEquals('thinkingConfig' in withNone, false);
  const withOne = generationConfig({ model: 'x', thinking: { thinkingBudget: 0 } });
  assertEquals(withOne.thinkingConfig, { thinkingBudget: 0 });
  assertEquals(withNone.responseMimeType, 'application/json');   // the rest is shared
});

Deno.test('ladderFrom falls back to the default ladder on nothing usable', () => {
  assertEquals(ladderFrom(null), LADDER);
  assertEquals(ladderFrom(''), LADDER);
  assertEquals(ladderFrom('  , ,'), LADDER);
});

Deno.test('ladderFrom keeps env order and knows the thinking field of known ids', () => {
  const rungs = ladderFrom('gemma-4-31b-it, gemini-3.1-flash-lite');
  assertEquals(rungs.map((r) => r.model), ['gemma-4-31b-it', 'gemini-3.1-flash-lite']);
  assertEquals(rungs[0].thinking, null);
  assertEquals(rungs[1].thinking, { thinkingBudget: 0 });
});

/* An id nobody has measured gets no thinkingConfig: a missing one is never an
   error, and a guessed one is a 400 on every wagon. */
Deno.test('ladderFrom sends an unknown model no thinking field at all', () => {
  assertEquals(ladderFrom('some-future-model'), [{ model: 'some-future-model', thinking: null }]);
});

Deno.test('readWagons accepts a well-formed body', () => {
  const got = readWagons({ wagons: [{ members: [A, B] }] });
  assertEquals(Array.isArray(got), true);
  assertEquals((got as Member[][])[0].length, 2);
});

/* The cache-only path raises the wagon cap, because nothing is prompted with:
   the 24 ceiling is a prompt-size limit, not a lookup one. */
Deno.test('readWagons honours a raised wagon cap for lookups', () => {
  const body = { wagons: Array.from({ length: 40 }, () => ({ members: [A] })) };
  assertEquals(typeof readWagons(body), 'string');
  assertEquals(Array.isArray(readWagons(body, MAX_LOOKUP_WAGONS)), true);
  const over = { wagons: Array.from({ length: MAX_LOOKUP_WAGONS + 1 }, () => ({ members: [A] })) };
  assertEquals(typeof readWagons(over, MAX_LOOKUP_WAGONS), 'string');
});

Deno.test('readWagons rejects everything malformed with a message', () => {
  for (
    const body of [
      {},
      { wagons: [] },
      { wagons: [{}] },
      { wagons: [{ members: [] }] },
      { wagons: [{ members: [{ id: '', title: 't' }] }] },
      { wagons: [{ members: [{ id: 'x', title: '   ' }] }] },
      { wagons: Array.from({ length: 25 }, () => ({ members: [A] })) },
      { wagons: [{ members: Array.from({ length: 61 }, () => A) }] },
    ]
  ) {
    assertEquals(typeof readWagons(body as Record<string, unknown>), 'string');
  }
});
