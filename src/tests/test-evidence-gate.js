import { strict as assert } from 'node:assert';
import { evaluateEvidence, isVagueQuery } from '../services/evidence-gate.js';

const result = (id, score = 0.7) => ({ repo: 'facebook/react', id, score });
const specificity = ({
    verdict = 'SUFFICIENT',
    confidence = 0.9,
    component = null,
    symptom = null,
    time = null,
    errorCode = null,
    fileOrSymbol = null,
    missingFields = [],
} = {}) => ({
    verdict,
    confidence,
    signals: { component, symptom, time, errorCode, fileOrSymbol },
    missingFields,
    clarificationQuestion: null,
});

// Exact identifiers are resolved deterministically before semantic evidence.
assert.equal(evaluateEvidence({
    query: 'Explain abcdef12', results: [result('abcdef12')], directMatchCount: 1,
}).verdict, 'SEARCH');
const unknownSha = evaluateEvidence({
    query: `解释提交 ${'f'.repeat(40)}`, results: [result('a', 0.9)], denseResults: [result('a', 0.9)],
    specificity: specificity({ fileOrSymbol: 'commit SHA' }),
});
assert.equal(unknownSha.verdict, 'ABSTAIN');
assert.equal(unknownSha.reason, 'unrecognized-commit-id');
assert.equal(evaluateEvidence({
    query: 'zzzxqvnonexistenttoken2026case1', results: [result('a', 0.8)], denseResults: [result('a', 0.8)],
}).verdict, 'ABSTAIN');
assert.equal(evaluateEvidence({
    query: 'NeverSeenFeatureFlagXYZ 怎么了？', results: [result('a', 0.9)], denseResults: [result('a', 0.9)],
    specificity: specificity({ fileOrSymbol: 'NeverSeenFeatureFlagXYZ' }),
}).reason, 'unrecognized-identifier');

// Chinese sufficiency comes from structured signals, not whitespace token count.
const chineseSufficient = specificity({ component: '广告页面', symptom: '加载很慢', time: '昨天' });
const chineseGate = evaluateEvidence({
    query: '广告页面从昨天开始加载很慢', results: [result('a', 0.55)], denseResults: [result('a', 0.55)],
    specificity: chineseSufficient,
});
assert.notEqual(chineseGate.verdict, 'ASK_USER');
assert.equal(chineseGate.features.specificitySignalCount, 3);
assert.equal(isVagueQuery('广告页面从昨天开始加载很慢'), false);

const chineseVague = evaluateEvidence({
    query: '页面坏了', results: [], specificity: specificity({
        verdict: 'AMBIGUOUS', component: '页面', symptom: '坏了', missingFields: ['component', 'symptom', 'time'],
    }),
});
assert.equal(chineseVague.verdict, 'ASK_USER');
assert.equal(chineseVague.features.investigationSignalCount, 0);

assert.equal(evaluateEvidence({
    query: '我遇到了一个非常严重而且影响工作的问题，请帮我深入调查为什么会这样',
    results: [result('a', 0.8)], denseResults: [result('a', 0.8)],
    specificity: specificity({ verdict: 'AMBIGUOUS', symptom: '严重问题', missingFields: ['component', 'symptom', 'time'] }),
}).verdict, 'ASK_USER');

// A distinctive key can override short-query ambiguity only with strong channel agreement.
const keySpecificity = specificity({
    verdict: 'AMBIGUOUS', fileOrSymbol: 'NewGoogleLoginGSI', missingFields: ['symptom'],
});
const keyGate = evaluateEvidence({
    query: 'NewGoogleLoginGSI 怎么了？',
    results: [result('key', 0.61)], denseResults: [result('key', 0.61)], lexicalResults: [result('key', 0)],
    specificity: keySpecificity,
});
assert.equal(keyGate.verdict, 'SEARCH');
assert.equal(keyGate.reason, 'distinctive-signal-multi-channel-support');

// Explicit metadata defines a candidate slice; automatic defaults are not passed as filters.
assert.equal(evaluateEvidence({
    query: 'What changed?', results: [result('a', 0.3)], denseResults: [result('a', 0.3)],
    filters: { repo: 'facebook/react', dateFrom: '2018-01-01', dateTo: '2018-01-01' },
    specificity: specificity({ time: '2018-01-01' }),
}).verdict, 'SEARCH');
const implicitDefault = evaluateEvidence({
    query: 'React scheduler behavior', results: [result('a', 0.3)], denseResults: [result('a', 0.3)],
    filters: {}, specificity: specificity({ component: 'React scheduler', symptom: 'behavior changed' }),
});
assert.equal(implicitDefault.verdict, 'ABSTAIN');
assert.equal(implicitDefault.features.metadataConstraints, 0);

// Parse fallback is conservative: dense-only similarity cannot become a high-confidence search.
assert.equal(evaluateEvidence({
    query: 'React scheduler behavior changed yesterday',
    results: [result('a', 0.9)], denseResults: [result('a', 0.9)],
    specificity: specificity({ verdict: 'AMBIGUOUS' }), specificityFallback: true,
}).verdict, 'ABSTAIN');

// Existing calibrated retrieval behavior remains in place when specificity is valid.
assert.equal(evaluateEvidence({
    query: 'resolve scheduler update',
    results: [result('a', 0.61)], denseResults: [result('a', 0.61)], lexicalResults: [result('a', 0)],
    specificity: specificity({ component: 'scheduler', symptom: 'update behavior' }),
}).verdict, 'SEARCH');
assert.equal(evaluateEvidence({
    query: 'kubernetes ingress retry policy',
    results: [result('a', 0.65)], denseResults: [result('a', 0.65)], lexicalResults: [],
    specificity: specificity({ component: 'kubernetes ingress', symptom: 'retry policy changed' }),
}).verdict, 'SEARCH');
assert.equal(evaluateEvidence({
    query: 'kubernetes ingress retry policy',
    results: [result('a', 0.55)], denseResults: [result('a', 0.55)], lexicalResults: [],
    specificity: specificity({ component: 'kubernetes ingress', symptom: 'retry policy changed' }),
}).verdict, 'ABSTAIN');

// A top RRF rank is not itself evidence, and sufficient no-result queries abstain.
assert.equal(evaluateEvidence({
    query: 'scheduler retry behavior',
    results: [{ ...result('a', 0.4), _rrfScore: 0.99 }], denseResults: [result('a', 0.4)],
    specificity: specificity({ component: 'scheduler', symptom: 'retry behavior' }),
}).verdict, 'ABSTAIN');
assert.equal(evaluateEvidence({
    query: '广告页面从昨天开始加载很慢', results: [], specificity: chineseSufficient,
}).verdict, 'ABSTAIN');

console.log('evidence gate: PASS');
