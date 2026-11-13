/**
 * `cd scripts && node --test cave-wagon-views.test.mjs`.
 *
 * The HTML builders and the naming client are the two places in the wagon map
 * that can be wrong without throwing: a table that drops a wagon still renders
 * something plausible, and a badly keyed name renders nothing at all and just
 * costs money. So these are assertions about structure and about the bytes on
 * the wire, not snapshots.
 *
 * No jsdom, no network: the builders return strings, and `nameWagons` takes a
 * fake fetch that records what it was asked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LONE_COLOR,
  nameWagons, topCategory, trainStripHtml, wagonKey, wagonLabel,
  wagonTableHtml, wagonTipHtml, wireTrainStrip,
} from '../docs/assets/cave-wagon-views.mjs';

/* Four stones, hand-written: two in wagon 1, one in wagon 2, one lone. The
   first title carries `<`, `>` and `&` on purpose — arXiv titles are untrusted
   input into innerHTML. */
const STONES = [
  {
    arxiv_id: '2608.01234',
    title: 'Valley <splitting> in Si/SiGe & wells',
    authors: ['Duarte, A. H.', 'Moises Alvarez'],
    primary_category: 'cond-mat.mes-hall',
    abs_url: 'https://arxiv.org/abs/2608.01234',
  },
  {
    arxiv_id: '2608.05678',
    title: 'Charge noise in silicon double quantum dots',
    authors: ['L\\"uders, J.'],
    primary_category: 'cond-mat.mes-hall',
    abs_url: 'https://arxiv.org/abs/2608.05678',
  },
  {
    arxiv_id: '2608.09012',
    title: 'A theorem about anything',
    authors: ['Solo, A.'],
    primary_category: 'quant-ph',
    abs_url: 'https://arxiv.org/abs/2608.09012',
  },
  {
    arxiv_id: '2608.09999',
    title: 'Late stone',
    authors: ['Nobody'],
    primary_category: 'quant-ph',
    abs_url: 'https://arxiv.org/abs/2608.09999',
  },
];

/* Wagon 0 holds stones 0 and 1; wagon 1 holds stone 2; stone 3 is lone. */
const COMPONENTS = [{ indices: [0, 1] }, { indices: [2] }];

test('the table has one block per component, in order, plus the lone flatcar', () => {
  const html = wagonTableHtml({ stones: STONES, components: COMPONENTS });

  assert.equal((html.match(/class="wagon-table-block"/g) || []).length, 3);
  const at0 = html.indexOf('id="wagon-block-0"');
  const at1 = html.indexOf('id="wagon-block-1"');
  const atLone = html.indexOf('id="wagon-block-lone"');
  assert.ok(at0 >= 0 && at0 < at1 && at1 < atLone, 'blocks are in component order, lone last');

  // Same markup as the reference: the table's own class and its three columns.
  assert.match(html, /<table class="wagon-table"><thead><tr><th>Title<\/th><th>Authors<\/th><th>Category<\/th>/);
  assert.match(html, /<span class="wagon-table-count">2 stones<\/span>/);
  assert.match(html, /<span class="wagon-table-count">1 stones<\/span>/);
  assert.match(html, /class="wagon-td-authors" title="Duarte, A. H., Moises Alvarez">/);
  assert.match(html, /<div class="wagon-authors-scroll">A. H. Duarte, M. Alvarez<\/div>/);
  assert.match(html, /<span class="wagon-swatch" style="background:#f5b301"><\/span>/);
  assert.ok(html.includes('background:' + LONE_COLOR), 'the lone table wears the lone colour');
});

test('names replace the numbers; a null leaves the reference fallback', () => {
  const unnamed = wagonTableHtml({ stones: STONES, components: COMPONENTS });
  assert.match(unnamed, /<span class="wagon-table-name">Wagon 1<\/span>/);
  assert.match(unnamed, /<span class="wagon-table-name">Wagon 2<\/span>/);
  assert.match(unnamed, /<span class="wagon-table-name">Lone stones<\/span>/);

  const named = wagonTableHtml({
    stones: STONES, components: COMPONENTS, names: ['Silicon qubits', null],
  });
  assert.match(named, /<span class="wagon-table-name">Silicon qubits<\/span>/);
  assert.match(named, /<span class="wagon-table-name">Wagon 2<\/span>/);
  assert.doesNotMatch(named, />Wagon 1</);
});

test('titles and authors are escaped in the body and in the title attributes', () => {
  const html = wagonTableHtml({ stones: STONES, components: COMPONENTS });
  assert.match(html, /Valley &lt;splitting&gt; in Si\/SiGe &amp; wells/);
  assert.doesNotMatch(html, /Valley <splitting>/);
  // The full author list reaches the tooltip; the TeX accent does not.
  assert.match(html, /title="Luders, J."/);
  assert.match(html, /<div class="wagon-authors-scroll">J. Luders<\/div>/);
});

test('centrality orders each wagon and appears as a column only when given', () => {
  const stones = STONES.slice(0, 3);
  /* Stone 1 is the most like the rest of its wagon, stone 2 the least. */
  const central = [
    [1, 0.9, 0.1],
    [0.9, 1, 0.8],
    [0.1, 0.8, 1],
  ];

  const plain = wagonTableHtml({ stones, components: [{ indices: [0, 1, 2] }] });
  assert.doesNotMatch(plain, /Centrality/);
  assert.ok(plain.indexOf('Valley') < plain.indexOf('Charge noise'), 'no matrix, no reordering');

  const ranked = wagonTableHtml({ stones, components: [{ indices: [0, 1, 2] }], central });
  assert.match(ranked, /<th>Centrality<\/th>/);
  assert.ok(
    ranked.indexOf('Charge noise') < ranked.indexOf('Valley') &&
    ranked.indexOf('Valley') < ranked.indexOf('A theorem'),
    'rows run from most central to least (0.850, 0.500, 0.450)',
  );
  assert.match(ranked, /<td class="num">0\.850<\/td>/);
});

test('an empty haul still says so', () => {
  assert.equal(
    wagonTableHtml({ stones: [], components: [] }),
    '<p class="hint">No stones to show.</p>',
  );
});


test('the strip draws one wagon per component, widths in proportion to size', () => {
  const html = trainStripHtml({
    stones: STONES, components: COMPONENTS, names: ['Silicon qubits', null],
  });

  assert.equal((html.match(/class="train-wagon"/g) || []).length, 2);
  assert.equal((html.match(/class="train-wagon is-lone"/g) || []).length, 1);
  assert.match(html, /^<span class="train-loco" aria-hidden="true"><\/span>/);
  assert.match(html, /data-wagon="0" style="flex-grow:2;background:#f5b301"/);
  assert.match(html, /aria-label="Silicon qubits — 2 stones"><span class="train-wagon-n">2<\/span>/);
  assert.match(html, /aria-label="Wagon 2 — 1 stones"><span class="train-wagon-n">1<\/span>/);
  assert.match(html, /data-wagon="lone" style="flex-grow:1;background:#6c6355"/);
  assert.match(html, /aria-label="Lone stones — 1 stones"/);
  assert.equal(LONE_COLOR, '#6c6355');

  /* Width is flex-grow with flex-basis 0 (filter.css), so the shares are the
     counts over the haul and they fill the strip exactly. */
  const grows = [...html.matchAll(/flex-grow:(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(grows, [2, 1, 1]);
  const total = grows.reduce((a, b) => a + b, 0);
  const widths = grows.map((g) => (g / total) * 100);
  assert.deepEqual(widths, [50, 25, 25]);
  assert.equal(Math.round(widths.reduce((a, b) => a + b, 0)), 100);

  // No stones, no strip — the reference clears the element rather than drawing a loco.
  assert.equal(trainStripHtml({ stones: [], components: [] }), '');
});

test('the tooltip counts the haul and names the wagon main category', () => {
  const tip = wagonTipHtml({
    name: 'Silicon qubits',
    members: [0, 1],
    stones: STONES,
    total: 4,
    central: 'Charge noise in silicon double quantum dots',
    gloss: 'silicon spin qubits',
  });
  assert.match(tip, /^<div class="tt-title">Silicon qubits<\/div>/);
  assert.match(tip, /<div class="tt-row">2 stones · 50% of the haul · mostly cond-mat\.mes-hall<\/div>/);
  assert.match(tip, /<div class="tt-row tt-gloss">silicon spin qubits<\/div>/);
  assert.match(tip, /<div class="tt-row tt-central">Charge noise in silicon double quantum dots<\/div>/);

  // The lone flatcar has no central title and no gloss.
  const lone = wagonTipHtml({ name: 'Lone stones', members: [3], stones: STONES, total: 4 });
  assert.doesNotMatch(lone, /tt-central|tt-gloss/);
  assert.match(lone, /1 stones · 25% of the haul · mostly quant-ph/);

  assert.equal(topCategory([0, 1], STONES), 'cond-mat.mes-hall');
  assert.equal(topCategory([0, 1, 2, 3], STONES), 'cond-mat.mes-hall'); // 2:2, first to reach 2
  assert.equal(topCategory([], STONES), '');
  assert.equal(wagonLabel(['x', null], 0), 'x');
  assert.equal(wagonLabel(['x', null], 1), 'Wagon 2');
  assert.equal(wagonLabel(undefined, 3), 'Wagon 4');
});

test('nameWagons posts the contract body and maps the reply onto components', async () => {
  const key0 = await wagonKey([0, 1], STONES);
  const key1 = await wagonKey([2], STONES);
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ names: { [key0]: { name: 'Silicon qubits', gloss: 'unused' } }, keys: [key0, key1] }),
    };
  };

  const names = await nameWagons({
    url: 'https://example.test/wagon-name',
    stones: STONES,
    components: COMPONENTS,
    fetchImpl,
  });

  assert.deepEqual(names, ['Silicon qubits', null]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://example.test/wagon-name');
  assert.equal(seen[0].init.method, 'POST');
  assert.deepEqual(seen[0].init.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(seen[0].init.body), {
    wagons: [
      {
        members: [
          { id: '2608.01234', title: 'Valley <splitting> in Si/SiGe & wells' },
          { id: '2608.05678', title: 'Charge noise in silicon double quantum dots' },
        ],
      },
      { members: [{ id: '2608.09012', title: 'A theorem about anything' }] },
    ],
  });

  // Nothing to name is not a request.
  const uncalled = await nameWagons({ url: 'u', stones: STONES, components: [], fetchImpl });
  assert.deepEqual(uncalled, []);
  assert.equal(seen.length, 1);
});

test('a failed naming request rejects with the endpoint own words', async () => {
  await assert.rejects(
    nameWagons({
      url: 'https://example.test/wagon-name',
      stones: STONES,
      components: COMPONENTS,
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: 'budget spent' }) }),
    }),
    /budget spent/,
  );
  await assert.rejects(
    nameWagons({
      url: 'https://example.test/wagon-name',
      stones: STONES,
      components: COMPONENTS,
      fetchImpl: async () => ({ ok: false, status: 502, json: async () => { throw new Error('no body'); } }),
    }),
    /HTTP 502/,
  );
  await assert.rejects(nameWagons({ stones: STONES, components: COMPONENTS }), /needs a url/);
});


test('more wagons than the endpoint will name: the biggest go, the rest stay null', async () => {
  const components = [{ indices: [3] }, { indices: [0, 1] }, { indices: [2] }];
  const key = await wagonKey([0, 1], STONES);
  let posted;
  const names = await nameWagons({
    url: 'u',
    stones: STONES,
    components,
    maxWagons: 2,
    fetchImpl: async (_url, init) => {
      posted = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ names: { [key]: { name: 'Silicon qubits' } } }) };
    },
  });

  assert.equal(posted.wagons.length, 2);
  assert.equal(posted.wagons[0].members.length, 2, 'the pair is the biggest and goes first');
  assert.deepEqual(posted.wagons[0].members.map((m) => m.id), ['2608.01234', '2608.05678']);
  assert.deepEqual(names, [null, 'Silicon qubits', null], 'names stay parallel to components');
});

test('a wagon key ignores member order, changes with the members, and matches the golden digest', async () => {
  assert.equal(await wagonKey([0, 1], STONES), await wagonKey([1, 0], STONES));
  assert.notEqual(await wagonKey([0, 1], STONES), await wagonKey([0], STONES));
  assert.notEqual(await wagonKey([0, 1], STONES), await wagonKey([0, 2], STONES));

  /* The whitespace is the point, and the digest is pinned on the other side by
     supabase/functions/wagon-name/naming.ts: two spaces and a newline collapse
     to one, and a trailing space goes, before the hash. */
  const dirty = [
    { arxiv_id: ' 2608.01234 ', title: 'Valley  splitting in\nSi/SiGe quantum wells ' },
    { arxiv_id: '2608.05678', title: 'Charge noise in silicon double quantum dots' },
  ];
  assert.equal(
    await wagonKey([1, 0], dirty),
    '0cf357c0a944ef663d75fd37e3acd4fc8978aa386e05f90ea2a33e3725b578fb',
  );
});

test('hover fills the tooltip, moves it inside the window, and click hands over the key', () => {
  /* The smallest fake DOM the wiring touches: handlers, inline style, width. */
  function fakeEl() {
    const on = {};
    return {
      innerHTML: '',
      style: {},
      offsetWidth: 260,
      addEventListener(type, fn) { (on[type] || (on[type] = [])).push(fn); },
      fire(type, event) { for (const fn of on[type] || []) fn(event); },
    };
  }
  function wagonButton(key) {
    const el = {
      closest: (sel) => (sel === '.train-wagon' ? el : null),
      getAttribute: (name) => (name === 'data-wagon' ? key : null),
    };
    return el;
  }

  const strip = fakeEl();
  const tip = fakeEl();
  const picked = [];
  globalThis.window = { innerWidth: 1200 };
  try {
    wireTrainStrip(strip, tip, {
      stones: STONES,
      components: COMPONENTS,
      names: ['Silicon qubits', null],
      onPick: (key) => picked.push(key),
    });

    strip.fire('mousemove', { target: wagonButton('0'), clientX: 100, clientY: 50 });
    assert.match(tip.innerHTML, /Silicon qubits/);
    assert.match(tip.innerHTML, /2 stones · 50% of the haul/);
    assert.equal(tip.style.display, '');
    assert.equal(tip.style.left, '114px');
    assert.equal(tip.style.top, '66px');

    strip.fire('mousemove', { target: wagonButton('lone'), clientX: 1100, clientY: 10 });
    assert.match(tip.innerHTML, /Lone stones/);
    assert.equal(tip.style.left, '932px', 'clamped to the right edge, 8px in');

    strip.fire('mousemove', { target: { closest: () => null } });
    assert.equal(tip.style.display, 'none', 'off a wagon, the tooltip goes');

    strip.fire('click', { target: wagonButton('1') });
    assert.deepEqual(picked, ['1']);
    assert.equal(tip.style.display, 'none');

    // Wiring a page with no strip or no tip is a no-op, not a crash.
    wireTrainStrip(null, tip, {});
    wireTrainStrip(strip, null, {});
  } finally {
    delete globalThis.window;
  }
});

