"""The Dig's shared vector cache.

The invariant under test everywhere here: a cached vector is returned only for
*exactly* the text, model and dimension it was stored under. Everything else in
the feature is an optimization, but that one is a correctness property — a
vector handed back for the wrong key produces a plausible ranking and no error.
"""
from __future__ import annotations

import pytest

from arxave import store

MODEL = 'Xenova/bge-small-en-v1.5'
DIM = 4  # small, so the tests read as arithmetic rather than as fixtures


def vec(*values: float) -> list[float]:
    return list(values)


# --------------------------------------------------------------------------
# the key
# --------------------------------------------------------------------------

def test_sha_is_stable_and_whitespace_insensitive():
    """The browser collapses whitespace when it parses an abstract out of the
    feed; the warmer and the store must collapse the same way or every hash
    misses."""
    a = store.text_sha('silicon  spin\n qubits ')
    b = store.text_sha('silicon spin qubits')
    assert a == b
    assert len(a) == 64


def test_sha_distinguishes_different_texts():
    assert store.text_sha('charge noise') != store.text_sha('charge noise.')


# --------------------------------------------------------------------------
# the wire format
# --------------------------------------------------------------------------

def test_pack_roundtrip():
    values = vec(0.5, -0.25, 0.125, 0.0)
    assert store.unpack_vector(store.pack_vector(values)) == values


def test_pack_is_four_bytes_per_value():
    """The browser reads these bytes as a Float32Array — a change in width here
    would decode as garbage there, silently."""
    assert len(store.pack_vector(vec(1.0, 2.0, 3.0, 4.0))) == 16


# --------------------------------------------------------------------------
# reads and writes
# --------------------------------------------------------------------------

def test_roundtrip_through_the_store(cfg):
    sha = store.text_sha('silicon spin qubits')
    with store.connect(cfg.db_path) as conn:
        store.upsert_vector(conn, sha, MODEL, DIM, vec(1.0, 0.0, 0.0, 0.0),
                            source='arxiv:2401.12345')
        found = store.vectors_for(conn, [sha], MODEL, DIM)
    assert store.unpack_vector(found[sha]) == vec(1.0, 0.0, 0.0, 0.0)


def test_miss_is_absent_not_empty(cfg):
    with store.connect(cfg.db_path) as conn:
        store.upsert_vector(conn, store.text_sha('a'), MODEL, DIM, vec(1, 0, 0, 0))
        found = store.vectors_for(
            conn, [store.text_sha('a'), store.text_sha('b')], MODEL, DIM
        )
    assert store.text_sha('a') in found
    assert store.text_sha('b') not in found


def test_a_different_model_or_dim_is_a_miss(cfg):
    """The whole reason model and dim are in the primary key: a 384-dim bge
    vector and a 768-dim Gemini one for the same text are not interchangeable,
    and mixing them fails silently rather than loudly."""
    sha = store.text_sha('exchange gates')
    with store.connect(cfg.db_path) as conn:
        store.upsert_vector(conn, sha, MODEL, DIM, vec(1, 0, 0, 0))
        assert store.vectors_for(conn, [sha], 'other-model', DIM) == {}
        assert store.vectors_for(conn, [sha], MODEL, DIM + 1) == {}


def test_rewrite_keeps_the_first_vector(cfg):
    """The same (text, model, dim) must always give the same vector, so a second
    write is either identical or a bug. Preserving the first keeps the cache
    reproducible — only seen_at moves."""
    sha = store.text_sha('charge noise')
    with store.connect(cfg.db_path) as conn:
        store.upsert_vector(conn, sha, MODEL, DIM, vec(1, 0, 0, 0), seen_at='2026-08-01')
        store.upsert_vector(conn, sha, MODEL, DIM, vec(0, 1, 0, 0), seen_at='2026-08-09')
        found = store.vectors_for(conn, [sha], MODEL, DIM)
        row = conn.execute('SELECT seen_at FROM dig_vectors WHERE text_sha=?', (sha,)).fetchone()
    assert store.unpack_vector(found[sha]) == vec(1, 0, 0, 0)
    assert row['seen_at'] == '2026-08-09'


def test_wrong_length_is_rejected(cfg):
    with store.connect(cfg.db_path) as conn:
        with pytest.raises(ValueError, match='expected dim=4'):
            store.upsert_vector(conn, store.text_sha('x'), MODEL, DIM, vec(1, 0, 0))
        with pytest.raises(ValueError, match='expected 16'):
            store.upsert_vector(conn, store.text_sha('x'), MODEL, DIM, b'\x00' * 8)


def test_empty_lookup_hits_no_query(cfg):
    with store.connect(cfg.db_path) as conn:
        assert store.vectors_for(conn, [], MODEL, DIM) == {}


def test_lookup_chunks_past_the_parameter_limit(cfg):
    """SQLite's default parameter ceiling is 999; a day across several archives
    can exceed it, and the failure would be a hard error, not a slow read."""
    shas = [store.text_sha(f'paper {i}') for i in range(1200)]
    with store.connect(cfg.db_path) as conn:
        for sha in shas[:5]:
            store.upsert_vector(conn, sha, MODEL, DIM, vec(1, 0, 0, 0))
        found = store.vectors_for(conn, shas, MODEL, DIM)
    assert len(found) == 5


# --------------------------------------------------------------------------
# retention
# --------------------------------------------------------------------------

def test_prune_drops_only_the_unwanted(cfg):
    """Pruned on last-wanted, not on the paper's date: a vector people still ask
    for is worth keeping however old its paper is."""
    fresh, stale = store.text_sha('fresh'), store.text_sha('stale')
    with store.connect(cfg.db_path) as conn:
        store.upsert_vector(conn, fresh, MODEL, DIM, vec(1, 0, 0, 0), seen_at='2026-08-10')
        store.upsert_vector(conn, stale, MODEL, DIM, vec(0, 1, 0, 0), seen_at='2026-07-01')
        assert store.prune_vectors(conn, '2026-08-04') == 1
        found = store.vectors_for(conn, [fresh, stale], MODEL, DIM)
    assert fresh in found and stale not in found
