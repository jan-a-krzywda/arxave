/**
 * details — the two live pieces of the Details page: the stage explorer and
 * the grade calculator.
 *
 * THE CALCULATOR IS THE RANKING'S OWN ARITHMETIC. `promiseScore` and `phi` are
 * imported from sieve-core, not re-typed, so the Promise it prints is the one
 * the Ranking card sorts by. The z sliders are turned back into raw impact and
 * novelty through the field's `promise_ref` before the call, which is exactly
 * the order the page works in. The row bar is `orderNight`'s key; it is
 * repeated here rather than imported because cave-stage-ranking pulls in the
 * whole card.
 */
import { PROMISE_REF, phi, promiseScore } from './sieve-core.mjs';

/** Each field's `promise_ref`, as corpus.json ships it. */
const REFS = {
  quantum: PROMISE_REF,
  ai: { impact: { mean: 0.749, sd: 0.1317 }, novelty: { mean: 0.1254, sd: 0.0388 }, rho: -0.544 },
};

/** cave-stage-ranking's SOLO_MAX: points a single-author paper loses at full slider. */
const SOLO_MAX = 30;

const SRC = 'https://github.com/jan-a-krzywda/arxave/blob/main/docs/assets/';

/** One row per stage: what it does, what goes in and out, the rule, the file. */
const STAGES = [
  {
    name: 'Dig',
    does: 'Pulls tonight\'s arXiv listing for your categories.',
    io: ['categories, 1–7 publishing days', 'up to 1 000 abstracts'],
    rule: 'Publishing days, not calendar days — arXiv is silent on weekends. First category picks the field.',
    file: 'cave-stage-dig.mjs',
  },
  {
    name: 'Train',
    does: 'Turns each abstract into a vector while the mine train fills.',
    io: ['abstracts', '768-d SPECTER2 vectors, clipped ±0.25, centred on the field mean'],
    rule: 'Cached by text hash: a warm night is a download, not a computation.',
    file: 'cave-train.mjs',
  },
  {
    name: 'Map',
    does: 'Groups the night into wagons and files every paper under a topic.',
    io: ['vectors', 'wagons + one leaf topic (and a close runner-up) per paper'],
    rule: 'Average linkage; cut auto-picked in 0.40–0.75, slider 0.20–0.70; no wagon over 20% of the night.',
    file: 'cave-stage-map.mjs',
  },
  {
    name: 'Priorities',
    does: 'You weigh topics and, optionally, describe what you want in words.',
    io: ['topic tree, your text', 'weights 1.5 / 1 / 0.5 / off; your words as vectors'],
    rule: 'Off removes a topic from the corpus too — no neighbours, no landmarks, no median.',
    file: 'cave-stage-priorities.mjs',
  },
  {
    name: 'Ranking',
    does: 'Grades and orders the night; you pick papers.',
    io: ['night + priorities', 'Match · Impact · Surprise · Exp. per paper, 5 at a time'],
    rule: 'No gate: Topic match is a weight on the order, not a filter that can empty the night.',
    file: 'cave-stage-ranking.mjs',
  },
  {
    name: 'Story',
    does: 'An LLM writes a short read-first guide around your picks.',
    io: ['≤ 12 picks', 'one narrative, cached per night + picks'],
    rule: 'The model\'s text is escaped first; only paper ids it was sent become links.',
    file: 'cave-stage-story.mjs',
  },
];

const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function mountStages(root) {
  if (!root) return;
  const tabs = root.querySelector('.dt-tabs');
  const panel = root.querySelector('.dt-panel');
  tabs.innerHTML = STAGES.map((s, i) =>
    '<button type="button" role="tab" data-i="' + i + '" aria-selected="false">' +
      '<span class="dt-n">' + (i + 1) + '</span>' + esc(s.name) + '</button>').join('');

  function show(i) {
    const s = STAGES[i];
    for (const b of tabs.querySelectorAll('button')) b.setAttribute('aria-selected', String(Number(b.dataset.i) === i));
    panel.innerHTML =
      '<p class="dt-does">' + esc(s.does) + '</p>' +
      '<p class="dt-io"><span>' + esc(s.io[0]) + '</span><span class="dt-arrow">→</span><span>' + esc(s.io[1]) + '</span></p>' +
      '<p class="dt-rule">' + esc(s.rule) + '</p>' +
      '<a class="dt-src" href="' + SRC + s.file + '">' + esc(s.file) + '</a>';
  }

  tabs.addEventListener('click', (event) => {
    const b = event.target.closest('button');
    if (b) show(Number(b.dataset.i));
  });
  show(0);
}

const pct = (x) => Math.round(100 * x);

function mountCalc(root) {
  if (!root) return;
  const input = (k) => root.querySelector('[data-k="' + k + '"]');
  const out = (k, text) => { root.querySelector('[data-o="' + k + '"]').textContent = text; };
  const row = (k, html) => { root.querySelector('[data-r="' + k + '"]').innerHTML = html; };
  const bar = (v) => '<span class="dt-bar"><span style="width:' + Math.max(0, Math.min(100, v)) + '%"></span></span>';

  function paint() {
    const ref = REFS[input('field').value] || PROMISE_REF;
    const zi = Number(input('zi').value);
    const zn = Number(input('zn').value);
    const zf = Number(input('zf').value);
    const s = Number(input('s').value) / 100;
    const w = Number(input('m').value) / 100;
    out('zi', zi.toFixed(1));
    out('zn', zn.toFixed(1));
    out('zf', zf.toFixed(1));
    out('s', String(Math.round(s * 100)));
    out('m', String(Math.round(w * 100)));

    const impact = ref.impact.mean + zi * ref.impact.sd;
    const novelty = ref.novelty.mean + zn * ref.novelty.sd;
    const beta = 1.5 * s - 1.25;
    const sd = Math.sqrt(Math.max(1 + beta * beta + 2 * beta * ref.rho, 1e-6));
    const promise = pct(promiseScore(impact, novelty, s, ref));
    const fit = pct(phi(zf));
    const penalty = input('solo').checked ? 0.5 * SOLO_MAX : 0;
    const rel = Math.round(Math.min(100, Math.max(0, (1 - w) * promise + w * fit - penalty)));

    row('raw', impact.toFixed(3) + ' / ' + novelty.toFixed(3) + ' <small>ρ = ' + ref.rho + '</small>');
    row('beta', beta.toFixed(2));
    row('sd', sd.toFixed(2));
    row('grades', pct(phi(zi)) + ' · ' + pct(phi(zn)) + ' · ' + fit);
    row('promise', bar(promise) + '<b>' + promise + '</b>');
    row('rel', bar(rel) + '<b class="dt-gold">' + rel + '</b>' + (penalty ? ' <small>−' + penalty + '</small>' : ''));
  }

  root.addEventListener('input', paint);
  root.addEventListener('change', paint);
  paint();
}

mountStages(document.getElementById('dt-stages'));
mountCalc(document.getElementById('dt-calc'));
