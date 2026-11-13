/**
 * `cd scripts && node --test cave-wagon-graph.test.mjs`.
 *
 * The wagon graph is canvas code, so there is no DOM here: a hand-written fake
 * 2D context records every call, a fake canvas records its listeners, and
 * requestAnimationFrame is a queue the test drains frame by frame. That is
 * enough to say the things that go wrong silently — a mount that never paints,
 * a teardown that leaves a loop running, a tooltip that reads out the wrong
 * stone — and nothing more.
 *
 * No jsdom, no dependencies: same as the other cave tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeHtml,
  clusterIds,
  wagonLabel,
  mountWagonGraph,
} from '../docs/assets/cave-wagon-graph.mjs';

/* ── fakes ─────────────────────────────────────────────────────────────── */

/* The 2D context methods the graph actually calls. A missing one is a thrown
   TypeError in the module, so this list is a small contract of its own. */
const CTX_METHODS = [
  'setTransform', 'clearRect', 'fillRect', 'beginPath', 'moveTo', 'lineTo',
  'stroke', 'arc', 'fill', 'save', 'restore', 'translate', 'rotate',
  'strokeRect', 'setLineDash',
];

function fakeCtx() {
  const calls = [];
  const ctx = { calls };
  for (const name of CTX_METHODS) ctx[name] = (...args) => calls.push([name, ...args]);
  return ctx;
}

const BOX = { left: 0, top: 0, width: 640, height: 420, right: 640, bottom: 420 };

function fakeCanvas() {
  const listeners = new Map();
  const ctx = fakeCtx();
  return {
    width: 0,
    height: 0,
    style: {},
    ctx,
    listeners,
    listenerCount: () => listeners.size,
    getContext: (kind) => (kind === '2d' ? ctx : null),
    getBoundingClientRect: () => BOX,
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
  };
}

/** requestAnimationFrame as a queue the test drains, plus what was cancelled. */
function fakeAnimation(t) {
  const queue = [];
  const cancelled = new Set();
  let next = 1;
  const saved = {
    raf: globalThis.requestAnimationFrame,
    caf: globalThis.cancelAnimationFrame,
    dpr: globalThis.devicePixelRatio,
  };
  globalThis.devicePixelRatio = 1;
  globalThis.requestAnimationFrame = (fn) => { queue.push(fn); return next++; };
  globalThis.cancelAnimationFrame = (id) => { cancelled.add(id); };
  t.after(() => {
    globalThis.requestAnimationFrame = saved.raf;
    globalThis.cancelAnimationFrame = saved.caf;
    globalThis.devicePixelRatio = saved.dpr;
  });
  return {
    cancelled,
    frames(n) {
      for (let i = 0; i < n; i++) {
        const fn = queue.shift();
        if (!fn) return i;
        fn();
      }
      return n;
    },
  };
}

/* Click every grid point until one of them pins a stone — a press and release
   without movement is a press on the node under the cursor, and the layout is
   randomised, so the test hunts rather than assuming a coordinate. */
function clickUntilPinned(canvas, reads) {
  const down = canvas.listeners.get('mousedown');
  const up = canvas.listeners.get('mouseup');
  const at = { clientX: 0, clientY: 0 };
  for (let y = 0; y <= BOX.height; y += 5) {
    for (let x = 0; x <= BOX.width; x += 5) {
      at.clientX = x;
      at.clientY = y;
      const before = reads.length;
      down(at);
      up(at);
      const pin = reads.slice(before).find((r) => r.isPinned);
      if (pin) return pin;
    }
  }
  return null;
}

/* ── fixture: tonight's haul, three wagons of four stones ──────────────── */

const GROUPS = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]];

function haul() {
  const n = 12;
  const S = Array.from({ length: n }, () => new Array(n).fill(0.1));
  for (let i = 0; i < n; i++) S[i][i] = 1;
  for (const group of GROUPS) {
    for (const a of group) {
      for (const b of group) if (a !== b) S[a][b] = 0.8;
    }
  }
  const stones = Array.from({ length: n }, (_, i) => ({
    title: `Stone number ${i} on exchange gates`,
    authors: [`Author ${i}`, 'Someone Else'],
    abs_url: `https://arxiv.org/abs/2401.0000${i}`,
    primary_category: 'quant-ph',
  }));
  const components = GROUPS.map((indices) => ({ indices }));
  return { S, stones, components, names: ['Silicon spin qubits', null, 'Tin-vacancy centres'] };
}

/* ── the pure bits ─────────────────────────────────────────────────────── */

test('clusterIds numbers the wagons and leaves the loose stones at -1', () => {
  assert.deepEqual(clusterIds(5, [{ indices: [0, 2] }, { indices: [1] }]), [0, 1, 0, -1, -1]);
  assert.deepEqual(clusterIds(2, []), [-1, -1]);
});

test('a wagon reads out under its name, or its number until it has one', () => {
  const names = ['Silicon spin qubits', null];
  assert.equal(wagonLabel(names, 0), 'Silicon spin qubits');
  assert.equal(wagonLabel(names, 1), 'Wagon 2', 'an unnamed wagon falls back to its number');
  assert.equal(wagonLabel([], 2), 'Wagon 3');
  assert.equal(wagonLabel(undefined, 0), 'Wagon 1');
});

test('the tooltip escapes titles rather than trusting arXiv', () => {
  assert.equal(
    escapeHtml(`<b>"x" & 'y'</b>`),
    '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;',
  );
  assert.equal(escapeHtml(null), '');
});

/* ── mounting ──────────────────────────────────────────────────────────── */

test('there is no graph without a usable canvas', () => {
  const haul0 = haul();
  assert.equal(mountWagonGraph(null, haul0), null);
  assert.equal(mountWagonGraph(undefined, haul0), null);
  assert.equal(mountWagonGraph({}, haul0), null, 'no getContext at all');
  assert.equal(mountWagonGraph({ getContext: () => null }, haul0), null, 'no 2D context');
});

test('twelve stones in three wagons paint, and the frames keep coming', (t) => {
  const anim = fakeAnimation(t);
  const canvas = fakeCanvas();
  const handle = mountWagonGraph(canvas, haul());

  assert.ok(handle, 'a mounted graph returns a handle');
  assert.equal(typeof handle.destroy, 'function');
  assert.equal(typeof handle.stop, 'function', 'the reference name still works');
  assert.equal(canvas.width, 640, 'the backing store is the CSS size at dpr 1');
  assert.equal(canvas.style.width, '640px');
  assert.ok(canvas.ctx.calls.length > 0, 'the first paint happens before any frame');

  /* Twelve stones drawn, and the background filled: a mount that quietly drew
     nothing would still have "some" calls, so count the node fills too. */
  const fills = canvas.ctx.calls.filter((c) => c[0] === 'fill').length;
  assert.ok(fills >= 12, `expected at least 12 node fills, saw ${fills}`);

  const painted = canvas.ctx.calls.length;
  anim.frames(5);
  assert.ok(canvas.ctx.calls.length > painted, 'the animation loop keeps painting');

  handle.unpin();
  handle.reheat();
  handle.setAssay(new Float32Array(12).fill(0.5), [11, 10, 9, 8], 4);
  handle.setAssay(null, null, 0);
  assert.ok(canvas.ctx.calls.length > painted, 'the assay redraws without throwing');

  handle.destroy();
});

test('destroy() takes the listeners off and stops the frames', (t) => {
  const anim = fakeAnimation(t);
  const canvas = fakeCanvas();
  const handle = mountWagonGraph(canvas, haul());

  assert.equal(canvas.listenerCount(), 5, 'mousedown, mousemove, mouseup, mouseleave, wheel');
  anim.frames(2);
  handle.destroy();

  assert.equal(canvas.listenerCount(), 0, 'every listener is off the canvas');
  assert.ok(anim.cancelled.size > 0, 'the pending frame was cancelled');

  const painted = canvas.ctx.calls.length;
  anim.frames(10);
  assert.equal(canvas.ctx.calls.length, painted, 'a queued loop returns without painting');
  assert.doesNotThrow(() => handle.destroy(), 'teardown is idempotent');
});

test('a pointer move over a stone reads out that stone, at the cursor', (t) => {
  const anim = fakeAnimation(t);
  const canvas = fakeCanvas();
  const fx = haul();
  const reads = [];
  const handle = mountWagonGraph(canvas, {
    ...fx,
    readout: (html, isPinned, evt) => reads.push({ html, isPinned, evt }),
  });
  anim.frames(3);

  const move = canvas.listeners.get('mousemove');
  assert.equal(typeof move, 'function');

  /* Sweep the canvas until a node answers. The layout is randomised by design,
     so the test hunts for a stone rather than assuming where one landed; the
     hit radius is a few pixels, so a fine grid is guaranteed to find one. */
  let hit = null;
  let lastEvent = null;
  search:
  for (let y = 0; y <= BOX.height && !hit; y += 5) {
    for (let x = 0; x <= BOX.width; x += 5) {
      lastEvent = { clientX: x, clientY: y };
      move(lastEvent);
      hit = reads.find((r) => /class="tt-title"/.test(r.html) &&
        fx.stones.some((s) => r.html.includes(s.title))) || null;
      if (hit) break search;
    }
  }

  assert.ok(hit, 'hovering a stone produced a readout');
  assert.equal(hit.isPinned, false, 'a hover is not a pin');
  assert.ok(hit.evt, 'the sink needs the event to float its tooltip');
  assert.equal(hit.evt.clientX, lastEvent.clientX);
  assert.equal(hit.evt.clientY, lastEvent.clientY);
  const stone = fx.stones.find((s) => hit.html.includes(s.title));
  assert.ok(hit.html.includes(stone.abs_url), 'the tooltip links the paper');
  assert.ok(hit.html.includes('Author'), 'and names the authors');

  /* The same hover, moved a pixel: the reference's "reposition only" call —
     null html with an event, so the sink follows the cursor without
     rebuilding the tooltip. */
  const before = reads.length;
  move({ clientX: lastEvent.clientX + 1, clientY: lastEvent.clientY + 1 });
  const reposition = reads.slice(before).find((r) => r.html === null);
  assert.ok(reposition, 'a stationary hover did not hand the sink the new cursor point');
  assert.equal(reposition.evt.clientX, lastEvent.clientX + 1);

  /* Pinning is the same gesture, with the button released over the stone. */
  const pin = clickUntilPinned(canvas, reads);
  assert.ok(pin, 'clicking a stone pinned it');
  assert.ok(pin.isPinned);
  assert.ok(pin.evt && Number.isFinite(pin.evt.clientX) && Number.isFinite(pin.evt.clientY),
    'a pinned tooltip parks on the node, so it carries coordinates too');
  assert.ok(
    fx.stones.some((s) => pin.html.includes(s.title)),
    'the pinned tooltip still names the stone',
  );

  handle.destroy();
});

