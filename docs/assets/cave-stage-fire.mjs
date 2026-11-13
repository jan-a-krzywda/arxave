/**
 * cave-stage-fire — stage 4: the fire, and the light the rest of the page sits
 * in.
 *
 * A THRESHOLD, NOT A FORM. Everything above this card is the dig: announce,
 * embed, cluster. Below it, the night is read. The only thing to do here is the
 * one press that lights the campfire, so the card is a band, a copy line,
 * tonight's numbers, and a button — the smallest stage on the page, on purpose.
 *
 * THE FIRE IS THE PAGE'S LAMP FROM HERE DOWN. Lighting it puts `cave-lit` on
 * `#cave-app`; `cave-fire.css` turns that into the warm wash and gold focus
 * rings on Priorities, Ranking, Act and Story. The class is also the record of
 * "the fire is lit", so it is set at mount when `flow.status('fire')` is done
 * and re-synced if a new dig invalidates the stage.
 *
 * NO ANIMATION ON RESTORE. `is-lit` is in the markup whenever the flow already
 * says done, so the browser's first style resolution is the lit one and the
 * transition has nothing to animate. The click path adds the class to an
 * already-painted unlit band, which is what makes the 600 ms fade (and its
 * reduced-motion bypass) run.
 *
 * THE ART IS A FILE, THE FLICKER IS CSS. `campfire.svg` is fetched and inlined
 * because a stylesheet cannot reach inside an `<img>`. If the fetch fails the
 * band keeps the copy, the numbers and the button, and hides the empty host:
 * a decoration that did not arrive is not a stage that failed.
 */
import { escapeHtml } from './sieve-ui.mjs';

/** The pale core of the flame — the one colour the SVG has beyond the palette. */
export const FLAME_CORE = '#ffe9a8';

/** The line the stage says, whatever the night did. */
export const FIRE_COPY = 'The night is hauled. Sit by the fire and say what matters to you.';

/** This module's stylesheet, resolved beside it so a baseurl needs no wiring. */
export const STYLE_HREF = new URL('./cave-fire.css', import.meta.url).href;

/** The drawing, resolved the same way. */
export const ART_HREF = new URL('./cave-art/campfire.svg', import.meta.url).href;

const LINK_ID = 'cave-fire-css';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Tonight's count, as the one line under the copy: "312 papers in 14 wagons".
 *
 * Null means there is no night to count — the dig has not run, or the corpus
 * failed; the caller shows its muted line instead of "0 papers". A night with
 * stones but no `components` (a mount that ran before the map cut) counts
 * papers only, rather than claiming zero wagons.
 */
export function firelineText(night) {
  if (!night || !Array.isArray(night.stones) || night.stones.length === 0) return null;
  const papers = plural(night.stones.length, 'paper', 'papers');
  const wagons = Array.isArray(night.components) ? night.components.length : 0;
  if (wagons === 0) return `${papers} tonight`;
  return `${papers} in ${plural(wagons, 'wagon', 'wagons')}`;
}

/** Is this stage lit? Accepts a flow status, a snapshot, or a plain boolean. */
function isLit(flowStatus) {
  if (flowStatus === true) return true;
  if (typeof flowStatus === 'string') return flowStatus === 'done' || flowStatus === 'lit';
  if (flowStatus && typeof flowStatus === 'object') {
    const done = flowStatus.done;
    if (done && typeof done === 'object') {
      return Object.prototype.hasOwnProperty.call(done, 'fire');
    }
  }
  return false;
}

/**
 * The class lists the lit state implies: what the band carries, and what the
 * page root carries. Both are plain strings so a caller can assign them
 * wholesale — `band` is "cave-fire-band" plus "is-lit", `app` is "cave-lit" or
 * empty.
 */
export function litClassesFor(flowStatus) {
  const lit = isLit(flowStatus);
  return {
    band: 'cave-fire-band' + (lit ? ' is-lit' : ''),
    app: lit ? 'cave-lit' : '',
  };
}

/**
 * The stage body as markup. `flowStatus` is `ctx.flow.status('fire')`; a night
 * without numbers still gets the copy and the button, with a muted line where
 * the count would be.
 */
export function fireHtml(night, flowStatus) {
  const { band, app } = litClassesFor(flowStatus);
  const numbers = firelineText(night);
  const lit = app !== '';
  return '<div class="' + band + '">'
    + '<div class="cave-fire-art" aria-hidden="true"></div>'
    + '<p class="cave-fire-copy">' + escapeHtml(FIRE_COPY) + '</p>'
    + (numbers
      ? '<p class="cave-fire-numbers">' + escapeHtml(numbers) + '</p>'
      : '<p class="cave-fire-muted">The night has no numbers yet — dig, then sit by the fire.</p>')
    + '<button type="button" class="cave-fire-btn"' + (lit ? ' disabled' : '') + '>'
    + (lit ? 'The fire is lit' : 'Sit by the fire')
    + '</button>'
    + '</div>';
}


/**
 * Link this module's stylesheet once. `doc` is injectable so the test can pass
 * a fake document; the shipped call takes the page's own.
 */
export function loadStyles(doc = (typeof document !== 'undefined' ? document : null)) {
  if (!doc || !doc.head) return null;
  if (typeof doc.getElementById === 'function' && doc.getElementById(LINK_ID)) return null;
  const link = doc.createElement('link');
  link.id = LINK_ID;
  link.rel = 'stylesheet';
  link.href = STYLE_HREF;
  doc.head.appendChild(link);
  return link;
}

/** Put `cave-lit` on the page root, or take it off. */
function paintApp(lit) {
  if (typeof document === 'undefined') return;
  const app = document.getElementById('cave-app');
  if (app && app.classList) app.classList.toggle('cave-lit', lit);
}

/** Fetch the drawing into the host; a failed fetch hides the empty box. */
function inlineArt(host) {
  if (!host || typeof fetch !== 'function') return;
  fetch(ART_HREF)
    .then((resp) => (resp.ok ? resp.text() : Promise.reject(new Error('HTTP ' + resp.status))))
    .then((svg) => {
      if (svg && svg.indexOf('<svg') !== -1) host.innerHTML = svg;
    })
    .catch(() => {
      host.hidden = true;
    });
}

/**
 * Mount stage 4 into its card body.
 *
 * `ctx.night` is the only data this stage reads; `ctx.corpus` and `ctx.topics`
 * are not needed and may be null. `ctx.flow` is used for the lit state and the
 * completion; without it the band still lights, it just cannot be remembered.
 */
export function mount(bodyEl, ctx) {
  if (!bodyEl) return;
  loadStyles();

  const state = ctx || {};
  const flow = state.flow || null;
  const status = flow && typeof flow.status === 'function' ? flow.status('fire') : 'open';
  const lit = isLit(status);

  bodyEl.innerHTML = fireHtml(state.night, status);

  const band = bodyEl.querySelector('.cave-fire-band');
  const btn = bodyEl.querySelector('.cave-fire-btn');
  const art = bodyEl.querySelector('.cave-fire-art');

  paintApp(lit);
  inlineArt(art);

  if (!btn) return;

  if (!lit) {
    btn.addEventListener('click', () => {
      if (flow && flow.status('fire') === 'locked') return;
      if (band && band.classList) band.classList.add('is-lit');
      btn.textContent = 'The fire is lit';
      btn.disabled = true;
      paintApp(true);
      if (flow && typeof flow.complete === 'function') flow.complete('fire', 'by the fire');
    });
  }

  /* A new dig clears the fire (and the glow); finishing anything else leaves
     both alone. Cheap to keep in step here rather than in the shell. */
  if (flow && typeof flow.onChange === 'function') {
    flow.onChange(() => {
      const now = flow.status('fire') === 'done';
      if (band && band.classList) band.classList.toggle('is-lit', now);
      paintApp(now);
    });
  }
}
