# Edge functions

Four functions back the browser filter page (`docs/filter.md`). All are
callable without a JWT — the page is static and has no Supabase session.

| Function | Why it exists |
|----------|---------------|
| `relay`  | arXiv and Scirate send **no** `Access-Control-Allow-Origin` header (measured 2026-07-28, on `export.arxiv.org/api/query`, `rss.arxiv.org` and `scirate.com`). A browser cannot fetch them, with or without a key. This relays the GET server-side, allowlisted to those hosts. |
| `embed`  | Optional. The page defaults to in-browser embeddings (transformers.js, free), so this only serves people who pick "Hosted" for speed. Deploy it or don't — the page works either way. |
| `dig-cache` | The shared vector cache. Embedding a day of abstracts in the browser costs ~60 s; the vectors are ~200 kB. So the *second* person to haul a day downloads instead of re-embedding. Reads are public; writes need `x-dig-key`. |
| `wagon-name` | Names the train's wagons from their titles. The clustering is local and free; this only says what each cluster is *about*. Cache reads are free and unmetered; a miss spends against a daily budget in Postgres. |

## dig-cache

Keyed on the **sha256 of the text**, never on an arXiv id — so one table serves
abstracts, touchstones and core samples alike, and a revised abstract is a
different text and therefore a miss rather than a stale hit. `model` and `dim`
ride in the key for the reason in [dig-spec §5.6](../../docs/dig-spec.md): a
384-dim bge vector and a 768-dim Gemini one for the same text are not
interchangeable, and mixing them yields plausible garbage and no error.

```
POST /dig-cache  { model, dim, sha: ["<hex>", …] }
  → { model, dim, hits: { "<hex>": "<base64 float32le>" }, misses: n }

PUT  /dig-cache  { model, dim, items: [{ sha, vector, source? }] }
  header  x-dig-key: $DIG_WRITE_KEY
  → { written: n }
```

**Reads are public, writes are not, and that asymmetry is the whole security
model.** A returned vector is unverifiable by the client: it cannot tell a
correct embedding from a crafted one, and a poisoned vector silently reorders
someone's ranking rather than failing. So the only writer is the warmer
([`scripts/warm-dig.mjs`](../../scripts/warm-dig.mjs)), which holds
`DIG_WRITE_KEY` and runs the same model and quantization as the browser.
Opening writes to the page would need a verification story first — quorum
across independent clients, or server-side embedding — not just a rate limit.

Every failure is a **miss, never an error**: the page embeds locally when the
cache is down, empty, or opted out with `window.ARXAVE_DIG_CACHE = false`.

The wire format is little-endian float32, `dim * 4` bytes — the same bytes
`store.pack_vector` writes from Python and `Float32Array` reads in the browser.
`deno test supabase/functions/dig-cache/` pins that agreement.

## wagon-name

A wagon is a connected component of the coupling map. The page can already draw
it, count it, and point at its most central paper; what it cannot do is say what
the papers have in common. This does.

```
POST /wagon-name  { wagons: [{ members: [{ id, title }, …] }, …] }
  → { names: { "<key>": { name, gloss } }, keys: ["<key>", …],
      cached: n, generated: n, unnamed: n, capped: bool }
```

**This calls per wagon, not per paper, and that is the whole reason it is
affordable.** [`enrich.mjs`](../../scripts/enrich.mjs) calls once per paper and
is kept cheap by only ever seeing the handful a feed already selected. Naming
sees the whole haul — but a haul of ~150 stones clusters into five to fifteen
wagons, and the request carries **titles, not abstracts**, because what a
cluster is about is a question its titles already answer. Ten titles is ~200
tokens against ~15k for ten abstracts. A day of naming costs less than one
enrichment.

The cache key is `sha256` over the wagon's **sorted `id\ttitle` lines**, defined
once in [`naming.ts`](wagon-name/naming.ts) and recomputed independently by the
browser. Sorted because a wagon is a set and component order comes out of a DFS.
Titles are in the key, not just ids, because the titles are what the model is
shown and they arrive from the client: keying on ids alone would let anyone name
a real wagon by sending real ids with invented titles, and everyone after them
would read that name from cache. Folded in, a client that lies poisons only a key
nobody else computes. Two honest people hauling the same day get identical titles
from the same listing, so they still collide on a hit.

**Reads are free, generation is budgeted** — the same asymmetry as `dig-cache`,
for a different reason. There the worry was a poisoned vector *nobody can
verify*; a name sits next to the titles it came from and is checkable on sight,
so the risk here is not truth but cost. Cache hits are therefore unlimited and
unmetered, and only a genuine miss debits the meter.

That meter is a Postgres row, not an in-memory bucket. `embed` keeps its per-IP
budget in an isolate-local Map and says honestly that an isolate recycle resets
it — fine for CPU, not fine for a metered third-party API. `wagon_name_spend`
checks the per-client and global caps in one transaction and returns how many
calls it granted; a call the provider then refuses is refunded, so a bad
afternoon at Gemini does not burn a caller's day. Defaults are 40 namings per
client per UTC day and 600 across everyone, both overridable by secret.

**Every failure is a missing name, never an error.** No `GEMINI_API_KEY`, an
exhausted budget, a refused call, a timeout, `crypto.subtle` missing because the
page is on `http://` — each one leaves the wagon numbered exactly as it was
before naming existed. Naming is a garnish on a clustering that already happened
locally, and `window.ARXAVE_WAGON_NAME = false` removes the button outright.

Naming is on a **button**, not on every recompute, and that is a cost decision
rather than a UI one: the threshold slider re-derives components on every input
event, so naming inside `clusterOrder` would turn one drag into dozens of
call-sets. Names are held by membership, so dragging the threshold away and back
re-attaches names already paid for with no request at all.

## Deploy

```bash
brew install supabase/tap/supabase        # CLI is not installed yet
supabase login
supabase link --project-ref ugxxakguqgpxpdfhgtsb

# embed and wagon-name need a key; relay needs nothing
supabase secrets set GEMINI_API_KEY="$(grep '^GEMINI_API_KEY=' ../../.env | cut -d= -f2-)"

# dig-cache: a write key of your choosing. SUPABASE_URL and
# SUPABASE_SERVICE_ROLE_KEY are injected by the platform — do not set them.
supabase secrets set DIG_WRITE_KEY="$(openssl rand -hex 32)"

# wagon-name: salts the per-caller hash so the budget table holds no raw IPs.
# Rotating it resets everyone's budget, which is a blunt way to clear a stuck day.
supabase secrets set WAGON_NAME_SALT="$(openssl rand -hex 16)"

# Optional — the defaults are 40 and 600. Raise or lower without redeploying.
# supabase secrets set WAGON_NAME_CLIENT_DAILY=40 WAGON_NAME_GLOBAL_DAILY=600

supabase functions deploy relay
supabase functions deploy embed
supabase functions deploy dig-cache
supabase functions deploy wagon-name
```

`config.toml` already sets `verify_jwt = false` for all four; the CLI picks
that up.

`wagon-name` needs [`wagon-names.sql`](../wagon-names.sql) run first — it
creates the cache table, the budget table, the `wagon_name_spend` meter and its
nightly prune. Without it every call is a clean miss that grants no budget, so
the page shows numbered wagons and no error, which is the designed failure but
not the one you want in production.

`dig-cache` reads and writes the `dig_vectors` table, which the Python batch
creates on its first connection (`CREATE TABLE IF NOT EXISTS`, see
[`src/arxave/db.py`](../../src/arxave/db.py)). Run
[`rls.sql`](../rls.sql) after that, so the table is closed to anon and the
function stays its only door.

The same `DIG_WRITE_KEY` goes into the repo's GitHub secrets, where the nightly
[warm-dig workflow](../../.github/workflows/warm-dig.yml) picks it up.

That workflow has no `on: schedule` — its clock is a pg_cron job in this same
project, set up by [`warm-cron.sql`](../warm-cron.sql), which calls the Actions
dispatch API at 04:10 UTC. GitHub's cron dispatcher was measured slipping up to
two hours on this repo, which pushed the warm past the morning it was for.

## Verify

```bash
BASE=https://ugxxakguqgpxpdfhgtsb.supabase.co/functions/v1

# relay: should return Atom XML plus access-control-allow-origin: *
curl -is "$BASE/relay?url=$(printf %s 'https://export.arxiv.org/api/query?search_query=cat:quant-ph&max_results=1' | jq -sRr @uri)" | head -20

# relay: should refuse anything off the allowlist
curl -s "$BASE/relay?url=https://example.com" ; echo

# embed: should return one 768-dim vector
curl -s -X POST "$BASE/embed" -H 'Content-Type: application/json' \
  -d '{"input":["silicon spin qubits"]}' | jq '.model, (.data[0].embedding | length)'

# dig-cache: a read for a text nobody has cached is a clean miss, not an error
curl -s -X POST "$BASE/dig-cache" -H 'Content-Type: application/json' \
  -d '{"model":"Xenova/bge-small-en-v1.5","dim":384,
       "sha":["0000000000000000000000000000000000000000000000000000000000000000"]}'

# dig-cache: a write without the key must be refused
curl -s -X PUT "$BASE/dig-cache" -H 'Content-Type: application/json' \
  -d '{"model":"m","dim":1,"items":[]}'

# wagon-name: a real wagon. Expect a name, a gloss, and generated:1 the first
# time — then generated:0 and cached:1 on an immediate repeat, which is the
# cache doing its job.
curl -s -X POST "$BASE/wagon-name" -H 'Content-Type: application/json' \
  -d '{"wagons":[{"members":[
        {"id":"2608.00001","title":"Valley splitting in Si/SiGe heterostructures"},
        {"id":"2608.00002","title":"Valley-orbit coupling in silicon quantum dots"},
        {"id":"2608.00003","title":"Measuring valley splitting by magnetospectroscopy"}]}]}' \
  | jq '.names, .cached, .generated, .capped'

# wagon-name: a malformed body is a 400 with a message, never a silent empty
curl -s -X POST "$BASE/wagon-name" -H 'Content-Type: application/json' \
  -d '{"wagons":[{"members":[]}]}'

# the meter is durable — run the same wagon 41 times from one address and the
# 41st should come back capped:true rather than billing a 41st call.

# the rate limit bites first: six or more *uncached* wagons in one request on
# the free tier come back with retryAfter set and the rest unnamed, not errored.

# end to end: warm one category, then check the page reports "already cut"
DIG_WRITE_KEY=… node ../../scripts/warm-dig.mjs --categories quant-ph
```

## Cost and abuse

`relay` only proxies GETs and stays inside free tiers at any plausible traffic
(Supabase gives 500k function invocations/month; one filter run is ~120
requests). `embed` is the one that costs money, and is billed to whoever
deploys it — which is why the page does not use it by default. Caps live at the top of
[`embed/index.ts`](embed/index.ts): 400 texts per call, 6k chars per text, 800k
chars per call, and a per-IP hourly budget of 3000 texts. The per-IP bucket is
in-memory, so an isolate recycle resets it — it is a speed bump, not a
guarantee. If the page gets traffic, add a durable counter (a Postgres table)
or put the project's own function rate limits in front.

`wagon-name` is the other one that costs money, and it is the first function
here that spends it *on a stranger's behalf* — so its counter is the durable
one that paragraph asks for. Worst case per day is `WAGON_NAME_GLOBAL_DAILY`
calls of **~270 total tokens** each — measured 2026-08-13 across two wagons, two
runs each: 182–205 prompt, ~50 output, no thinking. At the default 600 calls
that is under 200k tokens a day even if every single call is a miss.

Thinking is off (`thinkingBudget: 0`) and the prompt carries the load instead.
This was briefly set to 512 on the theory that thinking bought the correct word
order — a four-title wagon named itself "Silicon Valley Splitting" at 0 and
"Valley Splitting in Silicon" at 512. That misread the evidence. The fault was
in `SYSTEM`, which asked for the field's terminology but never said to keep a
paper's prepositional phrasing, leaving the model free to compress into a
compound that collides with a famous proper noun. With that stated outright,
budget 0 produces the right name on both test wagons twice each, and is the
*more* stable of the two settings as well as 2.4× cheaper — at 512 the label
drifts ("Valley splitting and coupling in silicon"). A thinking budget cannot
fix a prompt that never stated the constraint.

**The binding limit is requests per minute, not the daily budget.** Measured
2026-08-13, this project's key is on the Gemini free tier: **5 requests/min** on
`gemini-2.5-flash`. A first haul with ten uncached wagons therefore 429s on the
sixth, long before any daily cap is in sight. The function stops at the first
429 rather than marching through the rest collecting one each, refunds every
granted-but-unspent call, and returns `retryAfter` in seconds so the page can
say "press again in about 50s" instead of "come back tomorrow". The wagons
already named are cache hits, so the next press resumes rather than restarts.
Raising throughput means a paid tier, not a code change. Realistically it is far less, because the cache is shared and two people
hauling `quant-ph` on the same morning cluster the same papers. Caps and both
budgets are at the top of [`wagon-name/index.ts`](wagon-name/index.ts); the
transactional meter is in [`wagon-names.sql`](../wagon-names.sql).

Users who would rather not use the hosted path can switch the page's embedding
mode to **Own key** and point it at any OpenAI-compatible `/v1/embeddings`.

`dig-cache` costs nothing but storage: a day of one category set is ~130
vectors × 384 × 4 B ≈ **200 kB**, and the batch's rolling-window prune
(`store.prune_vectors`, keyed on *last wanted*, not on the paper's date) holds
the table to the retention window. Its reads are the one thing that could get
hot, which is why they are a single `POST` per haul rather than one request per
paper.
