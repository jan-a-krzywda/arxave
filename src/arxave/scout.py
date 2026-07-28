"""Stage 1 — pull the overnight arXiv firehose for the configured categories.

Written from scratch: the spec refers to reusing a `daily_arxiv.py`, but no
such file exists in the corpus repo.

Idempotent by construction — `arxiv_id` is UNIQUE and the cite key is derived
from it, so re-running the same day enriches existing rows rather than
inserting duplicates.
"""
from __future__ import annotations

import logging
import sqlite3
from datetime import date, datetime, timedelta, timezone

from . import store
from .config import Config

log = logging.getLogger(__name__)


def _query(categories: list[str]) -> str:
    return ' OR '.join(f'cat:{c}' for c in categories)


def cutoff_date(on_date: date, lookback_days: int) -> date:
    """Walk back `lookback_days` *publishing* days, skipping weekends.

    arXiv does not announce on Saturday or Sunday, so a plain calendar
    subtraction returns an empty window every Monday — the newest submissions
    are from Friday. Counting publishing days instead means a Monday run with
    lookback_days=1 reaches back to Friday and picks up the weekend's backlog.
    """
    cursor = on_date
    remaining = max(lookback_days, 1)
    while remaining > 0:
        cursor -= timedelta(days=1)
        if cursor.weekday() < 5:  # Mon-Fri
            remaining -= 1
    return cursor


def fetch(cfg: Config, on_date: date | None = None) -> list[dict]:
    """Fetch recent papers. Returns plain dicts so `--dry-run` needs no DB."""
    import arxiv

    on_date = on_date or date.today()
    cutoff = datetime.combine(
        cutoff_date(on_date, cfg.scout.lookback_days),
        datetime.min.time(),
        tzinfo=timezone.utc,
    )

    search = arxiv.Search(
        query=_query(cfg.scout.categories),
        max_results=cfg.scout.max_results,
        sort_by=arxiv.SortCriterion.SubmittedDate,
        sort_order=arxiv.SortOrder.Descending,
    )

    papers: list[dict] = []
    for result in arxiv.Client().results(search):
        published = result.published
        if published is not None and published < cutoff:
            # Results are date-sorted, so the first old one ends the window.
            break
        authors = [a.name for a in result.authors]
        arxiv_id = store.bare_arxiv_id(result.entry_id)
        published_iso = published.date().isoformat() if published else ''
        papers.append({
            'cite_key': store.make_cite_key(authors, published_iso, arxiv_id),
            'arxiv_id': arxiv_id,
            'title': (result.title or '').strip().replace('\n', ' '),
            'authors': authors,
            'published': published_iso,
            'primary_category': result.primary_category or '',
            'abstract': (result.summary or '').strip(),
        })
    return papers


def run(cfg: Config, conn: sqlite3.Connection, on_date: date | None = None) -> int:
    """Insert fetched papers at status='new'. Returns the count fetched."""
    papers = fetch(cfg, on_date)
    today = date.today().isoformat()

    for p in papers:
        cite_key = p.pop('cite_key')
        existing = conn.execute(
            'SELECT status FROM papers WHERE cite_key=?', (cite_key,)
        ).fetchone()
        if existing:
            # Seen before — leave its status alone so a later stage's progress
            # isn't reset by an overlapping lookback window.
            continue
        store.upsert_paper(
            conn, cite_key, **p, first_seen=today, status='new'
        )

    log.info('scout: %d papers since %s in %s',
             len(papers), cutoff_date(on_date or date.today(), cfg.scout.lookback_days),
             ', '.join(cfg.scout.categories))
    return len(papers)
