"""papers.db — the memory layer.

Everything the scout evaluates lands here, including what the brief omits.
Two invariants hold the pipeline together:

  * every write is an upsert keyed on `cite_key`, so re-running a stage
    enriches rows instead of duplicating them;
  * `status` is the resume marker — each stage selects only rows in its input
    status, so a crashed run picks up where it stopped.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3  # noqa: F401 — used only in type annotations (lazy under `annotations`)
import sys
import unicodedata
from array import array
from datetime import date
from typing import Any

from . import db

# Pipeline order. A stage reads rows at status[i] and advances them to status[i+1].
STATUSES = ('new', 'summarized', 'filtered', 'ranked', 'briefed')

# The authoritative schema — rendered per engine — lives in db.SCHEMA.

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

def connect(target: Any):
    """Open the store. `target` is a SQLite path or a postgres:// URL — the
    engine is chosen by db.connect(). Returned as a context manager."""
    return db.connect(target)


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


def prune_old(conn: sqlite3.Connection, before: str) -> dict[str, int]:
    """Delete papers published before `before` (ISO date), and their children.

    The rolling window that keeps the store small. Pruning is by `published`,
    not `first_seen`: it is the paper's age that matters, so a paper scouted
    today but published two weeks ago is still old. Rows with an empty
    `published` are never pruned — an unknown date must not be read as ancient.

    sqlite has no cascade here (foreign_keys is off by default), so children are
    deleted explicitly first, then the papers. Returns per-table delete counts.
    """
    doomed = [
        r['cite_key'] for r in conn.execute(
            "SELECT cite_key FROM papers WHERE published != '' AND published < ?",
            (before,),
        )
    ]
    if not doomed:
        return {'papers': 0, 'refs': 0, 'embeddings': 0,
                'summaries': 0, 'user_filters': 0}

    placeholders = ','.join('?' for _ in doomed)

    def _del(table: str) -> int:
        return conn.execute(
            f'DELETE FROM {table} WHERE cite_key IN ({placeholders})', doomed
        ).rowcount

    # Children first, papers last.
    counts = {t: _del(t) for t in ('refs', 'embeddings', 'summaries', 'user_filters')}
    counts['papers'] = _del('papers')
    return counts


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
# per-user summaries and filters
#
# The batch pipeline writes the shared baseline onto `papers` (see upsert_paper)
# and never touches these tables. They exist for the hosted layer: when a user
# re-summarizes with a stronger LLM or filters against their own topics, the
# result lands here keyed by user_id, leaving the baseline intact. The shared
# baseline is represented as user_id='' — never NULL, which cannot sit in a
# composite primary key in either engine.
# --------------------------------------------------------------------------

BASELINE_USER = ''  # the shared, batch-written row

_SUMMARY_FIELDS = (
    'summary', 'research_question', 'contribution', 'claim', 'stakes',
    'connection', 'created_at',
)
_FILTER_FIELDS = (
    'topics', 'relevance_score', 'relevant', 'filter_reason', 'importance',
    'briefed_on', 'created_at',
)


def _upsert(conn: sqlite3.Connection, table: str, key_cols: tuple[str, ...],
            allowed: tuple[str, ...], key_vals: tuple, fields: dict) -> None:
    """Composite-key upsert shared by both per-user tables."""
    unknown = set(fields) - set(allowed)
    if unknown:
        raise ValueError(f'unknown column(s) for {table}: {sorted(unknown)}')
    if 'topics' in fields and isinstance(fields['topics'], (list, tuple)):
        fields['topics'] = json.dumps(list(fields['topics']))

    cols = [*key_cols, *fields]
    placeholders = ', '.join('?' for _ in cols)
    updates = ', '.join(f'{c}=excluded.{c}' for c in fields) or \
        f'{key_cols[0]}=excluded.{key_cols[0]}'  # no-op update if only keys given
    conn.execute(
        f'INSERT INTO {table} ({", ".join(cols)}) VALUES ({placeholders}) '
        f'ON CONFLICT ({", ".join(key_cols)}) DO UPDATE SET {updates}',
        [*key_vals, *fields.values()],
    )


def upsert_summary(conn: sqlite3.Connection, cite_key: str, llm_model: str,
                   *, user_id: str = BASELINE_USER, **fields: Any) -> None:
    """Insert or update one (paper, user, model) summary."""
    _upsert(conn, 'summaries', ('cite_key', 'user_id', 'llm_model'),
            _SUMMARY_FIELDS, (cite_key, user_id, llm_model), fields)


def summary_for(conn: sqlite3.Connection, cite_key: str, *,
                user_id: str = BASELINE_USER, llm_model: str | None = None):
    """One summary row, or None. Without llm_model, the most recent for the user."""
    if llm_model is not None:
        return conn.execute(
            'SELECT * FROM summaries WHERE cite_key=? AND user_id=? AND llm_model=?',
            (cite_key, user_id, llm_model),
        ).fetchone()
    return conn.execute(
        'SELECT * FROM summaries WHERE cite_key=? AND user_id=? '
        'ORDER BY created_at DESC NULLS LAST LIMIT 1',
        (cite_key, user_id),
    ).fetchone()


def upsert_user_filter(conn: sqlite3.Connection, cite_key: str, user_id: str,
                       **fields: Any) -> None:
    """Insert or update one user's filter verdict for a paper."""
    _upsert(conn, 'user_filters', ('cite_key', 'user_id'),
            _FILTER_FIELDS, (cite_key, user_id), fields)


def user_filter_for(conn: sqlite3.Connection, cite_key: str, user_id: str):
    return conn.execute(
        'SELECT * FROM user_filters WHERE cite_key=? AND user_id=?',
        (cite_key, user_id),
    ).fetchone()


# --------------------------------------------------------------------------
# the Dig's shared vector cache
#
# Embedding a day of abstracts in the browser costs ~60 s; downloading the same
# vectors costs ~200 kB. This table is what makes the second visitor to a day
# pay the download instead of the minute.
#
# Keyed on the sha256 of the *text*, so one table serves abstracts, touchstones
# and core samples, and a revised abstract simply misses rather than returning a
# stale vector. `source` is provenance only — never part of the key.
# --------------------------------------------------------------------------

# Wire format for `vector`: little-endian float32, `dim * 4` bytes. Chosen over
# JSON because it is 4x smaller and needs no parse on either side.
_LITTLE_ENDIAN = sys.byteorder == 'little'


def text_sha(text: str) -> str:
    """The cache key for one text. Whitespace-collapsed first, so a text that
    differs only in wrapping is one entry — the browser collapses the same way
    when it parses an abstract out of the arXiv feed."""
    collapsed = ' '.join((text or '').split())
    return hashlib.sha256(collapsed.encode('utf-8')).hexdigest()


def pack_vector(values: list[float]) -> bytes:
    arr = array('f', values)
    if not _LITTLE_ENDIAN:
        arr.byteswap()
    return arr.tobytes()


def unpack_vector(blob: bytes) -> list[float]:
    arr = array('f')
    arr.frombytes(bytes(blob))
    if not _LITTLE_ENDIAN:
        arr.byteswap()
    return list(arr)


def upsert_vector(conn: sqlite3.Connection, sha: str, model: str, dim: int,
                  vector: bytes | list[float], *, source: str | None = None,
                  seen_at: str | None = None) -> None:
    """Insert or refresh one cached vector.

    The vector itself is never rewritten on conflict — the same (text, model,
    dim) must always give the same vector, so a second write is either identical
    or a bug, and preserving the first keeps the cache reproducible. Only
    `seen_at` moves, which is what keeps a still-wanted entry out of the prune.
    """
    if isinstance(vector, list):
        if len(vector) != dim:
            raise ValueError(
                f'vector for {sha[:8]} has {len(vector)} values, expected dim={dim}'
            )
        blob = pack_vector(vector)
    else:
        if len(vector) != dim * 4:
            raise ValueError(
                f'vector for {sha[:8]} is {len(vector)} bytes, '
                f'expected {dim * 4} for dim={dim}'
            )
        blob = bytes(vector)
    conn.execute(
        'INSERT INTO dig_vectors (text_sha, model, dim, vector, source, seen_at) '
        'VALUES (?, ?, ?, ?, ?, ?) '
        'ON CONFLICT (text_sha, model, dim) DO UPDATE SET seen_at=excluded.seen_at',
        (sha, model, dim, blob, source, seen_at or date.today().isoformat()),
    )


def vectors_for(conn: sqlite3.Connection, shas: list[str], model: str,
                dim: int) -> dict[str, bytes]:
    """The cached vectors among `shas`, as {sha: packed bytes}. Misses are
    simply absent — the caller embeds those and may contribute them back."""
    if not shas:
        return {}
    found: dict[str, bytes] = {}
    # Chunked so a long day's worth of ids cannot blow the parameter limit
    # (SQLite's default is 999; Postgres's is 65535).
    for i in range(0, len(shas), 500):
        chunk = shas[i:i + 500]
        placeholders = ','.join('?' for _ in chunk)
        rows = conn.execute(
            f'SELECT text_sha, vector FROM dig_vectors '
            f'WHERE model=? AND dim=? AND text_sha IN ({placeholders})',
            [model, dim, *chunk],
        )
        for row in rows:
            found[row['text_sha']] = bytes(row['vector'])
    return found


def prune_vectors(conn: sqlite3.Connection, before: str) -> int:
    """Drop cache entries last wanted before `before` (ISO date).

    Pruned on `seen_at`, not on the paper's date: a vector for an old abstract
    that people still ask for is still worth keeping, and one nobody has asked
    for in a week is dead weight whatever its paper's age.
    """
    return conn.execute(
        'DELETE FROM dig_vectors WHERE seen_at IS NOT NULL AND seen_at < ?',
        (before,),
    ).rowcount


# --------------------------------------------------------------------------
# runs
# --------------------------------------------------------------------------

def start_run(conn: sqlite3.Connection, topics: list[str]) -> int:
    # RETURNING rather than lastrowid: works on both engines (SQLite >= 3.35,
    # Postgres), so the runs id doesn't depend on a SQLite-only cursor attr.
    cur = conn.execute(
        'INSERT INTO runs (started, topics, n_scraped, n_relevant, n_briefed) '
        'VALUES (?, ?, 0, 0, 0) RETURNING run_id',
        (date.today().isoformat(), json.dumps(topics)),
    )
    row = cur.fetchone()
    return int(row['run_id'])


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
