"""CLI — orchestrates the pipeline.

Every stage is idempotent and resumable via the `status` column, so `arxave run`
after a crash picks up where it stopped, and `--stage` runs one stage in
isolation while iterating on prompts.
"""
from __future__ import annotations

import argparse
import logging
import sys
from datetime import date

from . import brief, config, connect, corpus, filter as filter_stage
from . import rank, refs, scout, serve, store, summarize

log = logging.getLogger('arxave')

STAGES = ('scout', 'summarize', 'filter', 'refs', 'connect', 'rank', 'brief')


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format='%(message)s',
        stream=sys.stderr,
    )


def _parse_date(raw: str | None) -> date:
    if not raw:
        return date.today()
    try:
        return date.fromisoformat(raw)
    except ValueError:
        raise SystemExit(f'--date: expected YYYY-MM-DD, got {raw!r}')


def cmd_sync_corpus(args, cfg: config.Config) -> int:
    meta = corpus.sync(cfg, args.source)
    print(f'Synced {meta["n_records"]} records from {meta["source"]}')
    print(f'  {meta["n_with_references"]} carry references (the graph edges)')
    print(f'  -> {cfg.corpus_snapshot}')
    return 0


def cmd_run(args, cfg: config.Config) -> int:
    on_date = _parse_date(args.date)
    stages = [args.stage] if args.stage else list(STAGES)

    if args.dry_run:
        if 'scout' not in stages:
            raise SystemExit('--dry-run only applies to the scout stage')
        papers = scout.fetch(cfg, on_date)
        print(f'{len(papers)} papers in the last {cfg.scout.lookback_days} day(s):\n')
        for p in papers:
            print(f'  {p["published"]}  {p["arxiv_id"]}  {p["title"][:88]}')
        print('\nNothing written.')
        return 0

    snap = corpus.load(cfg)
    warning = corpus.staleness_warning(cfg, snap)
    if warning:
        log.warning('warning: %s', warning)

    with store.connect(cfg.store_target) as conn:
        run_id = store.start_run(conn, cfg.topics)
        counts: dict[str, int] = {}

        if 'scout' in stages:
            counts['n_scraped'] = scout.run(cfg, conn, on_date)
        if 'summarize' in stages:
            summarize.run(cfg, conn)
        if 'filter' in stages:
            counts['n_relevant'] = filter_stage.run(cfg, conn)
        if 'refs' in stages:
            refs.run(cfg, conn, snap)
        if 'connect' in stages:
            connect.run(cfg, conn, snap)
        if 'rank' in stages:
            rank.run(cfg, conn)
        if 'brief' in stages:
            counts['n_briefed'] = brief.pitch(cfg, conn)
            path = brief.render(cfg, conn, on_date)
            print(f'\n{path}')

        # Rolling-window prune — full runs only, so `--stage` stays a pure,
        # non-destructive way to re-run one step while iterating.
        if not args.stage and cfg.retention.enabled:
            from datetime import timedelta
            before = (on_date - timedelta(days=cfg.retention.days)).isoformat()
            pruned = store.prune_old(conn, before)
            # The Dig's vector cache ages on its own clock (last wanted, not
            # published), but the same window bounds it.
            n_vectors = store.prune_vectors(conn, before)
            if n_vectors:
                log.info('prune: dropped %d cached vectors unused since %s',
                         n_vectors, before)
            if pruned['papers']:
                log.info(
                    'prune: dropped %d papers published before %s '
                    '(+%d refs, +%d embeddings)',
                    pruned['papers'], before, pruned['refs'], pruned['embeddings'],
                )

        store.finish_run(conn, run_id, **counts)
        log.info('store: %s', store.status_counts(conn))

    return 0


def cmd_render(args, cfg: config.Config) -> int:
    """Re-render an existing brief from the store — no LLM calls."""
    on_date = _parse_date(args.date)
    with store.connect(cfg.store_target) as conn:
        print(brief.render(cfg, conn, on_date))
    return 0


def _global_flags(*, suppress: bool) -> argparse.ArgumentParser:
    """Global flags, attachable to the top-level parser and to each subparser
    so both `arxave -v run` and `arxave run -v` work.

    The subparser copies must use SUPPRESS defaults: argparse applies a
    subparser's defaults *after* the main parser has parsed, so a real default
    there would silently overwrite a value given before the subcommand. With
    SUPPRESS the attribute is simply not set unless the flag was passed.
    """
    p = argparse.ArgumentParser(add_help=False)
    p.add_argument(
        '-c', '--config',
        default=argparse.SUPPRESS if suppress else config.DEFAULT_CONFIG,
        help='path to arxave.yaml (default: config/arxave.yaml)',
    )
    p.add_argument(
        '-v', '--verbose', action='store_true',
        default=argparse.SUPPRESS if suppress else False,
        help='verbose logging',
    )
    return p


def build_parser() -> argparse.ArgumentParser:
    sub_flags = _global_flags(suppress=True)

    parser = argparse.ArgumentParser(
        prog='arxave', description='A daily arXiv scout that briefs you.',
        parents=[_global_flags(suppress=False)],
    )
    sub = parser.add_subparsers(dest='command', required=True)

    p_run = sub.add_parser('run', help='run the pipeline', parents=[sub_flags])
    p_run.add_argument('--date', help='brief date, YYYY-MM-DD (default: today)')
    p_run.add_argument('--stage', choices=STAGES, help='run a single stage')
    p_run.add_argument('--dry-run', action='store_true',
                       help='scout only: print what would be fetched, write nothing')
    p_run.set_defaults(func=cmd_run)

    p_sync = sub.add_parser(
        'sync-corpus', help="snapshot the paper library's works.json into arxave",
        parents=[sub_flags],
    )
    p_sync.add_argument('--from', dest='source', help='override corpus.source')
    p_sync.set_defaults(func=cmd_sync_corpus)

    p_render = sub.add_parser(
        'render', help='re-render a brief from the store (no LLM calls)',
        parents=[sub_flags],
    )
    p_render.add_argument('--date', help='brief date, YYYY-MM-DD (default: today)')
    p_render.set_defaults(func=cmd_render)

    p_serve = sub.add_parser(
        'serve', help='start the local web UI at http://127.0.0.1:8765',
        parents=[sub_flags],
    )
    p_serve.set_defaults(func=cmd_serve)

    return parser


class _NoConfig:
    """Sentinel passed to `serve` — it doesn't need a config at startup."""
    pass


def cmd_serve(args, cfg: config.Config | _NoConfig) -> int:
    """Start the local web server (no config needed — form generates it)."""
    serve.run_server()
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    _setup_logging(args.verbose)
    try:
        if args.command == 'serve':
            cfg = _NoConfig()
        else:
            cfg = config.load(args.config)
        return args.func(args, cfg)
    except (config.ConfigError, corpus.CorpusError) as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('\ninterrupted — progress is saved; re-run to resume', file=sys.stderr)
        return 130


if __name__ == '__main__':
    raise SystemExit(main())
