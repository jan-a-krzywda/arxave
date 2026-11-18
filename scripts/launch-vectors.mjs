/**
 * launch-vectors — the 12 launch phrases, embedded once and shipped as a page
 * asset.
 *
 * WHY A FILE AND NOT A CALL. A launch's phrase is fixed data (`cave-launch.mjs`),
 * so every visit to `/ai/llms` embedded the same sentence again: a cold embed
 * function, a wait before the ranking, and a bill that grew with traffic and
 * never with new information. The vector never changes until the model does, so
 * it belongs beside `corpus.json` where the page already fetches static assets.
 *
 * THE MODEL IS NAMED IN THE FILE. A same-shaped vector from another embedding
 * model scores plausibly and ranks the wrong papers, and nothing downstream
 * could notice — so the file carries the model that made it and the loader
 * (`docs/assets/cave-launch-vectors.mjs`) refuses anything else, falling back to
 * the endpoint. Keep `MODEL` in step with the corpus' own.
 *
 * WHAT THE VECTORS ARE. The page's `embedTexts` answer, un-centred and
 * un-clipped: the runtime puts them through `corpusSpace` against whichever
 * field's corpus is loaded, exactly as it does a typed phrase. Centring here
 * would bake one field's mean into a file both fields read.
 *
 * Usage:
 *   node scripts/launch-vectors.mjs [--embed <url>] [--out <file>]
 *
 * Flags:
 *   --embed  the deployed embed function (default: $EMBED_URL, then the pick)
 *   --out    where to write (default: docs/assets/corpus/launch-vectors.json)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { LAUNCHES } from '../docs/assets/cave-launch.mjs';
/* The model identity and the width come from the page module, which is the one
   both the build and the reader share: a file that named a different model than
   the page checks for would be ignored on every visit, working silently.
   `warm-dig.mjs` is NOT imported here (see `main`). */
import { MODEL } from '../docs/assets/sieve-ui.mjs';

/* Five decimals is far more precision than a cosine needs and about a third of
   the bytes of the raw doubles: the file is twelve vectors on the wire, not a
   checkpoint. */
const ROUND = 1e5;

const DEFAULT_OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'assets', 'corpus', 'launch-vectors.json');

/** One vector → plain numbers at five decimals, ready for `JSON.stringify`. */
function rounded(vec) {
  return Array.from(vec, (v) => Math.round(v * ROUND) / ROUND);
}

/**
 * The file's whole contents, with the embedder injected (`embed(texts)` →
 * one vector per text, in order) so tests need no network and the CLI only has
 * to hand over `embedChunk`.
 *
 * `dim` is measured off the vectors rather than taken from `DIM`: the file must
 * say what is actually in it, or a pick that answered a different width would
 * ship vectors the page would then quietly compare at the wrong size.
 */
export async function buildVectorsFile(launches, embed) {
  const vectors = await embed(launches.map((launch) => launch.phrase));
  if (!Array.isArray(vectors) || vectors.length !== launches.length) {
    throw new Error('launch-vectors: the pick answered ' +
      (vectors ? vectors.length : 'no') + ' vectors for ' + launches.length + ' phrases');
  }

  const dim = vectors[0]?.length ?? 0;
  const rows = {};
  launches.forEach((launch, at) => {
    const vec = vectors[at];
    if (!vec || vec.length !== dim) {
      throw new Error('launch-vectors: ' + launch.id + ' is ' +
        (vec ? vec.length : 'no') + '-dim against ' + dim);
    }
    rows[launch.id] = rounded(vec);
  });

  return { model: MODEL, dim, built: new Date().toISOString(), vectors: rows };
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  /* `warm-dig.mjs` is imported here rather than at the top, the way
     `embed-local.mjs` guards its optional dependency: that module pulls
     `fast-xml-parser`, and this file must be importable by `node --test` in a
     checkout with no `node_modules`. The CLI is the only path that needs it,
     and it is where the deployed endpoint and its model check already live. */
  const { DEFAULT_EMBED, embedChunk, resolveEndpoint } = await import('./warm-dig.mjs');

  let embedUrl;
  try {
    embedUrl = resolveEndpoint(arg('embed'), process.env.EMBED_URL, DEFAULT_EMBED);
  } catch (err) {
    console.error('launch-vectors: ' + err.message);
    process.exit(2);
  }

  /* One call for the twelve phrases in the table's order; `embedChunk` already
     refuses a reply from another model or width, which is the one failure that
     would otherwise ship silently. */
  const file = await buildVectorsFile(LAUNCHES, (texts) => embedChunk(texts, embedUrl));

  const out = arg('out', DEFAULT_OUT);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(file) + '\n');
  console.log(
    `launch-vectors: ${LAUNCHES.length} phrases × ${file.dim} on ${file.model} → ${out}`);
}

// Importable for tests; only the CLI invocation writes the file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('launch-vectors: ' + (err?.stack ?? err));
    process.exit(1);
  });
}
