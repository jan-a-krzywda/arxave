"""Minimal web server for the arxave config UI.

Starts on http://localhost:8765. The form POSTs config to /run, the server
writes config/arxave.yaml + .env and executes `arxave run` as a subprocess.
All secrets stay on the machine — nothing is sent over the network except
to the LLM provider (which in the LM Studio case is also localhost).

ponytail: single-threaded synchronous server — one run at a time.
Blocking is fine here since LLM calls dominate latency anyway.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import textwrap
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

PORT = 8765

_RUN_LOCK = threading.Lock()
_RUNNING: subprocess.Popen[str] | None = None


def _build_html() -> str:
    """Return the config-form page as a single HTML string. No external assets."""
    return textwrap.dedent("""\
    <!DOCTYPE html>
    <html lang="en">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Arxave — Run</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { max-width: 800px; margin: 0 auto; padding: 1.5rem; }
      h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
      .safety { background: #fff3cd; border: 1px solid #ffc107; padding: 0.6rem 0.8rem;
                border-radius: 6px; font-size: 0.85rem; margin-bottom: 1.25rem; }
      fieldset { border: 1px solid #dee2e6; border-radius: 6px; padding: 1rem 1.25rem;
                 margin-bottom: 1.25rem; }
      legend { font-weight: 600; }
      .sub { font-weight: 400; font-size: 0.8rem; color: #6c757d; }
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
              gap: 0.75rem; }
      .grid label { display: flex; flex-direction: column; gap: 0.2rem;
                    font-size: 0.8rem; font-weight: 600; color: #495057; }
      .grid input, .grid select { padding: 0.4rem 0.5rem; border: 1px solid #ced4da;
                                  border-radius: 4px; font-size: 0.9rem; }
      textarea { width: 100%; font-family: monospace; font-size: 0.85rem; padding: 0.5rem;
                 border: 1px solid #ced4da; border-radius: 4px; resize: vertical;
                 box-sizing: border-box; }
      .buttons { display: flex; gap: 0.75rem; margin-top: 1rem; }
      button { font-size: 0.95rem; padding: 0.55rem 1.25rem; border: none; border-radius: 6px;
               cursor: pointer; font-weight: 600; }
      #run-btn { background: #6f42c1; color: #fff; }
      #run-btn:hover { background: #5a32a3; }
      #run-btn:disabled { background: #a28ad4; cursor: not-allowed; }
      #output { margin-top: 1rem; padding: 0.75rem 1rem; border-radius: 6px;
                background: #f0f0f0; font-family: monospace; font-size: 0.8rem;
                white-space: pre-wrap; max-height: 400px; overflow-y: auto; display: none; }
      #output.error { background: #f8d7da; color: #842029; }
      @media (prefers-color-scheme: dark) {
        body { background: #1a1a2e; color: #ddd; }
        fieldset { background: #222; border-color: #444; }
        .grid label { color: #aaa; }
        .grid input, .grid select, textarea { background: #2a2a3a; color: #ddd;
                                              border-color: #555; }
        #output { background: #2a2a3a; }
      }
    </style>
    </head>
    <body>
    <h1>🧪 Arxave</h1>
    <div class="safety">
      <strong>🔒 Everything stays on this machine.</strong>
      The server writes <code>config/arxave.yaml</code> + <code>.env</code>
      and runs the pipeline locally. API keys are read from the environment
      or <code>.env</code> — they are never sent over the network.
    </div>

    <form id="form" autocomplete="off">
      <fieldset>
        <legend>🧠 Small LLM <span class="sub">— summarize, filter</span></legend>
        <div class="grid">
          <label>Provider
            <select id="light-provider">
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="deepseek">DeepSeek</option>
              <option value="groq">Groq</option>
              <option value="together">Together</option>
              <option value="ollama">Ollama</option>
              <option value="lm-studio" selected>LM Studio</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label>Model
            <input type="text" id="light-model" value="liquid/lfm2.5-1.2b">
          </label>
          <label>Base URL
            <input type="text" id="light-base-url" value="http://127.0.0.1:1234/v1">
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>🧠 Large LLM <span class="sub">— brief generation</span></legend>
        <div class="grid">
          <label>Provider
            <select id="heavy-provider">
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="deepseek">DeepSeek</option>
              <option value="groq">Groq</option>
              <option value="together">Together</option>
              <option value="ollama">Ollama</option>
              <option value="lm-studio" selected>LM Studio</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label>Model
            <input type="text" id="heavy-model" value="liquid/lfm2.5-1.2b">
          </label>
          <label>Base URL
            <input type="text" id="heavy-base-url" value="http://127.0.0.1:1234/v1">
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>📋 Topics</legend>
        <textarea id="topics" rows="4" placeholder="silicon spin qubits and exchange gates
    charge noise and decoherence in quantum dots"></textarea>
      </fieldset>

      <div class="buttons">
        <button type="submit" id="run-btn">🚀 Run Scout</button>
      </div>
    </form>

    <div id="output"></div>

    <script>
      const PRESETS = {
        anthropic: { provider: 'anthropic', base_url: '' },
        openai:    { provider: 'openai',    base_url: '' },
        deepseek:  { provider: 'openai',    base_url: 'https://api.deepseek.com/v1' },
        groq:      { provider: 'openai',    base_url: 'https://api.groq.com/openai/v1' },
        together:  { provider: 'openai',    base_url: 'https://api.together.xyz/v1' },
        ollama:    { provider: 'ollama',    base_url: 'http://localhost:11434/v1' },
        'lm-studio': { provider: 'openai', base_url: 'http://127.0.0.1:1234/v1' },
        custom:    { provider: 'openai',    base_url: '' },
      };
      document.querySelectorAll('select[id$="-provider"]').forEach(function(sel) {
        sel.addEventListener('change', function() {
          var role = sel.id.startsWith('light') ? 'light' : 'heavy';
          var preset = PRESETS[sel.value];
          document.getElementById(role + '-base-url').value = preset.base_url;
        });
      });
      // Init base URLs for default LM Studio selection.
      ['light', 'heavy'].forEach(function(role) {
        document.getElementById(role + '-base-url').value =
          PRESETS[document.getElementById(role + '-provider').value].base_url;
      });

      document.getElementById('form').addEventListener('submit', function(e) {
        e.preventDefault();
        var btn = document.getElementById('run-btn');
        var out = document.getElementById('output');
        btn.disabled = true;
        out.style.display = '';
        out.className = '';
        out.textContent = '⏳ Running… (this may take a few minutes for LLM calls)';

        function role(r) {
          return {
            provider: PRESETS[document.getElementById(r + '-provider').value].provider,
            model: document.getElementById(r + '-model').value.trim(),
            base_url: document.getElementById(r + '-base-url').value.trim() || null,
          };
        }

        var body = {
          light: role('light'),
          heavy: role('heavy'),
          topics: document.getElementById('topics').value
            .split('\\\\n').map(function(l){ return l.trim(); }).filter(Boolean),
        };

        fetch('/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(function(resp) {
          return resp.json().then(function(data) {
            out.textContent = data.output || data.error || '(no output)';
            if (data.error) out.className = 'error';
          });
        }).catch(function(err) {
          out.textContent = 'Request failed: ' + err.message;
          out.className = 'error';
        }).finally(function() {
          btn.disabled = false;
        });
      });
    </script>
    </body>
    </html>
    """)


def _write_config(light: dict, heavy: dict, topics: list[str]) -> None:
    """Write config/arxave.yaml and .env from the form payload."""
    import yaml

    provider_map = {
        'anthropic': 'ANTHROPIC_API_KEY',
        'openai': 'OPENAI_API_KEY',
        'ollama': 'OLLAMA_API_KEY',
    }
    light_env = provider_map.get(light['provider'], 'CUSTOM_API_KEY')
    heavy_env = provider_map.get(heavy['provider'], 'CUSTOM_API_KEY')

    config = {
        'corpus': {
            'source': '~/openspin-repos/SpinLib/scripts/.local/graph/works.json',
            'stale_after_days': 30,
        },
        'scout': {
            'categories': ['cond-mat.mes-hall', 'quant-ph'],
            'lookback_days': 1,
            'max_results': 200,
        },
        'topics': topics,
        'llm': {
            'light': {
                'provider': light['provider'],
                'model': light['model'],
                'api_key_env': light_env,
                'base_url': light.get('base_url') or None,
            },
            'heavy': {
                'provider': heavy['provider'],
                'model': heavy['model'],
                'api_key_env': heavy_env,
                'base_url': heavy.get('base_url') or None,
            },
        },
        'ranking': {
            'weights': {'llm': 0.6, 'centrality': 0.3, 'scites': 0.1},
            'top_n': 5,
        },
        'connect': {
            'enabled': True,
            'openalex_mailto': 'j.a.krzywda@gmail.com',
        },
    }

    Path('config').mkdir(exist_ok=True)
    with open('config/arxave.yaml', 'w') as f:
        yaml.dump(config, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

    # .env — only add keys if they aren't already in the environment
    env_lines = [
        '# Arxave environment — generated by arxave serve.',
        '# WARNING: contains API secrets. Keep local.',
        '',
    ]
    for var in sorted({light_env, heavy_env}):
        if var not in os.environ:
            env_lines.append(f'{var}=')
        else:
            env_lines.append(f'# {var} already set in environment')
    with open('.env', 'w') as f:
        f.write('\n'.join(env_lines) + '\n')


def _run_arxave() -> tuple[int, str]:
    """Execute `arxave run` and return (exit_code, combined_output)."""
    proc = subprocess.run(
        [sys.executable, '-m', 'arxave.run', 'run'],
        capture_output=True, text=True, timeout=600,
    )
    return proc.returncode, (proc.stdout + proc.stderr).strip() or '(no output)'


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == '/':
            self._reply(200, 'text/html', _build_html())
        else:
            self._reply(404, 'text/plain', 'Not found')

    def do_POST(self) -> None:
        if self.path != '/run':
            self._reply(404, 'text/plain', 'Not found')
            return

        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length))

        light: dict = body.get('light', {})
        heavy: dict = body.get('heavy', {})
        topics: list[str] = body.get('topics', [])

        if not light.get('model') or not heavy.get('model'):
            self._reply(400, 'application/json', json.dumps(
                {'error': 'Both light and heavy model names are required.'}))
            return
        if not topics:
            self._reply(400, 'application/json', json.dumps(
                {'error': 'At least one topic is required.'}))
            return

        acquired = _RUN_LOCK.acquire(blocking=False)
        if not acquired:
            self._reply(409, 'application/json', json.dumps(
                {'error': 'A run is already in progress. Wait for it to finish.'}))
            return

        try:
            _write_config(light, heavy, topics)
            exit_code, output = _run_arxave()
            if exit_code != 0:
                self._reply(200, 'application/json', json.dumps(
                    {'error': f'Exit code {exit_code}', 'output': output}))
            else:
                self._reply(200, 'application/json', json.dumps(
                    {'output': output}))
        except Exception as exc:
            self._reply(500, 'application/json', json.dumps(
                {'error': str(exc)}))
        finally:
            _RUN_LOCK.release()

    def _reply(self, code: int, content_type: str, body: str) -> None:
        data = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', f'{content_type}; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args: Any) -> None:
        """Suppress default stderr logging — keep the console clean."""
        pass


def run_server() -> None:
    """Start the HTTP server. Blocks until stopped."""
    server = HTTPServer(('127.0.0.1', PORT), _Handler)

    def _shutdown(signum: int, frame: Any) -> None:
        print('\nshutting down…')
        server.shutdown()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    print(f'🧪 Arxave serving at http://127.0.0.1:{PORT}')
    print('   Open this URL in your browser. Press Ctrl+C to stop.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    server.server_close()