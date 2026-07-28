from __future__ import annotations

import pytest

from arxave.run import build_parser


@pytest.mark.parametrize('argv', [
    ['-v', 'run'],
    ['run', '-v'],
    ['-v', 'run', '--stage', 'connect'],
    ['run', '--stage', 'connect', '-v'],
])
def test_verbose_works_before_or_after_the_subcommand(argv):
    """Argparse puts global flags before the subcommand only. Rejecting the
    other form is a papercut — both must parse."""
    assert build_parser().parse_args(argv).verbose is True


@pytest.mark.parametrize('argv', [
    ['-c', 'other.yaml', 'run'],
    ['run', '-c', 'other.yaml'],
    ['sync-corpus', '-c', 'other.yaml'],
    ['render', '-c', 'other.yaml'],
])
def test_config_flag_works_in_both_positions(argv):
    assert build_parser().parse_args(argv).config == 'other.yaml'


def test_stage_is_restricted_to_known_stages():
    with pytest.raises(SystemExit):
        build_parser().parse_args(['run', '--stage', 'nonsense'])


def test_a_subcommand_is_required():
    with pytest.raises(SystemExit):
        build_parser().parse_args([])


def test_sync_corpus_accepts_a_source_override():
    args = build_parser().parse_args(['sync-corpus', '--from', '/tmp/w.json'])
    assert args.source == '/tmp/w.json'


def test_dry_run_is_scout_only():
    from arxave.run import cmd_run
    args = build_parser().parse_args(['run', '--stage', 'rank', '--dry-run'])
    with pytest.raises(SystemExit, match='only applies to the scout stage'):
        cmd_run(args, None)


def test_bad_date_is_rejected_clearly():
    from arxave.run import _parse_date
    with pytest.raises(SystemExit, match='expected YYYY-MM-DD'):
        _parse_date('20th July')
