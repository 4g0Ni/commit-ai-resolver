import { strict as assert } from 'node:assert';
import {
    deriveIssueRcaWindow,
    evaluateIssueRcaEvidence,
    ISSUE_RCA_EVIDENCE_POLICY,
} from '../services/issue-rca-evidence-gate.js';

const issue = {
    number: 19591,
    createdAt: '2020-08-12T08:50:57Z',
    closedAt: '2020-08-15T13:42:50Z',
};
const window = deriveIssueRcaWindow(issue);
const candidates = [
    {
        repo: 'facebook/react',
        id: '49cd77d2',
        commitId: '49cd77d24a5244d159be14671654da63932ea9be',
        score: 0.9762,
        sourceRanks: { rawDense: 1, rawLexical: 1, compactDense: 1, compactLexical: 1 },
    },
    {
        repo: 'facebook/react',
        id: '4f5fb561',
        commitId: '4f5fb56100fac50f2c8bb33f984301b550e71407',
        score: 0.61,
        sourceRanks: { rawDense: 3, compactDense: 2 },
    },
];

assert.deepEqual(window, {
    valid: true,
    source: 'issue-lifecycle',
    dateFrom: '2020-08-05',
    dateTo: '2020-09-14',
    beforeCreatedDays: 7,
    afterClosedDays: 30,
    issueLifetimeDays: 4,
});

// Retrieval alone can only request verification. Neither a high LTR score,
// four-channel consensus, nor lifecycle metadata can directly authorize SEARCH.
const retrievalOnly = evaluateIssueRcaEvidence({
    query: "Bug: 'use strict' leaks out of the UMD wrapper",
    issue,
    retrievalWindow: window,
    results: candidates,
});
assert.equal(retrievalOnly.verdict, 'VERIFY');
assert.equal(retrievalOnly.reason, 'candidate-verification-required');
assert.equal(retrievalOnly.features.retrieval.topChannelCount, 4);
assert.equal(retrievalOnly.features.retrieval.topDenseConsensus, true);
assert.equal(retrievalOnly.features.retrieval.topLexicalConsensus, true);
assert.equal(retrievalOnly.features.retrieval.scoreCalibratedAsProbability, false);

assert.equal(evaluateIssueRcaEvidence({
    query: 'React Issue', issue, retrievalWindow: window, results: [],
}).reason, 'no-retrieval-results');

assert.equal(evaluateIssueRcaEvidence({
    query: 'React Issue', issue, retrievalWindow: { ...window, source: 'user-explicit' }, results: candidates,
}).reason, 'untrusted-window-provenance');

assert.equal(evaluateIssueRcaEvidence({
    query: 'React Issue', issue, retrievalWindow: { ...window, dateTo: '2020-09-15' }, results: candidates,
}).reason, 'issue-window-mismatch');

assert.equal(evaluateIssueRcaEvidence({
    query: 'Open React Issue', issue: { createdAt: issue.createdAt }, retrievalWindow: {}, results: candidates,
}).reason, 'open-or-invalid-closed-at');

assert.equal(evaluateIssueRcaEvidence({
    query: 'React Issue', issue, retrievalWindow: window, results: candidates,
    verification: { status: 'INSUFFICIENT', supportingCandidateIds: [], evidenceTypes: [] },
}).reason, 'causal-evidence-insufficient');

assert.equal(evaluateIssueRcaEvidence({
    query: 'React Issue', issue, retrievalWindow: window, results: candidates,
    verification: { status: 'UNAVAILABLE' },
}).reason, 'causal-verification-unavailable');

assert.equal(evaluateIssueRcaEvidence({
    query: 'React Issue', issue, retrievalWindow: window, results: candidates,
    verification: { status: 'SUPPORTED', supportingCandidateIds: [], evidenceTypes: ['behavioral-fix'] },
}).reason, 'incomplete-causal-verification');

assert.equal(evaluateIssueRcaEvidence({
    query: 'React Issue', issue, retrievalWindow: window, results: candidates,
    verification: {
        status: 'SUPPORTED',
        supportingCandidateIds: ['facebook/react:deadbeef'],
        evidenceTypes: ['behavioral-fix'],
        confidence: 0.9,
    },
}).reason, 'verification-candidate-not-retrieved');

const supported = evaluateIssueRcaEvidence({
    query: 'React Issue',
    issue,
    retrievalWindow: window,
    results: candidates,
    verification: {
        status: 'SUPPORTED',
        supportingCandidateIds: ['facebook/react:49cd77d24a5244d159be14671654da63932ea9be'],
        evidenceTypes: ['behavioral-fix', 'regression-test'],
        confidence: 0.88,
    },
});
assert.equal(supported.verdict, 'SEARCH');
assert.equal(supported.reason, 'causal-evidence-supported');
assert.equal(supported.evidenceScore, 0.88);

assert.equal(ISSUE_RCA_EVIDENCE_POLICY.releaseGateEligible, false);
assert.equal(ISSUE_RCA_EVIDENCE_POLICY.ltrScoreIsCalibratedProbability, false);

console.log('issue RCA evidence gate v2: PASS');
