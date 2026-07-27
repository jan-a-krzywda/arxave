"""Offline tests for the e-print bibliography reader.

The network fetch is never exercised here — these pin the archive extraction
and the LaTeX parsing, which are where the real fragility lives.
"""
from __future__ import annotations

import gzip
import io
import tarfile

from sqout import arxiv_bib

SAMPLE_BBL = r"""
\begin{thebibliography}{99}
\bibitem{petta2005}
J.~R. Petta et al.,
\newblock Coherent Manipulation of Coupled Electron Spins,
\newblock Science \textbf{309}, 2180 (2005).
\bibitem{loss1998}
D.~Loss and D.~P. DiVincenzo,
\newblock Quantum computation with quantum dots,
\newblock arXiv:cond-mat/9701055, doi:10.1103/PhysRevA.57.120.
\bibitem{fresh2024}
Someone,
\newblock A recent preprint, arXiv:2401.12345.
\end{thebibliography}
"""

SAMPLE_BIB = r"""
@article{petta2005,
  title = {Coherent Manipulation of Coupled Electron Spins},
  doi = {10.1126/science.1116955},
  year = {2005},
}
@article{fresh,
  title = "A recent preprint",
  eprint = {arXiv:2401.12345},
}
"""


def _targz(files: dict[str, str]) -> bytes:
    """Build a gzipped tar of {name: text} in memory."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w') as tar:
        for name, text in files.items():
            data = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return gzip.compress(raw.getvalue())


def test_pdf_only_submission_yields_no_source():
    assert arxiv_bib.extract_source(b'%PDF-1.5\n...binary...') == ''


def test_extract_prefers_bbl_over_tex():
    archive = _targz({'main.tex': r'\bibitem body only', 'main.bbl': SAMPLE_BBL})
    text = arxiv_bib.extract_source(archive)
    assert 'Coherent Manipulation' in text
    assert 'body only' not in text  # .tex skipped once .bbl is present


def test_extract_falls_back_to_tex_when_no_bbl():
    archive = _targz({'main.tex': SAMPLE_BBL})
    assert 'Coherent Manipulation' in arxiv_bib.extract_source(archive)


def test_extract_single_gzipped_file():
    assert 'Coherent' in arxiv_bib.extract_source(gzip.compress(SAMPLE_BBL.encode()))


def test_parse_bbl_splits_per_bibitem_and_pulls_ids():
    refs = arxiv_bib.parse_bibliography(SAMPLE_BBL)
    assert len(refs) == 3
    # The middle entry carries both an old-style arXiv id and a DOI.
    loss = refs[1]
    assert loss['ref_arxiv'] == 'cond-mat/9701055'
    assert loss['ref_doi'] == '10.1103/physreva.57.120'
    # The fresh preprint entry gives a new-style id.
    assert refs[2]['ref_arxiv'] == '2401.12345'


def test_parse_bib_pulls_title_and_doi():
    refs = arxiv_bib.parse_bibliography(SAMPLE_BIB)
    assert len(refs) == 2
    assert refs[0]['ref_title'] == 'Coherent Manipulation of Coupled Electron Spins'
    assert refs[0]['ref_doi'] == '10.1126/science.1116955'
    assert refs[1]['ref_arxiv'] == '2401.12345'


def test_empty_source_yields_no_refs():
    assert arxiv_bib.parse_bibliography('') == []
