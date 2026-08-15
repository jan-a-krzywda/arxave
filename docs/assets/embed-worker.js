/*
 * The pick, off the main thread.
 *
 * transformers.js on the WASM backend is synchronous once it starts: a call to
 * the extractor runs to completion without giving the thread back. On the main
 * thread that means no frames — the haul train froze solid for the length of
 * the run, and shrinking the batch only chopped the freeze into smaller ones.
 * Here it blocks a thread nobody is watching, so the page animates through the
 * whole haul and stones drop in as each batch is posted back.
 *
 * Protocol (all messages are {type, ...}):
 *   in   {type:'load', urls, model}     → load transformers.js and the model
 *   out  {type:'progress', file, pct}   → …reporting the download as it goes
 *   out  {type:'ready'} | {type:'error', message}
 *   in   {type:'embed', id, texts}      → embed one batch
 *   out  {type:'vectors', id, vectors} | {type:'error', id, message}
 *
 * Loaded as a module worker; falls back to the main thread in filter.js if the
 * browser refuses it.
 */

let extractor = null;

async function load(urls, model) {
  let mod = null;
  const failures = [];
  for (const url of urls) {
    try {
      mod = await import(url);
      break;
    } catch (err) {
      failures.push(url + ' → ' + (err && err.message ? err.message : String(err)));
    }
  }
  if (!mod) {
    throw new Error('Could not load transformers.js from any CDN: ' + failures.join(' | '));
  }

  mod.env.allowLocalModels = false;

  extractor = await mod.pipeline('feature-extraction', model, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: function (p) {
      if (p && p.status === 'progress' && p.file && typeof p.progress === 'number') {
        self.postMessage({ type: 'progress', file: p.file, pct: Math.round(p.progress) });
      }
    },
  });
}

self.onmessage = async function (e) {
  const msg = e.data || {};

  if (msg.type === 'load') {
    try {
      await load(msg.urls, msg.model);
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
    }
    return;
  }

  if (msg.type === 'embed') {
    try {
      const out = await extractor(msg.texts, { pooling: 'mean', normalize: true });
      self.postMessage({ type: 'vectors', id: msg.id, vectors: out.tolist() });
    } catch (err) {
      self.postMessage({
        type: 'error', id: msg.id,
        message: err && err.message ? err.message : String(err),
      });
    }
  }
};
