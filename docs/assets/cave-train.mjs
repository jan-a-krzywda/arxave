/**
 * cave-train — the haul mine train, lifted out of `filter.js` unchanged.
 *
 * Stage 1's progress read-out is a pixel-art mine train instead of a bar.
 * A bar says how far along the haul is; the train says that and two
 * things a bar cannot — how big the night is (one cart per six papers, so
 * a fat announcement pulls a longer train) and how much of it is worth
 * carrying up (stones drop in as the abstracts come back, mostly dull
 * rock, gold now and then).
 *
 * Drawn on an integer art grid so it is as blocky as the cave walls in
 * the gutters: the canvas transform is set to `scale` art-pixels per CSS
 * pixel and every rect below is in whole art pixels.
 *
 * The reference read its host globals off `window`; here `win` resolves to
 * `window` in the browser (where `globalThis` *is* `window`) and to
 * `globalThis` in a plain Node test, which is the only difference.
 */

export const TRAIN = {
  ART_H: 26,       // art rows: chimney smoke at the top, sleepers at the bottom
  RAIL_Y: 21,      // the row the wheels rest on
  ENG_W: 20,
  CART_W: 14,      // 12 of body + 2 of coupling gap
  CART_CAP: 6,     // stones per cart: 3 across, 2 deep
  MIN_CARTS: 3,
  SCROLL: 15,      // art px/s the track slides under a standing train
};

// Cave palette, pre-resolved — canvas can't read var().
const TRAIN_C = {
  tie: '#2a3038', rail: '#4a525e',
  iron: '#39414d', ironLit: '#525c6a', ironDark: '#1b1f26',
  wheel: '#2b313a', hub: '#6d7682',
  glass: '#b98a08', lamp: '#f5b301',
  hold: '#15181d',                        // unlit cart interior
  rock: '#3f3a33', rockLit: '#5e564a',    // dull stone, warm against the iron
  gold: '#f5b301', goldLit: '#ffd45e',
};

/* Which stones came up gold. Hashed off the slot index rather than rolled,
   so a stone keeps its colour across sixty redraws a second. */
export function trainStoneGold(i) {
  return (((i + 1) * 2654435761) >>> 0) % 100 < 22;
}

/**
 * Mount the train on `canvas`. Returns a handle:
 *   .set(done, total)  — done abstracts of total; relays the train when
 *                        the total changes, then fills toward done/total
 *   .stop()            — cancel the animation frame; call when the wrap hides
 * Returns null where there is no canvas to draw on (the test DOM shim).
 */
export function startHaulTrain(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  var ctx = canvas.getContext('2d');
  if (!ctx) return null;

  var win = typeof window !== 'undefined' ? window : globalThis;
  var dpr = win.devicePixelRatio || 1;
  var still = !!(win.matchMedia &&
    win.matchMedia('(prefers-reduced-motion: reduce)').matches);

  var scale = 3, artW = 0, carts = TRAIN.MIN_CARTS, capacity = carts * TRAIN.CART_CAP;
  var laidOutFor = -1; // the total the current train length was built for
  var target = 0;      // stones the haul has earned
  var shown = 0;       // stones drawn, chasing target so they land one by one
  var shownF = 0;      // …carried as a float, so a slow frame still lands the tail
  var lastDrop = -99;  // when the newest stone started falling
  var t = 0, prev = 0, raf = 0, alive = true;
  var puffs = [];
  var nextPuff = 0;

  function now() { return (win.performance || Date).now() / 1000; }

  /* Cart count follows the day's size, but the train has to fit the column:
     chunky 3× pixels first, 2× only when that is what buys the full train. */
  function relayout(total) {
    /* Measure the wrap, not the canvas: relayout pins the canvas to an
       exact pixel width, so measuring itself would ratchet the train
       shorter every time it is called. */
    var avail = Math.max(200,
      (canvas.parentNode && canvas.parentNode.clientWidth) || canvas.clientWidth || 480);
    var want = Math.max(TRAIN.MIN_CARTS, Math.ceil(total / TRAIN.CART_CAP));
    function fits(s) {
      return Math.floor((avail / s - TRAIN.ENG_W) / TRAIN.CART_W);
    }
    scale = (fits(3) < want && fits(2) >= want) ? 2 : 3;
    carts = Math.max(TRAIN.MIN_CARTS, Math.min(want, Math.max(TRAIN.MIN_CARTS, fits(scale))));
    capacity = carts * TRAIN.CART_CAP;
    artW = TRAIN.ENG_W + carts * TRAIN.CART_W;

    canvas.width = Math.round(artW * scale * dpr);
    canvas.height = Math.round(TRAIN.ART_H * scale * dpr);
    canvas.style.width = (artW * scale) + 'px';
    canvas.style.height = (TRAIN.ART_H * scale) + 'px';
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }

  function px(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  }

  /* A dark tyre with a lit rim, and one spoke pixel walking around the hub
     — at four pixels across that is the whole vocabulary a wheel gets, and
     the walking pixel is what makes it read as turning rather than sliding. */
  function wheel(x, y, size, phase) {
    var e = size - 1;
    px(x, y, size, size, TRAIN_C.wheel);
    px(x + 1, y, e - 1, 1, TRAIN_C.rail);
    px(x + 1, y + e, e - 1, 1, TRAIN_C.rail);
    px(x, y + 1, 1, e - 1, TRAIN_C.rail);
    px(x + e, y + 1, 1, e - 1, TRAIN_C.rail);
    var spoke = size > 3
      ? [[1, 1], [2, 1], [2, 2], [1, 2]]
      : [[1, 0], [2, 1], [1, 2], [0, 1]];
    var s = spoke[Math.floor(phase * 4) % 4];
    px(x + s[0], y + s[1], 1, 1, TRAIN_C.hub);
  }

  function drawEngine(ex, yb, phase) {
    wheel(ex + 2, yb - 3, 4, phase);
    wheel(ex + 9, yb - 3, 4, phase);
    px(ex, yb - 5, 19, 2, TRAIN_C.iron);            // chassis
    px(ex + 1, yb - 12, 12, 7, TRAIN_C.iron);       // boiler
    px(ex + 1, yb - 12, 12, 1, TRAIN_C.ironLit);
    px(ex, yb - 11, 1, 5, TRAIN_C.ironLit);         // front plate
    px(ex + 2, yb - 16, 3, 4, TRAIN_C.iron);        // chimney
    px(ex + 1, yb - 16, 5, 1, TRAIN_C.ironLit);
    px(ex + 8, yb - 14, 2, 2, TRAIN_C.ironLit);     // steam dome
    px(ex + 13, yb - 15, 6, 10, TRAIN_C.iron);      // cab
    px(ex + 12, yb - 16, 8, 1, TRAIN_C.ironLit);    // roof
    px(ex + 15, yb - 13, 3, 3, TRAIN_C.glass);      // lit window
    px(ex - 1, yb - 10, 2, 2, TRAIN_C.lamp);        // headlamp
  }

  function drawCart(cx, yb, phase, firstSlot) {
    wheel(cx + 2, yb - 2, 3, phase);
    wheel(cx + 7, yb - 2, 3, phase);
    px(cx, yb - 11, 12, 9, TRAIN_C.iron);           // tub
    px(cx, yb - 11, 12, 1, TRAIN_C.ironLit);        // lit rim
    px(cx + 1, yb - 10, 10, 7, TRAIN_C.hold);       // the hold itself
    px(cx + 12, yb - 7, 2, 1, TRAIN_C.iron);        // coupling

    for (var s = 0; s < TRAIN.CART_CAP; s++) {
      var idx = firstSlot + s;
      if (idx >= shown) break;
      var col = [2, 5, 8][s % 3];
      var row = s < 3 ? yb - 5 : yb - 8;            // bottom row loads first
      /* The newest stone falls the last few pixels into its slot — from the
         rim, not above it, so it never reads as floating beside the cart. */
      var drop = 0;
      if (idx === shown - 1) {
        var p = (t - lastDrop) / 0.18;
        if (p < 1) drop = -Math.round((1 - Math.max(0, p)) * (row - (yb - 10)));
      }
      var gold = trainStoneGold(idx);
      px(cx + col, row + drop, 2, 2, gold ? TRAIN_C.gold : TRAIN_C.rock);
      px(cx + col, row + drop, 1, 1, gold ? TRAIN_C.goldLit : TRAIN_C.rockLit);
    }
  }

  function frame() {
    if (!alive) return;
    var n = now();
    var elapsed = prev ? n - prev : 0.016;
    // The wheels and the scrolling track want a clamped step, or a frame the
    // browser skipped turns into a jump. The load does not — see below.
    var dt = Math.min(0.05, elapsed);
    prev = n;
    t += dt;

    /* Stones land at a readable rate rather than snapping to the count, but
       the rate is per second, not per frame: the gap decays by a fixed
       factor of e⁻⁷ per second whatever the frame delivery. Frames are
       exactly what goes short here — the main thread is busy embedding while
       the haul runs, and a backgrounded tab gets a frame a second — and a
       per-frame step left the train stuck at a third of a load it had
       already earned. */
    if (shownF < target) {
      shownF = still ? target : target - (target - shownF) * Math.exp(-7 * elapsed);
      if (target - shownF < 0.5) shownF = target;
      var next = Math.min(target, Math.ceil(shownF));
      if (next !== shown) { shown = next; lastDrop = t; }
    } else if (shownF > target) {
      shownF = shown = target;   // a re-haul empties the carts
    }

    var moving = shown < capacity;
    var yb = TRAIN.RAIL_Y;
    var bob = moving && !still && Math.floor(t * 5) % 2 ? 1 : 0;
    var phase = still ? 0 : (moving ? t * 1.6 : 0);

    ctx.clearRect(0, 0, artW, TRAIN.ART_H);

    // Track. The train stands still and the sleepers run under it — the
    // alternative is a train that leaves the canvas.
    px(0, yb + 1, artW, 1, TRAIN_C.rail);
    var off = still || !moving ? 0 : Math.floor(t * TRAIN.SCROLL) % 7;
    for (var x = -7 + (7 - off); x < artW; x += 7) px(x, yb + 3, 4, 2, TRAIN_C.tie);

    // Smoke, only while there is still coal to burn.
    if (moving && !still) {
      if (t > nextPuff) {
        puffs.push({ x: TRAIN.ENG_W - 16, y: yb - 17, age: 0 });
        nextPuff = t + 0.42;
      }
      for (var i = puffs.length - 1; i >= 0; i--) {
        var p = puffs[i];
        p.age += dt;
        p.x -= 5 * dt; p.y -= 4.5 * dt;
        if (p.age > 1.4 || p.y < -3) { puffs.splice(i, 1); continue; }
        var size = 1 + Math.floor(p.age * 2.2);
        ctx.fillStyle = 'rgba(153,161,173,' + (0.42 * (1 - p.age / 1.4)).toFixed(3) + ')';
        ctx.fillRect(Math.round(p.x), Math.round(p.y), size, size);
      }
    }

    drawEngine(2, yb - bob, phase);
    for (var c = 0; c < carts; c++) {
      drawCart(TRAIN.ENG_W + c * TRAIN.CART_W, yb - bob, phase, c * TRAIN.CART_CAP);
    }

    // A loaded train stands still, and so does a reduced-motion one: stop
    // asking for frames rather than repainting an unchanging picture.
    if ((still || !moving) && shown === target) { raf = 0; return; }
    raf = win.requestAnimationFrame(frame);
  }

  function set(done, total) {
    total = total || 0;
    if (total !== laidOutFor) {
      laidOutFor = total;
      relayout(total);              // relayout clamps the length to the column
      if (shown > capacity) shownF = shown = capacity;
    }
    target = total > 0 ? Math.min(capacity, Math.round((done / total) * capacity)) : 0;
    if (!raf) { prev = 0; raf = win.requestAnimationFrame(frame); }
  }

  relayout(0);
  raf = win.requestAnimationFrame(frame);
  return {
    set: set,
    stop: function () { alive = false; if (raf) win.cancelAnimationFrame(raf); raf = 0; }
  };
}
