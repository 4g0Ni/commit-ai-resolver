import { strict as assert } from 'node:assert';
import { agenticSearch } from '../../api/agents/orchestrator.js';

function intentOnlyClient() {
    let calls = 0;
    return {
        get calls() { return calls; },
        chat: {
            completions: {
                async create() {
                    calls++;
                    return {
                        choices: [{ message: { content: JSON.stringify({
                            searchQuery: 'unrelated infrastructure subsystem change',
                            secondarySearchQuery: null,
                            confidence: 0.8,
                            verdict: 'GOOD',
                            keywords: ['infrastructure'],
                        }) } }],
                    };
                },
            },
        },
    };
}

const weakResult = {
    repo: 'facebook/react', id: 'aaaaaaaa', commitId: 'a'.repeat(40), date: '2018-01-01', author: 'Alice',
    score: 0.55, text: 'unrelated React change', metadata: { title: 'React change', summary: 'React change' },
};

async function run(query) {
    const llm = intentOnlyClient();
    const response = await agenticSearch({
        llm,
        llmFast: llm,
        embedQuery: async () => [1, 0],
        searchVectors: async () => [weakResult],
        searchLexical: async () => [],
        lookupByCommitIds: async () => [],
        getVectorStats: async () => ({ dateRange: { from: '2013-01-01', to: '2019-02-20' }, repos: ['facebook/react'] }),
        buildFullContext: async () => '',
        query,
    });
    return { response, calls: llm.calls };
}

const ood = await run('Which commit changed Kafka consumer offsets?');
assert.equal(ood.response.evidenceGate.verdict, 'ABSTAIN');
assert.equal(ood.response.suspects.length, 0);
assert.equal(ood.calls, 1, 'abstention skips synthesis and evaluator model calls');

const vague = await run('it is slow');
assert.equal(vague.response.type, 'clarification');
assert.equal(vague.response.evidenceGate.verdict, 'ASK_USER');
assert.equal(vague.calls, 1, 'clarification skips synthesis and evaluator model calls');

console.log('orchestrator evidence gate: PASS');

