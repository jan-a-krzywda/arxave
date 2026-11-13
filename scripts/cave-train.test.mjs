/**
 * `cd scripts && node --test cave-train.test.mjs`.
 *
 * The train is canvas code, so there is no DOM to lean on: the file below is a
 * fake canvas whose 2D context records every `fillRect` (colour included) and a
 * fake clock that owns `requestAnimationFrame`. That makes the two claims that
 * matter checkable without a browser — an idle train draws pixels but no
 * stones, a half-full haul draws stones (gold among the rock) — and it keeps
 * the animation deterministic: `performance.now()` is the frame counter, not
 * wall time, so "advance 60 frames" means the same thing on every machine.
 *
 * `startHaulTrain` reads its host globals off `globalThis` in Node (see the
 * module header); each harness installs stubs and restores the real globals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TRAIN, trainStoneGold, startHaulTrain } from '../docs/assets/cave-train.mjs';

/* Palette entries the train uses only for stones: the 1×1 lit pixel of each. */
const GOLD_LIT = '#ffd45e';
const ROCK_LIT = '#5e564a';

/**
 * A fake canvas plus a manual `requestAnimationFrame`.
 *
 * `advance(n, ms)` fires the frames scheduled so far, moving the fake clock
 * `ms` on first, and leaves anything a callback schedules for the next advance
 * (so a loop that stops stops growing the queue).
 */
function harness({ width = 480, dpr = 1, reduced = false } = {}) {
  const ctx = {
    fillStyle: '',
    imageSmoothingEnabled: true,
    fills: [],
    setTransform() {},
    clearRect() {},
    fillRect(x, y, w, h) { this.fills.push({ x, y, w, h, color: this.fillStyle }); },
  };
  const canvas = {
    style: {},
    width: 0,
    height: 0,
    clientWidth: width,
    parentNode: null,
    getContext: (kind) => (kind === '2d' ? ctx : null),
  };

  const env = { time: 0, frames: new Map(), nextId: 0, scheduled: 0, cancelled: 0 };

  const saved = new Map();
  const put = (key, value) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  put('requestAnimationFrame', (cb) => {
    env.scheduled += 1;
    env.nextId += 1;
    env.frames.set(env.nextId, cb);
    return env.nextId;
  });
  put('cancelAnimationFrame', (id) => { env.cancelled += 1; env.frames.delete(id); });
  put('performance', { now: () => env.time * 1000 });
  put('devicePixelRatio', dpr);
  put('matchMedia', reduced ? (q) => ({ matches: /reduce/.test(q) }) : undefined);

  return {
    canvas,
    ctx,
    /** Frame queue length: what the train has asked for and not drawn yet. */
    pending: () => env.frames.size,
    scheduled: () => env.scheduled,
    cancelled: () => env.cancelled,
    advance(frames = 1, ms = 50) {
      for (let f = 0; f < frames; f++) {
        env.time += ms;
        const due = [...env.frames.values()];
        env.frames.clear();
        for (const cb of due) cb(env.time);
      }
    },
    restore() {
      for (const [key, desc] of saved) {
        if (desc) Object.defineProperty(globalThis, key, desc);
        else delete globalThis[key];
      }
    },
  };
}

/** Stones drawn: each is a 2×2 body plus a 1×1 lit highlight. */
const stoneCount = (fills) => fills.filter((r) => r.color === GOLD_LIT || r.color === ROCK_LIT).length;

test('startHaulTrain returns null without a usable canvas', () => {
  assert.equal(startHaulTrain(null), null);
  assert.equal(startHaulTrain(undefined), null);
  assert.equal(startHaulTrain({}), null, 'no getContext at all');
  assert.equal(startHaulTrain({ getContext: () => null }), null, 'context refused');
});

test('an idle train draws the picture but no stones', () => {
  const h = harness();
  try {
    const train = startHaulTrain(h.canvas);
    assert.ok(train, 'mounts on a 2D canvas');
    assert.equal(typeof train.set, 'function');
    assert.equal(typeof train.stop, 'function');

    train.set(0, 200);
    h.advance(1);

    assert.ok(h.ctx.fills.length > 0, 'the engine and track are painted');
    assert.equal(stoneCount(h.ctx.fills), 0, 'nothing has landed yet');
    assert.ok(h.canvas.width > 0 && h.canvas.height > 0, 'canvas sized to the art grid');
    assert.equal(h.canvas.height, Math.round(TRAIN.ART_H * 3 * 1), 'default 3× art pixels');
  } finally {
    h.restore();
  }
});

test('set(100,200) draws stones, gold among them, and more load than at 0', () => {
  const h = harness();
  try {
    const train = startHaulTrain(h.canvas);

    train.set(0, 200);
    h.advance(1);
    const empty = h.ctx.fills.length;
    const emptyStones = stoneCount(h.ctx.fills);

    h.ctx.fills.length = 0;
    train.set(100, 200);
    h.advance(60);             // the stones land one by one, then settle
    h.ctx.fills.length = 0;
    h.advance(1);              // one steady-state frame

    assert.ok(h.ctx.fills.length > empty, 'the loaded train paints more than the idle one');
    assert.ok(stoneCount(h.ctx.fills) > emptyStones, 'half a haul shows stones');

    const gold = h.ctx.fills.filter((r) => r.color === GOLD_LIT).length;
    const rock = h.ctx.fills.filter((r) => r.color === ROCK_LIT).length;
    assert.ok(gold > 0, 'some stones came up gold');
    assert.ok(rock > 0, 'most stones are dull rock');

    /* 200 papers is 10 carts of 6 (480 px column, 3× pixels), and half of that
       capacity is 30 stones — the haul loads exactly that many, each as one
       2×2 body plus one 1×1 highlight. */
    assert.equal(stoneCount(h.ctx.fills), 30);
    assert.equal(gold + rock, 30);
  } finally {
    h.restore();
  }
});

test('stop() stops asking for frames', () => {
  const h = harness();
  try {
    const train = startHaulTrain(h.canvas);
    train.set(1, 200);         // mid-haul: the loop keeps animating
    h.advance(3);
    assert.ok(h.pending() > 0, 'a mid-haul train wants the next frame');

    const before = h.scheduled();
    train.stop();
    assert.equal(h.pending(), 0, 'the pending frame is cancelled');

    h.advance(5);
    assert.equal(h.scheduled(), before, 'nothing new was scheduled after stop()');
  } finally {
    h.restore();
  }
});

test('trainStoneGold is deterministic and about a fifth of the stones are gold', () => {
  for (let i = 0; i < 1000; i += 37) {
    assert.equal(trainStoneGold(i), trainStoneGold(i), `slot ${i} has one colour`);
    assert.equal(typeof trainStoneGold(i), 'boolean');
  }

  let gold = 0;
  for (let i = 0; i < 1000; i++) if (trainStoneGold(i)) gold += 1;
  assert.ok(gold >= 150 && gold <= 300, `gold stones: ${gold}/1000 (want 15%..30%)`);
});

