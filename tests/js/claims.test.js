/*
 * Claims: save/restore of a Dig setup. Run with `node tests/js/claims.test.js`.
 *
 * docs/assets/filter.js is a plain browser IIFE with no bundler and no test
 * runner, so this loads it against the shim DOM in dom-shim.js and drives the
 * real event handlers. It covers the wiring — records, autosave, slot
 * switching, migration — not rendering; the shim has no layout and no canvas.
 */
const fs = require('fs');
const path = require('path');
const { install } = require('./dom-shim.js');

const IDS = [
  'claim-select', 'claim-save-as', 'claim-delete', 'claim-status',
  'categories', 'cat-chips', 'cat-add', 'lookback', 'max-results',
  'pick-gate', 'sharpen-btn', 'sharpen-status', 'sharpen-progress-wrap',
  'sharpen-progress', 'sharpen-label', 'sharpen-done',
  'haul-btn', 'haul-status', 'haul-progress-wrap', 'haul-train', 'haul-label',
  'wagon-panel', 'wagon-stats', 'wagon-view-switch', 'wagon-sort-toggle',
  'wagon-sort-label', 'wagon-expand-btn', 'wagon-canvas', 'wagon-graph-canvas',
  'wagon-matrix-wrap', 'wagon-graph-wrap', 'wagon-graph-hint', 'wagon-readout',
  'train-strip', 'train-strip-tip',
  'touchstones-list', 'add-touchstone',
  'cores-list', 'add-core', 'bib-file', 'bib-status',
  'paydirt-n', 'table-view-toggle', 'assay-stats', 'assay-grid', 'assay-rail',
  'assay-column-titles', 'assay-matrix-wrap', 'assay-legends',
  'assay-table-wrap', 'assay-table-head', 'assay-table-body',
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
  // defaults the real HTML carries
  const d = env.registry;
  d['categories'].value = 'cond-mat.mes-hall, quant-ph';
  d['lookback'].value = '1';
  d['max-results'].value = '200';
  d['paydirt-n'].value = '10';
  (0, eval)(SRC);
  return env;
}

function claims(env) { return JSON.parse(env.store['arxave-dig-claims'] || '{}'); }

console.log('\n1. cold start');
{
  const env = fresh();
  const c = claims(env);
  check('a working claim exists', !!c['working'], JSON.stringify(Object.keys(c)));
  check('current pointer set', env.store['arxave-dig-current'] === 'working');
  check('picker rendered', /working/.test(env.registry['claim-select'].innerHTML));
  check('schema version stamped', c['working'] && c['working'].arxave_claim === 1);
}

console.log('\n2. edits autosave (touchstone text + scout + paydirt)');
{
  const env = fresh();
  const d = env.registry;
  d['add-touchstone'].fire('click');
  const row = d['touchstones-list'].children[0];
  const textInput = row.querySelector('.ts-text');
  textInput.value = 'charge noise in Si/SiGe double dots';
  textInput.fire('input');

  /* #categories is a hidden mirror now — the picker writes it. Add a code the
     way the UI does, through the dropdown. */
  d['cat-add'].value = 'hep-th';
  d['cat-add'].fire('change');
  d['paydirt-n'].value = '25';
  d['paydirt-n'].fire('input');

  const saved = claims(env)['working'];
  check('touchstone text saved', saved.touchstones[0].text === 'charge noise in Si/SiGe double dots',
    JSON.stringify(saved.touchstones));
  check('per-row weight defaults to 1.0 (no stage-2 control; tuned later in the assay rail)',
    saved.touchstones[0].weight === 1.0, JSON.stringify(saved.touchstones));
  check('scout categories saved',
    saved.scout.categories === 'cond-mat.mes-hall, quant-ph, hep-th',
    saved.scout.categories);
  check('paydirt_n saved', saved.blend.paydirt_n === 25);
}

console.log('\n3. save as → new named slot, working slot untouched');
{
  const env = fresh();
  const d = env.registry;
  d['add-touchstone'].fire('click');
  const t = d['touchstones-list'].children[0].querySelector('.ts-text');
  t.value = 'spin qubits'; t.fire('input');

  global.__promptAnswer = 'Spin qubits';
  d['claim-save-as'].fire('click');

  const c = claims(env);
  check('named slot created', !!c['spin-qubits'], JSON.stringify(Object.keys(c)));
  check('name preserved', c['spin-qubits'] && c['spin-qubits'].name === 'Spin qubits');
  check('current now points at it', env.store['arxave-dig-current'] === 'spin-qubits');
  check('working slot still there', !!c['working']);
  check('delete enabled for named claim', d['claim-delete'].disabled === false);

  // Editing now writes into the named slot, not working
  const t2 = d['touchstones-list'].children[0].querySelector('.ts-text');
  t2.value = 'spin qubits and exchange gates'; t2.fire('input');
  const c2 = claims(env);
  check('edit lands in named slot', c2['spin-qubits'].touchstones[0].text === 'spin qubits and exchange gates');
  check('edit did not touch working', c2['working'].touchstones[0].text === 'spin qubits');
  check('name survives autosave', c2['spin-qubits'].name === 'Spin qubits');
}

console.log('\n4. switching claims swaps the whole setup');
{
  /* Semantics under test: autosave always writes the *current* slot, so
     "Save as" moves you into the new claim and later edits belong to it.
     Switching slots must therefore restore the other slot's setup wholesale. */
  const env = fresh();
  const d = env.registry;

  // Claim A: one touchstone, pay dirt 7
  d['add-touchstone'].fire('click');
  let t = d['touchstones-list'].children[0].querySelector('.ts-text');
  t.value = 'alpha'; t.fire('input');
  d['paydirt-n'].value = '7'; d['paydirt-n'].fire('input');
  global.__promptAnswer = 'Alpha';
  d['claim-save-as'].fire('click');

  // Back to the working claim, and build a different setup there
  d['claim-select'].value = 'working';
  d['claim-select'].fire('change');
  // "Save as" forks: the working claim keeps whatever it held at fork time.
  check('working claim kept its pre-fork row', d['touchstones-list'].children.length === 1,
    'got ' + d['touchstones-list'].children.length);

  d['add-touchstone'].fire('click');
  d['add-touchstone'].fire('click');
  d['touchstones-list'].children.forEach(function (row, i) {
    const inp = row.querySelector('.ts-text');
    inp.value = 'beta ' + i; inp.fire('input');
  });
  d['paydirt-n'].value = '3'; d['paydirt-n'].fire('input');

  // Switch back to Alpha — every control must come back
  d['claim-select'].value = 'alpha';
  d['claim-select'].fire('change');

  check('rows rebuilt to 1', d['touchstones-list'].children.length === 1,
    'got ' + d['touchstones-list'].children.length);
  check('row text is alpha',
    d['touchstones-list'].children[0].querySelector('.ts-text').value === 'alpha',
    d['touchstones-list'].children[0].querySelector('.ts-text').value);
  check('paydirt control restored', d['paydirt-n'].value == 7, String(d['paydirt-n'].value));
  check('working claim kept its three rows', claims(env)['working'].touchstones.length === 3,
    JSON.stringify(claims(env)['working'].touchstones));
  check('editing after a switch lands in Alpha', (function () {
    const inp = d['touchstones-list'].children[0].querySelector('.ts-text');
    inp.value = 'alpha edited'; inp.fire('input');
    const c = claims(env);
    return c['alpha'].touchstones[0].text === 'alpha edited' &&
           c['working'].touchstones[1].text === 'beta 1';
  })());
}

console.log('\n5. delete a claim');
{
  const env = fresh();
  const d = env.registry;
  d['add-touchstone'].fire('click');
  global.__promptAnswer = 'Doomed';
  d['claim-save-as'].fire('click');
  global.__confirmAnswer = true;
  d['claim-delete'].fire('click');
  const c = claims(env);
  check('slot gone', !c['doomed'], JSON.stringify(Object.keys(c)));
  check('fell back to working', env.store['arxave-dig-current'] === 'working');
  check('delete disabled on working', d['claim-delete'].disabled === true);
  global.__confirmAnswer = undefined;
}

console.log('\n6. legacy state migrates');
{
  const env = fresh({
    'arxave-dig-touchstones': JSON.stringify([{ id: 'ts-1', text: 'legacy topic' }]),
    'arxave-dig-cores': JSON.stringify([{ id: 'core-1', doi: '10.1103/RevModPhys.95.025003' }]),
  });
  const c = claims(env);
  check('legacy folded into working claim',
    c['working'] && c['working'].touchstones[0].text === 'legacy topic',
    JSON.stringify(c['working']));
  check('legacy core carried', c['working'].cores[0].doi === '10.1103/RevModPhys.95.025003');
  check('legacy keys dropped', env.store['arxave-dig-touchstones'] === undefined);
  check('rows rendered from migrated claim', env.registry['touchstones-list'].children.length === 1);
  check('core parked until pick sharpened',
    /waiting for the pick/.test(env.registry['cores-list'].children[0].querySelector('.row-status').textContent || ''),
    JSON.stringify(env.registry['cores-list'].children[0].querySelector('.row-status').textContent));
}

console.log('\n7. remove a row');
{
  const env = fresh();
  const d = env.registry;
  d['add-touchstone'].fire('click');
  d['add-touchstone'].fire('click');
  let t = d['touchstones-list'].children[0].querySelector('.ts-text');
  t.value = 'first'; t.fire('input');
  t = d['touchstones-list'].children[1].querySelector('.ts-text');
  t.value = 'second'; t.fire('input');
  d['touchstones-list'].children[0].querySelector('.row-remove').fire('click');
  const saved = claims(env)['working'];
  check('one touchstone left', saved.touchstones.length === 1, JSON.stringify(saved.touchstones));
  check('the right one survived', saved.touchstones[0].text === 'second');
  check('DOM row removed', d['touchstones-list'].children.length === 1);
}

console.log('\n8. name collision does not overwrite');
{
  const env = fresh();
  const d = env.registry;
  d['add-touchstone'].fire('click');
  global.__promptAnswer = 'Same Name';
  d['claim-save-as'].fire('click');
  global.__promptAnswer = 'same-name!';   // slugifies to the same thing
  d['claim-save-as'].fire('click');
  const c = claims(env);
  const named = Object.keys(c).filter(function (k) { return k !== 'working'; });
  check('two distinct slots', named.length === 2, JSON.stringify(named));
}

console.log(failures === 0 ? '\nALL PASS\n' : '\n' + failures + ' FAILURE(S)\n');
process.exit(failures === 0 ? 0 : 1);
