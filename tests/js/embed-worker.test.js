/*
 * The pick cuts off the main thread. Run with `node tests/js/embed-worker.test.js`.
 *
 * Wiring guards, in the same spirit as lazy-pick.test.js: a real check would
 * need a browser with workers and a 32 MB CDN import. What these pin are the
 * properties whose loss is silent — the page keeps working after every one of
 * them, just with the frozen train this change existed to remove.
 */
const fs = require('fs');
const path = require('path');

const JS = fs.readFileSync(path.join(__dirname, '../../docs/assets/filter.js'), 'utf8');
const WORKER_PATH = path.join(__dirname, '../../docs/assets/embed-worker.js');
const WORKER = fs.readFileSync(WORKER_PATH, 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (extra ? ' — ' + extra : ''));
  }
}

console.log('\n1. the worker is a sibling of the script that starts it');
{
  // A hard-coded '/assets/embed-worker.js' breaks under a Jekyll baseurl, and
  // fails as a 404 the fallback quietly swallows.
  check('the URL is derived from document.currentScript',
    /document\.currentScript[\s\S]{0,200}embed-worker\.js/.test(JS));
  check('the worker file exists where filter.js looks for it', fs.existsSync(WORKER_PATH));
  check('it is started as a module worker', /new Worker\(WORKER_URL,\s*\{\s*type:\s*'module'\s*\}\)/.test(JS));
}

console.log('\n2. the worker answers both halves of the protocol');
for (const type of ['load', 'embed']) {
  check("handles {type:'" + type + "'}", new RegExp("msg\\.type === '" + type + "'").test(WORKER));
}
for (const type of ['progress', 'ready', 'vectors', 'error']) {
  check("posts {type:'" + type + "'}", new RegExp("type: '" + type + "'").test(WORKER));
}

console.log('\n3. a browser without workers still hauls');
{
  const body = JS.slice(JS.indexOf('async function loadPick()'));
  const head = body.slice(0, body.indexOf('state.extractor = pick'));
  check('the worker load is tried in a try/catch', /try\s*\{[\s\S]{0,120}loadPickInWorker\(/.test(head));
  check('and falls back to the main thread', /loadPickInline\(/.test(head));
  check('the inline path yields so the page still paints',
    /batch: INLINE_BATCH,[\s\S]{0,300}yieldToPaint\(\)/.test(JS));
}

console.log('\n4. batches are what the count follows, not the animation');
{
  const body = JS.slice(JS.indexOf('async function embedTexts(texts'));
  const loop = body.slice(body.indexOf('for (var i = 0'), body.indexOf('return vectors'));
  check('the batch is embedded through the handle', /await pick\.embed\(/.test(loop));
  // Reporting the batch before it lands is what made stones drop in lockstep
  // with a thread that had not done the work yet.
  check('progress is reported after the vectors are in',
    /vectors\.push\(rows\[r\]\);[\s\S]{0,300}statusFn\(vectors\.length, texts\.length\)/.test(loop));
  check('no yield is needed around the worker call', !/yieldToPaint\(\)/.test(loop));
}

console.log('\n5. a failed worker cannot hang the haul');
{
  const body = JS.slice(JS.indexOf('function loadPickInWorker'), JS.indexOf('async function loadPickInline'));
  check('an in-flight batch is rejected on worker error',
    /onerror[\s\S]{0,600}pending\[id\]\.reject\(/.test(body));
  check('and on an error reply carrying an id', /waiting\.reject\(err\)/.test(body));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll passed');
process.exit(failures ? 1 : 0);
