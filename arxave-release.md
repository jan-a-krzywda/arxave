# arXave release plan

Five chunks. Each one lands on its own, site stays shippable between them.
Tick a box when the chunk is done and verified by a Jekyll build.

---

## Chunk 1 — Header: four icons, centred, with glosses

**Why.** Today the nav is three words in the top-right corner, in minima's
default rail. A first-time visitor lands on the root, sees a filter form, and
has no idea the site has three other rooms. Make the nav the first thing the
eye lands on: four pixel icons, centred under the wordmark, each with its
one-word gloss.

**What changes**

- `docs/_includes/header.html` — replace the `page_paths` loop with an explicit
  four-item nav: Dig, Stockpile, Haul, Details. Each item is a pixel-art inline
  SVG icon over a label over a gloss.
- Glosses: Dig — *new*, Stockpile — *history*, Haul — *today*, Details — *how it
  works*.
- Mark the current room: `page.url` match sets `.is-here`.
- Keep the GitHub star link, moved to the right of the bar so it does not sit
  inside the centred group.
- Keep the mobile checkbox/label menu working; below 600px the four icons stay
  in one row but drop to icon + label, gloss hidden.
- `docs/_sass/cave.scss` — styles for the new nav.
- `docs/_config.yml` — `header_pages` no longer drives the nav; keep the key out
  or note it is unused, and add `details.md`.

**Done when**

- [x] Root, /stockpile/, /haul/, /details/ all show the same centred four-icon bar.
- [x] Current room is visibly marked.
- [x] Nav is usable at 375px wide.

---

## Chunk 2 — Menu labels carry their gloss

**Why.** "Stockpile" and "Haul" are cave words. They are the right words — they
are what the thing *is* — but a stranger cannot rank them. The gloss is the
translation, and it belongs next to the word, not in a paragraph further down.

**What changes**

- Glosses ship as part of Chunk 1's nav markup (`Dig (new)`, `Stockpile
  (history)`, `Haul (today)`, `Details (how it works)`).
- `docs/filter.md`, `docs/stockpile.md`, `docs/haul.md` — page `title` stays the
  cave word; a new `gloss` front-matter key holds the translation so the layout
  and the nav read from one source.

**Done when**

- [x] Every nav item shows word + gloss.
- [x] No page title changed, so no link or anchor moved.

---

## Chunk 3 — Details page

**Why.** Nothing on the site explains the machine. The README does, but the
README is on GitHub, and the site is where people land. Details is the room you
walk into when you want to know what "pay dirt" means before you trust a ranking
that used it.

**What changes**

- New `docs/details.md`, `permalink: /details/`, `layout: page`.
- Sections:
  1. **What arXave does** — the one-paragraph version.
  2. **The three rooms** — Dig, Stockpile, Haul, what each is for.
  3. **How a rock gets graded** — scout → summarize → filter → refs → connect →
     rank → brief, one line each, plus the three ranking signals and what is
     deliberately *not* a signal.
  4. **Reading a card** — the six drawers, band names, what "pay dirt / worth a
     look / long shot" mean.
  5. **Seams and presets** — what a preset is, how to bend one.
  6. **Where the compute runs** — browser vs Supabase `embed`/`relay`, what text
     is cached and what never is.
  7. **Running it yourself** — CLI pointer, short.
  8. **What is not built yet** — honest list, WIP-marked.
- Pixel wall gutters, same as every other room.

**Done when**

- [x] /details/ builds and is reachable from the nav on every page.
- [x] Every claim on it is true of the code as it stands today.

---

## Chunk 4 — Stockpile and Haul get their own walls

**Why.** Dig has pixel rock in the gutters and the other two rooms have blank
margin. Same building, different rooms — the walls should say which room you are
in without reading a word.

**What changes**

- Move the `.cave-wall` base rules out of `assets/filter.css` into
  `assets/style.css`, which all three pages already load. Add a
  `--cave-wall-art` custom property so each page points the same rules at its
  own tile.
- New `docs/assets/stockpile-wall.svg` — sorted stone stacked in bins: neat
  courses of graded blocks, biggest at the bottom, a gold-flecked one near the
  top of a stack. Sorted, not scattered: this is the room where everything is
  already filed.
- New `docs/assets/haul-wall.svg` — market stalls: awning stripes, stones laid
  out on a counter, small price tags and a scale. This is the room where the
  night's stone is offered.
- `docs/stockpile.md`, `docs/haul.md` — add the two `.cave-wall` divs and set
  the tile.
- Same rules as the existing wall: 8px blocks, `shape-rendering: crispEdges`,
  `image-rendering: pixelated`, palette from `cave.scss`, hidden below 1340px.

**Done when**

- [x] Three rooms, three distinct walls, all in the same sprite language.
- [x] No horizontal scrollbar at any width; text never overlapped.

---

## Chunk 5 — README

**Why.** Release readme. It is the pitch, and right now it does not mention the
three rooms, the feeds, or the cards — it describes the M1 filter page and the
CLI.

**What changes**

- Keep caveman voice throughout. Keep the logo and the "Cave dark" line.
- Add **What you can do** near the top: a short table of the four rooms with
  links, then three worked "you want X → do Y" walkthroughs.
- Add a card anatomy block — what a paper looks like when arXave hands it to you.
- Update status: browser Dig, nightly preset feeds, stockpile archive, details.
- Fold the CLI down to its own section, below the browser story.
- Prune stale claims; keep the OpenAlex/`.bbl` finding and the pyrite defence,
  they are the load-bearing arguments.

**Done when**

- [x] A stranger reading the top third knows what the site does and where to click.
- [x] No link in it 404s.
