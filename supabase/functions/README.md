# Edge functions

Three functions back the browser filter page (`docs/filter.md`). All are
callable without a JWT — the page is static and has no Supabase session.

| Function | Why it exists |
|----------|---------------|
| `relay`  | arXiv and Scirate send **no** `Access-Control-Allow-Origin` header (measured 2026-07-28, on `export.arxiv.org/api/query`, `rss.arxiv.org` and `scirate.com`). A browser cannot fetch them, with or without a key. This relays the GET server-side, allowlisted to those hosts. |
| `embed`  | Optional. The page defaults to in-browser embeddings (transformers.js, free), so this only serves people who pick "Hosted" for speed. Deploy it or don't — the page works either way. |
| `dig-cache` | The shared vector cache. Embedding a day of abstracts in the browser costs ~60 s; the vectors are ~200 kB. So the *second* person to haul a day downloads instead of re-embedding. Reads are public; writes need `x-dig-key`. |

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

## Deploy

```bash
brew install supabase/tap/supabase        # CLI is not installed yet
supabase login
supabase link --project-ref ugxxakguqgpxpdfhgtsb

# embed needs a key; relay needs nothing
supabase secrets set GEMINI_API_KEY="$(grep '^GEMINI_API_KEY=' ../../.env | cut -d= -f2-)"

# dig-cache: a write key of your choosing. SUPABASE_URL and
# SUPABASE_SERVICE_ROLE_KEY are injected by the platform — do not set them.
supabase secrets set DIG_WRITE_KEY="$(openssl rand -hex 32)"

supabase functions deploy relay
supabase functions deploy embed
supabase functions deploy dig-cache
```

`config.toml` already sets `verify_jwt = false` for all three; the CLI picks
that up.

`dig-cache` reads and writes the `dig_vectors` table, which the Python batch
creates on its first connection (`CREATE TABLE IF NOT EXISTS`, see
[`src/arxave/db.py`](../../src/arxave/db.py)). Run
[`rls.sql`](../rls.sql) after that, so the table is closed to anon and the
function stays its only door.

The same `DIG_WRITE_KEY` goes into the repo's GitHub secrets, where the nightly
[warm-dig workflow](../../.github/workflows/warm-dig.yml) picks it up.

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

Users who would rather not use the hosted path can switch the page's embedding
mode to **Own key** and point it at any OpenAI-compatible `/v1/embeddings`.

`dig-cache` costs nothing but storage: a day of one category set is ~130
vectors × 384 × 4 B ≈ **200 kB**, and the batch's rolling-window prune
(`store.prune_vectors`, keyed on *last wanted*, not on the paper's date) holds
the table to the retention window. Its reads are the one thing that could get
hot, which is why they are a single `POST` per haul rather than one request per
paper.
