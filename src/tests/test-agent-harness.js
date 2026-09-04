import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { BudgetManager, BudgetExceededError } from '../../api/agents/harness/budget-manager.js';
import { validateSupervisorOutput } from '../../api/agents/harness/output-validator.js';
import { createMultiAgentRuntime } from '../../api/agents/multi-agent-runtime.js';

const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));
const agentsModule = await import(pathToFileURL(apiRequire.resolve('@openai/agents')).href);
const { RunContext } = agentsModule;

const budgets = new BudgetManager({ maxAgentCalls: 1, maxToolCalls: 1, maxDiffFetches: 1 });
budgets.consumeAgentCall('first');
assert.throws(() => budgets.consumeAgentCall('second'), BudgetExceededError);
budgets.consumeToolCall('get_commit_diff', { isDiff: true });
assert.throws(() => budgets.consumeToolCall('get_commit_diff', { isDiff: true }), BudgetExceededError);

let searchCalls = 0;
let diffCalls = 0;
const candidate = {
    id: 'abc1234',
    commitId: 'abc1234def5678',
    repo: 'AdsAppUI',
    date: '2026-09-03',
    score: 0.9,
    metadata: { title: 'Fix login crash', summary: 'Guard a null token.' },
};
const runtime = createMultiAgentRuntime({
    qualityModel: 'unused-quality-model',
    fastModel: 'unused-fast-model',
    commitSearchService: {
        getIndexStats: async () => ({ totalCommits: 1, repos: ['AdsAppUI'], dateRange: null }),
        async search() {
            searchCalls += 1;
            return {
                results: [candidate],
                totalResultCount: 1,
                evidenceGate: { verdict: 'SEARCH', evidenceScore: 0.9, reason: 'test' },
                filters: {},
                timings: {},
            };
        },
        lookup: async () => [],
    },
    commitDiffService: {
        available: true,
        async getCommitDiff() {
            diffCalls += 1;
            return { available: true, diff: 'diff', files: 1, truncated: false };
        },
    },
});
const context = runtime.harness.createContext({
    runId: 'harness-test',
    query: 'login crash',
    services: {
        commitSearch: runtime.harness ? {
            getIndexStats: async () => ({}),
            async search() {
                searchCalls += 1;
                return {
                    results: [candidate],
                    totalResultCount: 1,
                    evidenceGate: { verdict: 'SEARCH', evidenceScore: 0.9, reason: 'test' },
                    filters: {},
                    timings: {},
                };
            },
            lookup: async () => [],
        } : null,
        commitDiff: {
            available: true,
            async getCommitDiff() {
                diffCalls += 1;
                return { available: true, diff: 'diff', files: 1, truncated: false };
            },
        },
    },
});
const runContext = new RunContext(context);
const searchTool = runtime.harness.toolsFor('retrieval-agent').find(item => item.name === 'search_commits');
const searchInput = JSON.stringify({
    semanticQuery: 'login crash',
    secondaryQuery: null,
    repo: null,
    author: null,
    dateFrom: null,
    dateTo: null,
    riskLevel: null,
    changeType: null,
    topK: 10,
});
await searchTool.invoke(runContext, searchInput);
await searchTool.invoke(runContext, searchInput);
assert.equal(searchCalls, 1, 'identical searches should be deduplicated');
assert(context.candidates.has('AdsAppUI:abc1234'));

const diffTool = runtime.harness.toolsFor('diff-investigator-agent').find(item => item.name === 'get_commit_diff');
const denied = JSON.parse(await diffTool.invoke(runContext, JSON.stringify({
    candidateKey: 'AdsAppUI:deadbee',
    reason: 'test an ungrounded candidate',
})));
assert.equal(denied.ok, false);
assert.equal(denied.error.code, 'candidate_not_in_ledger');
assert.equal(diffCalls, 0);

const guardedContext = runtime.harness.createContext({
    runId: 'evidence-gate-test',
    query: 'Why did this break?',
    services: context.services,
});
guardedContext.lastEvidenceGate = { verdict: 'ABSTAIN', evidenceScore: 0, reason: 'test-abstain' };
guardedContext.evidenceGates = [{ source: 'test', ...guardedContext.lastEvidenceGate }];
guardedContext.candidates.addAll([candidate], 'test', { evidenceVerdict: 'ABSTAIN' });
const weakCandidateDiff = JSON.parse(await diffTool.invoke(
    new RunContext(guardedContext),
    JSON.stringify({ candidateKey: 'AdsAppUI:abc1234', reason: 'Attempt to bypass the evidence gate.' }),
));
assert.equal(weakCandidateDiff.error.code, 'candidate_not_in_ledger');
assert.equal(diffCalls, 0);
const guardedOutput = validateSupervisorOutput({
    type: 'answer',
    reply: 'Invented strong conclusion.',
    confidence: 0.99,
    citedCandidateKeys: ['AdsAppUI:abc1234'],
    suggestedActions: ['Refine the commit search'],
    decisionSummary: 'This should be overridden by the deterministic gate.',
}, guardedContext);
assert.equal(guardedOutput.confidence, 0);
assert.deepEqual(guardedOutput.citedCandidateKeys, []);
assert(!guardedOutput.reply.includes('Invented strong conclusion'));

await runtime.close();
console.log('agent harness policies: PASS');
