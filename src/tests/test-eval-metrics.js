import { strict as assert } from 'node:assert';
import { compareSummaries, expectedCalibrationError, scoreRanking } from '../eval/lib/metrics.js';

const gold = [
    { repo: 'demo', id: 'a', relevance: 3, required: true },
    { repo: 'demo', id: 'b', relevance: 1, required: false },
];
const perfect = scoreRanking([{ repo: 'demo', id: 'a' }, { repo: 'demo', id: 'b' }], gold, 10);
assert.equal(perfect.recallAtK, 1);
assert.equal(perfect.requiredRecallAtK, 1);
assert.equal(perfect.mrr, 1);
assert.equal(perfect.ndcg, 1);

const miss = scoreRanking([{ repo: 'demo', id: 'c' }], gold, 10);
assert.equal(miss.recallAtK, 0);
assert.equal(miss.hitAtK, false);

const delta = compareSummaries(
    { retrieval: { hybrid: { recallAt10: 0.5, requiredRecallAt10: 0.5, mrrAt10: 0.5, latencyMs: { p95: 10 } } } },
    { retrieval: { hybrid: { recallAt10: 0.7, requiredRecallAt10: 0.6, mrrAt10: 0.8, latencyMs: { p95: 12 } } } },
);
assert.ok(Math.abs(delta.hybrid.recallAt10 - 0.2) < 1e-9);
assert.equal(delta.hybrid.p95LatencyMs, 2);
assert.ok(Math.abs(expectedCalibrationError([
    { confidence: 0.8, correct: true },
    { confidence: 0.2, correct: false },
]) - 0.2) < 1e-9);
console.log('eval metrics: PASS');
