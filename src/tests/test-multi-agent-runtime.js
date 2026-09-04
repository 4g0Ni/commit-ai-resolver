import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createMultiAgentRuntime } from '../../api/agents/multi-agent-runtime.js';
import { orchestrateSearch, selectOrchestrationMode } from '../../api/agents/multi-agent-orchestrator.js';

const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));
const testing = await import(pathToFileURL(apiRequire.resolve('@openai/agents/testing')).href);
const { ScriptedModel, assistantMessage, functionCall } = testing;

const candidate = {
    id: 'abc1234',
    commitId: 'abc1234def5678',
    repo: 'AdsAppUI',
    date: '2026-09-03',
    author: 'Developer',
    score: 0.91,
    metadata: {
        title: 'Fix login crash',
        summary: 'Guard a null token before reading claims.',
        riskLevel: 'MEDIUM',
        url: 'https://example.test/abc1234',
    },
};
const searchArguments = {
    semanticQuery: 'login null token crash',
    secondaryQuery: null,
    repo: 'AdsAppUI',
    author: null,
    dateFrom: null,
    dateTo: null,
    riskLevel: null,
    changeType: null,
    topK: 10,
};
const retrievalOutput = {
    evidenceSummary: 'One matching commit changes the failing token path.',
    candidateKeys: ['AdsAppUI:abc1234'],
    confidence: 0.9,
    evidenceVerdict: 'SEARCH',
    needsClarification: false,
    clarificationQuestion: null,
    recommendedNextStep: 'investigate',
    queriesUsed: ['login null token crash'],
};
const investigationOutput = {
    analysis: 'The diff adds a null guard before claims are read.',
    rootCauseCandidateKey: 'AdsAppUI:abc1234',
    confidence: 0.86,
    mechanism: 'A missing null guard allowed the login path to dereference an absent token.',
    hypotheses: [{
        candidateKey: 'AdsAppUI:abc1234',
        claim: 'The changed guard matches the reported crash path.',
        supportingEvidence: ['Auth.js checks token before reading claims.'],
        contradictingEvidence: [],
        confidence: 0.86,
    }],
    needsMoreEvidence: false,
    recommendedQueries: [],
};
const critiqueOutput = {
    verdict: 'PASS',
    qualityScore: 0.85,
    supportedCandidateKeys: ['AdsAppUI:abc1234'],
    unsupportedClaims: [],
    missingEvidence: [],
    recommendedAction: 'answer',
    feedback: 'The candidate, symptom, and diff mechanism align.',
};
const supervisorOutput = {
    type: 'answer',
    reply: 'The strongest root-cause candidate is the null-token guard change.',
    confidence: 0.85,
    citedCandidateKeys: ['AdsAppUI:abc1234', 'AdsAppUI:deadbee'],
    suggestedActions: ['Inspect the candidate diff'],
    decisionSummary: 'Retrieval found one candidate; diff inspection supported it; the critic passed it.',
};

const fastModel = new ScriptedModel([
    [functionCall('search_commits', searchArguments, { callId: 'search_1' })],
    [assistantMessage(JSON.stringify(retrievalOutput))],
    [functionCall('get_evidence_snapshot', { includeDiffs: true, limit: 10 }, { callId: 'critic_snapshot_1' })],
    [assistantMessage(JSON.stringify(critiqueOutput))],
]);
const qualityModel = new ScriptedModel([
    [functionCall('delegate_commit_retrieval', { input: 'Find commits related to the login crash.' }, { callId: 'delegate_retrieval_1' })],
    [functionCall('delegate_diff_investigation', { input: 'Inspect the strongest grounded candidate.' }, { callId: 'delegate_diff_1' })],
    [functionCall('get_evidence_snapshot', { includeDiffs: false, limit: 10 }, { callId: 'investigator_snapshot_1' })],
    [functionCall('get_commit_diff', { candidateKey: 'AdsAppUI:abc1234', reason: 'Test the null-token crash mechanism.' }, { callId: 'diff_1' })],
    [assistantMessage(JSON.stringify(investigationOutput))],
    [functionCall('delegate_evidence_critique', { input: 'Challenge the current causal hypothesis.' }, { callId: 'delegate_critic_1' })],
    [assistantMessage(JSON.stringify(supervisorOutput))],
]);

const runtime = createMultiAgentRuntime({
    qualityModel,
    fastModel,
    commitSearchService: {
        getIndexStats: async () => ({ totalCommits: 1, repos: ['AdsAppUI'], dateRange: null }),
        async search() {
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
            return {
                available: true,
                repo: 'AdsAppUI',
                commitId: candidate.commitId,
                files: 1,
                diff: 'diff --git a/Auth.js b/Auth.js\n+if (!token) return;',
                truncated: false,
                error: null,
            };
        },
    },
});

const result = await runtime.run({
    query: 'Why did the AdsAppUI login path crash?',
    correlationId: 'multi-agent-test',
});
assert.equal(result.searchMethod, 'multi-agent');
assert.equal(result.confidence, 0.85);
assert.equal(result.suspects[0].shortId, 'abc1234');
assert(result.reply.includes('[abc1234](https://example.test/abc1234)'));
assert.deepEqual(result.agentTrace.agentCalls, [
    'delegate_commit_retrieval',
    'delegate_diff_investigation',
    'delegate_evidence_critique',
]);
assert.equal(result.agentTrace.budgets.used.diffFetches, 1);
assert.equal(result.promptMetrics.validationRejections, 1);
fastModel.assertComplete();
qualityModel.assertComplete();
await runtime.close();

assert.equal(selectOrchestrationMode('auto', 'What changed yesterday?'), 'workflow');
assert.equal(selectOrchestrationMode('auto', 'Why did login crash?'), 'multi_agent');
const fallback = await orchestrateSearch({
    configuredMode: 'multi_agent',
    multiAgentRuntime: { run: async () => { throw Object.assign(new Error('boom'), { code: 'test_failure' }); } },
    legacySearch: async () => ({ reply: 'legacy', searchMethod: 'agentic' }),
    params: { query: 'Why did login crash?' },
});
assert.equal(fallback.reply, 'legacy');
assert.equal(fallback.orchestrationFallback.used, true);
assert.equal(fallback.orchestrationFallback.reason, 'test_failure');

console.log('multi-agent runtime: PASS');

