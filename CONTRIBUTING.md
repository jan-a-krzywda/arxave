# Contributing to arXave

## The idea

arXiv drops hundreds of papers every night. Reading them is not the hard part —
finding the few that matter is. Somewhere in the pile is the paper that changes
what you build next month, and next to it sits pyrite: a big name and a big
claim that costs you three evenings and the real nugget you didn't pick up
because your hands were full.

arXave is a lamp and a sieve. Every morning it washes the whole night against
*your* seam, holds up the few stones that match, and says **why** each one looks
like gold. Every rock it touches goes in the bag — even the ones it throws
back — so nothing is lost and you can re-wash later when your seam changes.

Two goals, only two:

1. Never miss a nugget that matters.
2. More tunnel swept in the same hours, less pyrite carried home.

The [README](README.md) has the longer version and the layout of the four
rooms (Dig, Stockpile, Haul, Details).

## Help wanted

- **Seams.** The catalogue of curated presets in [`docs/presets/`](docs/presets/)
  is where a field becomes a one-click filter. A good seam is worth more than a
  code change. Add one for a corner of arXiv you know well.
- **The rush.** Crowd-attention signal (Scirate scites) is stubbed and parked
  behind a Cloudflare challenge. A working path here is open.
- **Connections from references.** We build paper-to-paper links from each
  preprint's e-print `.bbl` rather than a citation index, because fresh
  preprints aren't indexed. Edge cases in that parser are worth reporting.
- **Bugs and rough edges.** Open an issue with the night, the categories, and
  what you expected.

## How to work

- Open an issue before a large change so we can agree on the shape.
- Keep pull requests focused — one concern per PR.
- The site is Jekyll under [`docs/`](docs/); the nightly pipeline is Python and
  Node under [`scripts/`](scripts/) and [`src/`](src/).
- Match the voice of the file you're editing. The prose here leans terse and
  concrete on purpose.

## Contact

[Jan A. Krzywda](https://jan-a-krzywda.com/) and collaborators. Issues and pull
requests on GitHub are the best channel.
