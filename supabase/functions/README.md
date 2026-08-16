# Edge functions

Four functions back the browser filter page (`docs/filter.md`). All are
callable without a JWT — the page is static and has no Supabase session.

| Function | Why it exists |
|----------|---------------|
| `relay`  | arXiv and Scirate send **no** `Access-Control-Allow-Origin` header (measured 2026-07-28, on `export.arxiv.org/api/query`, `rss.arxiv.org` and `scirate.com`). A browser cannot fetch them, with or without a key. This relays the GET server-side, allowlisted to those hosts. |
| `embed`  | **The pick.** Every vector the page uses comes from here. It used to be optional, back when the page carried its own 32 MB encoder and this only served people who chose "Hosted" for speed; the browser has no encoder now, so a deployment without this function is a page that cannot rank anything. |
| `dig-cache` | The shared vector cache. Embedding a day of abstracts in the browser costs ~60 s; the vectors are ~200 kB. So the *second* person to haul a day downloads instead of re-embedding. Reads are public; writes need `x-dig-key`. |
| `wagon-name` | Names the train's wagons from their titles. The clustering is local and free; this only says what each cluster is *about*. Cache reads are free and unmetered; a miss spends against a daily budget in Postgres. |

## dig-cache

Keyed on the **sha256 of the text**, never on an arXiv id — so one table serves
abstracts, touchstones and core samples alike, and a revised abstract is a
different text and therefore a miss rather than a stale hit. `model` and `dim`
ride in the key for the reason in [dig-spec §5.6](../../docs/dig-spec.md): a
vector from one model and a vector from another are not interchangeable for the
same text — equal dimension included — and mixing them yields plausible garbage
and no error.

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
`DIG_WRITE_KEY` and calls this same `embed` function for its vectors.

That last clause used to read "runs the same model and quantization as the
browser", and keeping those two implementations in step was a standing hazard.
There is one implementation now. Note also that *server-side embedding* was
listed here as something that might let writes open up. It has happened, and it
does not — the reason writes are closed is that a **client** cannot verify a
vector, and that is still true.

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

**This calls once per train, not per wagon and certainly not per paper, and
that is the whole reason it is affordable.** [`enrich.mjs`](../../scripts/enrich.mjs)
calls once per paper and is kept cheap by only ever seeing the handful a feed
already selected. Naming sees the whole haul — but every unnamed wagon rides in
one request as a numbered group, and the request carries **titles, not
abstracts**, because what a cluster is about is a question its titles already
answer. Measured 2026-08-14: nine wagons named in one 2.3s call for 1041 tokens,
and the 24-wagon worst case (30 papers each) in 3.3s for 6.9k. Ten abstracts
alone would be ~15k. A day of naming costs less than one enrichment.

Each group shows at most `MAX_TITLES` (12) of its members, with the true count
stated — the topic of a thirty-paper cluster is evident in the first dozen
titles and the rest is tokens spent to say it again.

The reply is an array of `{ group, name, gloss }`, and **the group number is
load-bearing**: a model handed nine groups can return eight, or reorder them, and
an array position would then file every name after the gap under the wrong
wagon. A wrong name is worse than no name, because only someone who reads the
titles can catch it. Carrying the number makes a dropped group a missing key
instead of a shifted one; out-of-range numbers are discarded.

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

# wagon-name needs a Gemini key; relay needs nothing
supabase secrets set GEMINI_API_KEY="$(grep '^GEMINI_API_KEY=' ../../.env | cut -d= -f2-)"

# embed needs a Hugging Face token. Create one at
# https://huggingface.co/settings/tokens — fine-grained, with only
# "Make calls to Inference Providers" ticked. It is the billing identity as
# much as the credential: a free HF account carries $0.10 of inference credit
# a month, and the token is how HF knows whose credit to spend.
supabase secrets set HF_TOKEN="hf_..."

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
# Expect "allenai/specter2_base" and 768. The FIRST call after an idle period
# may come back 503 with warming:true and a retryAfter — that is the upstream
# loading the model, not a failure. Call it again.
curl -s -X POST "$BASE/embed" -H 'Content-Type: application/json' \
  -d '{"input":["silicon spin qubits"]}' | jq '.model, .dim, (.data[0].embedding | length)'

# dig-cache: a read for a text nobody has cached is a clean miss, not an error
curl -s -X POST "$BASE/dig-cache" -H 'Content-Type: application/json' \
  -d '{"model":"allenai/specter2_base","dim":768,
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

# the meter is durable — 40 requests carrying *uncached* wagons from one
# address, and the 41st should come back capped:true rather than billing it.
# (One request is one call now, however many wagons it names, so this is 40
# presses rather than 40 wagons.)

# a rate limit is a backstop, not the common case: it takes a train that
# survives all four rungs of the ladder. When it does bite, the response has
# retryAfter set and the rest unnamed, not errored.

# end to end: warm one category, then check the page reports "already cut"
DIG_WRITE_KEY=… node ../../scripts/warm-dig.mjs --categories quant-ph
```

## Cost and abuse

`relay` only proxies GETs and stays inside free tiers at any plausible traffic
(Supabase gives 500k function invocations/month; one filter run is ~120
requests).

`embed` costs money and is billed to whoever deploys it — and it is no longer
optional, so that bill is now the price of running the page rather than a
choice a user made. **HF bills compute time × hardware rate, not tokens**, and
`hf-inference` is CPU for embedding models. A free HF account carries $0.10 of
credit a month, PRO $2.00.

The shape of the spend is lopsided and worth understanding before tuning any
cap. The warmer cuts a whole night — ~870 abstracts across the popular archives
— in one job; a person's touchstone is one short text. So **the nightly warm is
most of the bill and the interactive path is a rounding error**, and the cache
is what keeps it that way: a warmed day costs the readers of it nothing at all.
If the credit runs out, the warm is the thing to trim (fewer categories, or a
shorter `--lookback`), not the page.

Caps live at the top of
[`embed/index.ts`](embed/index.ts): 400 texts per call, 6k chars per text, 800k
chars per call, and a per-IP hourly budget of 3000 texts. The per-IP bucket is
in-memory, so an isolate recycle resets it — it is a speed bump, not a
guarantee. If the page gets traffic, add a durable counter (a Postgres table)
or put the project's own function rate limits in front.

`wagon-name` is the other one that costs money, and it is the first function
here that spends it *on a stranger's behalf* — so its counter is the durable
one that paragraph asks for. **One request is one metered call**, however many
wagons it names — so the budget now counts presses, not wagons, and a press that
falls down the ladder costs one call per rung it tries. Worst case per day is
`WAGON_NAME_GLOBAL_DAILY` calls of **~6.9k total tokens** each (24 wagons of 30
papers, measured 2026-08-14: 5717 prompt, 1164 output, no thinking). At the
default 600 that is ~4M tokens a day if every call is a maximal miss, and a
realistic train is ~1k tokens.

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

**The scarce budget was requests per minute, not tokens, and naming used to
spend the scarce one to save the abundant one.** Measured 2026-08-13 and again
2026-08-14, this project's key is on the Gemini free tier and 429s on the sixth
or seventh call within a minute — so a call per wagon meant a seven-wagon train
stopping halfway with "4 of 7 named" while using a fraction of a 250k/min token
ceiling. Batching the train into one request removed that limit outright; issue
#51 was this and not a model that could not name things.

The ladder below is what survives of the per-wagon fallback, and it is now a
backstop. Rate limits are metered per model, so if a model is full, refuses the
request, or names only some of the groups, the leftovers go to the next model —
one metered call per rung, four rungs, at most four calls per press however it
fails. `LADDER` in [`wagon-name/naming.ts`](wagon-name/naming.ts), best first:

| rung | model | `thinkingConfig` |
| --- | --- | --- |
| 1 | `gemini-3.5-flash-lite` | `{ thinkingLevel: 'low' }` |
| 2 | `gemini-3.1-flash-lite` | `{ thinkingBudget: 0 }` |
| 3 | `gemma-4-31b-it` | *none* |
| 4 | `gemma-4-26b-a4b-it` | *none* |

**The thinking field is per-model and the wrong one is a hard 400**, not a
warning — measured 2026-08-14: `thinkingBudget` on `gemini-3.5-flash-lite`
returns `INVALID_ARGUMENT`, and either spelling on a Gemma returns "Thinking
budget is not supported for this model". So it travels with the model id, and an
id that arrives via `ARXAVE_NAME_MODELS` and is not in the table is sent no
`thinkingConfig` at all — a missing one is never an error, a guessed one is.
All four accept `systemInstruction` and `responseSchema` and were checked
against a real three-title wagon.

On a 429 the function steps down a rung and retries *the wagons still unnamed*;
a 400 or 404 steps down too, since a refused request shape will be refused
again. A failed call is refunded, so only calls that produced a name are
charged. Only an exhausted ladder ends the run — then `retryAfter` comes back in
seconds (the shortest wait any rung asked for) so the page can say "press again
in about 50s" instead of "come back tomorrow"; `capped` is reserved for the
meter itself refusing, which is the one case that really does mean tomorrow. The
wagons already named are cache hits, so the next press
resumes rather than restarts. `models` in the response lists the rungs that
actually answered. Set `ARXAVE_NAME_MODELS` to a comma-separated list to
override the ladder; the older single-model `ARXAVE_NAME_MODEL` still works and
pins it to one rung. Realistically it is far less, because the cache is shared and two people
hauling `quant-ph` on the same morning cluster the same papers. Caps and both
budgets are at the top of [`wagon-name/index.ts`](wagon-name/index.ts); the
transactional meter is in [`wagon-names.sql`](../wagon-names.sql).

Users who would rather not use this deployment's pick can set
`window.ARXAVE_EMBED` to any OpenAI-shaped `/v1/embeddings` — their own LM
Studio, Ollama, or a paid endpoint. It must serve the **same model**: the page
checks the `dim` in the reply against its own and refuses a mismatch, but two
different models at 768 dims would pass that check and quietly rank the wrong
papers first.

`dig-cache` costs nothing but storage: a day of one category set is ~130
vectors × 768 × 4 B ≈ **400 kB**, and the batch's rolling-window prune
(`store.prune_vectors`, keyed on *last wanted*, not on the paper's date) holds
the table to the retention window. Its reads are the one thing that could get
hot, which is why they are a single `POST` per haul rather than one request per
paper.
