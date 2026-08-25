import { strict as assert } from 'node:assert';
import { evaluateEvidence } from '../services/evidence-gate.js';

const result = (id, score = 0.7) => ({ repo: 'facebook/react', id, score });

assert.equal(evaluateEvidence({ query: 'Explain abcdef12', results: [result('abcdef12')], directMatchCount: 1 }).verdict, 'SEARCH');
assert.equal(evaluateEvidence({ query: 'something broke', results: [result('a')], denseResults: [result('a')] }).verdict, 'ASK_USER');
assert.equal(evaluateEvidence({ query: 'zzzxqvnonexistenttoken2026case1', results: [result('a', 0.8)], denseResults: [result('a', 0.8)] }).verdict, 'ABSTAIN');
assert.equal(evaluateEvidence({
    query: 'What did Alice change on 2018-01-01?',
    results: [result('a', 0.3)], denseResults: [result('a', 0.3)],
    filters: { author: 'Alice', dateFrom: '2018-01-01', dateTo: '2018-01-01' },
}).verdict, 'SEARCH');
assert.equal(evaluateEvidence({
    query: 'resolve scheduler update',
    results: [result('a', 0.61)], denseResults: [result('a', 0.61)], lexicalResults: [result('a', 0)],
}).verdict, 'SEARCH');
assert.equal(evaluateEvidence({
    query: 'kubernetes ingress retry policy',
    results: [result('a', 0.55)], denseResults: [result('a', 0.55)], lexicalResults: [],
}).verdict, 'ABSTAIN');

console.log('evidence gate: PASS');
