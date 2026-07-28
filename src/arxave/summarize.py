"""Stage 2 — structured summary of each new paper.

Runs on the light role, once per scouted paper. The summary is what the filter
reads next, so it should be faithful rather than persuasive; the argument comes
later, in the brief.
"""
from __future__ import annotations

import logging
import sqlite3

from . import store
from .config import Config
from .llm import LLM, LLMError, Summary, get_llm

log = logging.getLogger(__name__)

SYSTEM = """\
You are a research assistant summarizing physics preprints for a working
researcher. For each paper, produce a faithful structured summary.

- summary: one paragraph covering the topic, the approach, and the main result.
- research_question: the question the paper sets out to answer.
- contribution: specifically what is new relative to prior work.

Describe only what the abstract supports. Do not speculate about impact, do not
editorialize, and do not pad. If the abstract is vague, say so plainly rather
than inventing specifics."""


def _prompt(row: sqlite3.Row) -> str:
    return (
        f'Title: {row["title"]}\n'
        f'Categories: {row["primary_category"]}\n\n'
        f'Abstract:\n{row["abstract"]}'
    )


def run(cfg: Config, conn: sqlite3.Connection, llm: LLM | None = None) -> int:
    """Summarize every paper at status='new'. Returns the count summarized."""
    rows = store.papers_with_status(conn, 'new')
    if not rows:
        return 0

    role = cfg.llm_role('light')
    llm = llm or get_llm(role)

    done = 0
    for row in rows:
        try:
            result: Summary = llm.complete_json(SYSTEM, _prompt(row), Summary)
        except LLMError as exc:
            # Leave the row at 'new' so the next run retries it.
            log.warning('summarize: %s failed, will retry: %s', row['cite_key'], exc)
            continue

        store.upsert_paper(
            conn,
            row['cite_key'],
            summary=result.summary,
            research_question=result.research_question,
            contribution=result.contribution,
            llm_model=role.model,
            status='summarized',
        )
        done += 1

    log.info('summarize: %d/%d papers', done, len(rows))
    return done
