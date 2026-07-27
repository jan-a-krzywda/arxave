"""papers.db — the memory layer.

Everything the scout evaluates lands here, including what the brief omits.
Two invariants hold the pipeline together:

  * every write is an upsert keyed on `cite_key`, so re-running a stage
    enriches rows instead of duplicating them;
  * `status` is the resume marker — each stage selects only rows in its input
    status, so a crashed run picks up where it stopped.
"""
from __future__ import annotations

import json
import re
import sqlite3
import unicodedata
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from typing import Any, Iterator

# Pipeline order. A stage reads rows at status[i] and advances them to status[i+1].
STATUSES = ('new', 'summarized', 'filtered', 'ranked', 'briefed')

SCHEMA = """
CREATE TABLE IF NOT EXISTS papers (
    cite_key        TEXT PRIMARY KEY,
    arxiv_id        TEXT UNIQUE,
    doi             TEXT,
    openalex_id     TEXT,
    title           TEXT,
    authors         TEXT,               -- JSON array
    published       TEXT,               -- ISO date
    primary_category TEXT,
    abstract        TEXT,
    -- LLM enrichment --
    summary         TEXT,
    research_question TEXT,
    contribution    TEXT,
    topics          TEXT,               -- JSON array of matched user topics
    relevance_score REAL,
    relevant        INTEGER,
    filter_reason   TEXT,
    -- ranking --
    scites          INTEGER,
    centrality      REAL,
    cited_in_corpus TEXT,               -- JSON array of matched corpus titles
    importance      REAL,
    -- briefing --
    claim           TEXT,
    stakes          TEXT,
    connection      TEXT,
    verdict         TEXT,
    briefed_on      TEXT,
    -- bookkeeping --
    first_seen      TEXT,
    llm_model       TEXT,
    status          TEXT
);

CREATE INDEX IF NOT EXISTS idx_papers_status ON papers(status);

CREATE TABLE IF NOT EXISTS embeddings (
    cite_key TEXT PRIMARY KEY REFERENCES papers(cite_key),
    dim      INTEGER,
    vector   BLOB
);

CREATE TABLE IF NOT EXISTS refs (
    cite_key    TEXT REFERENCES papers(cite_key),  -- the citing arXiv paper
    raw         TEXT,               -- the bib entry verbatim
    ref_doi     TEXT,               -- parsed, normalized, nullable
    ref_arxiv   TEXT,               -- parsed bare arXiv id, nullable
    ref_title   TEXT,               -- parsed, nullable
    matched_key TEXT,               -- corpus cite_key if it overlaps, else NULL
    source      TEXT                -- 'eprint' | 'openalex'
);

CREATE INDEX IF NOT EXISTS idx_refs_cite_key ON refs(cite_key);

CREATE TABLE IF NOT EXISTS runs (
    run_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    started    TEXT,
    topics     TEXT,
    n_scraped  INTEGER,
    n_relevant INTEGER,
    n_briefed  INTEGER
);
"""

# Columns a stage is allowed to write. Guards against a typo silently
# becoming a no-op UPDATE.
_WRITABLE = {
    'arxiv_id', 'doi', 'openalex_id', 'title', 'authors', 'published',
    'primary_category', 'abstract', 'summary', 'research_question',
    'contribution', 'topics', 'relevance_score', 'relevant', 'filter_reason',
    'scites', 'centrality', 'cited_in_corpus', 'importance', 'claim', 'stakes',
    'connection', 'verdict', 'briefed_on', 'first_seen', 'llm_model', 'status',
}


# --------------------------------------------------------------------------
# cite keys
# --------------------------------------------------------------------------

def bare_arxiv_id(raw: str) -> str:
    """Strip URL wrapper and version suffix: '.../abs/2401.12345v2' -> '2401.12345'."""
    s = (raw or '').strip()
    s = re.sub(r'^https?://arxiv\.org/abs/', '', s, flags=re.IGNORECASE)
    s = re.sub(r'^arxiv:', '', s, flags=re.IGNORECASE)
    return re.sub(r'v\d+$', '', s)


def _lastname(author: str) -> str:
    """Last whitespace token, ASCII-folded, alphanumerics only.

    'Lieven M. K. Vandersypen' -> 'Vandersypen'; 'J. Krzywda' -> 'Krzywda';
    'Ana Muñoz' -> 'Munoz'. Falls back to 'Anon' when nothing survives.
    """
    tokens = (author or '').strip().split()
    if not tokens:
        return 'Anon'
    folded = unicodedata.normalize('NFKD', tokens[-1])
    ascii_only = folded.encode('ascii', 'ignore').decode('ascii')
    cleaned = re.sub(r'[^A-Za-z0-9]', '', ascii_only)
    return cleaned.capitalize() if cleaned else 'Anon'


def make_cite_key(authors: list[str] | None, published: str | None, arxiv_id: str) -> str:
    """`{Lastname}{Year}_{arxiv_id}` — e.g. 'Petta2024_2401.12345'.

    Collision-proof by construction, since arXiv IDs are unique. The prefix
    keeps it readable and roughly compatible with the corpus's `Author2012`
    style, but uniqueness never depends on it.
    """
    last = _lastname(authors[0]) if authors else 'Anon'
    year = (published or '')[:4]
    if not re.fullmatch(r'\d{4}', year):
        year = ''
    return f'{last}{year}_{bare_arxiv_id(arxiv_id)}'


# --------------------------------------------------------------------------
# connection
# --------------------------------------------------------------------------

@contextmanager
def connect(db_path: Path) -> Iterator[sqlite3.Connection]:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(SCHEMA)
        yield conn
        conn.commit()
    finally:
        conn.close()


# --------------------------------------------------------------------------
# writes
# --------------------------------------------------------------------------

def upsert_paper(conn: sqlite3.Connection, cite_key: str, **fields: Any) -> None:
    """Insert or enrich. Only the passed fields are touched; existing values
    for unmentioned columns survive, which is what makes re-runs safe."""
    unknown = set(fields) - _WRITABLE
    if unknown:
        raise ValueError(f'unknown column(s) for papers: {sorted(unknown)}')
    if not fields:
        return

    for json_col in ('authors', 'topics', 'cited_in_corpus'):
        if isinstance(fields.get(json_col), (list, tuple)):
            fields[json_col] = json.dumps(list(fields[json_col]))

    cols = ['cite_key', *fields]
    placeholders = ', '.join('?' for _ in cols)
    updates = ', '.join(f'{c}=excluded.{c}' for c in fields)
    conn.execute(
        f'INSERT INTO papers ({", ".join(cols)}) VALUES ({placeholders}) '
        f'ON CONFLICT(cite_key) DO UPDATE SET {updates}',
        [cite_key, *fields.values()],
    )


def set_status(conn: sqlite3.Connection, cite_key: str, status: str) -> None:
    if status not in STATUSES:
        raise ValueError(f'unknown status {status!r}; expected one of {STATUSES}')
    conn.execute('UPDATE papers SET status=? WHERE cite_key=?', (status, cite_key))


# --------------------------------------------------------------------------
# reads
# --------------------------------------------------------------------------

def papers_with_status(conn: sqlite3.Connection, status: str) -> list[sqlite3.Row]:
    return list(conn.execute(
        'SELECT * FROM papers WHERE status=? ORDER BY published DESC, cite_key',
        (status,),
    ))


def top_ranked(conn: sqlite3.Connection, limit: int) -> list[sqlite3.Row]:
    """Highest-importance ranked papers that have not been briefed yet."""
    return list(conn.execute(
        'SELECT * FROM papers WHERE status=? AND briefed_on IS NULL '
        'ORDER BY importance DESC NULLS LAST, cite_key LIMIT ?',
        ('ranked', limit),
    ))


def also_evaluated(conn: sqlite3.Connection, exclude: set[str]) -> list[sqlite3.Row]:
    """Everything seen this run that isn't being pitched — the accumulation
    the brief reports but doesn't sell."""
    rows = conn.execute(
        'SELECT * FROM papers WHERE briefed_on IS NULL '
        'ORDER BY relevant DESC NULLS LAST, importance DESC NULLS LAST, cite_key'
    )
    return [r for r in rows if r['cite_key'] not in exclude]


def status_counts(conn: sqlite3.Connection) -> dict[str, int]:
    return {
        row['status']: row['n']
        for row in conn.execute(
            'SELECT status, COUNT(*) AS n FROM papers GROUP BY status'
        )
    }


def json_list(value: str | None) -> list:
    """Decode a JSON-array column, tolerating NULL and legacy plain text."""
    if not value:
        return []
    try:
        decoded = json.loads(value)
    except (TypeError, ValueError):
        return [value]
    return decoded if isinstance(decoded, list) else [decoded]


# --------------------------------------------------------------------------
# references (the citing paper's own bibliography)
# --------------------------------------------------------------------------

_REF_FIELDS = ('raw', 'ref_doi', 'ref_arxiv', 'ref_title', 'matched_key', 'source')


def replace_refs(conn: sqlite3.Connection, cite_key: str, refs: list[dict]) -> None:
    """Overwrite the reference list for one paper.

    Delete-then-insert keyed on cite_key, so re-running the refs stage refreshes
    a paper's bibliography instead of duplicating it — the same idempotence the
    rest of the pipeline relies on.
    """
    conn.execute('DELETE FROM refs WHERE cite_key=?', (cite_key,))
    if not refs:
        return
    rows = [
        (cite_key, *(r.get(f) for f in _REF_FIELDS))
        for r in refs
    ]
    conn.executemany(
        f'INSERT INTO refs (cite_key, {", ".join(_REF_FIELDS)}) '
        f'VALUES (?, {", ".join("?" for _ in _REF_FIELDS)})',
        rows,
    )


def refs_for(conn: sqlite3.Connection, cite_key: str) -> list[sqlite3.Row]:
    return list(conn.execute('SELECT * FROM refs WHERE cite_key=?', (cite_key,)))


def has_refs(conn: sqlite3.Connection, cite_key: str) -> bool:
    row = conn.execute(
        'SELECT 1 FROM refs WHERE cite_key=? LIMIT 1', (cite_key,)
    ).fetchone()
    return row is not None


# --------------------------------------------------------------------------
# runs
# --------------------------------------------------------------------------

def start_run(conn: sqlite3.Connection, topics: list[str]) -> int:
    cur = conn.execute(
        'INSERT INTO runs (started, topics, n_scraped, n_relevant, n_briefed) '
        'VALUES (?, ?, 0, 0, 0)',
        (date.today().isoformat(), json.dumps(topics)),
    )
    return int(cur.lastrowid)


def finish_run(conn: sqlite3.Connection, run_id: int, **counts: int) -> None:
    allowed = {'n_scraped', 'n_relevant', 'n_briefed'}
    unknown = set(counts) - allowed
    if unknown:
        raise ValueError(f'unknown run column(s): {sorted(unknown)}')
    if not counts:
        return
    updates = ', '.join(f'{c}=?' for c in counts)
    conn.execute(
        f'UPDATE runs SET {updates} WHERE run_id=?', [*counts.values(), run_id]
    )
