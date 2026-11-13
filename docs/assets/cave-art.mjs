/**
 * cave-art — where the pixel art lives, and the one string of markup the page
 * builds from it.
 *
 * The four SVGs in `cave-art/` are static files, not JS: they are decoration,
 * they never change at runtime, and keeping them as files means the browser
 * caches them for free. What is left here is the two things a page must not
 * guess — the paths, and the empty-state markup whose text is untrusted.
 *
 * PATHS ARE SITE-ROOT (`/assets/…`), matching how `_includes/head.html` links
 * the stylesheets. A page under a Jekyll baseurl prefixes them with
 * `relative_url` when it hands them over; nothing here assumes one.
 *
 * THE FLICKER NEEDS THE SVG IN THE PAGE. `.cv-flame` is styled in
 * cave-tokens.css, and CSS cannot reach inside an `<img src=…>`; the header
 * band therefore wants its SVG inlined for the flame to move, while the empty
 * states are stills and are fine as `<img>` (which is what `emptyState` emits).
 */
import { escapeHtml } from './sieve-ui.mjs';

export const ART = Object.freeze({
  header: '/assets/cave-art/cave-header.svg',
  idle: '/assets/cave-art/empty-idle.svg',
  none: '/assets/cave-art/empty-none.svg',
  digging: '/assets/cave-art/empty-digging.svg',
});

/* The three empty-state drawings are 128 px squares (16 cells of 8 px); the
   header is 640×128. Declared here so a page can reserve the space before the
   file arrives instead of jumping when it does. */
export const ART_SIZE = Object.freeze({ width: 128, height: 128 });

const KINDS = new Set(['idle', 'none', 'digging']);

/**
 * The empty state markup: the drawing, and the line the caller supplies.
 *
 * `kind` picks the picture ('idle' — nothing to do, 'none' — no papers yet,
 * 'digging' — working); anything else is a programming error and throws rather
 * than rendering a hole. `text` is the reader-facing sentence and is escaped:
 * a paper title carrying `<` reaches this function often enough.
 */
export function emptyState(kind, text) {
  if (!KINDS.has(kind)) throw new TypeError(`cave-art: unknown empty state "${kind}"`);
  return `<div class="cv-empty" data-kind="${kind}">`
    + `<img class="cv-empty-art" src="${ART[kind]}" alt="" `
    + `width="${ART_SIZE.width}" height="${ART_SIZE.height}" decoding="async">`
    + `<p class="cv-empty-text">${escapeHtml(text)}</p>`
    + '</div>';
}
