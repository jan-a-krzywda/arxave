/**
 * `node tests/js/report.test.js` — no dependencies.
 *
 * The report is the feed you asked for: this night, these weights, this
 * selection. It shares the feed's bands on purpose, and the thing these checks
 * exist to stop is the one way that sharing can go wrong — **a hand pick
 * wearing a measured band.** A band is what the assay was confident about; a
 * tick is what the reader wanted. A report is read by someone who did not move
 * these sliders, so if an opinion can come out looking like a measurement, the
 * chips stop meaning anything and the feed's own chips go with them.
 */
const path = require('path');
const fs = require('fs');
const { install } = require('./dom-shim');

const IDS = [
  'app', 'claim-select', 'claim-save-as', 'claim-clear', 'claim-delete',
  'claim-status', 'categories', 'cat-chips', 'cat-add', 'lookback',
  'max-results', 'paydirt-n', 'touchstones-list', 'cores-list',
  'presets-list', 'presets-group', 'presets-hint', 'presets-blurb',
  'gate-block', 'gate-z', 'gate-z-value', 'gate-readout',
  'gate-max-items', 'gate-min-items', 'gate-soft-z', 'gate-long-z',
  'report-bar', 'report-source', 'report-btn', 'report-note',
  'report-panel', 'report-body', 'report-title',
  'stage-1', 'stage-2', 'stage-3', 'cors-proxy',
];

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'docs', 'assets', 'filter.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

const env = install(IDS);
env.registry['categories'].value = 'quant-ph';
env.registry['lookback'].value = '1';
env.registry['max-results'].value = '200';
env.registry['paydirt-n'].value = '10';
new Function(SRC)();

const bandOf = global.window.ARXAVE_BAND_OF;
const gateOver = global.window.ARXAVE_GATE_OVER;
const select = global.window.ARXAVE_REPORT_SELECT;
const tally = global.window.ARXAVE_REPORT_TALLY;

const OPT = { min_z: 2.0, min_items: 3, soft_z: 1.0, long_z: 0.5, max_items: 15 };

/* One outlier, one middling paper, and a blob. Hand-computed against the same
   median/MAD the gate uses, so the bands below are arithmetic, not output. */
const grades = [0.50, 0.55, 0.58, 0.60, 0.61, 0.62, 0.63, 0.65, 0.70, 0.90];
const order = grades.map((_, i) => i).sort((a, b) => grades[b] - grades[a]);
const gate = gateOver(grades, order, OPT);
const zOf = (i) => gate.z[i];

console.log('\n1. the bands are the gate\'s own arithmetic');
{
  check('the outlier is pay dirt', bandOf(zOf(9), OPT) === 'paydirt',
    String(zOf(9)));
  check('the next one down is worth a look', bandOf(zOf(8), OPT) === 'look',
    String(zOf(8)));
  check('the blob is a long shot', bandOf(zOf(7), OPT) === 'longshot',
    String(zOf(7)));
  check('no spread means no confidence to claim', bandOf(null, OPT) === 'longshot');
}

console.log('\n2. each source selects what it says it does');
{
  const g = select('gate', order, gate, OPT, 10, null);
  check('the gate source is exactly what would ship', g.length === gate.keptCount,
    JSON.stringify({ got: g.length, kept: gate.keptCount }));
  check('and it comes out in grade order',
    g.every((it, i) => i === 0 || grades[g[i - 1].si] >= grades[it.si]));

  const p = select('paydirt', order, gate, OPT, 3, null);
  check('the pay dirt source is the top N by grade',
    p.length === 3 && p[0].si === 9 && p[2].si === 7,
    JSON.stringify(p.map((x) => x.si)));

  /* Top-N is a cut on rank, not on confidence, so it reaches past the bands —
     which is exactly why its items still have to carry honest ones. */
  check('a top-N cut still bands by measurement, not by rank',
    p[0].band === 'paydirt' && p[2].band === 'longshot',
    JSON.stringify(p.map((x) => x.band)));

  const empty = select('picked', order, gate, OPT, 10, null);
  check('nothing ticked selects nothing', empty.length === 0);
}

console.log('\n3. a hand pick is an opinion and is never dressed as a measurement');
{
  // Ticked: the outlier (real pay dirt) and a paper from the blob (nothing).
  const picked = { 9: true, 3: true };
  const sel = select('picked', order, gate, OPT, 10, picked);
  check('both ticks come back', sel.length === 2, JSON.stringify(sel.map((s) => s.si)));

  const outlier = sel.find((s) => s.si === 9);
  const blob = sel.find((s) => s.si === 3);
  check('a tick that clears a band keeps it — agreeing is not a demotion',
    outlier.band === 'paydirt', outlier.band);
  check('a tick that clears nothing is marked hand-picked, not long shot',
    blob.band === 'picked', blob.band);
  check('ticks come out in grade order, like everything else',
    sel[0].si === 9 && sel[1].si === 3);

  /* The failure this whole file exists for: `picked` must not be reachable
     from a source the reader did not choose by hand. */
  const viaGate = select('gate', order, gate, OPT, 10, picked);
  check('no measured selection can produce a hand-picked chip',
    viaGate.every((it) => it.band !== 'picked'),
    JSON.stringify(viaGate.map((x) => x.band)));
}

console.log('\n4. the tally says whether there was any pay dirt');
{
  check('an empty top band is said out loud',
    /^No pay dirt/.test(tally([{ band: 'look' }, { band: 'longshot' }])),
    tally([{ band: 'look' }, { band: 'longshot' }]));
  check('counts are spelled out',
    tally([{ band: 'paydirt' }, { band: 'look' }, { band: 'look' }]) ===
      '1 pay dirt · 2 worth a look.',
    tally([{ band: 'paydirt' }, { band: 'look' }, { band: 'look' }]));
  check('hand picks are counted as their own thing',
    /1 hand-picked/.test(tally([{ band: 'paydirt' }, { band: 'picked' }])),
    tally([{ band: 'paydirt' }, { band: 'picked' }]));
  check('one long shot is not "1 long shots"',
    /1 long shot\./.test(tally([{ band: 'longshot' }])),
    tally([{ band: 'longshot' }]));
}

console.log(failures ? '\n' + failures + ' report check(s) FAILED'
  : '\nAll report checks passed.');
process.exit(failures ? 1 : 0);
