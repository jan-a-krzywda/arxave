"""Stage 3 — relevance gate against the user's topics.

The gate result is written for *every* paper, not only the survivors. That is
the point of the memory layer: the papers that don't make the brief are still
evaluated, still stored, and still reportable. Only relevant papers advance to
status='filtered'; the rest stop at 'summarized' with relevant=0.
"""
from __future__ import annotations

import logging
import sqlite3

from . import store
from .config import Config
from .llm import LLM, LLMError, Relevance, get_llm

log = logging.getLogger(__name__)

SYSTEM_TEMPLATE = """\
You are the relevance gate for a researcher's daily paper scout. You decide
which papers are worth their attention.

Their topics of interest:
{topics}

Judge the paper against these topics.

- relevant: true only if the paper substantively concerns at least one topic.
  A passing mention, a shared piece of vocabulary, or a loose thematic
  resemblance is not enough.
- relevance_score: 0..1. Reserve above 0.8 for a direct hit on a topic.
- matched_topics: copy the matched topic strings verbatim from the list above.
  Empty when nothing matches.
- reason: one sentence.

Be strict. The value of this brief is in what it leaves out — a false positive
costs the reader more than a false negative, because they will open the PDF."""


def _system(topics: list[str]) -> str:
    return SYSTEM_TEMPLATE.format(
        topics='\n'.join(f'- {t}' for t in topics)
    )


def _prompt(row: sqlite3.Row) -> str:
    return (
        f'Title: {row["title"]}\n'
        f'Categories: {row["primary_category"]}\n\n'
        f'Summary: {row["summary"]}\n'
        f'Research question: {row["research_question"]}\n'
        f'Contribution: {row["contribution"]}'
    )


def run(cfg: Config, conn: sqlite3.Connection, llm: LLM | None = None) -> int:
    """Gate every summarized paper. Returns the count judged relevant."""
    rows = store.papers_with_status(conn, 'summarized')
    if not rows:
        return 0

    role = cfg.llm_role('light')
    llm = llm or get_llm(role)
    system = _system(cfg.topics)

    kept = 0
    for row in rows:
        try:
            result: Relevance = llm.complete_json(system, _prompt(row), Relevance)
        except LLMError as exc:
            log.warning('filter: %s failed, will retry: %s', row['cite_key'], exc)
            continue

        # Guard against a model returning topics it invented rather than
        # copying — an unmatchable string would corrupt the brief's framing.
        matched = [t for t in result.matched_topics if t in cfg.topics]

        store.upsert_paper(
            conn,
            row['cite_key'],
            relevant=int(result.relevant),
            relevance_score=result.relevance_score,
            topics=matched,
            filter_reason=result.reason,
        )
        if result.relevant:
            store.set_status(conn, row['cite_key'], 'filtered')
            kept += 1

    log.info('filter: %d/%d papers relevant', kept, len(rows))
    return kept
