/**
 * llm — the grader: the prompt, the response validation, and the call.
 *
 * One paper in, one grade out. The rubric is the criterion pack's prose and is
 * inserted into the prompt VERBATIM, so how papers are scored is an edit to
 * `rubric.md` and not to this file. The prompt lists the citable requirement
 * ids and nothing else, because a model handed the whole criterion would cite
 * ids the pack never published.
 *
 * EVERYTHING THAT REACHES A FEED IS VALIDATED HERE FIRST. A grade naming an axis
 * that does not exist, a `kind` no consumer knows, or an empty `why` is a
 * silent data-loss bug three stages downstream, so each throws `GradeError`
 * rather than being written. The one thing that is not fatal is a `refs` entry
 * that is not a listed requirement: a model reaching for a plausible id is
 * ordinary, the citation list is a soft signal, and dropping the entry loses
 * nothing that throwing would not lose harder. With no requirements at all the
 * list is forced empty — the pack said there is nothing to cite.
 *
 * Network and time sit behind `fetchImpl` and `sleep`, so the retry ladder is
 * tested without a socket and without a wait.
 */

const KINDS = ['device', 'benchmark', 'algorithm', 'integration', 'review'];
const ACTION_TYPES = ['code', 'follow-up', 'mail', 'question', 'problem'];

/* Total tries, not retries: one attempt plus the two the contract allows on a
   429 or a 5xx. Backoff grows linearly — 1 s, then 2 s — which is long enough
   for a rate limiter to reset and short enough that a run of twenty papers does
   not sit in a sleep. */
const ATTEMPTS = 3;
const BACKOFF_MS = 1000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const retryable = (status) => status === 429 || status >= 500;

/** A call failed, or returned something that did not validate. */
export class GradeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GradeError';
  }
}

/** `requirements` is a Map id->text per the contract; accept a plain object too. */
function reqEntries(requirements) {
  if (requirements instanceof Map) return [...requirements];
  return Object.entries(requirements ?? {});
}

function hasRequirement(requirements, id) {
  if (requirements instanceof Map) return requirements.has(id);
  return Object.prototype.hasOwnProperty.call(requirements ?? {}, id);
}

function idSet(ids) {
  return ids instanceof Set ? ids : new Set(ids ?? []);
}

/**
 * The two turns sent to the model.
 *
 * The rubric goes in as one array element, unaltered: no trimming, no
 * re-wrapping, because a rule that survives in the file but not in the prompt
 * is a rule that quietly stopped applying. The requirements are printed as
 * `id: text` — the text so the model can match, the id so the reply can cite.
 */
export function buildGradePrompt({ rubric, requirements, axes, paper }) {
  const reqs = reqEntries(requirements).map(([id, text]) => `${id}: ${text}`).join('\n');
  const axisList = Object.entries(axes ?? {})
    .map(([id, axis]) => `${id}: ${axis?.name ?? ''}`.trim())
    .join('\n');

  const system = [
    'You grade one paper for a curated reading feed, against the criterion below.',
    'Judge from the supplied text only; do not credit claims the text does not make.',
    '',
    'RUBRIC:',
    rubric,
    '',
    'Return ONLY a JSON object, no prose and no markdown fence:',
    '{"relevance":1-5 int, "novelty":1-5 int, "axis":"A".."I", "refs":[ids], ' +
      '"why":string, "kind":"device"|"benchmark"|"algorithm"|"integration"|"review", ' +
      '"actions":[{"type":"code"|"follow-up"|"mail"|"question"|"problem","title":string,"body":string}]}',
    'refs may contain ONLY ids listed in REQUIREMENTS below; use [] when none apply.',
    'why is one sentence naming the concrete reason, not a restatement of the abstract.',
  ].join('\n');

  const user = [
    'REQUIREMENTS (cite only these ids):',
    reqs || '(none)',
    '',
    'AXES:',
    axisList || '(none)',
    '',
    `Paper id: ${paper?.id ?? ''}`,
    `Title: ${paper?.title ?? ''}`,
    paper?.authors ? `Authors: ${paper.authors}` : '',
    '',
    `Abstract: ${paper?.abstract ?? ''}`,
    paper?.intro ? `\nIntroduction:\n${paper.intro}` : '',
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** The JSON body, tolerating a ```json fence the model wrapped it in. */
function extractJson(text) {
  const raw = String(text ?? '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new GradeError('grade is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GradeError('grade is not a JSON object');
  }
  return parsed;
}

function intInRange(value, lo, hi, field) {
  if (!Number.isInteger(value) || value < lo || value > hi) {
    throw new GradeError(`${field} must be an integer ${lo}-${hi}, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * A model reply, reduced to the grade the feed stores, or `GradeError`.
 *
 * Fields are validated in the order the contract names them so a reply with
 * several problems reports the first rather than a compound message.
 */
export function parseGrade(text, { requirements, axisIds }) {
  const obj = extractJson(text);
  const axes = idSet(axisIds);

  const relevance = intInRange(obj.relevance, 1, 5, 'relevance');
  const novelty = intInRange(obj.novelty, 1, 5, 'novelty');

  if (typeof obj.axis !== 'string' || !axes.has(obj.axis)) {
    throw new GradeError(
      `axis must be one of ${[...axes].join(', ')}, got ${JSON.stringify(obj.axis)}`);
  }
  if (typeof obj.kind !== 'string' || !KINDS.includes(obj.kind)) {
    throw new GradeError(`kind must be one of ${KINDS.join(', ')}, got ${JSON.stringify(obj.kind)}`);
  }
  if (typeof obj.why !== 'string' || obj.why.trim() === '') {
    throw new GradeError('why must be a non-empty string');
  }

  const refs = reqEntries(requirements).length === 0
    ? []
    : (Array.isArray(obj.refs) ? obj.refs : [])
      .filter((id) => typeof id === 'string' && hasRequirement(requirements, id));

  const actions = (Array.isArray(obj.actions) ? obj.actions : [])
    .filter((a) => a && typeof a === 'object' && ACTION_TYPES.includes(a.type))
    .map((a) => ({ type: a.type, title: String(a.title ?? ''), body: String(a.body ?? '') }));

  return { relevance, novelty, axis: obj.axis, refs, why: obj.why, kind: obj.kind, actions };
}

/**
 * Grade one paper through an OpenAI-compatible `/chat/completions` endpoint.
 *
 * `args` is the `buildGradePrompt` shape; `llm` is `config.llm`. A missing key
 * is not an error to retry — it is a misconfiguration, and returning `no-key`
 * before the first socket call means a keyless run costs nothing and touches
 * nothing.
 */
export async function gradePaper(
  args,
  { llm, fetchImpl = fetch, env = process.env, sleep = wait } = {},
) {
  const key = env?.[llm?.api_key_env];
  if (!key) return { error: 'no-key' };

  const messages = buildGradePrompt(args);
  const url = `${String(llm.base_url).replace(/\/+$/, '')}/chat/completions`;
  const body = JSON.stringify({
    model: llm.model,
    messages,
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let resp;
    try {
      resp = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body,
      });
    } catch (err) {
      return { error: `request failed: ${err?.message ?? err}` };
    }

    if (resp.ok) {
      const data = await resp.json().catch(() => null);
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') return { error: 'no content in response' };
      try {
        return parseGrade(content, {
          requirements: args.requirements,
          axisIds: Object.keys(args.axes ?? {}),
        });
      } catch (err) {
        if (err instanceof GradeError) return { error: err.message };
        throw err;
      }
    }

    const detail = await resp.text().catch(() => '');
    if (retryable(resp.status) && attempt < ATTEMPTS) {
      await sleep(BACKOFF_MS * attempt);
      continue;
    }
    return { error: `HTTP ${resp.status}${detail ? `: ${String(detail).slice(0, 200)}` : ''}` };
  }

  /* The loop returns on the last attempt; this is unreachable but keeps the
     function total for a reader. */
  return { error: 'exhausted retries' };
}
