/*
 * The gate: the page's count against the feed builder's cut, and the claim
 * plumbing that carries it. Run with `node tests/js/gate.test.js`.
 *
 * The point of the first half is parity. `gateOver` in docs/assets/filter.js
 * and `selectItems` in scripts/preset-feed.mjs are two implementations of one
 * rule, kept apart because the site has no build step. A divergence does not
 * throw — the page would simply promise "3 would ship" and the feed would ship
 * four, forever, quietly. So these run both over the same grades.
 *
 * Needs `npm install` in scripts/ (preset-feed.mjs pulls fast-xml-parser).
 */
const fs = require('fs');
const path = require('path');
const { install } = require('./dom-shim.js');

const IDS = [
  'claim-select', 'claim-save-as', 'claim-clear', 'claim-delete', 'claim-status',
  'categories', 'cat-chips', 'cat-add', 'lookback', 'max-results',
  'pick-gate', 'sharpen-btn', 'sharpen-status', 'sharpen-progress-wrap',
  'sharpen-progress', 'sharpen-label', 'sharpen-done',
  'haul-btn', 'haul-status', 'haul-progress-wrap', 'haul-train', 'haul-label',
  'wagon-panel', 'wagon-stats', 'wagon-view-switch', 'wagon-sort-toggle',
  'wagon-sort-label', 'wagon-expand-btn', 'wagon-canvas', 'wagon-graph-canvas',
  'wagon-matrix-wrap', 'wagon-graph-wrap', 'wagon-graph-hint', 'wagon-readout',
  'train-strip', 'train-strip-tip',
  'touchstones-list', 'add-touchstone',
  'presets-list', 'presets-group', 'presets-hint', 'presets-blurb',
  'cores-list', 'add-core', 'bib-file', 'bib-status',
  'paydirt-n', 'table-view-toggle', 'assay-stats', 'assay-grid', 'assay-rail',
  'assay-column-titles', 'assay-matrix-wrap', 'assay-legends',
  'assay-table-wrap', 'assay-table-head', 'assay-table-body',
  'gate-block', 'gate-z', 'gate-z-value', 'gate-readout',
  'gate-max-items', 'gate-min-items', 'gate-soft-z', 'gate-long-z',
  'stage-1', 'stage-2', 'stage-3', 'app', 'cors-proxy',
  'wagon-modal', 'wagon-modal-backdrop', 'wagon-modal-close', 'wagon-modal-canvas',
  'wagon-modal-graph-canvas', 'wagon-modal-readout', 'wagon-modal-header-title',
  'cell-tooltip',
];

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'docs', 'assets', 'filter.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

function fresh(seedStore) {
  const env = install(IDS);
  if (seedStore) Object.assign(env.store, seedStore);
  const d = env.registry;
  d['categories'].value = 'cond-mat.mes-hall, quant-ph';
  d['lookback'].value = '1';
  d['max-results'].value = '200';
  d['paydirt-n'].value = '10';
  d['gate-z'].value = '2';
  d['gate-max-items'].value = '15';
  d['gate-min-items'].value = '3';
  d['gate-soft-z'].value = '1';
  (0, eval)(SRC);
  return env;
}

function claims(env) { return JSON.parse(env.store['arxave-dig-claims'] || '{}'); }

/* Deterministic, so a failure is reproducible. Grades in [0.55, 0.75] with a
   few planted outliers is the shape a real night has — a tight blob and a
   handful above it (docs/feed-catalogue-plan.md, Part 2). */
function lcg(seed) {
  let s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function nightOf(n, seed, outliers) {
  const rnd = lcg(seed);
  const g = [];
  for (let i = 0; i < n; i++) g.push(0.55 + rnd() * 0.2);
  for (let i = 0; i < (outliers || 0); i++) g[i] = 0.85 + rnd() * 0.1;
  return g;
}

function orderOf(grades) {
  const idx = grades.map((_, i) => i);
  idx.sort((a, b) => grades[b] - grades[a]);
  return idx;
}

async function main() {
  const { selectItems } = await import(
    path.join(__dirname, '..', '..', 'scripts', 'preset-feed.mjs'));

  console.log('\n1. parity with the feed builder');
  {
    const env = fresh();
    const gateOver = global.window.ARXAVE_GATE_OVER;
    check('the page exposes its gate', typeof gateOver === 'function');

    const nights = [
      ['66 papers, 2 outliers', nightOf(66, 7, 2)],
      ['66 papers, none above the blob', nightOf(66, 11, 0)],
      ['91 papers, 8 outliers', nightOf(91, 23, 8)],
      ['4 papers', nightOf(4, 31, 1)],
      ['1 paper', nightOf(1, 5, 0)],
      ['every grade identical', new Array(20).fill(0.6)],
    ];
    const opts = [
      { min_z: 2.0, min_items: 3, soft_z: 1.0, long_z: 0.5, max_items: 15 },
      { min_z: 0, min_items: 3, soft_z: 1.0, long_z: 0.5, max_items: 15 },
      { min_z: 4, min_items: 0, soft_z: 1.0, long_z: 0.5, max_items: 15 },
      { min_z: 2.0, min_items: 5, soft_z: 0.5, long_z: 0.25, max_items: 3 },
      { min_z: 1.2, min_items: 10, soft_z: 1.2, long_z: 0, max_items: 50 },
      // The old shape, with no long_z at all: both sides must default the same.
      { min_z: 2.0, min_items: 3, soft_z: 1.0, max_items: 15 },
    ];

    let mismatches = [];
    for (const [label, grades] of nights) {
      const order = orderOf(grades);
      for (const opt of opts) {
        const mine = gateOver(grades, order, opt);
        const theirs = selectItems(
          grades.map((g, i) => ({ id: i, grade: g })),
          {
            minZ: opt.min_z, minItems: opt.min_items, softZ: opt.soft_z,
            longZ: opt.long_z, maxItems: opt.max_items,
          });
        if (mine.keptCount !== theirs.length) {
          mismatches.push(label + ' @ z' + opt.min_z + '/' + opt.max_items +
            ': page ' + mine.keptCount + ', builder ' + theirs.length);
          continue;
        }
        // Same count is not enough — it has to be the same papers.
        const mineIds = order.slice(0, mine.keptCount).slice().sort((a, b) => a - b).join(',');
        const theirIds = theirs.map((r) => r.id).slice().sort((a, b) => a - b).join(',');
        if (mineIds !== theirIds) {
          mismatches.push(label + ': different papers (' + mineIds + ' vs ' + theirIds + ')');
        }
        // …and the z it reports has to be the z the builder computed.
        if (mine.z && theirs.length && theirs[0].z !== null) {
          const d = Math.abs(mine.z[theirs[0].id] - theirs[0].z);
          if (d > 1e-9) mismatches.push(label + ': z differs by ' + d);
        }
      }
    }
    check('every night and setting agrees', mismatches.length === 0,
      mismatches.join(' | '));
  }

  console.log('\n2. what the report says');
  {
    const env = fresh();
    const gateOver = global.window.ARXAVE_GATE_OVER;
    const dflt = { min_z: 2.0, min_items: 3, soft_z: 1.0, max_items: 15 };

    const flat = new Array(20).fill(0.6);
    const deg = gateOver(flat, orderOf(flat), dflt);
    check('no spread stands the gate down to top-N',
      deg.degenerate === true && deg.keptCount === 15 && deg.z === null);

    /* A quiet night — both the pay-dirt line and the ship line are out of
       reach, so the floor is the only thing shipping anything. This is the case
       Part 2 of the catalogue plan is about: what the floor ships is capped at
       the floor and wears a Long shot chip, which is what keeps a lower bar
       from being a padded one. */
    const g = nightOf(60, 17, 2);
    const ord = orderOf(g);
    const r = gateOver(g, ord, { min_z: 100, min_items: 3, soft_z: 100, long_z: 0, max_items: 15 });
    check('the floor is a floor', r.floored === true && r.hard === 0 && r.keptCount === 3,
      JSON.stringify({ hard: r.hard, kept: r.keptCount, floored: r.floored }));

    /* …and it reaches down to long z and no further, however hungry the floor
       is: asking for 40 gets you the two that are actually above z 2. */
    const reach = gateOver(g, ord,
      { min_z: 100, min_items: 40, soft_z: 100, long_z: 2, max_items: 50 });
    let above2 = 0;
    for (let i = 0; i < g.length; i++) if (reach.z[i] >= 2) above2++;
    check('the floor never pads past long z',
      reach.keptCount === above2 && above2 < 40,
      JSON.stringify({ kept: reach.keptCount, above2: above2 }));

    /* The band split is the promise the readout makes, so it has to be the same
       arithmetic the feed builder's tally runs. */
    const banded = gateOver(g, ord, dflt);
    let paydirt = 0;
    for (let i = 0; i < banded.keptCount; i++) if (banded.z[ord[i]] >= dflt.min_z) paydirt++;
    check('pay dirt is counted among what ships, not beyond it',
      banded.hard === paydirt && banded.hard <= banded.keptCount,
      JSON.stringify({ hard: banded.hard, paydirt, kept: banded.keptCount }));

    check('the ceiling wins over the floor',
      gateOver(g, ord, { min_z: 0, min_items: 10, soft_z: 0, max_items: 2 })
        .keptCount === 2);
    check('nothing to gate reads as nothing', gateOver(null, null, dflt) === null);
  }

  console.log('\n3. the gate rides in the claim');
  {
    const env = fresh();
    const d = env.registry;

    d['gate-z'].value = '2.6';
    d['gate-z'].fire('input');
    d['gate-max-items'].value = '7';
    d['gate-max-items'].fire('input');

    const c = claims(env)['working'];
    check('saved with the claim', c.select && c.select.min_z === 2.6 && c.select.max_items === 7,
      JSON.stringify(c.select));
    check('the label follows the slider', d['gate-z-value'].textContent === '2.6');
    check('defaults are the builder\'s defaults',
      c.select.min_items === 3 && c.select.soft_z === 1 && c.select.long_z === 0.5,
      JSON.stringify(c.select));

    d['gate-long-z'].value = '0.2';
    d['gate-long-z'].fire('input');
    check('how far the floor reaches rides in the claim too',
      claims(env)['working'].select.long_z === 0.2,
      JSON.stringify(claims(env)['working'].select));
    d['gate-long-z'].value = '0.5';
    d['gate-long-z'].fire('input');

    // A field left empty falls back rather than poisoning the claim with NaN.
    d['gate-min-items'].value = '';
    d['gate-min-items'].fire('input');
    check('an empty field falls back to the default',
      claims(env)['working'].select.min_items === 3);
    d['gate-min-items'].fire('change');
    check('and the field is put back on screen', d['gate-min-items'].value === 3 ||
      d['gate-min-items'].value === '3', JSON.stringify(d['gate-min-items'].value));

    // Out of range is clamped, not trusted.
    d['gate-z'].value = '99';
    d['gate-z'].fire('input');
    check('z is clamped to the slider\'s range', claims(env)['working'].select.min_z === 4);
  }

  console.log('\n4. a claim from before the gate still loads');
  {
    const old = {
      'working': {
        arxave_claim: 1, name: 'Dig Setup', saved: '2026-08-01',
        scout: { categories: 'quant-ph', lookback_days: 1, max_results: 200 },
        touchstones: [{ text: 'valley splitting', weight: 1 }],
        cores: [], blend: { paydirt_n: 10 },
      },
    };
    const env = fresh({ 'arxave-dig-claims': JSON.stringify(old) });
    const d = env.registry;
    /* Storage is not rewritten on load — the slot is saved on the next edit,
       like every other claim — so the defaults show up on screen first. */
    check('the gate arrives at its defaults',
      String(d['gate-z'].value) === '2' && String(d['gate-max-items'].value) === '8',
      JSON.stringify([d['gate-z'].value, d['gate-max-items'].value]));
    check('the touchstone survived', claims(env)['working'].touchstones.length === 1);

    d['paydirt-n'].value = '12';
    d['paydirt-n'].fire('input');
    const c = claims(env)['working'];
    check('and the next edit writes the gate into the old claim',
      c.select && c.select.min_z === 2 && c.select.max_items === 8,
      JSON.stringify(c.select));
    check('without losing the touchstone', c.touchstones.length === 1);
  }

  console.log('\n5. clear');
  {
    const env = fresh();
    const d = env.registry;

    d['add-touchstone'].fire('click');
    d['add-core'].fire('click');
    d['gate-z'].value = '3';
    d['gate-z'].fire('input');
    let c = claims(env)['working'];
    check('setup has rows to begin with', c.touchstones.length === 1 && c.cores.length === 1);

    global.__confirmAnswer = false;
    d['claim-clear'].fire('click');
    check('a declined confirm changes nothing',
      claims(env)['working'].touchstones.length === 1);

    global.__confirmAnswer = true;
    d['claim-clear'].fire('click');
    c = claims(env)['working'];
    check('rows are gone', c.touchstones.length === 0 && c.cores.length === 0);
    check('the gate is back at its default', c.select.min_z === 2);
    check('the scout is untouched', c.scout.categories === 'cond-mat.mes-hall, quant-ph');
    check('the slot is still the working one', env.store['arxave-dig-current'] === 'working');
    check('stage 3 is hidden', d['stage-3'].style.display === 'none');
    check('the rows on screen are gone too',
      d['touchstones-list'].innerHTML === '' && d['cores-list'].innerHTML === '');

    d['claim-clear'].fire('click');
    check('clearing an empty setup says so', /Nothing to clear/.test(d['claim-status'].textContent),
      d['claim-status'].textContent);
  }

  console.log(failures === 0 ? '\nAll gate checks passed.\n' : '\n' + failures + ' FAILED\n');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
