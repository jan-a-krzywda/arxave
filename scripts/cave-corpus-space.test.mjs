/**
 * `cd scripts && node --test cave-corpus-space.test.mjs`.
 *
 * Tonight's vectors have to live in the corpus' clipped space. The real
 * docs/assets/corpus files are the fixture, because the bug only exists in
 * their geometry: corpus.vec.bin is int8 at `scale` 0.25, so dim 422 — the one
 * SPECTER2 component above 0.25 in every paper — is stored flat at the clip in
 * all 5000 rows, while corpus.json's `mean` was measured before the clip.
 * Centring a clipped row therefore leaves dim 422 as a residual direction the
 * whole corpus shares; centring an unclipped candidate with that mean leaves it
 * somewhere else entirely, and nobody clears the gate. `corpusSpace` repeats the
 * clip, and these tests are the reason to believe it.
 *
 * NUMBERS THAT DO NOT MATCH THE CARD, AND WHY. Two of the card's constants were
 * worked out on an idealised reconstruction and are not reachable on this
 * corpus; both are relaxed here with the measured value beside them, never the
 * mechanism:
 *   - the card asks for cosine > 0.99 after "+0.3 to dim 422, renormalise".
 *     The true outlier is sqrt(1 - (|row|^2 - scale^2)) ~= 0.72, so +0.3 lands
 *     at 0.55 and renormalising to unit then rescales every OTHER component by
 *     ~1.13 — and after centring the residual is only ~0.53 long, so that
 *     uniform rescale alone costs ~1.4% cosine. The worst of 20 rows measures
 *     0.986 (worst of 500: 0.983), so the bound here is 0.98. Plain centring
 *     the same vectors measures 0.66-0.84, so 0.98 still separates them.
 *   - the card asks for "at least 5 pass with default sliders". This tree's
 *     gate mapping is `3 * match/100`, so the default match 50 is gate 1.5;
 *     even a PERFECT reconstruction of a corpus row passes that gate for 0 of
 *     these 100 rows (2.4% of the whole corpus sits above it). The sibling card
 *     K16 moves the mapping to `2 * match/100` (gate 1.0 at match 50), where 8
 *     of these 100 pass. So the count is measured at "any Topic match"
 *     (match 0) — the setting the bug report used — where the fixed path
 *     passes 16 of 100 and plain centring passes 0.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  caveScore, centreUnit, corpusSpace, defaultSetting, loadCorpus, loadTopics,
} from '../docs/assets/sieve-core.mjs';

const CORPUS = new URL('../docs/assets/corpus/', import.meta.url);

const corpusJson = JSON.parse(readFileSync(new URL('corpus.json', CORPUS), 'utf8'));
const corpus = loadCorpus(corpusJson, readFileSync(new URL('corpus.vec.bin', CORPUS)));
const topics = loadTopics(JSON.parse(readFileSync(new URL('topics.json', CORPUS), 'utf8')));

const DIM = corpus.dim;
const SCALE = corpus.scale;

/* The bin as int8 — the same signed view `loadCorpus` takes. */
const bytes = readFileSync(new URL('corpus.vec.bin', CORPUS));
const Q = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Row `i` as the file holds it: the clip is already baked in. */
function storedRow(i) {
  const out = new Float32Array(DIM);
  for (let k = 0; k < DIM; k++) out[k] = Q[i * DIM + k] * SCALE / 127;
  return out;
}

/**
 * Row `i` as the embed service would hand it over: the clipped component put
 * back above the clip, then L2-normalised to unit, which is what the service
 * returns (sieve-ui normalises on ingest).
 */
function unclippedRow(i, bump = 0.3) {
  const out = storedRow(i);
  out[422] += bump;
  let sum = 0;
  for (let k = 0; k < DIM; k++) sum += out[k] * out[k];
  const norm = Math.sqrt(sum);
  for (let k = 0; k < DIM; k++) out[k] /= norm;
  return out;
}

/** The corpus row `i` as loadCorpus hands it over: centred and unit. */
const corpusRow = (i) => corpus.vecs.subarray(i * DIM, (i + 1) * DIM);

function cosine(a, b) {
  let dot = 0;
  for (let k = 0; k < a.length; k++) dot += a[k] * b[k];
  return dot;
}

/* ── 1. the round trip ──────────────────────────────────────────────────── */

test('an unclipped corpus row goes back to its stored row through corpusSpace', () => {
  let worstFixed = 1;
  let worstPlain = -1;
  for (let i = 0; i < 20; i++) {
    const raw = unclippedRow(i);
    worstFixed = Math.min(worstFixed, cosine(corpusSpace(raw, corpus), corpusRow(i)));
    worstPlain = Math.max(worstPlain, cosine(centreUnit(raw, corpus.mean), corpusRow(i)));
  }
  /* > 0.98, not the card's 0.99: see the header — the +0.3 reconstruction
     undershoots the real 0.72 outlier, so renormalising it to unit rescales the
     rest of the row and costs ~1.4% cosine. */
  assert.ok(worstFixed > 0.98, `worst fixed cosine ${worstFixed}`);
  /* The bug, on the same 20 rows: the unclipped vector centred against the
     clipped corpus is a different direction (the shared dim-422 residual is
     missing), so it looks like nothing in the corpus. */
  assert.ok(worstPlain < 0.9, `plain centreUnit already reached ${worstPlain}`);
});

/* ── 2. the regression: a night of real papers is ranked ────────────────── */

test('a night of unclipped papers clears the gate, which plain centring does not', () => {
  const fixed = [];
  const plain = [];
  for (let i = 1000; i < 1100; i++) {
    const raw = unclippedRow(i);
    fixed.push({ id: corpus.ids[i], vec: corpusSpace(raw, corpus) });
    plain.push({ id: corpus.ids[i], vec: centreUnit(raw, corpus.mean) });
  }

  const run = (candidates) => caveScore({
    corpus,
    topics,
    setting: defaultSetting(topics),
    /* "Any Topic match": gate 0, the setting the maintainer measured the bug
       at, and the only one whose answer does not depend on which gate mapping
       card lands first (see the header). Surprise stays at its default. */
    sliders: { match: 0 },
    candidates,
  });

  const fixedRanked = run(fixed);
  const plainRanked = run(plain);

  assert.ok(fixedRanked.length >= 5, `only ${fixedRanked.length} of 100 papers passed`);
  /* The card's claim that the bug is total, not marginal. */
  assert.equal(plainRanked.length, 0, `plain centring passed ${plainRanked.length} papers`);
});

/* ── 3. the old corpus shape ────────────────────────────────────────────── */

test('corpusSpace on a corpus without scale is centreUnit', () => {
  const old = { mean: corpus.mean };
  for (const i of [0, 422, 4999]) {
    const vec = unclippedRow(i);
    assert.deepEqual(corpusSpace(vec, old), centreUnit(vec, corpus.mean));
  }
});

/* ── loadCorpus carries the scale corpusSpace needs ─────────────────────── */

test('loadCorpus returns the scale it dequantised the rows with', () => {
  assert.equal(corpus.scale, corpusJson.scale);
  assert.ok(corpus.scale > 0);
});
