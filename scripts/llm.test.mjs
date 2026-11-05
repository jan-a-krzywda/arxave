/**
 * `node --test scripts/llm.test.mjs` (from this dir).
 *
 * Two halves. The pure half pins the prompt and the response validation, where
 * every failure is silent: a rubric that arrives in the prompt re-wrapped has
 * quietly stopped being the rubric, and a grade with an axis no preset has
 * reaches the feed as a card filed nowhere. The other half runs `gradePaper`
 * against a real `node:http` server on a loopback port, because the retry
 * ladder — 429, 5xx, the backoff between them — is the one thing a stubbed
 * `fetch` cannot prove: it is the HTTP status, not the call count, that decides
 * whether a retry happens.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { buildGradePrompt, gradePaper, GradeError, parseGrade } from './llm.mjs';

const RUBRIC = [
  '# Rubric',
  '',
  '## relevance (1-5)',
  '',
  '- 5: changes how the machine is operated.',
  '- 1: unrelated.',
].join('\n');

const REQUIREMENTS = new Map([
  ['Req_10', 'Universal gate set on spin qubits'],
  ['Req_11', 'At least 16 addressable qubits'],
]);

const AXES = { A: { name: 'Spin qubit devices' }, B: { name: 'Benchmarking' } };
const AXIS_IDS = ['A', 'B'];

const PAPER = {
  id: '2601.00001',
  title: 'A record two-qubit gate',
  authors: 'A. Author, B. Author',
  abstract: 'We report a gate fidelity of 99.9%.',
};

/** A valid grade object; spread `over` to break exactly one field. */
function gradeObject(over = {}) {
  return {
    relevance: 5,
    novelty: 4,
    axis: 'A',
    refs: ['Req_10'],
    why: 'It sets a new two-qubit fidelity record.',
    kind: 'device',
    actions: [{ type: 'code', title: 'Try it', body: 'github.com/x/y' }],
    ...over,
  };
}

const parse = (over = {}, opts = {}) =>
  parseGrade(JSON.stringify(gradeObject(over)), {
    requirements: REQUIREMENTS,
    axisIds: AXIS_IDS,
    ...opts,
  });

/* ------------------------------------------------------------------ prompt */

test('the prompt carries the rubric verbatim', () => {
  const messages = buildGradePrompt({
    rubric: RUBRIC, requirements: REQUIREMENTS, axes: AXES, paper: PAPER,
  });
  const text = messages.map((m) => m.content).join('\n');
  assert.ok(text.includes(RUBRIC), 'the rubric appears byte-for-byte');
  assert.ok(messages.every((m) => typeof m.role === 'string' && typeof m.content === 'string'));
  assert.ok(messages.some((m) => m.role === 'system'));
  assert.ok(messages.some((m) => m.role === 'user'));
});

test('the prompt lists the requirement ids, and only those in the map', () => {
  const messages = buildGradePrompt({
    rubric: RUBRIC,
    requirements: new Map([['Req_10', 'Universal gate set on spin qubits']]),
    axes: AXES,
    paper: PAPER,
  });
  const text = messages.map((m) => m.content).join('\n');
  assert.ok(text.includes('Req_10'));
  assert.ok(text.includes('Universal gate set on spin qubits'));
  // Req_11 exists in the full pack but was not supplied; it must not leak in.
  assert.ok(!text.includes('Req_11'), 'an id not in the map never reaches the prompt');
});

test('the prompt carries the paper and the axes', () => {
  const messages = buildGradePrompt({
    rubric: RUBRIC, requirements: REQUIREMENTS, axes: AXES, paper: PAPER,
  });
  const text = messages.map((m) => m.content).join('\n');
  assert.ok(text.includes('A. Author, B. Author'));
  assert.ok(text.includes('We report a gate fidelity of 99.9%.'));
  assert.ok(text.includes('Spin qubit devices'));
});

test('an empty requirement map says so rather than listing nothing', () => {
  const messages = buildGradePrompt({
    rubric: RUBRIC, requirements: new Map(), axes: AXES, paper: PAPER,
  });
  const text = messages.map((m) => m.content).join('\n');
  assert.ok(text.includes('(none)'));
  assert.ok(!text.includes('Req_'));
});

/* --------------------------------------------------------------- parseGrade */

test('a well-formed grade comes back as the stored shape', () => {
  const grade = parse();
  assert.deepEqual(grade, {
    relevance: 5,
    novelty: 4,
    axis: 'A',
    refs: ['Req_10'],
    why: 'It sets a new two-qubit fidelity record.',
    kind: 'device',
    actions: [{ type: 'code', title: 'Try it', body: 'github.com/x/y' }],
  });
});

test('a ```json fence is tolerated', () => {
  const fenced = '```json\n' + JSON.stringify(gradeObject()) + '\n```';
  const grade = parseGrade(fenced, { requirements: REQUIREMENTS, axisIds: AXIS_IDS });
  assert.equal(grade.relevance, 5);
  assert.equal(grade.axis, 'A');
});

test('refs to ids not in the requirements map are dropped, not fatal', () => {
  const grade = parse({ refs: ['Req_10', 'Req_99', 'nonsense', 7] });
  assert.deepEqual(grade.refs, ['Req_10']);
});

test('an empty requirements map forces refs to []', () => {
  const grade = parseGrade(JSON.stringify(gradeObject({ refs: ['Req_10', 'Req_11'] })), {
    requirements: new Map(),
    axisIds: AXIS_IDS,
  });
  assert.deepEqual(grade.refs, []);
});

test('each invalid field throws GradeError', () => {
  const cases = {
    'relevance below range': { relevance: 0 },
    'relevance above range': { relevance: 6 },
    'relevance not an integer': { relevance: 4.5 },
    'relevance a string': { relevance: '5' },
    'novelty below range': { novelty: 0 },
    'novelty above range': { novelty: 9 },
    'unknown axis': { axis: 'Z' },
    'axis not a string': { axis: 3 },
    'unknown kind': { kind: 'paper' },
    'missing kind': { kind: undefined },
    'empty why': { why: '' },
    'whitespace why': { why: '   ' },
    'missing why': { why: undefined },
  };
  for (const [name, over] of Object.entries(cases)) {
    assert.throws(() => parse(over), GradeError, name);
  }
});

test('a reply that is not JSON at all throws GradeError', () => {
  assert.throws(() => parseGrade('sorry, I cannot help', {
    requirements: REQUIREMENTS, axisIds: AXIS_IDS,
  }), GradeError);
});

test('actions with an unknown type are dropped, the known ones kept', () => {
  const grade = parse({
    actions: [
      { type: 'code', title: 'Try it', body: 'link' },
      { type: 'telepathy', title: 'nope', body: 'nope' },
      { type: 'question', title: 'Ask', body: 'why?' },
    ],
  });
  assert.deepEqual(grade.actions.map((a) => a.type), ['code', 'question']);
});

test('a missing actions list is an empty list, not a throw', () => {
  const grade = parse({ actions: undefined });
  assert.deepEqual(grade.actions, []);
});

/* --------------------------------------------------------------- gradePaper */

/*
 * A real HTTP server on a loopback port. `respond(n)` returns `{status, body}`
 * for the n-th request, so a test can script "429 then 200" without a stub that
 * decides by call count alone — which is exactly the seam where a retry bug
 * hides.
 */
function serve(respond) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push({
        method: req.method, url: req.url, auth: req.headers.authorization, body: raw,
      });
      const out = respond(requests.length);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        requests,
        base: `http://127.0.0.1:${server.address().port}/v1`,
      });
    });
  });
}

const gradeBody = (content) => ({
  status: 200,
  body: { choices: [{ message: { content } }] },
});
const httpError = (status) => ({ status, body: { error: { message: 'boom' } } });

const ARGS = { rubric: RUBRIC, requirements: REQUIREMENTS, axes: AXES, paper: PAPER };
const LLM = { base_url: '', model: 'test-model', api_key_env: 'TEST_KEY' };
const noSleep = async () => {};

test('gradePaper posts to /chat/completions and returns the validated grade', async () => {
  const { server, requests, base } = await serve(() => gradeBody(JSON.stringify(gradeObject())));
  try {
    const out = await gradePaper(ARGS, {
      llm: { ...LLM, base_url: base },
      env: { TEST_KEY: 'secret' },
      sleep: noSleep,
    });
    assert.equal(out.relevance, 5);
    assert.equal(out.axis, 'A');
    assert.deepEqual(out.refs, ['Req_10']);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/v1/chat/completions');
    assert.equal(requests[0].auth, 'Bearer secret');
    const sent = JSON.parse(requests[0].body);
    assert.equal(sent.model, 'test-model');
    assert.ok(sent.messages.some((m) => m.content.includes(RUBRIC)));
  } finally {
    server.close();
  }
});

test('a 429 is retried, and the backoff waits before the retry', async () => {
  const { server, requests, base } = await serve((n) =>
    (n < 2 ? httpError(429) : gradeBody(JSON.stringify(gradeObject()))));
  const waits = [];
  try {
    const out = await gradePaper(ARGS, {
      llm: { ...LLM, base_url: base },
      env: { TEST_KEY: 'k' },
      sleep: async (ms) => { waits.push(ms); },
    });
    assert.equal(out.relevance, 5);
    assert.equal(requests.length, 2);
    assert.deepEqual(waits, [1000]);
  } finally {
    server.close();
  }
});

test('three 5xx responses give an error, not a grade', async () => {
  const { server, requests, base } = await serve(() => httpError(500));
  const waits = [];
  try {
    const out = await gradePaper(ARGS, {
      llm: { ...LLM, base_url: base },
      env: { TEST_KEY: 'k' },
      sleep: async (ms) => { waits.push(ms); },
    });
    assert.ok(out.error, 'the failure comes back as {error}');
    assert.equal(out.relevance, undefined);
    assert.equal(requests.length, 3, 'one attempt plus two retries');
    assert.deepEqual(waits, [1000, 2000]);
  } finally {
    server.close();
  }
});

test('a non-retryable status is returned without a retry', async () => {
  const { server, requests, base } = await serve(() => httpError(400));
  try {
    const out = await gradePaper(ARGS, {
      llm: { ...LLM, base_url: base },
      env: { TEST_KEY: 'k' },
      sleep: noSleep,
    });
    assert.match(out.error, /400/);
    assert.equal(requests.length, 1);
  } finally {
    server.close();
  }
});

test('a grade the validator rejects comes back as {error}, not a throw', async () => {
  const bad = JSON.stringify(gradeObject({ axis: 'Z' }));
  const { server, base } = await serve(() => gradeBody(bad));
  try {
    const out = await gradePaper(ARGS, {
      llm: { ...LLM, base_url: base },
      env: { TEST_KEY: 'k' },
      sleep: noSleep,
    });
    assert.ok(out.error);
    assert.equal(out.relevance, undefined);
  } finally {
    server.close();
  }
});

test('with no key in env, gradePaper returns no-key and makes no request', async () => {
  const { server, requests, base } = await serve(() => gradeBody(JSON.stringify(gradeObject())));
  try {
    const out = await gradePaper(ARGS, {
      llm: { ...LLM, base_url: base },
      env: {},
      sleep: noSleep,
    });
    assert.deepEqual(out, { error: 'no-key' });
    assert.equal(requests.length, 0, 'the network is never touched');
  } finally {
    server.close();
  }
});
