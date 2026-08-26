import { strict as assert } from 'node:assert';
import { agenticSearch } from '../../api/agents/orchestrator.js';

function specificity({
    verdict = 'SUFFICIENT', confidence = 0.9, component = null, symptom = null, time = null,
    errorCode = null, fileOrSymbol = null, missingFields = [], clarificationQuestion = null,
} = {}) {
    return {
        verdict,
        confidence,
        signals: { component, symptom, time, errorCode, fileOrSymbol },
        missingFields,
        clarificationQuestion,
    };
}

function intentPayload(overrides = {}) {
    return {
        author: null,
        repo: null,
        dateFrom: null,
        dateTo: null,
        searchQuery: 'unrelated infrastructure subsystem change',
        secondarySearchQuery: null,
        riskLevel: null,
        changeType: null,
        confidence: 0.8,
        verdict: 'GOOD',
        keywords: ['infrastructure'],
        ambiguities: [],
        clarificationQuestion: null,
        specificity: specificity({ component: 'infrastructure subsystem', symptom: 'changed behavior' }),
        ...overrides,
    };
}

function schemaClient(intent, { malformedIntent = false } = {}) {
    let calls = 0;
    return {
        get calls() { return calls; },
        chat: {
            completions: {
                async create(params) {
                    calls++;
                    const schemaName = params.response_format?.json_schema?.name;
                    if (schemaName === 'commit_search_intent') {
                        return { choices: [{ message: { content: malformedIntent ? '{bad json' : JSON.stringify(intent) } }] };
                    }
                    if (schemaName === 'commit_answer_synthesis') {
                        return { choices: [{ message: { content: JSON.stringify({
                            answer: 'The indexed commit matches the query.',
                            confidence: 0.8,
                            searchCoverage: 'partial',
                            rankedSuspects: ['bbbbbbbb'],
                            suggestedActions: [],
                        }) } }] };
                    }
                    throw new Error(`Unexpected model call: ${schemaName || 'no-schema'}`);
                },
            },
        },
    };
}

const weakResult = {
    repo: 'facebook/react', id: 'aaaaaaaa', commitId: 'a'.repeat(40), date: '2018-01-01', author: 'Alice',
    score: 0.55, text: 'unrelated React change', metadata: { title: 'React change', summary: 'React change' },
};

const supportedResult = {
    repo: 'facebook/react', id: 'bbbbbbbb', commitId: 'b'.repeat(40), date: '2019-02-19', author: 'Bob',
    score: 0.61,
    text: 'NewGoogleLoginGSI login configuration switch',
    metadata: {
        title: 'Update NewGoogleLoginGSI', summary: 'Changed the login configuration switch',
        url: 'https://example.test/bbbbbbbb', affectedAreas: ['login'], changedFiles: ['Dynamic.config'],
    },
};

async function runGate({
    query,
    intent = intentPayload(),
    denseResults = [weakResult],
    lexicalResults = [],
    directMatches = [],
    malformedIntent = false,
    maxIterations = 3,
}) {
    const llm = schemaClient(intent, { malformedIntent });
    const response = await agenticSearch({
        llm,
        llmFast: llm,
        embedQuery: async () => [1, 0],
        searchVectors: async () => denseResults,
        searchLexical: async () => lexicalResults,
        lookupByCommitIds: async () => directMatches,
        getVectorStats: async () => ({ dateRange: { from: '2013-01-01', to: '2019-02-20' }, repos: ['facebook/react'] }),
        buildFullContext: async () => '',
        query,
        maxIterations,
    });
    return { response, calls: llm.calls };
}

const ood = await runGate({ query: 'Which commit changed Kafka consumer offsets?' });
assert.equal(ood.response.evidenceGate.verdict, 'ABSTAIN');
assert.equal(ood.response.suspects.length, 0);
assert.equal(ood.calls, 1, 'abstention skips synthesis and evaluator model calls');

const clarificationQuestion = '请说明是哪个具体页面，以及出现了什么可观察到的现象？';
const vague = await runGate({
    query: '页面坏了',
    intent: intentPayload({
        searchQuery: '页面问题',
        verdict: 'ASK_USER',
        specificity: specificity({
            verdict: 'AMBIGUOUS', component: '页面', symptom: '坏了',
            missingFields: ['component', 'symptom'], clarificationQuestion,
        }),
    }),
    denseResults: [],
});
assert.equal(vague.response.type, 'clarification');
assert.equal(vague.response.reply, clarificationQuestion);
assert.equal(vague.response.evidenceGate.verdict, 'ASK_USER');
assert.equal(vague.calls, 1, 'clarification skips synthesis and evaluator model calls');
const vagueGateTrace = vague.response.iterationLog.find(entry => entry.stage === 'evidence-gate');
assert.equal(vagueGateTrace.specificity.verdict, 'AMBIGUOUS');
assert.equal(vagueGateTrace.reason, 'high-confidence-ambiguous');

const invalidClarification = await runGate({
    query: '页面坏了',
    intent: intentPayload({
        searchQuery: '页面问题',
        verdict: 'ASK_USER',
        specificity: specificity({
            verdict: 'AMBIGUOUS', component: '页面', symptom: '坏了',
            missingFields: ['component', 'symptom'], clarificationQuestion: '请再多说一点？',
        }),
    }),
    denseResults: [],
});
assert.equal(invalidClarification.response.reply, '请提供受影响的功能或组件和具体症状。');

const chineseSufficient = await runGate({
    query: '广告页面从昨天开始加载很慢',
    intent: intentPayload({
        searchQuery: '广告页面加载很慢',
        specificity: specificity({ component: '广告页面', symptom: '加载很慢', time: '昨天' }),
    }),
});
assert.notEqual(chineseSufficient.response.evidenceGate.verdict, 'ASK_USER');

const implicitDefault = await runGate({
    query: 'React scheduler behavior changed',
    intent: intentPayload({
        searchQuery: 'React scheduler behavior changed',
        specificity: specificity({ component: 'React scheduler', symptom: 'behavior changed' }),
    }),
});
assert.equal(implicitDefault.response.evidenceGate.verdict, 'ABSTAIN');
assert.equal(implicitDefault.response.evidenceGate.features.metadataConstraints, 0);
const ragTrace = implicitDefault.response.iterationLog.find(entry => entry.stage === 'rag-search' && entry.status === 'done');
assert(ragTrace.filters.dateFrom, 'the automatic date window is still applied to retrieval');

const explicitMetadata = await runGate({
    query: 'What changed in facebook/react on 2019-02-19?',
    intent: intentPayload({
        repo: 'facebook/react',
        dateFrom: '2019-02-19',
        dateTo: '2019-02-19',
        searchQuery: 'commit summary',
        specificity: specificity({ time: '2019-02-19' }),
    }),
    denseResults: [{ ...supportedResult, score: 0.3 }],
    maxIterations: 1,
});
const metadataGateTrace = explicitMetadata.response.iterationLog.find(entry => entry.stage === 'evidence-gate');
assert.equal(metadataGateTrace.verdict, 'SEARCH');
assert.equal(metadataGateTrace.reason, 'structured-candidate-slice');
assert.deepEqual(metadataGateTrace.features.explicitMetadataFields, ['repo', 'dateFrom', 'dateTo']);

const malformed = await runGate({
    query: 'React scheduler behavior changed yesterday',
    malformedIntent: true,
    denseResults: [{ ...weakResult, score: 0.9 }],
});
assert.equal(malformed.response.evidenceGate.verdict, 'ABSTAIN');
assert.equal(malformed.response.evidenceGate.features.specificityFallback, true);
assert.equal(malformed.calls, 1, 'intent parse failure does not add a model call');

const configKey = await runGate({
    query: 'NewGoogleLoginGSI 怎么了？',
    intent: intentPayload({
        searchQuery: 'NewGoogleLoginGSI',
        // Legacy intent asks, but the final gate can still use retrieval evidence.
        verdict: 'ASK_USER',
        specificity: specificity({
            verdict: 'AMBIGUOUS', fileOrSymbol: 'NewGoogleLoginGSI', missingFields: ['symptom'],
            clarificationQuestion: '这个配置键出现了什么具体现象？',
        }),
    }),
    denseResults: [supportedResult],
    lexicalResults: [{ ...supportedResult, score: 0 }],
    maxIterations: 1,
});
const configGateTrace = configKey.response.iterationLog.find(entry => entry.stage === 'evidence-gate');
assert.equal(configGateTrace.verdict, 'SEARCH');
assert.equal(configGateTrace.reason, 'distinctive-signal-multi-channel-support');
assert.equal(configKey.response.type, 'answer');
assert.equal(configKey.calls, 2, 'specificity reuses the intent call; only synthesis adds a call');

const validSha = 'b'.repeat(40);
const sha = await runGate({
    query: `Explain ${validSha}`,
    intent: intentPayload({ searchQuery: validSha, specificity: specificity({ fileOrSymbol: validSha }) }),
    denseResults: [],
    directMatches: [supportedResult],
    maxIterations: 1,
});
const shaGateTrace = sha.response.iterationLog.find(entry => entry.stage === 'evidence-gate');
assert.equal(shaGateTrace.verdict, 'SEARCH');
assert.equal(shaGateTrace.reason, 'exact-commit-match');

console.log('orchestrator evidence gate: PASS');
