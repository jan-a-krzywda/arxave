"""The decoupling tests: arxave must run off its own snapshot, never the source."""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta

import pytest

from arxave import connect, corpus, store
from arxave.config import ConfigError

WORKS = {
    'Petta2005': {
        'openalex_id': 'https://openalex.org/W1',
        'doi': '10.1126/science.1116955',
        'title': 'Coherent manipulation of coupled electron spins',
        'year': 2005,
        'referenced_works': ['https://openalex.org/W99'],
    },
    'Loss1998': {
        'openalex_id': 'https://openalex.org/W2',
        'doi': '10.1103/physreva.57.120',
        'title': 'Quantum computation with quantum dots',
        'year': 1998,
        'referenced_works': [],
    },
}


@pytest.fixture
def source(tmp_path):
    p = tmp_path / 'external' / 'works.json'
    p.parent.mkdir(parents=True)
    p.write_text(json.dumps(WORKS))
    return p


def test_sync_copies_and_records_provenance(cfg, source):
    meta = corpus.sync(cfg, source)
    assert cfg.corpus_snapshot.exists()
    assert meta['n_records'] == 2
    assert meta['n_with_references'] == 1
    assert meta['source'] == str(source)
    assert len(meta['sha256']) == 64
    assert json.loads(cfg.corpus_meta.read_text())['sha256'] == meta['sha256']


def test_snapshot_survives_the_source_disappearing(cfg, source):
    """The whole point: after sync, the library is no longer on the run path."""
    corpus.sync(cfg, source)
    source.unlink()
    source.parent.rmdir()

    snap = corpus.load(cfg)
    assert snap
    assert snap.ids['https://openalex.org/W1'] == 'Petta2005'
    assert 'Coherent manipulation' in snap.titles['Petta2005']


def test_sync_reports_a_missing_source_clearly(cfg, tmp_path):
    with pytest.raises(corpus.CorpusError, match='corpus source not found'):
        corpus.sync(cfg, tmp_path / 'nope.json')


def test_sync_rejects_malformed_json(cfg, tmp_path):
    bad = tmp_path / 'bad.json'
    bad.write_text('{not json')
    with pytest.raises(corpus.CorpusError, match='not valid JSON'):
        corpus.sync(cfg, bad)


def test_sync_rejects_a_json_array(cfg, tmp_path):
    bad = tmp_path / 'arr.json'
    bad.write_text('[1, 2]')
    with pytest.raises(corpus.CorpusError, match='keyed by cite_key'):
        corpus.sync(cfg, bad)


def test_sync_without_a_source_is_a_config_error(cfg):
    with pytest.raises(ConfigError, match='corpus.source is not set'):
        corpus.sync(cfg, None)


def test_load_of_a_missing_snapshot_degrades(cfg):
    """Absence costs the connection line; it must not break the run."""
    snap = corpus.load(cfg)
    assert not snap
    assert snap.ids == {}


def test_load_of_a_corrupt_snapshot_degrades(cfg):
    cfg.corpus_dir.mkdir(parents=True)
    cfg.corpus_snapshot.write_text('{oops')
    assert not corpus.load(cfg)


def test_staleness_warning(cfg, source):
    assert 'no corpus snapshot' in corpus.staleness_warning(cfg, corpus.EMPTY)

    corpus.sync(cfg, source)
    assert corpus.staleness_warning(cfg, corpus.load(cfg)) is None

    old = (datetime.now() - timedelta(days=99)).isoformat(timespec='seconds')
    stale = corpus.Snapshot(ids={'W1': 'K'}, titles={}, synced_at=old)
    assert '99 days old' in corpus.staleness_warning(cfg, stale)


# --------------------------------------------------------------------------
# connect stage
# --------------------------------------------------------------------------

def _snapshot():
    return corpus.Snapshot(
        ids={r['openalex_id']: k for k, r in WORKS.items()},
        titles={k: r['title'] for k, r in WORKS.items()},
        synced_at=date.today().isoformat(),
    )


def test_connect_records_overlap(cfg, monkeypatch):
    monkeypatch.setattr(connect.openalex, 'resolve_by_doi', lambda dois, **kw: {
        'K1': {
            'openalex_id': 'https://openalex.org/W50',
            'doi': '10.48550/arxiv.2401.1',
            'title': 'New paper',
            'year': 2024,
            'referenced_works': ['https://openalex.org/W1', 'https://openalex.org/W77'],
        }
    })
    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', arxiv_id='2401.1', status='filtered')
        assert connect.run(cfg, conn, _snapshot()) == 1
        row = conn.execute('SELECT * FROM papers WHERE cite_key="K1"').fetchone()

    assert store.json_list(row['cited_in_corpus']) == [
        'Coherent manipulation of coupled electron spins'
    ]
    assert row['centrality'] == pytest.approx(0.1)
    assert row['openalex_id'] == 'https://openalex.org/W50'


def test_connect_treats_an_unindexed_paper_as_ordinary(cfg, monkeypatch):
    """Fresh preprints usually aren't in OpenAlex yet. Not an error."""
    monkeypatch.setattr(connect.openalex, 'resolve_by_doi', lambda dois, **kw: {})
    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', arxiv_id='2401.1', status='filtered')
        assert connect.run(cfg, conn, _snapshot()) == 0
        row = conn.execute('SELECT * FROM papers WHERE cite_key="K1"').fetchone()
    assert row['centrality'] is None
    assert row['status'] == 'filtered'  # still moves on to rank


def test_connect_survives_openalex_being_down(cfg, monkeypatch):
    def boom(dois, **kw):
        raise connect.openalex.OpenAlexError('network down')

    monkeypatch.setattr(connect.openalex, 'resolve_by_doi', boom)
    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', arxiv_id='2401.1', status='filtered')
        assert connect.run(cfg, conn, _snapshot()) == 0


def test_connect_skips_without_a_snapshot(cfg):
    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', arxiv_id='2401.1', status='filtered')
        assert connect.run(cfg, conn, corpus.EMPTY) == 0
