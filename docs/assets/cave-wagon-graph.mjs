/**
 * cave-wagon-graph — the force-directed wagon graph, as a mountable module.
 *
 * COPIED FROM `docs/assets/filter.js` (`drawWagonGraph`, `clusterIds`, the wagon
 * colours and the graph hint). That file stays the reference: same seeding, same
 * forces, same slots, same colours, same pan / zoom / drag / pin behaviour, same
 * drawing order. Only the seams moved:
 *
 *   - data arrives as arguments (S, stones, components) instead of `state.*`;
 *   - `names` replaces the reference's wagon-name lookup ('Wagon 3' until named);
 *   - `readout` is the one sink the graph writes to;
 *   - listeners are addEventListener'd rather than assigned to `on*` properties,
 *     so `destroy()` can take them off again.
 *
 * THE READOUT CARRIES THE POINTER EVENT, as in the reference:
 * `readout(html, isPinned, evt)`. A sink floats its tooltip at
 * `evt.clientX/clientY`. `readout(null, false, evt)` is the reference's
 * "reposition only" call — the tooltip stays as it is and just follows; `html
 * === ''` hides it. A pinned tooltip parks on its node instead of trailing the
 * cursor (`emitPinnedAnchor`), so the pointer can travel to its link.
 *
 * NO NODE IMPORTS, no bundler: the page loads this as an ES module.
 */

/* One hue per wagon, cycled if there are more wagons than colours. */
export const WAGON_COLORS = Object.freeze([
  '#f5b301', '#5fb3a1', '#c96f4a', '#8f7fd4',
  '#7fa650', '#d98cb3', '#4f9ad6', '#c9a227',
  '#a8705a', '#6fbf73'
]);

const LONE_COLOR = '#6c6355';   // stones that joined no wagon

/* The clustering threshold the graph draws edges at when the caller does not
   pass one. Same value as filter.js (and cave-wagons.mjs): measured, not
   invented — see the sweep note above WAGON_THRESH in filter.js. Duplicated
   rather than imported so this module mounts on its own. */
const WAGON_THRESH = 0.46;

/* The line under the graph. Unchanged from filter.js. */
export const WAGON_GRAPH_HINT = 'drag a stone to move it · drag the rock to pan · ' +
  'scroll to zoom · click to pin, then hover its wagon-mates to compare';

/* ── helpers ────────────────────────────────────────────────────────────── */

/**
 * Local copy on purpose: the graph builds tooltip markup from arXiv titles, and
 * a module that reached into a page-level global for that would be one rename
 * away from putting a raw `<` into innerHTML. Verbatim from filter.js.
 */
export function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** [N] array of cluster ids, -1 for stones outside every wagon. */
export function clusterIds(n, components) {
  var cid = new Array(n).fill(-1);
  for (var c = 0; c < components.length; c++) {
    var members = components[c].indices;
    for (var m = 0; m < members.length; m++) cid[members[m]] = c;
  }
  return cid;
}

/** The label a wagon goes by: its name once it has one, its number until then.
 *  `names` is one entry per component — a string, or null for an unnamed wagon. */
export function wagonLabel(names, c) {
  var name = names && names[c];
  return name ? String(name) : 'Wagon ' + (c + 1);
}

/* Canvas can't resolve CSS var() strings, so the rock colour is read off the
   element each paint (the light theme repaints the same canvas). Outside a
   browser — a node test, a detached canvas — fall back to the dark rock. */
const ROCK_FALLBACK = '#21262e';
function rockHex(canvas) {
  try {
    if (typeof getComputedStyle === 'function') {
      var hex = getComputedStyle(canvas).getPropertyValue('--rock').trim();
      if (hex) return hex;
    }
  } catch (err) { /* not a styled element */ }
  return ROCK_FALLBACK;
}

/* Read lazily: a page may load this before anything has set the ratio, and a
   test stubs it after import. */
function pixelRatio() {
  var r = typeof globalThis !== 'undefined' ? globalThis.devicePixelRatio : 0;
  return r || 1;
}

function requestFrame(fn) {
  if (typeof globalThis.requestAnimationFrame !== 'function') return null;
  var id = globalThis.requestAnimationFrame(fn);
  return id === undefined ? null : id;
}

function cancelFrame(id) {
  if (id === null || typeof globalThis.cancelAnimationFrame !== 'function') return;
  globalThis.cancelAnimationFrame(id);
}

/* ── the graph ──────────────────────────────────────────────────────────── */

/**
 * Force-directed wagon graph on a canvas. Nodes are draggable, the view pans
 * and zooms, hover previews and click pins the readout.
 *
 * `cfg.S` the similarity matrix, `cfg.stones` the papers, `cfg.components` the
 * wagons (each `{ indices: [...] }`), `cfg.names` one label or null per wagon,
 * `cfg.readout(html, isPinned, evt)` the tooltip sink, `cfg.opts` the
 * reference's `{ width, height, thresh }`.
 *
 * Returns a handle — `destroy()` (alias `stop()`) stops the animation and takes
 * every listener off the canvas, plus the reference's `reheat`, `unpin` and
 * `setAssay`. Returns null when there is no usable canvas to draw on.
 */
export function mountWagonGraph(canvas, cfg) {
  cfg = cfg || {};
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  var ctx = canvas.getContext('2d');
  if (!ctx) return null;

  var S = cfg.S || [];
  var stones = cfg.stones || [];
  var components = cfg.components || [];
  var names = cfg.names || [];
  var readoutFn = typeof cfg.readout === 'function' ? cfg.readout : null;
  var opts = cfg.opts || {};

  var N = stones.length;
  var W = opts.width || 640;
  var H = opts.height || 420;
  var THRESH = opts.thresh === undefined ? WAGON_THRESH : opts.thresh;
  var dpr = pixelRatio();

  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';

  var cid = clusterIds(N, components);

  // Edges + degrees
  var edges = [];
  var deg = new Array(N).fill(0);
  var nbrs = new Array(N);
  var i;
  for (i = 0; i < N; i++) nbrs[i] = [];
  for (i = 0; i < N; i++) {
    for (var j = i + 1; j < N; j++) {
      var w = S[i][j];
      if (w >= THRESH) {
        edges.push({ a: i, b: j, w: w });
        deg[i]++; deg[j]++;
        nbrs[i].push(j); nbrs[j].push(i);
      }
    }
  }

  // Seed positions: each wagon on its own arc, lone stones on an outer ring.
  // A same-size ring left a fifteen-stone wagon squeezed into the same
  // angular slice as a three-stone one, and its own internal repulsion —
  // summed over fourteen neighbors — easily outran the anchor's pull and
  // bled it into whatever sat next door. The anchor ring below is sized and
  // ordered from each wagon's own footprint, and the slots keep every stone
  // inside its own slice no matter how its internal forces balance.
  var nodes = new Array(N);
  var nComp = components.length;
  var compSize = new Array(nComp);
  for (var cs = 0; cs < nComp; cs++) compSize[cs] = components[cs].indices.length;
  function wagonFootprint(sz) { return 34 + 24 * Math.sqrt(sz); }
  var clusterCap = new Array(nComp);
  for (var cc = 0; cc < nComp; cc++) clusterCap[cc] = wagonFootprint(compSize[cc]) * 1.15;

  // Largest wagons first, then alternate to the smallest and back — spreads
  // the big wagons apart around the ring instead of leaving them adjacent.
  var bySize = [];
  for (var oi = 0; oi < nComp; oi++) bySize.push(oi);
  bySize.sort(function (a, b) { return compSize[b] - compSize[a]; });
  var ring = new Array(nComp);
  var lo = 0, hi = nComp - 1, pos = 0, front = true;
  while (lo <= hi) {
    ring[pos++] = front ? bySize[lo++] : bySize[hi--];
    front = !front;
  }
  var slotOf = new Array(nComp);
  for (var s = 0; s < nComp; s++) slotOf[ring[s]] = s;

  // Anchor radius: big enough that the worst adjacent pair of clamp radii
  // (by ring order, not by index) still clears with a pad between them.
  var maxAdjSum = 0;
  for (var a1 = 0; a1 < nComp; a1++) {
    var pairSum = clusterCap[ring[a1]] + clusterCap[ring[(a1 + 1) % nComp]];
    if (pairSum > maxAdjSum) maxAdjSum = pairSum;
  }
  var ANCHOR_R = nComp > 1
    ? Math.max(200, (maxAdjSum + 40) / (2 * Math.sin(Math.PI / nComp)))
    : 0;
  var maxCap = 0;
  for (var mc = 0; mc < nComp; mc++) if (clusterCap[mc] > maxCap) maxCap = clusterCap[mc];
  var LONE_R = Math.max(200, ANCHOR_R + maxCap + 70);

  var clusterAnchor = new Array(nComp);
  for (var ci = 0; ci < nComp; ci++) {
    var cbase = (slotOf[ci] / Math.max(1, nComp)) * Math.PI * 2;
    clusterAnchor[ci] = { x: Math.cos(cbase) * ANCHOR_R, y: Math.sin(cbase) * ANCHOR_R };
  }
  // Hub marker position: the wagon's live centroid, recomputed every tick
  // in the simulation loop below. Anchor gravity keeps a wagon's stones
  // near clusterAnchor, but cross-wagon repulsion skews the actual blob
  // off that point — tracking the centroid keeps the diamond marker inside
  // the cloud of dots it names instead of pinned to one edge of it.
  var hubPos = new Array(nComp);
  var hubSumX = new Array(nComp), hubSumY = new Array(nComp), hubSumN = new Array(nComp);
  for (var hp = 0; hp < nComp; hp++) hubPos[hp] = { x: clusterAnchor[hp].x, y: clusterAnchor[hp].y };

  // A wagon's stones are PLACED, not relaxed into position.
  //
  // Every attempt to get a round blob out of the force balance failed, and
  // the reason is structural: a wagon is a near-complete graph whose spring
  // lengths encode the cosines between its stones, so the layout faithfully
  // reproduces whatever geometry those cosines have. A tight topical cluster
  // sits along a gradient in embedding space — one dominant direction — so
  // the honest 2D answer for it really is close to a line, and no amount of
  // reweighting the forces argues with that. Meanwhile, the intra-wagon
  // distances carry nothing a reader can use: membership is already the
  // whole message, and the exact spacing inside a wagon is noise.
  //
  // So each stone gets a fixed slot on a Vogel (sunflower) spiral around its
  // wagon's anchor — radius from sqrt(k/n), angle stepped by the golden
  // angle — which fills a disk evenly by construction. The slots are laid
  // over an annulus rather than a full disk, leaving a hole at the centre so
  // the wagon's diamond stays visible on top of its own stones.
  var GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  var wagonCount = {};
  var loneAngle = new Array(N);
  for (i = 0; i < N; i++) {
    var c = cid[i];
    var r, ang, ox, oy, tgx = 0, tgy = 0;
    if (c >= 0) {
      wagonCount[c] = (wagonCount[c] || 0) + 1;
      var k = wagonCount[c];
      var n2 = Math.max(1, compSize[c]);
      // Jitter keeps the spiral from reading as a manufactured pattern
      // without letting any stone drift far enough to reopen a void.
      ang = k * GOLDEN_ANGLE + (Math.random() - 0.5) * 0.35;
      // Uniform over the annulus [rHole, rOuter]: equal area per stone.
      var rOuter = clusterCap[c] * 0.82;
      // 14 ≈ HUB_R * 2.8, spelled out because HUB_R is declared further down.
      var rHole = Math.min(14, rOuter * 0.45);
      r = Math.sqrt(rHole * rHole
        + (rOuter * rOuter - rHole * rHole) * ((k - 0.5) / n2))
        * (0.94 + Math.random() * 0.12);
      tgx = Math.cos(ang) * r; tgy = Math.sin(ang) * r;
      ox = clusterAnchor[c].x; oy = clusterAnchor[c].y;
    } else {
      ang = Math.random() * Math.PI * 2;
      loneAngle[i] = ang;
      r = LONE_R + Math.random() * 90;
      ox = 0; oy = 0;
    }
    nodes[i] = {
      i: i,
      x: ox + Math.cos(ang) * r,
      y: oy + Math.sin(ang) * r,
      tx: tgx,
      ty: tgy,
      vx: 0, vy: 0,
      r: 2.5 + Math.min(3.5, Math.sqrt(deg[i]) * 0.7)
    };
  }

  // ── Simulation ──
  var alpha = 1.0;
  var raf = null;
  var stopped = false;

  function tick() {
    if (alpha < 0.004) return false;
    var REP = 3200;
    var K = 0.045;

    // Repulsion — O(N²), fine for a day's haul (a few hundred stones).
    // Only pairs with a loose stone in them matter now: two clustered stones
    // are both pinned to slots, so a force between them would be discarded.
    for (var a = 0; a < N; a++) {
      var na = nodes[a];
      if (cid[a] >= 0) continue;              // clustered: takes no forces
      for (var b = 0; b < N; b++) {
        if (b === a) continue;
        var nb = nodes[b];
        var dx = na.x - nb.x, dy = na.y - nb.y;
        var d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.01; }
        if (d2 > 160000) continue;            // ignore far pairs
        var f = REP / d2;
        if (cid[b] >= 0) f *= 2.8;            // keep loose stones off the wagons
        // Cap any single pair's force. Without this, a dense knot's summed
        // repulsion threw nodes across the canvas each frame — visible as
        // jiggle that took many seconds to damp out instead of settling.
        if (f > 260) f = 260;
        var d = Math.sqrt(d2);
        na.vx += (dx / d) * f; na.vy += (dy / d) * f;
      }
    }

    // Springs — stronger, shorter for higher cosine. These now only act on
    // edges with a loose stone at one end: an edge inside a wagon joins two
    // pinned stones, and it was exactly those springs, reconstructing the
    // cosine geometry of a topical cluster, that drew each wagon as a line.
    for (var e = 0; e < edges.length; e++) {
      var ed = edges[e];
      if (cid[ed.a] >= 0 && cid[ed.b] >= 0) continue;
      var p = nodes[ed.a], q = nodes[ed.b];
      var t = (ed.w - THRESH) / Math.max(0.001, 1 - THRESH);
      var L = 92 - 46 * t;
      var ddx = q.x - p.x, ddy = q.y - p.y;
      var dd = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01;
      var force = (dd - L) * K * (0.4 + t);
      var fx = (ddx / dd) * force, fy = (ddy / dd) * force;
      if (cid[ed.a] < 0) { p.vx += fx; p.vy += fy; }
      if (cid[ed.b] < 0) { q.vx -= fx; q.vy -= fy; }
    }

    // Gravity, for the loose stones only — the clustered ones are carried to
    // their slots by the integrator below.
    for (var g = 0; g < N; g++) {
      var ndg = nodes[g];
      var cg = cid[g];
      if (cg < 0) {
        // Lone stones keep their own seeded angle and sit past every wagon's
        // clamp radius — pulling them toward the origin instead put them
        // inside the wagon ring, not outside it.
        var lx = Math.cos(loneAngle[g]) * LONE_R, ly = Math.sin(loneAngle[g]) * LONE_R;
        ndg.vx += (lx - ndg.x) * 0.01;
        ndg.vy += (ly - ndg.y) * 0.01;
      }
    }

    // Integrate, with a speed cap — uncapped, a dense wagon's summed
    // repulsion throws nodes across the canvas and the layout flickers
    // instead of relaxing.
    //
    // Clustered stones do not integrate at all: they ease straight to their
    // slot. Easing toward a fixed point cannot oscillate and cannot fold up
    // into a ring, so the wagon holds the disk the slots describe however
    // the forces happen to balance — and it settles without the jiggle a
    // dense wagon used to show. They still repel the loose stones around
    // them, they just no longer take forces themselves.
    var MAX_STEP = 14;
    for (var m = 0; m < N; m++) {
      var nd = nodes[m];
      if (nd === dragNode) { nd.vx = 0; nd.vy = 0; continue; }
      var mc = cid[m];
      if (mc >= 0) {
        var ma = clusterAnchor[mc];
        nd.x += (ma.x + nd.tx - nd.x) * 0.14;
        nd.y += (ma.y + nd.ty - nd.y) * 0.14;
        nd.vx = 0; nd.vy = 0;
        continue;
      }
      nd.vx *= 0.82; nd.vy *= 0.82;
      var sx = nd.vx * alpha, sy = nd.vy * alpha;
      var sp = Math.sqrt(sx * sx + sy * sy);
      if (sp > MAX_STEP) { sx = sx / sp * MAX_STEP; sy = sy / sp * MAX_STEP; }
      nd.x += sx;
      nd.y += sy;
    }

    // The containment clamp that used to live here is gone. It projected
    // onto a circle, so whatever it caught every tick got laid out along
    // that circle — and since repulsion pushed the stones straight at it,
    // it was drawing the arcs itself. Slots sit at 0.82 of the cap and
    // nothing pushes a clustered stone off its slot, so containment is now
    // a property of the placement rather than a correction applied after it.

    for (var hc0 = 0; hc0 < nComp; hc0++) { hubSumX[hc0] = 0; hubSumY[hc0] = 0; hubSumN[hc0] = 0; }
    for (var hi = 0; hi < N; hi++) {
      var hcid = cid[hi];
      if (hcid >= 0) { hubSumX[hcid] += nodes[hi].x; hubSumY[hcid] += nodes[hi].y; hubSumN[hcid]++; }
    }
    for (var hc1 = 0; hc1 < nComp; hc1++) {
      if (hubSumN[hc1] > 0) { hubPos[hc1].x = hubSumX[hc1] / hubSumN[hc1]; hubPos[hc1].y = hubSumY[hc1] / hubSumN[hc1]; }
    }

    alpha *= 0.985;
    return true;
  }

  // ── View transform ──
  var view = { k: 1, tx: W / 2, ty: H / 2 };
  function toScreen(n) { return { x: n.x * view.k + view.tx, y: n.y * view.k + view.ty }; }
  function toWorld(sx, sy) { return { x: (sx - view.tx) / view.k, y: (sy - view.ty) / view.k }; }

  /** Transform that would frame the whole layout right now. */
  function fitTarget() {
    /* No stones: nothing to frame. (The reference never mounts empty; a page
       that clears the wagons can, and Infinity - Infinity would poison the
       view and draw nothing at a NaN transform.) */
    if (N === 0) return { k: 1, tx: W / 2, ty: H / 2 };
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i2 = 0; i2 < N; i2++) {
      if (nodes[i2].x < minX) minX = nodes[i2].x;
      if (nodes[i2].x > maxX) maxX = nodes[i2].x;
      if (nodes[i2].y < minY) minY = nodes[i2].y;
      if (nodes[i2].y > maxY) maxY = nodes[i2].y;
    }
    var pad = 34;
    var spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
    var k = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
    if (k > 2) k = 2;
    return {
      k: k,
      tx: W / 2 - ((minX + maxX) / 2) * k,
      ty: H / 2 - ((minY + maxY) / 2) * k
    };
  }

  // The view tracks the layout while it relaxes — a one-shot fit snaps and
  // then lets the graph drift out of frame. Any manual pan/zoom stops it.
  var autoFit = true;
  function stepFit(ease) {
    if (!autoFit) return;
    var t = fitTarget();
    view.k += (t.k - view.k) * ease;
    view.tx += (t.tx - view.tx) * ease;
    view.ty += (t.ty - view.ty) * ease;
  }
  function snapFit() {
    var t = fitTarget();
    view.k = t.k; view.tx = t.tx; view.ty = t.ty;
  }

  // ── Interaction state ──
  var hoverNode = null;
  var hoverAnchor = null;   // index into components — wagon hub under the cursor
  var HUB_R = 5;
  var pinnedNode = null;
  var dragNode = null;
  var panning = null;

  // Assay overlay — set once the caller has graded the stones. The layout never
  // changes with it: wagons come from the stones themselves, grades come from
  // the touchstones, and you want to see one against the other.
  var grades = null;      // Float32Array [N] or null
  var rank = null;        // [N] position in the grade order, 0 = best
  var payDirt = null;     // Set of indices in the pay-dirt cut

  function nodeColor(idx) {
    return cid[idx] >= 0 ? WAGON_COLORS[cid[idx] % WAGON_COLORS.length] : LONE_COLOR;
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = rockHex(canvas);
    ctx.fillRect(0, 0, W, H);

    var focus = pinnedNode !== null ? pinnedNode : hoverNode;
    // With a node pinned, hovering one of its own wagon-mates compares
    // against the pin. Unconnected stones don't react — the pin only
    // reads out against stones it actually shares a wagon with.
    var compareNode = (pinnedNode !== null && hoverNode !== null && hoverNode !== pinnedNode
      && nbrs[pinnedNode].indexOf(hoverNode) !== -1)
      ? hoverNode : null;
    var lit = null;
    if (focus !== null) {
      lit = new Set(nbrs[focus]);
      lit.add(focus);
      if (compareNode !== null) lit.add(compareNode);
    } else if (hoverAnchor !== null) {
      lit = new Set(components[hoverAnchor].indices);
    }
    var anyFocus = focus !== null || hoverAnchor !== null;

    // Edges
    for (var e = 0; e < edges.length; e++) {
      var ed = edges[e];
      var p = toScreen(nodes[ed.a]), q = toScreen(nodes[ed.b]);
      var touched = focus !== null && (ed.a === focus || ed.b === focus);
      var t = (ed.w - THRESH) / Math.max(0.001, 1 - THRESH);
      var alphaE = 0.12 + 0.5 * t;
      if (anyFocus) alphaE = touched ? 0.95 : alphaE * 0.25;
      ctx.globalAlpha = alphaE;
      ctx.strokeStyle = cid[ed.a] >= 0 && cid[ed.a] === cid[ed.b]
        ? nodeColor(ed.a) : '#7c7364';
      ctx.lineWidth = touched ? 1.6 : 0.8;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    }

    // Compare line: pin ↔ hovered wagon-mate.
    if (compareNode !== null) {
      var cp = toScreen(nodes[pinnedNode]), cq = toScreen(nodes[compareNode]);
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = '#f2ede3';
      ctx.lineWidth = 1.8;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(cp.x, cp.y);
      ctx.lineTo(cq.x, cq.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Nodes. Radius follows the zoom a little, so a tight wagon stays a
    // cloud of dots when zoomed out instead of one solid blob.
    var rScale = Math.min(1.3, Math.max(0.5, view.k));

    // Wagon hubs: one small marker at each wagon's anchor point, hoverable
    // to name the group and light up every stone it holds.
    for (var ci3 = 0; ci3 < nComp; ci3++) {
      var hs = toScreen(hubPos[ci3]);
      var isHubFocus = hoverAnchor === ci3;
      if (isHubFocus) {
        for (var hm = 0; hm < components[ci3].indices.length; hm++) {
          var ms = toScreen(nodes[components[ci3].indices[hm]]);
          ctx.globalAlpha = 0.55;
          ctx.strokeStyle = '#f2ede3';
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 3]);
          ctx.beginPath();
          ctx.moveTo(hs.x, hs.y);
          ctx.lineTo(ms.x, ms.y);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = anyFocus && !isHubFocus ? 0.25 : 1;
      // Hub size is fixed in SCREEN pixels, not scaled with the zoom: a
      // wagon marker that shrank with its stones vanished into the cloud
      // exactly when you needed it, on a zoomed-out AI-sized graph.
      var hr = isHubFocus ? HUB_R * 1.5 : HUB_R;
      ctx.save();
      ctx.translate(hs.x, hs.y);
      ctx.rotate(Math.PI / 4);
      // Dark envelope first, then a pale rim, so the diamond reads against
      // both the stone cloud and the edge haze behind it.
      ctx.fillStyle = '#12151a';
      ctx.fillRect(-hr - 2, -hr - 2, (hr + 2) * 2, (hr + 2) * 2);
      ctx.fillStyle = WAGON_COLORS[ci3 % WAGON_COLORS.length];
      ctx.fillRect(-hr, -hr, hr * 2, hr * 2);
      ctx.strokeStyle = '#f2ede3';
      ctx.lineWidth = isHubFocus ? 1.6 : 1.1;
      ctx.strokeRect(-hr - 1, -hr - 1, (hr + 1) * 2, (hr + 1) * 2);
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    for (var n = 0; n < N; n++) {
      var s = toScreen(nodes[n]);
      var dim = anyFocus && !lit.has(n);
      ctx.globalAlpha = dim ? 0.18 : 1;
      ctx.fillStyle = nodeColor(n);
      ctx.beginPath();
      var rr = nodes[n].r * rScale * (n === focus ? 1.8 : 1);
      ctx.arc(s.x, s.y, rr, 0, Math.PI * 2);
      ctx.fill();
      if (payDirt && payDirt.has(n)) {
        // Pay dirt: gold ring, so the assay's picks are findable in the wagons
        ctx.globalAlpha = dim ? 0.35 : 1;
        ctx.strokeStyle = '#f5b301';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(s.x, s.y, rr + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (n === focus) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#f2ede3';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(s.x, s.y, rr, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  function loop() {
    if (stopped) return;
    var moving = tick();
    stepFit(0.12);
    draw();
    if (moving || dragNode !== null) raf = requestFrame(loop);
    else raf = null;
  }

  function wake(a) {
    if (a > alpha) alpha = a;
    if (raf === null && !stopped) raf = requestFrame(loop);
  }

  // ── Readout ── a tooltip naming the stone under the cursor. While it
  // trails the cursor its link can't be clicked, so a pinned stone parks
  // its tooltip on the node instead and lets the pointer reach the link.
  function tipHtml(idx) {
    var authors = (stones[idx].authors || []).join(', ');
    return '<div class="tt-title"><a href="' + stones[idx].abs_url +
      '" target="_blank" rel="noopener">' + escapeHtml(stones[idx].title) + '</a></div>' +
      /* Smaller than the title: who wrote it is the second question, and a
         twenty-author collaboration must not push the title off the node. */
      (authors ? '<div class="tt-authors">' + escapeHtml(authors) + '</div>' : '');
  }

  function emit(idx, isPinned, evt) {
    if (!readoutFn) return;
    if (idx === null) { readoutFn('', false, null); return; }
    readoutFn(tipHtml(idx), !!isPinned, evt);
  }

  /** Readout for a hovered wagon hub: its name and how many stones it holds. */
  function emitWagon(ci4, evt) {
    if (!readoutFn) return;
    var n = components[ci4].indices.length;
    readoutFn('<div class="tt-title">' + escapeHtml(wagonLabel(names, ci4)) + '</div>' +
      '<div class="tt-authors">' + n + ' stone' + (n === 1 ? '' : 's') + '</div>', false, evt);
  }

  /** Park the tooltip on the pinned node, clickable, wherever it has drifted. */
  function emitPinnedAnchor() {
    if (!readoutFn || pinnedNode === null) return;
    var rect = canvas.getBoundingClientRect();
    var s = toScreen(nodes[pinnedNode]);
    readoutFn(tipHtml(pinnedNode), true,
      { clientX: rect.left + s.x, clientY: rect.top + s.y });
  }

  // ── Mouse ──
  function pick(e) {
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var best = null, bestD = Infinity;
    var rScale = Math.min(1.3, Math.max(0.5, view.k));
    for (var n = 0; n < N; n++) {
      var s = toScreen(nodes[n]);
      var dx = s.x - mx, dy = s.y - my;
      var d = dx * dx + dy * dy;
      var hitR = nodes[n].r * rScale + 5;
      var hit = hitR * hitR;
      if (d < hit && d < bestD) { bestD = d; best = n; }
    }
    var bestAnchor = null, bestAnchorD = Infinity;
    for (var ci5 = 0; ci5 < nComp; ci5++) {
      var hs = toScreen(hubPos[ci5]);
      var hdx = hs.x - mx, hdy = hs.y - my;
      var hd = hdx * hdx + hdy * hdy;
      var hHit = (HUB_R + 6) * (HUB_R + 6);
      if (hd < hHit && hd < bestAnchorD) { bestAnchorD = hd; bestAnchor = ci5; }
    }
    var node = null, anchor = null;
    if (best !== null && (bestAnchor === null || bestD <= bestAnchorD)) node = best;
    else if (bestAnchor !== null) anchor = bestAnchor;
    return { node: node, anchor: anchor, mx: mx, my: my };
  }

  function onMouseDown(e) {
    var p = pick(e);
    if (p.node !== null) {
      dragNode = nodes[p.node];
      dragNode.moved = false;
    } else {
      panning = { x: p.mx, y: p.my, tx: view.tx, ty: view.ty };
      autoFit = false;          // hands on the view: stop chasing the layout
    }
    wake(0.3);
  }

  function onMouseMove(e) {
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (dragNode) {
      var wpt = toWorld(mx, my);
      dragNode.x = wpt.x; dragNode.y = wpt.y;
      dragNode.moved = true;
      wake(0.35);
      return;
    }
    if (panning) {
      view.tx = panning.tx + (mx - panning.x);
      view.ty = panning.ty + (my - panning.y);
      draw();
      return;
    }
    var p = pick(e);
    canvas.style.cursor = (p.node !== null || p.anchor !== null) ? 'pointer' : 'grab';
    if (p.node !== hoverNode || p.anchor !== hoverAnchor) {
      hoverNode = p.node;
      hoverAnchor = p.anchor;
      if (hoverAnchor !== null) emitWagon(hoverAnchor, e);
      // Off every node with something pinned: hand the tooltip back to the
      // pin, parked and clickable, so the pointer can walk over to its link.
      else if (hoverNode === null && pinnedNode !== null) emitPinnedAnchor();
      else if (hoverNode !== null && hoverNode === pinnedNode) emitPinnedAnchor();
      else emit(hoverNode, false, e);
      draw();
    } else if (hoverAnchor !== null) {
      if (readoutFn) readoutFn(null, false, e);   // reposition only
    } else if (hoverNode !== null && hoverNode !== pinnedNode) {
      if (readoutFn) readoutFn(null, false, e);   // reposition only
    }
  }

  function onMouseUp(e) {
    if (dragNode && !dragNode.moved) {
      var idx = dragNode.i;
      if (pinnedNode === idx) { pinnedNode = null; emit(idx, false, e); }
      else { pinnedNode = idx; emitPinnedAnchor(); }
      draw();
    }
    dragNode = null;
    panning = null;
  }

  function onMouseLeave() {
    dragNode = null;
    panning = null;
    hoverNode = null;
    hoverAnchor = null;
    // A pinned tooltip has to survive the cursor leaving the canvas — that
    // is exactly the trip the pointer makes to reach its link.
    if (pinnedNode !== null) emitPinnedAnchor();
    else emit(null, false, null);
    draw();
  }

  function onWheel(e) {
    e.preventDefault();
    autoFit = false;
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var before = toWorld(mx, my);
    var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    view.k = Math.max(0.02, Math.min(6, view.k * factor));
    var after = toWorld(mx, my);
    view.tx += (after.x - before.x) * view.k;
    view.ty += (after.y - before.y) * view.k;
    draw();
  }

  /* Listeners, not on* properties — the one deliberate deviation from the
     reference. A property holds a single handler, so teardown could not tell
     its own handler from a page's, and a second graph on the same canvas would
     silently evict the first. The wheel has to be non-passive to preventDefault. */
  var WHEEL_OPTS = { passive: false };
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mouseleave', onMouseLeave);
  canvas.addEventListener('wheel', onWheel, WHEEL_OPTS);
  canvas.style.cursor = 'grab';

  // Warm up before the first paint. The opening frames are the ones where
  // wagons are still tearing themselves apart; showing them reads as flicker,
  // so run them silently and start the animation from a rough shape.
  var WARMUP = 90;
  for (var wu = 0; wu < WARMUP; wu++) {
    if (!tick()) break;
  }
  snapFit();
  draw();
  raf = requestFrame(loop);

  function destroy() {
    stopped = true;
    cancelFrame(raf);
    raf = null;
    canvas.removeEventListener('mousedown', onMouseDown);
    canvas.removeEventListener('mousemove', onMouseMove);
    canvas.removeEventListener('mouseup', onMouseUp);
    canvas.removeEventListener('mouseleave', onMouseLeave);
    canvas.removeEventListener('wheel', onWheel, WHEEL_OPTS);
    pinnedNode = null;
    hoverNode = null;
    hoverAnchor = null;
    emit(null, false, null);
  }

  return {
    /* The reference calls it `stop`; `destroy` is the same teardown under the
       name the rest of the cave modules use. */
    stop: destroy,
    destroy: destroy,
    reheat: function () { autoFit = true; wake(1); },
    /** Drop the pin without touching the tooltip — the caller owns that. */
    unpin: function () {
      if (stopped) return;
      pinnedNode = null;
      draw();
    },
    /** Overlay the assay: gold rings on the pay-dirt cut, grades in the
     *  readout. Redraw only — the layout is left alone. */
    setAssay: function (g, order, topN) {
      if (!g || !order) { grades = null; rank = null; payDirt = null; }
      else {
        grades = g;
        rank = new Array(N);
        for (var o = 0; o < order.length; o++) rank[order[o]] = o;
        payDirt = new Set(order.slice(0, topN));
      }
      draw();
      var focus = pinnedNode !== null ? pinnedNode : hoverNode;
      if (focus !== null) emit(focus, pinnedNode !== null, null);
    }
  };
}
