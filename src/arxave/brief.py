"""Stage 5 — the brief. The product.

Two halves, deliberately separated: `pitch` calls the heavy model to argue for
each top paper and writes the result to the store, then `render` builds the
Markdown *from the store*. That split is what makes the brief reproducible and
disposable — it is a view, never the source of truth, and it can be
re-rendered without spending a token.
"""
from __future__ import annotations

import logging
import sqlite3
from datetime import date
from pathlib import Path

from . import store
from .config import Config
from .llm import LLM, LLMError, Pitch, get_llm

log = logging.getLogger(__name__)

VERDICTS = ('read', 'skim', 'skip')

SYSTEM = """\
You are a research scout briefing one researcher on today's arXiv. You have
already decided this paper is worth their attention; your job now is to argue
it, in four fields.

- claim: the finding as a headline. Not the paper's title — what it found.
- stakes: one line on why it matters to this reader. This leads the pitch and
  is the whole sell. Say what changes if it holds.
- connection: how it relates to their work. If you are given a list of papers
  from their library that this one cites, name them and say what the
  relationship is — extends, contradicts, applies. If no such list is given,
  do NOT claim the paper is disconnected from their library and do NOT invent
  a citation link; instead say which of their topics it bears on and what it
  would change for them. Never imply a citation you were not shown.
- verdict: exactly one of "read", "skim", or "skip".

Write for someone who will act on this without opening the PDF. Lead with
consequence, not with methodology. Be specific and concrete — no hedging, no
throat-clearing, no restating the abstract."""


def _prompt(row: sqlite3.Row) -> str:
    cited = store.json_list(row['cited_in_corpus'])
    if cited:
        shown = cited[:8]
        connection_block = 'Papers in their library that this one cites:\n' + '\n'.join(
            f'- {t}' for t in shown
        )
        if len(cited) > len(shown):
            connection_block += f'\n- ...and {len(cited) - len(shown)} more'
    else:
        connection_block = (
            'No citation overlap with their library is available. Note that this '
            'is the normal case for a new preprint and carries NO information '
            'about the paper: reference lists for preprints are usually absent '
            'from the citation index entirely. Do not say the paper is '
            'disconnected from their work, and do not guess at a link. Instead, '
            'use the connection field to state which of their topics it bears on '
            'and what it would change for them.'
        )

    topics = store.json_list(row['topics'])
    return (
        f'Title: {row["title"]}\n'
        f'Matched topics: {", ".join(topics) if topics else "(none recorded)"}\n\n'
        f'Summary: {row["summary"]}\n'
        f'Research question: {row["research_question"]}\n'
        f'Contribution: {row["contribution"]}\n\n'
        f'{connection_block}'
    )


def pitch(cfg: Config, conn: sqlite3.Connection, llm: LLM | None = None) -> int:
    """Generate pitches for the top-N ranked papers. Returns the count pitched."""
    rows = store.top_ranked(conn, cfg.ranking.top_n)
    if not rows:
        return 0

    role = cfg.llm_role('heavy')
    llm = llm or get_llm(role)
    today = date.today().isoformat()

    done = 0
    for row in rows:
        try:
            result: Pitch = llm.complete_json(SYSTEM, _prompt(row), Pitch)
        except LLMError as exc:
            log.warning('brief: %s failed, will retry: %s', row['cite_key'], exc)
            continue

        verdict = result.verdict.strip().lower()
        if verdict not in VERDICTS:
            verdict = 'skim'

        store.upsert_paper(
            conn,
            row['cite_key'],
            claim=result.claim,
            stakes=result.stakes,
            connection=result.connection,
            verdict=verdict,
            briefed_on=today,
            status='briefed',
        )
        done += 1

    log.info('brief: %d papers pitched', done)
    return done


# --------------------------------------------------------------------------
# rendering
# --------------------------------------------------------------------------

def _arxiv_links(arxiv_id: str) -> str:
    return (
        f'[arXiv:{arxiv_id}](https://arxiv.org/abs/{arxiv_id}) · '
        f'[PDF](https://arxiv.org/pdf/{arxiv_id})'
    )


def _slide(n: int, row: sqlite3.Row) -> list[str]:
    verdict = (row['verdict'] or 'skim').lower()
    out = [
        f'## {n}. {row["claim"] or row["title"]}',
        '',
        f'**Why it matters** — {row["stakes"] or "—"}',
        '',
        f'**Connection** — {row["connection"] or "—"}',
        '',
        f'**Verdict: {verdict}** · {_arxiv_links(row["arxiv_id"])}',
        '',
        f'<sub>{row["title"]}</sub>',
        '',
    ]
    return out


def render(cfg: Config, conn: sqlite3.Connection, on_date: date | None = None) -> Path:
    """Render the brief from the store. Returns the written path."""
    on_date = on_date or date.today()
    briefed = list(conn.execute(
        'SELECT * FROM papers WHERE briefed_on=? ORDER BY importance DESC NULLS LAST',
        (on_date.isoformat(),),
    ))
    pitched_keys = {r['cite_key'] for r in briefed}
    others = store.also_evaluated(conn, pitched_keys)

    lines = [
        f'# Morning brief — {on_date.isoformat()}',
        '',
    ]

    if briefed:
        n_relevant = sum(1 for r in others if r['relevant']) + len(briefed)
        lines += [
            f'*{len(briefed)} of {len(others) + len(briefed)} papers evaluated '
            f'made the cut ({n_relevant} were on-topic).*',
            '',
            '---',
            '',
        ]
        for i, row in enumerate(briefed, 1):
            lines += _slide(i, row)
            lines += ['---', '']
    else:
        lines += [
            '*Nothing cleared the bar today.* Everything evaluated is recorded '
            'below and in `papers.db`.',
            '',
            '---',
            '',
        ]

    lines += [f'## Also evaluated ({len(others)})', '']
    if others:
        lines += [
            'Seen, judged, and remembered — not pitched.',
            '',
            '| Paper | On topic | Why not |',
            '|---|---|---|',
        ]
        for row in others:
            title = (row['title'] or row['cite_key']).replace('|', r'\|')
            on_topic = 'yes' if row['relevant'] else 'no'
            reason = (row['filter_reason'] or '—').replace('|', r'\|')
            lines.append(
                f'| [{title}](https://arxiv.org/abs/{row["arxiv_id"]}) '
                f'| {on_topic} | {reason} |'
            )
        lines.append('')
    else:
        lines += ['Nothing else was evaluated in this run.', '']

    lines += [
        '---',
        '',
        '## Sciting but unseen',
        '',
        '*Papers the community is sciting that your topic filters missed.*',
        '',
        'Not yet available — Scirate integration lands in M3.',
        '',
    ]

    cfg.briefs_dir.mkdir(parents=True, exist_ok=True)
    path = cfg.briefs_dir / f'{on_date.isoformat()}.md'
    path.write_text('\n'.join(lines))
    log.info('brief: wrote %s', path)
    return path
