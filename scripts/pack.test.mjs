/**
 * `node --test scripts/pack.test.mjs` (after `npm install` in this dir).
 *
 * The pack is the pipeline's data seam: a typo in a seed or a config key does
 * not throw at the point of use, it produces a preset that quietly ranks the
 * wrong papers. So these tests read the real pack and the real config, and pin
 * the one contract that keeps the generated files loadable — their keys are the
 * shipped presets' keys, plus `unlisted` and `axis`.
 *
 * Nothing here touches the network: the two functions that would (`loadPresets`
 * resolving cores) take an injected fetcher.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyOverrides, loadConfig, loadPack, presetsFromPack, writePresets } from './pack.mjs';
import { loadPresets } from './warm-dig.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const packDir = path.join(here, '..', 'criteria', 'quantum-systems');
const configFile = path.join(here, '..', 'config', 'quantum-systems.yml');
const presetDir = path.join(here, '..', 'docs', 'presets');

/** A config that passes validation; each test breaks exactly one key in it. */
const GOOD_CONFIG = `
criterion: demo
feed: { categories: [quant-ph, cond-mat.mes-hall], lookback_weekdays: 2 }
shortlist: { max: 20, min: 3, sensitivity: normal, tau_ref: null, tau_seed: null }
sensitivity_presets:
  strict: { background_pass: 0.005 }
  normal: { background_pass: 0.01 }
  broad:  { background_pass: 0.03 }
llm: { provider: openai-compatible, base_url: "https://x.invalid/v1", model: m, api_key_env: K }
store: { relevance: 4, novelty: 4, novelty_min_relevance: 3 }
ship: { relevance: 3, max: 8, longshots_on_empty: 2 }
axes: { A: 1.0, B: 1.0 }
`;

const readConfig = (yaml) => loadConfig('cfg.yml', { readFile: async () => yaml });

test('the shipped config loads and keeps its knobs', async () => {
  const config = await loadConfig(configFile);
  assert.equal(config.criterion, 'quantum-systems');
  assert.deepEqual(config.feed.categories, ['quant-ph', 'cond-mat.mes-hall']);
  assert.equal(config.shortlist.sensitivity, 'normal');
  assert.equal(config.ship.max, 8);
});

test('a missing key names the file and the key it wanted', async () => {
  const noFeed = GOOD_CONFIG.replace(/^feed:.*$/m, '');
  await assert.rejects(readConfig(noFeed), /cfg\.yml: feed\.categories is missing/);

  const noShip = GOOD_CONFIG.replace(/^ship:.*$/m, '');
  await assert.rejects(readConfig(noShip), /cfg\.yml: ship\.relevance is missing/);
});

test('a sensitivity that is not one of the three is refused by name', async () => {
  await assert.rejects(
    readConfig(GOOD_CONFIG.replace('sensitivity: normal', 'sensitivity: loose')),
    /cfg\.yml: shortlist\.sensitivity "loose" is not one of strict\|normal\|broad/);
});

test('a background pass rate outside (0, 1] is refused', async () => {
  await assert.rejects(
    readConfig(GOOD_CONFIG.replace('normal: { background_pass: 0.01 }', 'normal: { background_pass: 0 }')),
    /cfg\.yml: sensitivity_presets\.normal\.background_pass must be in \(0, 1\]/);
});

test('the pack reads its requirements into an id → text Map', async () => {
  const pack = await loadPack(packDir);
  assert.ok(pack.requirements instanceof Map);
  assert.equal(pack.requirements.size, 24);
  assert.equal(pack.requirements.get('Req_11'), 'At least 16 addressable qubits');
  assert.ok(pack.rubric.includes('relevance (1-5'));
  assert.deepEqual(Object.keys(pack.axes), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
});

test('overrides deep-merge over the config without mutating it', async () => {
  const config = await loadConfig(configFile);
  const pack = await loadPack(packDir);
  pack.criterion.overrides = { ship: { max: 5 }, llm: { model: 'other' } };

  const merged = applyOverrides(config, pack);
  assert.equal(merged.ship.max, 5);                       // overridden
  assert.equal(merged.ship.relevance, 3);                 // sibling key kept
  assert.equal(merged.llm.model, 'other');                // deep override
  assert.equal(merged.llm.base_url, config.llm.base_url); // deep sibling kept
  assert.equal(config.ship.max, 8);                       // the original is untouched
});

test('a generated preset has the shipped keys, plus unlisted and axis', async () => {
  const pack = await loadPack(packDir);
  const shipped = JSON.parse(await fs.readFile(path.join(presetDir, 'solid-state-qubits.json'), 'utf8'));
  const presets = presetsFromPack(pack, {
    saved: '2026-11-05',
    feed: { categories: ['quant-ph', 'cond-mat.mes-hall'], lookback_weekdays: 2 },
  });

  assert.deepEqual(presets.map((p) => p.slug),
    ['qs-a', 'qs-b', 'qs-c', 'qs-d', 'qs-e', 'qs-f', 'qs-g', 'qs-h', 'qs-i']);

  const { claim } = presets[0];
  assert.deepEqual(Object.keys(claim), [...Object.keys(shipped), 'unlisted', 'axis']);
  assert.deepEqual(Object.keys(claim.scout), Object.keys(shipped.scout));
  assert.equal(claim.unlisted, true);
  assert.equal(claim.axis, 'A');
  assert.equal(claim.preset, 'qs-a');
  assert.equal(claim.saved, '2026-11-05');
  assert.equal(claim.arxave_claim, 1);
  assert.deepEqual(claim.blend, { paydirt_n: 10 });
  assert.deepEqual(claim.scout, {
    categories: 'quant-ph, cond-mat.mes-hall', lookback_days: 2, max_results: 200,
  });
  assert.ok(claim.touchstones.length > 0);
  assert.ok(claim.cores.length > 0);
});

test('a seed with a DOI is a doi core; a seed with only an arXiv id is an arxiv core', () => {
  const pack = {
    criterion: { axes: ['A'], description: 'demo' },
    axes: {
      A: {
        name: 'A',
        touchstones: [{ text: 't', weight: 1 }],
        seeds: [
          { doi: '10.1/x', weight: 0.8, title: 'x', first_author: 'X', year: 2020 },
          { arxiv: '1210.7011', weight: 1.0, title: 'y', first_author: 'Y', year: 2013 },
        ],
      },
    },
  };
  const [{ claim }] = presetsFromPack(pack, { saved: '2026-11-05', feed: { categories: ['quant-ph'] } });
  assert.deepEqual(claim.cores, [
    { doi: '10.1/x', weight: 0.8 },
    { arxiv: '1210.7011', weight: 1.0 },
  ]);
});


/** An in-memory filesystem, so the write tests never touch a real directory. */
function memFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: async (file) => {
      if (!files.has(file)) {
        const err = new Error(`ENOENT: ${file}`);
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(file);
    },
    writeFile: async (file, data) => { files.set(file, data); },
  };
}

test('writePresets writes every axis preset and never touches index.json', async () => {
  const pack = await loadPack(packDir);
  const manifest = JSON.stringify({ presets: [{ slug: 'listed', name: 'L', blurb: 'b' }] }, null, 2);
  const mem = memFs({ '/out/index.json': manifest });

  const written = await writePresets(pack, '/out', {
    saved: '2026-11-05',
    feed: { categories: ['quant-ph'], lookback_weekdays: 2 },
    readFile: mem.readFile,
    writeFile: mem.writeFile,
  });

  assert.equal(written.length, 9);
  assert.equal(mem.files.get('/out/index.json'), manifest);   // byte-for-byte
  assert.ok(mem.files.has('/out/qs-a.json'));
  assert.equal(JSON.parse(mem.files.get('/out/qs-a.json')).unlisted, true);
});

test('a slug the catalogue already lists is skipped, not shadowed', async () => {
  const pack = await loadPack(packDir);
  const manifest = JSON.stringify({ presets: [{ slug: 'qs-a', name: 'L', blurb: 'b' }] });
  const mem = memFs({ '/out/index.json': manifest });

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    await writePresets(pack, '/out', {
      saved: '2026-11-05', readFile: mem.readFile, writeFile: mem.writeFile,
    });
  } finally {
    console.warn = realWarn;
  }

  assert.ok(!mem.files.has('/out/qs-a.json'));
  assert.ok(mem.files.has('/out/qs-b.json'));
  assert.equal(mem.files.get('/out/index.json'), manifest);
  assert.match(warnings.join('\n'), /qs-a is already in index\.json/);
});

test('loadPresets loads the unlisted qs-a and resolves its arXiv-only core', async () => {
  const refs = [];
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  let loaded;
  try {
    loaded = await loadPresets(presetDir, {
      coreFetch: async (ref, slug) => {
        refs.push(ref);
        return { text: `${ref.id} abstract`, title: ref.id, source: `preset:${slug}`, kind: 'core', weight: 1 };
      },
    });
  } finally {
    console.warn = realWarn;
  }

  assert.ok(loaded.bySlug.has('qs-a'));
  assert.ok(loaded.bySlug.get('qs-a').rows.length > 0);
  // The generated presets are not in index.json, and loadPresets says so —
  // then loads them anyway, which is exactly the unlisted contract.
  assert.match(warnings.join('\n'), /not in index\.json — .*qs-a\.json/);
  // qs-b's fourth seed is arXiv-only; the dispatcher must hand it to the arXiv
  // fetcher, not the OpenAlex one.
  assert.ok(refs.some((r) => r.kind === 'arxiv' && r.id === '1210.7011'));
  assert.ok(refs.some((r) => r.kind === 'doi'));
});

