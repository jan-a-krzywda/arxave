/**
 * threads — which of tonight's arXiv papers already have a GitHub Discussions
 * thread. The Cave's ranking card (L1) shows either "Discussion" (a link) or
 * "Start thread" (you are the first), and the browser can answer neither: the
 * REST search does not cover Discussions and GraphQL needs a token.
 *
 *   POST /threads  { repo: "owner/name", ids: ["2401.12345", …] }   (≤ 25)
 *     → { threads: { "2401.12345": "https://github.com/…/discussions/7" | null } }
 *
 * `THREADS_REPOS` is the allow-list and is the entire security model — without
 * it this would be a free GraphQL proxy on our token. Its default is the one
 * repo the Cave's own threads live in, so a deployment that sets nothing still
 * works and still cannot be pointed anywhere else.
 *
 * `threads.ts` carries the rest of the reasoning (the null/absent distinction,
 * the bracketed-id match, the two TTLs); this file is env into a `Deps`.
 */

import { type Deps, handleThreads, repoAllowList } from './threads.ts';

const GITHUB_TOKEN = Deno.env.get('GITHUB_TOKEN') ?? '';
/* Comma-separated, so a fork can point at its own Discussions without a
   redeploy of the code — only of the secret. */
const REPOS = repoAllowList(Deno.env.get('THREADS_REPOS'));

const deps: Deps = {
  fetch,
  token: GITHUB_TOKEN,
  repos: REPOS,
  log: (message) => console.log(message),
};

Deno.serve((req) => handleThreads(req, deps));
