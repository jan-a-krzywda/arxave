(function () {
  'use strict';

  // Show the app once JS is confirmed running.
  const app = document.getElementById('app');
  if (app) app.style.display = '';

  // ── Provider presets ──────────────────────────────────────────────
  const PRESETS = {
    anthropic: {
      provider: 'anthropic',
      base_url: '',
      env_var: 'ANTHROPIC_API_KEY',
      model: 'claude-haiku-4-5',
    },
    openai: {
      provider: 'openai',
      base_url: '',
      env_var: 'OPENAI_API_KEY',
      model: 'gpt-4o-mini',
    },
    deepseek: {
      provider: 'openai',
      base_url: 'https://api.deepseek.com/v1',
      env_var: 'DEEPSEEK_API_KEY',
      model: 'deepseek-chat',
    },
    groq: {
      provider: 'openai',
      base_url: 'https://api.groq.com/openai/v1',
      env_var: 'GROQ_API_KEY',
      model: 'llama-3.1-8b-instant',
    },
    together: {
      provider: 'openai',
      base_url: 'https://api.together.xyz/v1',
      env_var: 'TOGETHER_API_KEY',
      model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    },
    ollama: {
      provider: 'ollama',
      base_url: 'http://localhost:11434/v1',
      env_var: 'OLLAMA_API_KEY',
      model: 'llama3.2',
    },
    'lm-studio': {
      provider: 'openai',
      base_url: 'http://127.0.0.1:1234/v1',
      env_var: 'LM_STUDIO_API_KEY',
      model: 'liquid/lfm2.5-1.2b',
    },
    custom: {
      provider: 'openai',
      base_url: '',
      env_var: 'CUSTOM_API_KEY',
      model: '',
    },
  };

  // Separate heavy-model defaults (can differ from light).
  const HEAVY_MODEL = {
    anthropic: 'claude-opus-4-8',
    openai: 'gpt-4o',
    deepseek: 'deepseek-reasoner',
    groq: 'deepseek-r1-distill-llama-70b',
    together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    ollama: 'llama3.2',
    'lm-studio': 'liquid/lfm2.5-1.2b',
    custom: '',
  };

  // ── DOM refs ──────────────────────────────────────────────────────
  function byId(id) { return document.getElementById(id); }
  function qs(sel) { return document.querySelector(sel); }

  // ── Provider change → auto-fill model, base_url, env var ──────────
  function onProviderChange(role) {
    const prov = byId(role + '-provider').value;
    const preset = PRESETS[prov];

    byId(role + '-model').value = role === 'light' ? preset.model : (HEAVY_MODEL[prov] || preset.model);
    byId(role + '-base-url').value = preset.base_url;
    byId(role + '-env').value = preset.env_var;

    const baseLabel = byId(role + '-base-url-label');
    if (prov === 'custom' || prov === 'ollama') {
      baseLabel.style.display = '';
    } else {
      baseLabel.style.display = (preset.base_url ? '' : 'none');
    }
  }

  // Bind change events for both roles.
  ['light', 'heavy'].forEach(function (role) {
    var sel = byId(role + '-provider');
    sel.addEventListener('change', function () { onProviderChange(role); });
    onProviderChange(role); // initial state
  });

  // ── BibTeX keyword extraction ─────────────────────────────────────
  function extractBibKeywords(text) {
    var kw = new Set();

    // 1. author keywords field (case-insensitive, multiline)
    var kwMatch = text.match(/keywords\s*=\s*\{([^}]+)\}/i);
    if (kwMatch) {
      kwMatch[1].split(/[,;]\s*/).forEach(function (k) {
        k = k.trim();
        if (k && k.length > 2) kw.add(k);
      });
    }

    // 2. title words (≥5 chars, stripping punctuation)
    var titleMatch = text.match(/title\s*=\s*\{([^}]+)\}/i);
    if (titleMatch) {
      var title = titleMatch[1].replace(/\{[^}]*\}/g, ''); // strip BibTeX accents
      var words = title.toLowerCase().match(/\b\w{5,}\b/g) || [];
      var stop = new Set([
        'which', 'their', 'about', 'these', 'those', 'there', 'where',
        'using', 'between', 'through', 'based', 'with', 'from', 'into',
        'that', 'this', 'over', 'under', 'have', 'been', 'were', 'more',
        'also', 'than', 'paper', 'study', 'effect', 'model', 'system',
        'approach', 'method', 'results', 'experiment', 'demonstrate',
        'investigate', 'measurement', 'analysis', 'present', 'propose',
        'report', 'describe', 'calculate',
      ]);
      words.forEach(function (w) {
        if (!stop.has(w)) kw.add(w);
      });
    }

    return Array.from(kw);
  }

  // ── Chip list UI ──────────────────────────────────────────────────
  var chipContainer = byId('keyword-chips');

  byId('bib-file').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;

    var reader = new FileReader();
    reader.onload = function () {
      var keywords = extractBibKeywords(reader.result);
      if (keywords.length === 0) {
        chipContainer.innerHTML = '<p class="hint">No keywords found in the .bib file.</p>';
        return;
      }

      chipContainer.innerHTML = '<p class="hint">Click suggestions to add them to your topics:</p>';
      keywords.forEach(function (kw) {
        var chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = kw;
        chip.title = 'Add "' + kw + '" to topics';
        chip.addEventListener('click', function () {
          var ta = byId('topics');
          var lines = ta.value.trim().split('\n').filter(Boolean);
          if (lines.indexOf(kw) === -1) {
            lines.push(kw);
            ta.value = lines.join('\n');
          }
          chip.classList.add('used');
          chip.title = 'Already added';
          setTimeout(function () { chip.remove(); }, 400);
        });
        chipContainer.appendChild(chip);
      });
    };
    reader.readAsText(file);
  });

  // ── Build config object ───────────────────────────────────────────
  function buildConfig() {
    var role = function (r) {
      var prov = byId(r + '-provider').value;
      var base = byId(r + '-base-url').value.trim();
      return {
        provider: PRESETS[prov].provider,
        model: byId(r + '-model').value.trim(),
        api_key_env: byId(r + '-env').value.trim(),
        base_url: base || null,
      };
    };

    var topics = byId('topics').value
      .split('\n')
      .map(function (l) { return l.trim(); })
      .filter(Boolean);

    var cats = byId('categories').value
      .split(',')
      .map(function (c) { return c.trim(); })
      .filter(Boolean);

    return {
      corpus: {
        source: '~/openspin-repos/SpinLib/scripts/.local/graph/works.json',
        stale_after_days: 30,
      },
      scout: {
        categories: cats,
        lookback_days: parseInt(byId('lookback').value, 10) || 1,
        max_results: parseInt(byId('max-results').value, 10) || 200,
      },
      topics: topics,
      llm: {
        light: role('light'),
        heavy: role('heavy'),
      },
      ranking: {
        weights: {
          llm: parseFloat(byId('w-llm').value) || 0.6,
          centrality: parseFloat(byId('w-centrality').value) || 0.3,
          scites: parseFloat(byId('w-scites').value) || 0.1,
        },
        top_n: parseInt(byId('top-n').value, 10) || 5,
      },
      connect: {
        enabled: true,
        openalex_mailto: 'j.a.krzywda@gmail.com',
      },
    };
  }

  // ── Minimal YAML emitter (no library dependency) ──────────────────
  function emitYAML(obj, indent) {
    indent = indent || 0;
    var pad = '  '.repeat(indent);
    var lines = [];

    if (obj === null) return pad + 'null\n';
    if (typeof obj === 'boolean') return pad + String(obj) + '\n';
    if (typeof obj === 'number') return pad + String(obj) + '\n';
    if (typeof obj === 'string') {
      // Need quoting if it contains special chars or looks ambiguous.
      if (/[:{}\[\],&*#?|<>=!%@`'"]/.test(obj) || obj === '' || obj === 'true' || obj === 'false' || obj === 'null' ||
          /^\d/.test(obj) && !/^\d+\.?\d*$/.test(obj)) {
        return pad + JSON.stringify(obj) + '\n';
      }
      return pad + obj + '\n';
    }

    if (Array.isArray(obj)) {
      if (obj.length === 0) return pad + '[]\n';
      obj.forEach(function (item) {
        if (typeof item === 'string' || typeof item === 'number' || item === null || typeof item === 'boolean') {
          lines.push(pad + '- ' + emitYAML(item, 0).replace(/^\s+/, ''));
        } else {
          lines.push(pad + '- ');
          lines.push(emitYAML(item, indent + 1));
        }
      });
      return lines.join('');
    }

    // Object
    var keys = Object.keys(obj);
    if (keys.length === 0) return pad + '{}\n';
    keys.forEach(function (k) {
      var v = obj[k];
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        lines.push(pad + k + ':\n');
        lines.push(emitYAML(v, indent + 1));
      } else if (Array.isArray(v)) {
        lines.push(pad + k + ':\n');
        lines.push(emitYAML(v, indent + 1));
      } else {
        lines.push(pad + k + ': ' + emitYAML(v, 0).trimStart() + '\n');
      }
    });
    return lines.join('');
  }

  // ── Build .env ────────────────────────────────────────────────────
  function buildEnv(config) {
    var lines = [];
    lines.push('# Arxave environment — generated by the Arxave web UI.');
    lines.push('# WARNING: this file contains API secrets. Keep it local.');
    lines.push('# It is already listed in .gitignore — never commit it.');
    lines.push('');

    var seen = {};
    function addEnv(roleCfg) {
      var name = roleCfg.api_key_env;
      if (seen[name]) return;
      seen[name] = true;
      lines.push(name + '=');
    }

    addEnv(config.llm.light);
    addEnv(config.llm.heavy);

    if (lines.length === 4) lines.push('# (you can add more keys below)');
    return lines.join('\n') + '\n';
  }

  // ── File download helper ──────────────────────────────────────────
  function download(content, filename) {
    var blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Button handlers ───────────────────────────────────────────────
  byId('download-yaml').addEventListener('click', function () {
    var config = buildConfig();
    var yaml = [
      '# Arxave configuration — generated by the Arxave web UI.',
      '#',
      '# Place this at config/arxave.yaml in your arxave checkout.',
      '# No secrets here — API keys live in .env.',
      '',
    ].join('\n') + emitYAML(config);
    download(yaml, 'arxave.yaml');
  });

  byId('download-env').addEventListener('click', function () {
    var config = buildConfig();
    var env = buildEnv(config);
    download(env, '.env');
  });
})();
