/**
 * cave-launch-vectors — a launch phrase's vector, read from the shipped file.
 *
 * A launch's phrase is the same sentence every time (`cave-launch.mjs`), so the
 * Priorities autorun used to embed it again on every visit: a cold embed call
 * between the reader and their ranking, paid for text that never changed.
 * `scripts/launch-vectors.mjs` embeds the twelve once and writes them beside
 * `corpus.json`; this is the runtime half that reads one back.
 *
 * NULL IS THE NORMAL ANSWER, NOT AN ERROR. A build that predates the file, a
 * file built by an older embedding model, a width this page does not use, and a
 * launch added since the file was built are all the same thing to the caller:
 * no stored vector, so embed the words. A same-shaped vector from another model
 * scores plausibly and ranks the wrong papers, so the model is checked rather
 * than assumed — the fallback is cheap and the wrong answer is not.
 *
 * THE VECTORS ARE RAW. `buildVectorsFile` stores what `embedTexts` answers,
 * un-centred; the caller puts the vector through `corpusSpace` with whichever
 * field's corpus is loaded, exactly as it does a phrase the reader typed.
 */
import { DIM, MODEL } from './sieve-ui.mjs';

/**
 * Where the file sits. Resolved against this module rather than the site root,
 * so a build served under a path prefix (a project page, a local preview)
 * finds it where it really is; `?…` on the page changes nothing.
 */
export const VECTORS_URL = new URL('corpus/launch-vectors.json', import.meta.url).href;

/**
 * `id`'s vector as the page's own Float32Array, or null when the file cannot
 * supply one: no file, no such launch, another model, another width. Every
 * failure is silent by design — the caller has a working path to fall back on,
 * and a launch link must never stop on a missing optimisation.
 */
export async function loadLaunchVector(id, {
  url = VECTORS_URL, model = MODEL, dim = DIM, fetchImpl = fetch,
} = {}) {
  let file;
  try {
    const resp = await fetchImpl(url);
    if (!resp.ok) return null;
    file = await resp.json();
  } catch (_) {
    return null; /* no file, offline, or a body that is not JSON: all a miss */
  }

  if (!file || file.model !== model || Number(file.dim) !== dim) return null;
  const row = file.vectors ? file.vectors[id] : null;
  if (!Array.isArray(row) || row.length !== dim) return null;
  return Float32Array.from(row);
}
