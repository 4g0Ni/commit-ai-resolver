import { strict as assert } from 'node:assert';
import { extractIntent } from '../../api/agents/intent-extractor.js';

function intentPayload(overrides = {}) {
    return {
        author: null,
        repo: null,
        dateFrom: null,
        dateTo: null,
        searchQuery: '广告页面加载很慢',
        secondarySearchQuery: null,
        riskLevel: null,
        changeType: null,
        keywords: ['广告页面', '加载'],
        confidence: 0.9,
        ambiguities: [],
        verdict: 'GOOD',
        clarificationQuestion: null,
        specificity: {
            verdict: 'SUFFICIENT',
            confidence: 0.94,
            signals: {
                component: '广告页面',
                symptom: '加载很慢',
                time: '昨天',
                errorCode: null,
                fileOrSymbol: null,
            },
            missingFields: [],
            clarificationQuestion: null,
        },
        ...overrides,
    };
}

function mockLlm(contentFactory) {
    let calls = 0;
    let lastParams = null;
    return {
        get calls() { return calls; },
        get lastParams() { return lastParams; },
        chat: {
            completions: {
                async create(params) {
                    calls++;
                    lastParams = params;
                    const content = typeof contentFactory === 'function' ? contentFactory(params) : contentFactory;
                    return { choices: [{ message: { content } }], usage: { total_tokens: 42 } };
                },
            },
        },
    };
}

const sufficientClient = mockLlm(JSON.stringify(intentPayload()));
const sufficient = await extractIntent(sufficientClient, {
    query: '广告页面从昨天开始加载很慢',
    referenceDate: '2026-08-26',
});
assert.equal(sufficient.specificity.verdict, 'SUFFICIENT');
assert.deepEqual(sufficient.specificity.signals, {
    component: '广告页面', symptom: '加载很慢', time: '昨天', errorCode: null, fileOrSymbol: null,
});
assert.equal(sufficient._specificityFallback, false);
const intentSchema = sufficientClient.lastParams.response_format.json_schema.schema;
assert(intentSchema.required.includes('specificity'));
assert.deepEqual(intentSchema.properties.specificity.required,
    ['verdict', 'confidence', 'signals', 'missingFields', 'clarificationQuestion']);
assert.match(sufficientClient.lastParams.messages[0].content, /Length alone is not evidence/);

const vagueClient = mockLlm(JSON.stringify(intentPayload({
    searchQuery: '页面问题',
    confidence: 0.8,
    ambiguities: ['缺少具体功能和症状'],
    verdict: 'ASK_USER',
    clarificationQuestion: '哪个具体功能受影响，出现了什么现象？',
    specificity: {
        verdict: 'AMBIGUOUS',
        confidence: 0.96,
        signals: { component: '页面', symptom: '坏了', time: null, errorCode: null, fileOrSymbol: null },
        missingFields: ['component', 'symptom'],
        clarificationQuestion: '哪个具体功能受影响，出现了什么现象？',
    },
})));
const vague = await extractIntent(vagueClient, { query: '页面坏了', referenceDate: '2026-08-26' });
assert.equal(vague.specificity.verdict, 'AMBIGUOUS');
assert.deepEqual(vague.specificity.missingFields, ['component', 'symptom']);
assert.equal(vague.specificity.clarificationQuestion, '哪个具体功能受影响，出现了什么现象？');

const followUpClient = mockLlm(JSON.stringify(intentPayload({
    searchQuery: '广告页面加载变慢',
    specificity: {
        verdict: 'SUFFICIENT',
        confidence: 0.91,
        signals: { component: '广告页面', symptom: '变慢', time: '昨天', errorCode: null, fileOrSymbol: null },
        missingFields: [],
        clarificationQuestion: null,
    },
})));
const followUp = await extractIntent(followUpClient, {
    query: '昨天开始变慢了',
    history: [
        { role: 'user', content: '广告页面最近有问题' },
        { role: 'assistant', content: '具体是什么现象？' },
    ],
    referenceDate: '2026-08-26',
});
assert.equal(followUp.specificity.signals.component, '广告页面');
const followUpUserData = JSON.parse(followUpClient.lastParams.messages[1].content);
assert.equal(followUpUserData.recentConversation[0].content, '广告页面最近有问题');

const legacyPayload = (({ specificity: _specificity, ...legacy }) => legacy)(intentPayload());
const legacyClient = mockLlm(JSON.stringify(legacyPayload));
const legacy = await extractIntent(legacyClient, { query: 'legacy provider output', referenceDate: '2026-08-26' });
assert.equal(legacy._specificityFallback, true);
assert.equal(legacy.specificity.verdict, 'AMBIGUOUS');
assert.equal(legacy.specificity.confidence, 0);

const malformedClient = mockLlm('{not valid JSON');
const malformed = await extractIntent(malformedClient, {
    query: 'NewGoogleLoginGSI 怎么了？', referenceDate: '2026-08-26',
});
assert.equal(malformedClient.calls, 1);
assert.equal(malformed._parseError, true);
assert.equal(malformed._specificityFallback, true);
assert.equal(malformed.specificity.verdict, 'AMBIGUOUS');
assert.equal(malformed.specificity.confidence, 0);

console.log('intent extractor specificity: PASS');
