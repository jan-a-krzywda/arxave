"""Configuration: config/sqout.yaml plus API keys from a gitignored .env.

Paths are resolved absolutely at load time so no stage depends on the working
directory. Everything sqout owns lives under `.local/`; the one path pointing
outside the project (`corpus.source`) is read only by `sync-corpus`.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml
from dotenv import load_dotenv

DEFAULT_CONFIG = Path('config/sqout.yaml')


class ConfigError(Exception):
    """Raised for a malformed or incomplete config — always with a fix."""


@dataclass(frozen=True)
class LLMRoleConfig:
    role: str
    provider: str
    model: str
    api_key_env: str
    base_url: str | None = None

    @property
    def api_key(self) -> str:
        key = os.environ.get(self.api_key_env, '').strip()
        if not key:
            raise ConfigError(
                f'llm.{self.role}: ${self.api_key_env} is unset or empty. '
                f'Copy .env.example to .env and fill it in.'
            )
        return key


@dataclass(frozen=True)
class ScoutConfig:
    categories: list[str]
    lookback_days: int = 1
    max_results: int = 200


@dataclass(frozen=True)
class CorpusConfig:
    source: Path | None
    stale_after_days: int = 30


@dataclass(frozen=True)
class RankingConfig:
    weights: dict[str, float]
    top_n: int = 5


@dataclass(frozen=True)
class ConnectConfig:
    enabled: bool = True
    openalex_mailto: str = ''
    arxiv_bib: bool = True  # read each paper's own .bbl/.bib for day-one connections


@dataclass(frozen=True)
class RetentionConfig:
    """Rolling-window pruning. sqout prioritizes recent papers, and connections
    now come from each paper's own bibliography rather than stored history, so
    the store never needs to grow past a short window."""
    enabled: bool = True
    days: int = 7


@dataclass(frozen=True)
class Config:
    root: Path
    topics: list[str]
    scout: ScoutConfig
    corpus: CorpusConfig
    ranking: RankingConfig
    connect: ConnectConfig
    retention: RetentionConfig = field(default_factory=RetentionConfig)
    llm: dict[str, LLMRoleConfig] = field(default_factory=dict)

    # Paths sqout owns. Created on demand by whoever writes to them.
    @property
    def db_path(self) -> Path:
        return self.root / '.local' / 'sqout' / 'papers.db'

    @property
    def store_target(self) -> str:
        """Where the store lives: the Postgres URL in $SUPABASE_DB_URL when set,
        otherwise the local SQLite file. This is the single switch between the
        hosted shared DB and a local/offline run — no other code decides."""
        url = os.environ.get('SUPABASE_DB_URL', '').strip()
        return url or str(self.db_path)

    @property
    def corpus_dir(self) -> Path:
        return self.root / '.local' / 'corpus'

    @property
    def corpus_snapshot(self) -> Path:
        return self.corpus_dir / 'works.json'

    @property
    def corpus_meta(self) -> Path:
        return self.corpus_dir / 'meta.json'

    @property
    def briefs_dir(self) -> Path:
        return self.root / 'briefs'

    def llm_role(self, role: str) -> LLMRoleConfig:
        try:
            return self.llm[role]
        except KeyError:
            raise ConfigError(
                f"llm.{role} is not configured. Expected roles: 'light', 'heavy'."
            ) from None


def _require(data: dict, key: str, where: str):
    if key not in data:
        raise ConfigError(f'{where}: missing required key {key!r}')
    return data[key]


def _abs_path(raw: str, root: Path) -> Path:
    """Expand ~ and resolve relative to the project root, never to cwd."""
    p = Path(raw).expanduser()
    return p if p.is_absolute() else (root / p)


def load(path: Path | str = DEFAULT_CONFIG, *, root: Path | None = None) -> Config:
    """Load config. `root` defaults to the config file's parent's parent."""
    path = Path(path).expanduser().resolve()
    if not path.exists():
        raise ConfigError(f'config file not found: {path}')

    root = (root or path.parent.parent).resolve()

    # .env sits at the project root; load before reading any api_key_env.
    load_dotenv(root / '.env')

    raw = yaml.safe_load(path.read_text()) or {}

    topics = raw.get('topics') or []
    if not topics:
        raise ConfigError(
            f'{path}: `topics` is empty. The filter stage gates every paper '
            f'against this list, so a run without topics returns nothing.'
        )

    scout_raw = _require(raw, 'scout', str(path))
    scout = ScoutConfig(
        categories=list(_require(scout_raw, 'categories', 'scout')),
        lookback_days=int(scout_raw.get('lookback_days', 1)),
        max_results=int(scout_raw.get('max_results', 200)),
    )

    corpus_raw = raw.get('corpus') or {}
    source = corpus_raw.get('source')
    corpus = CorpusConfig(
        source=_abs_path(source, root) if source else None,
        stale_after_days=int(corpus_raw.get('stale_after_days', 30)),
    )

    ranking_raw = raw.get('ranking') or {}
    weights = {k: float(v) for k, v in (ranking_raw.get('weights') or {}).items()}
    if not weights:
        raise ConfigError(f'{path}: ranking.weights is empty')
    ranking = RankingConfig(weights=weights, top_n=int(ranking_raw.get('top_n', 5)))

    connect_raw = raw.get('connect') or {}
    connect = ConnectConfig(
        enabled=bool(connect_raw.get('enabled', True)),
        openalex_mailto=str(connect_raw.get('openalex_mailto', '') or ''),
        arxiv_bib=bool(connect_raw.get('arxiv_bib', True)),
    )
    if connect.enabled and not connect.openalex_mailto:
        raise ConfigError(
            f'{path}: connect.enabled is true but connect.openalex_mailto is empty. '
            f"OpenAlex's polite pool needs a contact address."
        )

    retention_raw = raw.get('retention') or {}
    retention = RetentionConfig(
        enabled=bool(retention_raw.get('enabled', True)),
        days=int(retention_raw.get('days', 7)),
    )
    if retention.days < 1:
        raise ConfigError(
            f'{path}: retention.days must be >= 1 (got {retention.days}); '
            f'set retention.enabled: false to keep everything.'
        )

    llm_raw = _require(raw, 'llm', str(path))
    llm = {}
    for role, cfg in llm_raw.items():
        llm[role] = LLMRoleConfig(
            role=role,
            provider=_require(cfg, 'provider', f'llm.{role}'),
            model=_require(cfg, 'model', f'llm.{role}'),
            api_key_env=_require(cfg, 'api_key_env', f'llm.{role}'),
            base_url=cfg.get('base_url') or None,
        )
    for required_role in ('light', 'heavy'):
        if required_role not in llm:
            raise ConfigError(f'{path}: llm.{required_role} is not configured')

    return Config(
        root=root,
        topics=list(topics),
        scout=scout,
        corpus=corpus,
        ranking=ranking,
        connect=connect,
        retention=retention,
        llm=llm,
    )
