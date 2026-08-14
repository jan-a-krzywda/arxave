/*
 * One paper is one stone. Run with `node tests/js/scout-dedup.test.js`.
 *
 * A haul with lookback > 1 reads two sources: the announcement RSS feed for
 * tonight and the search API for the earlier days. They disagree on the arXiv
 * id — the feed's <link> is '.../abs/2508.12345', the API's <id> is
 * '.../abs/2508.12345v1' — so a dedup on the raw string missed every paper
 * that appeared in both, and the same title came back twice (issue #49). Both
 * parsers must therefore go through bareArxivId, and it must strip versions.
 */
const fs = require('fs');
const path = require('path');

const JS = fs.readFileSync(path.join(__dirname, '../../docs/assets/filter.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (extra ? ' — ' + extra : ''));
  }
}

console.log('\n1. bareArxivId strips the wrapper and the version');
{
  // Lift the helper out of the IIFE — it touches no DOM, so it runs as-is.
  const src = JS.slice(JS.indexOf('function bareArxivId('));
  const body = src.slice(0, src.indexOf('\n  }\n') + 4);
  const bareArxivId = new Function(body + '\n  return bareArxivId;')();

  const cases = [
    ['http://arxiv.org/abs/2508.12345v1', '2508.12345'],
    ['https://arxiv.org/abs/2508.12345', '2508.12345'],
    ['  https://arxiv.org/abs/2508.12345v12  ', '2508.12345'],
    ['arXiv:2508.12345v2', '2508.12345'],
    ['cond-mat/0512345v1', 'cond-mat/0512345'],
    ['', ''],
  ];
  for (const [raw, want] of cases) {
    const got = bareArxivId(raw);
    check(JSON.stringify(raw) + ' → ' + want, got === want, 'got ' + JSON.stringify(got));
  }
}

console.log('\n2. both scout parsers canonicalise before they emit a stone');
{
  const atom = JS.slice(JS.indexOf('function parseAtomXML('), JS.indexOf('function parseAnnouncementRSS('));
  const rss = JS.slice(JS.indexOf('function parseAnnouncementRSS('), JS.indexOf('async function fetchAnnouncement('));
  check('parseAtomXML uses bareArxivId', /var arxivId = bareArxivId\(/.test(atom));
  check('parseAnnouncementRSS uses bareArxivId', /var arxivId = bareArxivId\(/.test(rss));
  // A raw /abs/ strip left in either one is the exact shape of the old bug.
  check('neither strips the wrapper by hand',
    !/arxivId = [^;]*replace\(\/\^\.\*\\\/abs\\\//.test(atom + rss));
}

console.log('\n3. the lookback pass still checks `seen` before pushing');
{
  const body = JS.slice(JS.indexOf('if (lookback > 1) {'), JS.indexOf('if (stones.length === 0) throw'));
  check('skips ids already hauled from the feed',
    /if \(seen\[candidates\[i\]\.arxiv_id\]\) continue;/.test(body));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll passed');
process.exit(failures ? 1 : 0);
