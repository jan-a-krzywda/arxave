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
  MAX_MEMBERS,
  type Member,
  normalizeTitle,
  parseResponse,
  promptFor,
  readWagons,
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

Deno.test('the prompt numbers the titles and stops at the member cap', () => {
  const many = Array.from({ length: MAX_MEMBERS + 10 }, (_, i) => ({
    id: `id${i}`,
    title: `Title ${i}`,
  }));
  const prompt = promptFor(many);
  assertEquals(prompt.includes(`${MAX_MEMBERS}. Title ${MAX_MEMBERS - 1}`), true);
  assertEquals(prompt.includes(`${MAX_MEMBERS + 1}.`), false);
});

Deno.test('parseResponse pulls name and gloss out of a Gemini reply', () => {
  const body = {
    candidates: [{
      content: {
        parts: [{ text: JSON.stringify({ name: 'Valley splitting', gloss: 'All Si/SiGe.' }) }],
      },
    }],
  };
  assertEquals(parseResponse(body), { name: 'Valley splitting', gloss: 'All Si/SiGe.' });
});

Deno.test('parseResponse returns null for every shape of failure', () => {
  assertEquals(parseResponse(null), null);
  assertEquals(parseResponse({}), null);
  assertEquals(parseResponse({ candidates: [] }), null);           // safety block
  assertEquals(parseResponse({ candidates: [{ content: { parts: [] } }] }), null);
  assertEquals(parseResponse({ candidates: [{ content: { parts: [{ text: '{ trunc' }] } }] }), null);
  // A reply that validates but carries no name is no name.
  const empty = { candidates: [{ content: { parts: [{ text: '{"name":"","gloss":"x"}' }] } }] };
  assertEquals(parseResponse(empty), null);
});

Deno.test('readWagons accepts a well-formed body', () => {
  const got = readWagons({ wagons: [{ members: [A, B] }] });
  assertEquals(Array.isArray(got), true);
  assertEquals((got as Member[][])[0].length, 2);
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
