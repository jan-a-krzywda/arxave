"""Stage 4c — blend the signals into a single `importance`.

No single relevance signal is trustworthy, so the score triangulates three:
LLM judgment, in-corpus citation centrality, and crowd attention (scites).

The blend renormalizes over whichever signals a given paper actually has. A
paper with no OpenAlex record yet is scored on the signals available rather
than penalized for the absence — otherwise the ranking would systematically
bury the newest papers, which is precisely backwards for a daily scout.
"""
from __future__ import annotations

import logging
import sqlite3

from . import scirate, store
from .config import Config

log = logging.getLogger(__name__)

# Scite count that saturates the crowd-attention signal.
SCITE_SATURATION = 20.0


def blend(signals: dict[str, float | None], weights: dict[str, float]) -> float:
    """Weighted mean over present signals only.

    Returns 0.0 when nothing is present — a paper with no usable signal sorts
    last rather than raising.
    """
    present = {
        k: v for k, v in signals.items()
        if v is not None and weights.get(k, 0.0) > 0
    }
    if not present:
        return 0.0
    total_weight = sum(weights[k] for k in present)
    if total_weight <= 0:
        return 0.0
    return sum(weights[k] * v for k, v in present.items()) / total_weight


def run(cfg: Config, conn: sqlite3.Connection) -> int:
    """Score every filtered paper. Returns the count ranked."""
    rows = store.papers_with_status(conn, 'filtered')
    if not rows:
        return 0

    scites = scirate.scites_for([r['arxiv_id'] for r in rows])

    for row in rows:
        raw_scites = scites.get(row['arxiv_id'])
        scite_signal = (
            min(raw_scites / SCITE_SATURATION, 1.0) if raw_scites is not None else None
        )
        importance = blend(
            {
                'llm': row['relevance_score'],
                'centrality': row['centrality'],
                'scites': scite_signal,
            },
            cfg.ranking.weights,
        )
        store.upsert_paper(
            conn,
            row['cite_key'],
            scites=raw_scites,
            importance=importance,
            status='ranked',
        )

    log.info('rank: %d papers scored', len(rows))
    return len(rows)
