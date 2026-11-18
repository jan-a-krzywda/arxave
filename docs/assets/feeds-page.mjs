/**
 * feeds-page — the Feeds room: every launch link on one page.
 *
 * A reader sent one launch link has no way to find the other eleven: the
 * addresses live in `cave-launch.mjs`, and the nav had no room that listed
 * them. So the room is RENDERED FROM THE TABLE rather than written into
 * `feeds.md` — a hand-kept list drifts the day a row is added, and nothing on
 * the page would say it had. `tests/js/feeds.test.mjs` holds the two ends
 * together.
 *
 * ONE SECTION PER FIELD, in the order the fields first appear in the table, and
 * the heading is the field's own label from `cave-fields.mjs` — the same word
 * the Dig uses when it names the pack — so a third pack needs no edit here. The
 * phrase rides along in a smaller line: it is what the launch ranks against, and
 * the one honest answer to a reader asking what they will get.
 *
 * Pure: a string in, a string out, no document. `feeds.md` mounts it.
 */
import { LAUNCHES } from './cave-launch.mjs';
import { fieldById } from './cave-fields.mjs';
import { escapeHtml } from './sieve-ui.mjs';

/** One card: the label a reader scans, the codes, and the phrase. */
function cardHtml(launch) {
  const cats = (launch.categories || []).join(' · ');
  return `<a class="feeds-card" href="/${escapeHtml(launch.id)}">
          <span class="feeds-card-label">${escapeHtml(launch.label)}</span>
          <span class="feeds-card-cats">${escapeHtml(cats)}</span>
          <span class="feeds-card-phrase">${escapeHtml(launch.phrase)}</span>
        </a>`;
}

/**
 * Every launch, grouped by field, as HTML.
 *
 * A launch whose field is not a pack falls back to the field id as its heading
 * rather than disappearing: the room's promise is that every link is on it.
 */
export function feedsHtml(launches) {
  const sections = [];
  const byField = new Map();
  for (const launch of Array.isArray(launches) ? launches : []) {
    const field = fieldById(launch.field);
    const key = field ? field.id : launch.field;
    if (!byField.has(key)) {
      byField.set(key, { label: field?.label ?? launch.field, cards: [] });
    }
    byField.get(key).cards.push(launch);
  }
  for (const { label, cards } of byField.values()) {
    sections.push(`<section class="feeds-field">
        <h2 class="feeds-field-head">${escapeHtml(label)}</h2>
        <div class="feeds-grid">
        ${cards.map(cardHtml).join('\n        ')}
        </div>
      </section>`);
  }
  return sections.join('\n    ');
}

/** Fill a container with the list this build ships. `feeds.md` is the caller. */
export function mountFeeds(root) {
  if (root) root.innerHTML = feedsHtml(LAUNCHES);
}
