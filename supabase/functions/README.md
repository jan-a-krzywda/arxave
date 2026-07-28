# Edge functions

Two functions back the browser filter page (`docs/filter.md`). Both are public
and unauthenticated — the page is static and has no Supabase session.

| Function | Why it exists |
|----------|---------------|
| `relay`  | arXiv and Scirate send **no** `Access-Control-Allow-Origin` header (measured 2026-07-28, on `export.arxiv.org/api/query`, `rss.arxiv.org` and `scirate.com`). A browser cannot fetch them, with or without a key. This relays the GET server-side, allowlisted to those hosts. |
| `embed`  | Optional. The page defaults to in-browser embeddings (transformers.js, free), so this only serves people who pick "Hosted" for speed. Deploy it or don't — the page works either way. |

## Deploy

```bash
brew install supabase/tap/supabase        # CLI is not installed yet
supabase login
supabase link --project-ref ugxxakguqgpxpdfhgtsb

# embed needs a key; relay needs nothing
supabase secrets set GEMINI_API_KEY="$(grep '^GEMINI_API_KEY=' ../../.env | cut -d= -f2-)"

supabase functions deploy relay
supabase functions deploy embed
```

`config.toml` already sets `verify_jwt = false` for both; the CLI picks that up.

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
