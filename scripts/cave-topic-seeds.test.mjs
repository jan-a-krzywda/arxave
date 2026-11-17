import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { pickTopicSeeds } from './cave-topic-seeds.mjs';
import { LEAVES, PARENTS, treeOf } from './cave-topics.mjs';

/* Six titles on two axes of a 2-D space: three "agent" papers along x, two
   "vision" papers along y, and one title that names both and must be dropped. */
const corpus = {
  dim: 2,
  ids: ['a1', 'a2', 'a3', 'v1', 'v2', 'both'],
  titles: [
    'An agent that plans', 'Agents for the web', 'Agentic search',
    'Video segmentation', 'Multimodal video', 'Agents that watch video',
  ],
  vecs: Float32Array.from([1, 0, 0.8, 0.6, 0.6, 0.8, 0, 1, 0.6, 0.8, 0.7, 0.7]),
};

const tree = {
  parents: [{ id: 'p', label: 'P' }],
  leaves: [
    { id: 'agents', parent: 'p', label: 'Agents', rules: [{ re: '\\bagent\\w*', why: 'agent' }] },
    { id: 'vision', parent: 'p', label: 'Vision', rules: [{ re: '\\bvideo\\b', why: 'video' }] },
  ],
};

test('pickTopicSeeds: one-leaf titles only, closest to the pool mean first', () => {
  const { seeds, poolSizes } = pickTopicSeeds(corpus, tree, { per: 2 });
  assert.deepEqual(poolSizes, { agents: 3, vision: 2 });
  // The agent pool's mean is (0.8, 0.47): a2 scores 0.92, a3 0.85, a1 0.80.
  assert.deepEqual(seeds.agents.map((s) => s.id), ['a2', 'a3']);
  assert.deepEqual(seeds.vision.map((s) => s.id).sort(), ['v1', 'v2']);
  assert.ok(!Object.values(seeds).flat().some((s) => s.id === 'both'), 'a two-leaf title is no seed');
  assert.equal(seeds.agents[0].why, 'agent');
});

test('treeOf: the quantum file keeps the contract tree; the AI file brings its own', () => {
  const quantum = treeOf(JSON.parse(readFileSync(new URL('./cave-seeds/topics.json', import.meta.url), 'utf8')));
  assert.equal(quantum.parents, PARENTS);
  assert.equal(quantum.leaves, LEAVES);

  const aiTree = JSON.parse(readFileSync(new URL('./cave-seeds/ai/tree.json', import.meta.url), 'utf8'));
  const ai = treeOf({ tree: aiTree });
  assert.ok(ai.parents.length >= 4);
  assert.ok(ai.leaves.every((l) => ai.parents.some((p) => p.id === l.parent)));
  assert.equal(new Set(ai.leaves.map((l) => l.id)).size, ai.leaves.length, 'leaf ids are unique');
  assert.ok(aiTree.leaves.every((l) => l.rules.every((r) => new RegExp(r.re, 'i'))), 'every rule compiles');

  assert.throws(() => treeOf({ tree: { parents: [{ id: 'p' }], leaves: [{ id: 'x', parent: 'q' }] } }), /unknown parent/);
});
