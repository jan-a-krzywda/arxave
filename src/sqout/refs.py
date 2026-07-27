"""Stage 4a — read each paper's own bibliography from its arXiv source.

Runs before `connect` and feeds it. For every filtered paper it fetches the
e-print, parses the reference list out of the `.bbl`/`.bib`, matches each entry
against the corpus, and stores the result in the `refs` table. `connect` then
reads those matches to compute centrality and the brief's Connection line.

Why here and not in `connect`: the bibliography is worth persisting on its own
(it is what a re-run or the future shared DB reads without re-fetching), and
keeping the network fetch in its own stage means `connect` stays a pure,
offline annotation pass over data already on disk.

Idempotent: a paper that already has stored refs is skipped, so re-running the
stage doesn't re-hit arXiv. Every fetch miss is ordinary — a PDF-only
submission or a transient network error just leaves that paper without bib
refs, and `connect` falls back to OpenAlex.
"""
from __future__ import annotations

import logging
import sqlite3
import time

from . import arxiv_bib, corpus, store
from .config import Config

log = logging.getLogger(__name__)

# arXiv asks automated clients to space out e-print downloads. One request per
# paper, a short pause between — the daily firehose is small enough that this
# never dominates the run.
_FETCH_PAUSE_S = 1.0


def run(cfg: Config, conn: sqlite3.Connection, snap: corpus.Snapshot | None = None) -> int:
    """Fetch + match bibliographies for filtered papers. Returns papers with refs."""
    if not cfg.connect.enabled or not cfg.connect.arxiv_bib:
        return 0

    rows = store.papers_with_status(conn, 'filtered')
    if not rows:
        return 0

    snap = snap if snap is not None else corpus.load(cfg)

    fetched = 0
    total_matches = 0
    for row in rows:
        cite_key = row['cite_key']
        if store.has_refs(conn, cite_key):
            continue  # already fetched on an earlier run

        try:
            parsed = arxiv_bib.references(row['arxiv_id'])
        except arxiv_bib.BibError as exc:
            log.debug('refs: %s — %s', cite_key, exc)
            continue

        if not parsed:
            # Resolved but empty (PDF-only source, or an unparseable .bbl).
            # Store nothing; connect will try OpenAlex for this paper.
            continue

        for ref in parsed:
            ref['source'] = 'eprint'
            ref['matched_key'] = snap.match_ref(
                ref.get('ref_doi'), ref.get('ref_arxiv'), ref.get('ref_title')
            ) if snap else None
        store.replace_refs(conn, cite_key, parsed)

        fetched += 1
        matches = sum(1 for r in parsed if r['matched_key'])
        total_matches += matches
        time.sleep(_FETCH_PAUSE_S)

    log.info(
        'refs: fetched %d/%d bibliographies, %d corpus references matched',
        fetched, len(rows), total_matches,
    )
    return fetched
