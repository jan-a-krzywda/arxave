/**
 * `deno test supabase/functions/dig-cache/`
 *
 * The one thing worth testing without a database: that a vector survives the
 * trip Python-writes → Postgres-bytea → browser-Float32Array unchanged. A
 * silent corruption here would not throw anywhere — it would just rank the
 * wrong papers first.
 */
import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { base64ToHex, floatsInHex, hexToBase64, sha256 } from './codec.ts';

/** The exact bytes `store.pack_vector([0.5, -0.25, 0.125, 0.0])` produces. */
const PY_BASE64 = 'AAAAPwAAgL4AAAA+AAAAAA==';
const PG_HEX = '\\x0000003f000080be0000003e00000000';

Deno.test('bytea hex → base64 matches what Python packed', () => {
  assertEquals(hexToBase64(PG_HEX), PY_BASE64);
});

Deno.test('base64 → bytea hex round-trips', () => {
  assertEquals(base64ToHex(PY_BASE64), PG_HEX);
  assertEquals(hexToBase64(base64ToHex(PY_BASE64)), PY_BASE64);
});

Deno.test('base64 decodes to the floats it encoded', () => {
  const hex = base64ToHex(PY_BASE64).slice(2);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  assertEquals([...new Float32Array(bytes.buffer)], [0.5, -0.25, 0.125, 0]);
});

Deno.test('floatsInHex counts float32s, which is the dim guard on write', () => {
  assertEquals(floatsInHex(PG_HEX), 4);
});

Deno.test('a truncated bytea is rejected rather than silently halved', () => {
  assertThrows(() => hexToBase64('\\x0000003f0'), Error, 'odd length');
});

Deno.test('sha256 agrees with store.text_sha on the collapsed text', async () => {
  // store.text_sha('silicon  spin\n qubits ') — the whitespace collapse happens
  // in the caller; this asserts only that the digest itself matches.
  assertEquals(
    await sha256('silicon spin qubits'),
    'eb6fd1375a144cfa58747ae5547440a3d453c21a80b969219e42cf41c1e1a67f',
  );
});
