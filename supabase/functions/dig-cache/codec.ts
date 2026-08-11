/**
 * Wire-format helpers for dig-cache, kept in their own module so they can be
 * tested without starting the server (`deno test supabase/functions/dig-cache`).
 *
 * Three representations meet here and all three must agree byte for byte:
 *   * Postgres stores the vector as `bytea`, which PostgREST renders as `\x…` hex;
 *   * the browser wants base64 it can feed to `atob` → `Float32Array`;
 *   * both are little-endian float32, `dim * 4` bytes — the same layout
 *     `store.pack_vector` writes from Python.
 */

/** Postgres `\x<hex>` bytea → base64. */
export function hexToBase64(pgHex: string): string {
  const hex = pgHex.startsWith('\\x') ? pgHex.slice(2) : pgHex;
  if (hex.length % 2 !== 0) throw new Error('bytea hex has an odd length');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** base64 → Postgres `\x<hex>` bytea literal. */
export function base64ToHex(b64: string): string {
  const binary = atob(b64);
  let hex = '\\x';
  for (let i = 0; i < binary.length; i++) {
    hex += binary.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return hex;
}

/** Floats carried by a `\x…` bytea, for the dimension check on write. */
export function floatsInHex(pgHex: string): number {
  return (pgHex.length - 2) / 8;   // -2 for the leading \x, /2 hex pairs, /4 float32
}

export async function sha256(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
