"""Stage 4a — Scirate scite counts. Stubbed in M1.

Scirate has no official API, so the real implementation (M3) scrapes and is
best-effort by nature. The interface is settled now so that dropping it in
later touches nothing else.

The contract that matters: an unavailable count is `None`, never 0. Ranking
renormalizes over the signals actually present, so `None` removes the scite
weight from that paper's blend instead of scoring it as "nobody cared".
"""
from __future__ import annotations

import logging

log = logging.getLogger(__name__)

_warned = False


def scites_for(arxiv_ids: list[str]) -> dict[str, int | None]:
    """arXiv ID -> scite count, or None where unavailable.

    M1 stub: every value is None.
    """
    global _warned
    if arxiv_ids and not _warned:
        log.info('scirate: stubbed in M1 — ranking uses LLM judgment and centrality')
        _warned = True
    return {aid: None for aid in arxiv_ids}
