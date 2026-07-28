"""Stage 4b — ground each paper against the corpus. Read-only.

Intersect a paper's reference list against the corpus snapshot. The overlap is
two things at once: the centrality signal for ranking, and the raw material for
the brief's "Connection" line — the part no generic tool can produce.

Two reference sources, tried in order:

  1. The paper's own arXiv bibliography, read from its `.bbl`/`.bib` by the
     `refs` stage. This ships inside the e-print at posting time, so it is
     populated for same-day preprints — the daily firehose arxave prioritizes.
     It is the primary source.

  2. OpenAlex, as a fallback for papers the bibliography couldn't connect.
     OpenAlex trails arXiv posting (DataCite + indexing lag), and its preprint
     records are often reference-less stubs — measured on arXiv:2112.08863,
     the arXiv-DOI record reports 0 referenced_works while the Rev. Mod. Phys.
     record for the same paper reports 664. So OpenAlex earns its keep on
     older papers and on re-runs after publication, not on fresh preprints —
     which is exactly why source 1 exists.

Nothing here writes to the corpus. No `library.bib` append, no `works.json`
merge, no graph rebuild; those are M2.

Every miss is ordinary, not an error: centrality stays NULL and the brief is
written to read correctly without it.
"""
from __future__ import annotations

import logging
import sqlite3

from . import corpus, openalex, store
from .config import Config

log = logging.getLogger(__name__)

# Overlap count that saturates the centrality signal. Citing ten corpus papers
# rather than five says "lands in a dense part of your library"; the difference
# between twenty and thirty says little more.
SATURATION = 10.0


def _bib_matches(conn: sqlite3.Connection, cite_key: str) -> list[str]:
    """Corpus cite_keys this paper cites, from its own arXiv bibliography.

    These come from the `refs` stage — the paper's `.bbl`/`.bib` matched
    against the corpus. Unlike OpenAlex this is populated for same-day
    preprints, so it is the primary connection source."""
    seen: list[str] = []
    for r in store.refs_for(conn, cite_key):
        key = r['matched_key']
        if key and key not in seen:
            seen.append(key)
    return seen


def _write_connection(conn: sqlite3.Connection, cite_key: str, cited_keys: list[str],
                      snap: corpus.Snapshot, **extra) -> None:
    store.upsert_paper(
        conn,
        cite_key,
        centrality=min(len(cited_keys) / SATURATION, 1.0),
        cited_in_corpus=[snap.titles.get(k, k) for k in cited_keys],
        **extra,
    )


def run(cfg: Config, conn: sqlite3.Connection, snap: corpus.Snapshot | None = None) -> int:
    """Annotate filtered papers with corpus overlap. Returns papers connected.

    Two citation sources, bib first: the paper's own arXiv bibliography (stored
    by the `refs` stage, and populated even for same-day preprints), then
    OpenAlex as a fallback for papers the bib couldn't connect — older papers,
    or ones with no readable source."""
    if not cfg.connect.enabled:
        log.info('connect: disabled in config')
        return 0

    rows = store.papers_with_status(conn, 'filtered')
    if not rows:
        return 0

    snap = snap if snap is not None else corpus.load(cfg)
    if not snap:
        log.warning(
            'connect: no corpus snapshot, skipping. Run `arxave sync-corpus`.'
        )
        return 0

    connected = 0
    from_bib = 0
    unconnected: list[sqlite3.Row] = []
    for row in rows:
        cited_keys = _bib_matches(conn, row['cite_key'])
        if cited_keys:
            _write_connection(conn, row['cite_key'], cited_keys, snap)
            connected += 1
            from_bib += 1
        else:
            unconnected.append(row)

    # OpenAlex fallback — only for papers the bibliography couldn't connect.
    from_oa = _openalex_fallback(cfg, conn, snap, unconnected)
    connected += from_oa

    log.info(
        'connect: %d/%d cite the corpus (%d from bib, %d from OpenAlex fallback)',
        connected, len(rows), from_bib, from_oa,
    )
    if rows and not connected:
        log.info(
            'connect: no connection lines this run — neither the papers\' '
            'bibliographies nor OpenAlex overlapped the corpus.'
        )
    return connected


def _openalex_fallback(cfg: Config, conn: sqlite3.Connection, snap: corpus.Snapshot,
                       rows: list[sqlite3.Row]) -> int:
    """Resolve papers with no bib match through OpenAlex. Returns papers connected.

    This is the original citation route: it earns its keep on older papers and
    on re-runs after a preprint is published, where OpenAlex has a real
    reference list that the fresh .bbl scan may have missed."""
    if not rows:
        return 0

    dois = {r['cite_key']: openalex.arxiv_doi(r['arxiv_id']) for r in rows}
    dois = {k: v for k, v in dois.items() if v}
    if not dois:
        return 0

    try:
        resolved = openalex.resolve_by_doi(dois, mailto=cfg.connect.openalex_mailto)
    except openalex.OpenAlexError as exc:
        # Non-fatal by design: rank and brief both handle absent centrality.
        log.warning('connect: OpenAlex unavailable, continuing without: %s', exc)
        return 0

    connected = 0
    for row in rows:
        record = resolved.get(row['cite_key'])
        if record is None:
            continue  # not indexed yet — the common case for fresh preprints
        refs = record['referenced_works']
        if not refs:
            # Resolved, but a stub with no reference list. Record the OpenAlex
            # ID anyway — it distinguishes "found, told us nothing" from "never
            # found" and is what a later re-run needs.
            store.upsert_paper(
                conn, row['cite_key'],
                doi=record['doi'], openalex_id=record['openalex_id'],
            )
            continue
        cited_keys = openalex.overlap(refs, snap.ids)
        _write_connection(
            conn, row['cite_key'], cited_keys, snap,
            doi=record['doi'], openalex_id=record['openalex_id'],
        )
        if cited_keys:
            connected += 1
    return connected
