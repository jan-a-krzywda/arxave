/*
 * The pick loads on demand, not up front. Run with `node tests/js/lazy-pick.test.js`.
 *
 * These are wiring guards, not behaviour tests — driving a real haul would need
 * a DOMParser, a canvas and a 32 MB CDN import, none of which the shim has. What
 * they pin is the pair of edits that a later change could silently undo, both of
 * which fail *quietly*: re-gating a button just makes the page ask for 32 MB it
 * no longer needs, and bypassing ensurePick() just makes embedding throw on a
 * null extractor for users who never pressed Stage 0.
 */
const fs = require('fs');
const path = require('path');

const JS = fs.readFileSync(path.join(__dirname, '../../docs/assets/filter.js'), 'utf8');
const MD = fs.readFileSync(path.join(__dirname, '../../docs/filter.md'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (extra ? ' — ' + extra : ''));
  }
}

console.log('\n1. no stage is gated on the model being loaded');
for (const id of ['haul-btn', 'add-touchstone', 'add-core']) {
  const tag = MD.match(new RegExp('<button[^>]*id="' + id + '"[^>]*>'));
  check(id + ' starts enabled', tag && !/\bdisabled\b/.test(tag[0]), tag && tag[0]);
}

console.log('\n2. local embedding asks for the pick itself');
{
  const body = JS.slice(JS.indexOf('async function embedTexts(texts'));
  const head = body.slice(0, body.indexOf('for (var i = 0'));
  check('embedTexts awaits ensurePick', /await\s+ensurePick\(\)/.test(head), head.trim());
  check('it does not read state.extractor directly',
    !/var\s+extractor\s*=\s*state\.extractor/.test(head));
}

console.log('\n3. the load is memoized, so racing callers download once');
{
  const body = JS.slice(JS.indexOf('function ensurePick()'), JS.indexOf('async function loadPick'));
  check('reuses an in-flight promise', /_pickPromise\s*=\s*loadPick\(\)/.test(body));
  check('clears it on failure so a retry is possible', /_pickPromise\s*=\s*null/.test(body));
}

console.log('\n4. a fully cached haul never reaches the model');
{
  // embedTextsCached must only call embedTexts when there are misses — that
  // conditional is the whole reason a warm day needs no download.
  const body = JS.slice(JS.indexOf('async function embedTextsCached'));
  const guarded = /if\s*\(missIdx\.length\)\s*\{[\s\S]{0,200}?embedTexts\(/.test(body);
  check('embedTexts is called only under `if (missIdx.length)`', guarded);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll passed');
process.exit(failures ? 1 : 0);
