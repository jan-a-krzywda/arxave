/**
 * cave-nudge — "more like this / less like this", as arithmetic.
 *
 * ONE PRESS, ONE RE-RANK, NO FETCH. The Act stage says a paper is more or less
 * like what the reader wants; the priorities stage keeps the two lists; this
 * module turns them into the two things ranking needs. Everything here is pure
 * — the same call twice is the same answer, and no argument is mutated — so the
 * page and `scripts/cave-nudge.test.mjs` run the identical code.
 *
 * `applyNudge` is the whole state machine of the two lists, and its one rule is
 * that a paper is in at most one of them: liking a paper that was disliked
 * moves it, clearing a press (sign 0) drops it from both, and pressing the same
 * side twice is a no-op rather than a second copy.
 *
 * `vecsFor` is the bridge from ids to the night's vectors, in the order the ids
 * came in. An id that is not in tonight's dig is skipped — an old nudge still
 * persists across nights, so an unknown id is the normal case, not an error.
 *
 * `applyLess` is the negative half of the re-rank: the disliked papers
 * themselves leave the list, every other paper loses `weight × max(0, cos)` of
 * its score against the nearest disliked vector, and the list is sorted again
 * by the new score (ties keep their incoming order). Positive nudges need no
 * equivalent — their vectors simply join the touchstones before `caveScore`.
 */

/** What one "less like this" vector may take off a score, full cosine. */
export const LESS_WEIGHT = 0.25;

/** Ids from a stored list: strings, trimmed, deduplicated, order kept. */
function idList(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const value of raw) {
    const id = String(value ?? '').trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * prefs + one nudge → new prefs. `sign` +1 is "more like", -1 "less like",
 * 0 clears the paper from both lists (the chip's ×). Other prefs fields ride
 * through untouched.
 */
export function applyNudge(prefs, nudge) {
  const base = prefs && typeof prefs === 'object' ? prefs : {};
  const more = idList(base.more);
  const less = idList(base.less);
  const id = String(nudge?.id ?? '').trim();
  const sign = Math.sign(Number(nudge?.sign) || 0);
  if (!id) return { ...base, more, less };

  const inMore = more.includes(id);
  const inLess = less.includes(id);
  const nextMore = sign > 0
    ? (inMore ? more : [...more.filter((other) => other !== id), id])
    : more.filter((other) => other !== id);
  const nextLess = sign < 0
    ? (inLess ? less : [...less.filter((other) => other !== id), id])
    : less.filter((other) => other !== id);

  return { ...base, more: nextMore, less: nextLess };
}

/**
 * The night vectors behind these ids, in the ids' order. Skips an unknown id
 * and a stone the night has no vector for; [] when the night has neither.
 */
export function vecsFor(ids, night) {
  const list = Array.isArray(ids) ? ids : [];
  const stones = night && Array.isArray(night.stones) ? night.stones : null;
  const vecs = night && Array.isArray(night.vecs) ? night.vecs : null;
  if (!stones || !vecs || !list.length) return [];

  const at = new Map();
  for (let i = 0; i < stones.length; i += 1) {
    const id = stones[i] && stones[i].id;
    if (id != null) at.set(String(id), i);
  }

  const out = [];
  for (const raw of list) {
    const i = at.get(String(raw));
    if (i === undefined) continue;
    const vec = vecs[i];
    if (vec && vec.length) out.push(vec);
  }
  return out;
}

/** Cosine, guarded: a missing or zero-length vector points anywhere, so 0. */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

/** Same vector by reference or by value — the night hands the same arrays on. */
function sameVec(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The ranked list after the dislikes: drop the disliked papers, take
 * `weight × max(0, max cosine to any less vector)` off every remaining score,
 * and sort by the new score, stable (a tie keeps its incoming order).
 *
 * Returns new items and a new array; `ranked` and its items are not mutated.
 * With no less vectors it is a plain copy in the same order, so the caller can
 * call it unconditionally.
 */
export function applyLess(ranked, lessVecs, options = {}) {
  const list = Array.isArray(ranked) ? ranked : [];
  const vecs = (Array.isArray(lessVecs) ? lessVecs : []).filter((vec) => vec && vec.length);
  if (!vecs.length) return list.slice();

  const asked = Number(options.weight);
  const weight = Number.isFinite(asked) ? Math.max(0, asked) : LESS_WEIGHT;

  /* ponytail: one pass per paper over the few disliked vectors (n × m × dim,
     with m a handful). A reader can dislike dozens, not thousands; if that
     ever changes, normalise the less vectors once and sort by dot product. */
  const scored = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i] || {};
    const vec = item.vec;
    if (vec && vecs.some((less) => sameVec(vec, less))) continue;

    let nearest = 0;
    if (vec && vec.length) {
      for (const less of vecs) nearest = Math.max(nearest, cosine(vec, less));
      nearest = Math.max(0, nearest);
    }
    const score = (Number(item.score) || 0) - weight * nearest;
    scored.push({ item, score, at: i });
  }

  scored.sort((a, b) => b.score - a.score || a.at - b.at);
  return scored.map(({ item, score }) => ({ ...item, score }));
}
