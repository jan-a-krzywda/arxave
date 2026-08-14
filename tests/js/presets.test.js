/*
 * Presets: which one is selected, and where the feeds are. Run with
 * `node tests/js/presets.test.js`.
 *
 * Covers issue #50 — the selected preset was invisible, every chip carried its
 * own RSS link, and a preset whose feed had not been built yet linked to a 404.
 * Loads the real filter.js against the shim DOM, same as claims.test.js.
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
  'presets-list', 'presets-group', 'presets-hint', 'presets-blurb',
  'preset-feeds', 'preset-feeds-btn', 'preset-feeds-menu',
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

const CATALOGUE = {
  presets: [
    { slug: 'spin-qubits', name: 'Spin qubits', blurb: 'Exchange gates and the noise that limits them.' },
    { slug: 'error-correction', name: 'Quantum error correction', blurb: 'Codes, decoders, thresholds.' },
    { slug: 'brand-new', name: 'Brand new', blurb: 'Added today, never built.' },
  ],
};

/* Two feeds built, one not — the third is the case that used to 404. */
const MANIFEST = {
  built: '2026-08-14',
  feeds: {
    'spin-qubits': { name: 'Spin qubits', items: 3, updated: '2026-08-14' },
    'error-correction': { name: 'Quantum error correction', items: 0, updated: '2026-08-14' },
  },
};

const PRESET_FILE = {
  touchstones: [
    { text: 'exchange gate fidelity in silicon', weight: 1.0 },
    { text: 'singlet-triplet readout', weight: 0.8 },
  ],
};

function fresh() {
  const env = install(IDS);
  const d = env.registry;
  d['categories'].value = 'cond-mat.mes-hall, quant-ph';
  d['lookback'].value = '1';
  d['max-results'].value = '200';
  d['paydirt-n'].value = '10';
  global.fetch = function (url) {
    let body = null;
    if (/presets\/index\.json/.test(url)) body = CATALOGUE;
    else if (/feeds\/index\.json/.test(url)) body = MANIFEST;
    else if (/presets\/[\w-]+\.json/.test(url)) body = PRESET_FILE;
    if (!body) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  (0, eval)(SRC);
  return env;
}

// Let the catalogue and manifest fetches settle.
const settle = () => new Promise((r) => setTimeout(r, 0));

function chips(env) {
  return env.registry['presets-list'].children.filter(
    (c) => c.className.indexOf('preset-btn') !== -1);
}

(async function run() {
  console.log('\n1. chips are one line each, with no RSS link between them');
  {
    const env = fresh();
    await settle(); await settle();
    const list = env.registry['presets-list'];
    check('one chip per catalogue entry', chips(env).length === 3,
      String(list.children.length));
    check('no per-preset RSS link survives',
      list.children.every((c) => c.className.indexOf('preset-feed') === -1));
    check('blurb is not baked into the chip',
      chips(env).every((c) => c.innerHTML.indexOf('Exchange gates') === -1));
  }

  console.log('\n2. the selected preset is marked, and only that one');
  {
    const env = fresh();
    await settle(); await settle();
    const cs = chips(env);
    check('nothing selected before a click',
      cs.every((c) => c.getAttribute('aria-pressed') === 'false'));
    cs[0].fire('click');
    await settle(); await settle();
    check('clicked chip is active', cs[0].classList.contains('is-active'), cs[0].className);
    check('clicked chip is pressed', cs[0].getAttribute('aria-pressed') === 'true');
    check('the others are not', cs.slice(1).every((c) => !c.classList.contains('is-active')));
    check('tick shown, not "edited"',
      cs[0].querySelector('.preset-state').textContent === '✓',
      cs[0].querySelector('.preset-state').textContent);
    check('selected blurb printed once',
      /Exchange gates/.test(env.registry['presets-blurb'].textContent),
      env.registry['presets-blurb'].textContent);
  }

  console.log('\n3. editing a row marks the preset edited, not unselected');
  {
    const env = fresh();
    await settle(); await settle();
    const cs = chips(env);
    cs[0].fire('click');
    await settle(); await settle();

    const row = env.registry['touchstones-list'].children[0];
    const input = row.querySelector('.ts-text');
    input.value = 'exchange gate fidelity in germanium';
    input.fire('input');
    check('still the selected preset', cs[0].classList.contains('is-active'));
    check('marked edited', cs[0].classList.contains('is-edited'), cs[0].className);
    check('state reads "edited"',
      cs[0].querySelector('.preset-state').textContent === 'edited',
      cs[0].querySelector('.preset-state').textContent);

    // Clearing every row's provenance drops the selection altogether.
    const row2 = env.registry['touchstones-list'].children[1];
    const input2 = row2.querySelector('.ts-text');
    input2.value = 'anything else';
    input2.fire('input');
    check('no preset once every row is the user\'s',
      !cs[0].classList.contains('is-active'), cs[0].className);
    check('blurb line cleared', env.registry['presets-blurb'].textContent === '');
  }

  console.log('\n4. one feeds menu, and it never offers an unbuilt feed');
  {
    const env = fresh();
    await settle(); await settle();
    const menu = env.registry['preset-feeds-menu'];
    const rows = menu.children;
    check('a row per catalogue entry', rows.length === 3, String(rows.length));
    check('built feeds are links', rows[0].tagName === 'a' && rows[1].tagName === 'a',
      rows.map((r) => r.tagName).join(','));
    check('unbuilt feed is not a link', rows[2].tagName !== 'a', rows[2].tagName);
    check('unbuilt feed says so', /builds tonight/.test(rows[2].innerHTML), rows[2].innerHTML);
    check('empty feed is offered but honest about it',
      /nothing today/.test(rows[1].innerHTML), rows[1].innerHTML);
    check('count shown for a feed with items', /3 today/.test(rows[0].innerHTML), rows[0].innerHTML);
    check('menu starts closed', menu.style.display === 'none', menu.style.display);
    check('the control is shown once a feed exists',
      env.registry['preset-feeds'].style.display === '');

    const btn = env.registry['preset-feeds-btn'];
    btn.fire('click', { stopPropagation: function () {} });
    check('button opens the menu', menu.style.display === '', menu.style.display);
    check('expanded state announced', btn.getAttribute('aria-expanded') === 'true');
    btn.fire('click', { stopPropagation: function () {} });
    check('button closes it again', menu.style.display === 'none');
  }

  console.log(failures ? `\n${failures} FAILED\n` : '\nAll passed\n');
  process.exit(failures ? 1 : 0);
})();
