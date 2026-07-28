"""Serve the filter page locally, with the CORS relay it needs. Dev only.

Two problems this solves at once:

1. arXiv sends no Access-Control-Allow-Origin header, so the browser page
   cannot fetch it directly and needs a relay in front. This serves one, with
   the same contract as supabase/functions/relay (GET ?url=, allowlisted).
2. Jekyll needs Ruby >= 3.0 and the system Ruby is 2.6, so `jekyll serve` is
   not always available. This renders filter.md well enough to exercise the
   page — front matter stripped, `relative_url` filters resolved.

    python scripts/dev_filter.py        # → http://127.0.0.1:8765/

The page's "Relay" field can stay blank: the rendered copy points at this
server. What you see is the real assets/filter.js, so behaviour matches
production; only the Jekyll layout (nav, theme) is missing.
"""
from __future__ import annotations

import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ALLOWED_HOSTS = {'export.arxiv.org', 'rss.arxiv.org', 'arxiv.org', 'scirate.com'}
PORT = 8765
TIMEOUT = 20
USER_AGENT = 'arxave-filter-dev/0.1 (+https://github.com/jan-a-krzywda/arxave)'

DOCS = Path(__file__).resolve().parent.parent / 'docs'
RELAY_PATHS = {'/relay', '/proxy', '/'}

CONTENT_TYPES = {
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
}

PAGE_TEMPLATE = """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>arxave filter — local preview</title>
<script>window.ARXAVE_RELAY = location.origin + '/relay';</script>
<style>
  body {{ max-width: 62rem; margin: 2rem auto; padding: 0 1rem;
         font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
  .dev-note {{ background: #fff3cd; border: 1px solid #ffe08a; border-radius: 4px;
              padding: 0.6rem 0.9rem; margin-bottom: 1.5rem; font-size: 0.85rem; }}
</style>
</head><body>
<div class="dev-note">
  <strong>Local preview.</strong> Served by <code>scripts/dev_filter.py</code>,
  which also relays arXiv on this port. Jekyll layout and nav are missing; the
  form and pipeline are the real ones.
</div>
{body}
</body></html>
"""


def render_page() -> bytes:
    """docs/filter.md → standalone HTML. Handles the Liquid this page uses."""
    raw = (DOCS / 'filter.md').read_text()
    # Strip YAML front matter.
    body = re.sub(r'^---\n.*?\n---\n', '', raw, count=1, flags=re.DOTALL)
    # {{ '/assets/x' | relative_url }} → /assets/x
    body = re.sub(r"\{\{\s*'([^']+)'\s*\|\s*relative_url\s*\}\}", r'\1', body)
    return PAGE_TEMPLATE.format(body=body).encode()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(body)

    def _fail(self, code: int, message: str) -> None:
        self._send(code, f'{{"error": "{message}"}}'.encode(), 'application/json')

    def do_OPTIONS(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self._send(204, b'', 'text/plain')

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urllib.parse.urlparse(self.path)
        target = urllib.parse.parse_qs(parsed.query).get('url', [''])[0]

        if target:
            self._relay(target)
        elif parsed.path in RELAY_PATHS:
            self._send(200, render_page(), 'text/html; charset=utf-8')
        elif parsed.path.startswith('/assets/'):
            self._asset(parsed.path)
        else:
            self._fail(404, 'Not found.')

    def _asset(self, path: str) -> None:
        # Resolve and confirm the result is still inside docs/assets.
        assets = (DOCS / 'assets').resolve()
        candidate = (assets / path[len('/assets/'):]).resolve()
        if not candidate.is_file() or assets not in candidate.parents:
            self._fail(404, 'No such asset.')
            return
        ctype = CONTENT_TYPES.get(candidate.suffix, 'application/octet-stream')
        self._send(200, candidate.read_bytes(), ctype)

    def _relay(self, target: str) -> None:
        host = urllib.parse.urlparse(target).hostname or ''
        if host not in ALLOWED_HOSTS:
            self._fail(403, f'Host {host} is not on the relay allowlist.')
            return

        req = urllib.request.Request(target, headers={'User-Agent': USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                body = resp.read()
                ctype = resp.headers.get('Content-Type', 'application/octet-stream')
        except urllib.error.HTTPError as exc:
            # Scirate answers 403 to non-browser clients; pass it through so the
            # page marks the scite signal unavailable rather than guessing.
            self._send(exc.code, exc.read() or b'', 'text/plain')
            return
        except Exception as exc:  # noqa: BLE001 - dev tool, report anything
            self._fail(502, f'Upstream fetch failed: {exc}')
            return

        self._send(200, body, ctype)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write('dev: ' + fmt % args + '\n')


def main() -> int:
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'filter page:  http://127.0.0.1:{PORT}/')
    print(f'relay:        http://127.0.0.1:{PORT}/relay?url=<encoded>')
    print(f'allowlist:    {", ".join(sorted(ALLOWED_HOSTS))}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nstopped')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
