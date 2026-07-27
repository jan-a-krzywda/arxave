"""Database adapter — one interface, two engines.

Runtime target is Postgres (Supabase); tests and offline runs use SQLite. Both
sit behind the same tiny surface so every `store` function is written once,
with `?` placeholders and dict-accessible rows, regardless of engine.

Engine selection is by connection string: a `SUPABASE_DB_URL` (or any
`postgres://` url passed in) selects Postgres; otherwise a local SQLite file.

What the two engines are made to agree on:
  * placeholders — queries use `?`; the Postgres path rewrites them to `%s`
    (and escapes literal `%`, of which sqout's queries currently have none);
  * rows — indexable by column name in both (`sqlite3.Row` / psycopg `dict_row`);
  * autoincrement ids — `INSERT ... RETURNING`, supported by SQLite >= 3.35 and
    Postgres alike, so no reliance on SQLite's `lastrowid`;
  * schema types — the DDL is templated and the engine-specific tokens
    (`{pk_autoinc}`, `{blob}`) are substituted per dialect.

Deliberately NOT an ORM and not general: it does exactly what store.py needs.
"""
from __future__ import annotations

import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

SQLITE = 'sqlite'
POSTGRES = 'postgres'

# Engine-specific DDL tokens. Keys are the template placeholders used in SCHEMA.
_TYPES = {
    SQLITE: {'pk_autoinc': 'INTEGER PRIMARY KEY AUTOINCREMENT', 'blob': 'BLOB'},
    POSTGRES: {'pk_autoinc': 'BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY',
               'blob': 'BYTEA'},
}

# One DDL statement per entry. `IF NOT EXISTS` everywhere so connect() is
# idempotent on both engines. Per-user tables use user_id='' (not NULL) for the
# shared baseline: NULL cannot sit in a composite primary key in either engine.
SCHEMA: tuple[str, ...] = (
    """CREATE TABLE IF NOT EXISTS papers (
        cite_key        TEXT PRIMARY KEY,
        arxiv_id        TEXT UNIQUE,
        doi             TEXT,
        openalex_id     TEXT,
        title           TEXT,
        authors         TEXT,
        published       TEXT,
        primary_category TEXT,
        abstract        TEXT,
        summary         TEXT,
        research_question TEXT,
        contribution    TEXT,
        topics          TEXT,
        relevance_score REAL,
        relevant        INTEGER,
        filter_reason   TEXT,
        scites          INTEGER,
        centrality      REAL,
        cited_in_corpus TEXT,
        importance      REAL,
        claim           TEXT,
        stakes          TEXT,
        connection      TEXT,
        verdict         TEXT,
        briefed_on      TEXT,
        first_seen      TEXT,
        llm_model       TEXT,
        status          TEXT
    )""",
    "CREATE INDEX IF NOT EXISTS idx_papers_status ON papers(status)",
    """CREATE TABLE IF NOT EXISTS embeddings (
        cite_key TEXT PRIMARY KEY REFERENCES papers(cite_key),
        dim      INTEGER,
        vector   {blob}
    )""",
    """CREATE TABLE IF NOT EXISTS refs (
        cite_key    TEXT REFERENCES papers(cite_key),
        raw         TEXT,
        ref_doi     TEXT,
        ref_arxiv   TEXT,
        ref_title   TEXT,
        matched_key TEXT,
        source      TEXT
    )""",
    "CREATE INDEX IF NOT EXISTS idx_refs_cite_key ON refs(cite_key)",
    # Per-user summary overrides. Baseline (batch Gemma) = user_id ''.
    """CREATE TABLE IF NOT EXISTS summaries (
        cite_key    TEXT NOT NULL,
        user_id     TEXT NOT NULL DEFAULT '',
        llm_model   TEXT NOT NULL,
        summary     TEXT,
        research_question TEXT,
        contribution TEXT,
        claim       TEXT,
        stakes      TEXT,
        connection  TEXT,
        created_at  TEXT,
        PRIMARY KEY (cite_key, user_id, llm_model)
    )""",
    # Per-user filter verdicts. No baseline row here — filtering is inherently
    # per-user (topics differ per person).
    """CREATE TABLE IF NOT EXISTS user_filters (
        cite_key        TEXT NOT NULL,
        user_id         TEXT NOT NULL,
        topics          TEXT,
        relevance_score REAL,
        relevant        INTEGER,
        filter_reason   TEXT,
        importance      REAL,
        briefed_on      TEXT,
        created_at      TEXT,
        PRIMARY KEY (cite_key, user_id)
    )""",
    """CREATE TABLE IF NOT EXISTS runs (
        run_id     {pk_autoinc},
        started    TEXT,
        topics     TEXT,
        n_scraped  INTEGER,
        n_relevant INTEGER,
        n_briefed  INTEGER
    )""",
)


def dialect_of(url: str | None) -> str:
    """Which engine a connection string selects."""
    if url and re.match(r'^(postgres|postgresql)://', url):
        return POSTGRES
    return SQLITE


def _render_schema(dialect: str) -> list[str]:
    tokens = _TYPES[dialect]
    return [stmt.format(**tokens) for stmt in SCHEMA]


class _PgConn:
    """Thin psycopg wrapper giving store.py the sqlite3-shaped API it expects.

    Translates `?` placeholders to `%s` and delegates everything else to the
    real connection, so `conn.execute(sql, params)` returns a cursor whose
    rows are keyed by column name."""

    def __init__(self, raw: Any):
        self._raw = raw

    @staticmethod
    def _translate(sql: str) -> str:
        # Escape any literal % (none today), then ? -> %s for psycopg.
        return sql.replace('%', '%%').replace('?', '%s')

    def execute(self, sql: str, params: Any = ()):  # noqa: ANN401
        return self._raw.execute(self._translate(sql), params)

    def executemany(self, sql: str, seq: Any):  # noqa: ANN401
        cur = self._raw.cursor()
        cur.executemany(self._translate(sql), seq)
        return cur

    def commit(self) -> None:
        self._raw.commit()

    def close(self) -> None:
        self._raw.close()


@contextmanager
def connect(url_or_path: str | Path) -> Iterator[Any]:
    """Open a connection to whichever engine the argument selects.

    A `postgres://` URL opens psycopg (row_factory=dict_row); anything else is
    treated as a SQLite file path. Schema is ensured on open, work is committed
    on clean exit, and the connection is always closed."""
    url = str(url_or_path)
    dialect = dialect_of(url)

    if dialect == POSTGRES:
        import psycopg
        from psycopg.rows import dict_row
        raw = psycopg.connect(url, row_factory=dict_row)
        conn: Any = _PgConn(raw)
        try:
            for stmt in _render_schema(POSTGRES):
                raw.execute(stmt)
            raw.commit()
            yield conn
            raw.commit()
        finally:
            raw.close()
        return

    path = Path(url_or_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        for stmt in _render_schema(SQLITE):
            conn.execute(stmt)
        yield conn
        conn.commit()
    finally:
        conn.close()
