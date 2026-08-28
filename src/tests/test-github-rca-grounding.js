import { strict as assert } from 'node:assert';
import { buildGroundedRcaCandidate, buildReviewTemplate, groundedRcaSelectionArea, meaningfulText, rankGroundedRcaCandidates, selectDiverseGroundedRcaCandidates } from '../services/github-rca-grounding.js';

const commitId = 'a'.repeat(40);
const corpus = new Map([[commitId, {
    id: commitId.slice(0, 8),
    shortId: commitId.slice(0, 8),
    commitId,
    changedFiles: ['packages/react-dom/src/events/ToggleEvent.js'],
    summary: { affectedAreas: ['React DOM'] },
}]]);
const issue = {
    number: 123,
    title: 'Bug: toggle event source is missing',
    url: 'https://github.com/react/react/issues/123',
    author: { login: 'reporter' },
    createdAt: '2026-01-01T00:00:00Z',
    closedAt: '2026-01-03T00:00:00Z',
    bodyText: 'Steps To Reproduce\nDispatch a native ToggleEvent with a source element.\n\nThe current behavior\nThe synthetic event exposes undefined.\n\nThe expected behavior\nThe source element should be copied.',
    labels: { nodes: [{ name: 'Type: Bug' }] },
    closedByPullRequestsReferences: { nodes: [{
        number: 124,
        title: 'Copy source to synthetic ToggleEvent',
        url: 'https://github.com/react/react/pull/124',
        author: { login: 'fixer' },
        mergedAt: '2026-01-03T00:00:00Z',
        mergeCommit: { oid: commitId },
        bodyText: 'The interface omitted source. This fixes the copy and adds regression coverage with a focused test.',
    }] },
};

const candidate = buildGroundedRcaCandidate(issue, corpus);
assert.equal(candidate.id, 'facebook-react-issue-123');
assert.equal(candidate.relevantCommits[0].commitId, commitId);
assert.deepEqual(candidate.evidence.affectedAreas, ['React DOM']);
assert.match(candidate.query, /synthetic event exposes undefined/);
assert.ok(candidate.qualitySignals.score >= 8);
assert.equal(candidate.provenance.relationship, 'Issue.closedByPullRequestsReferences');
assert.deepEqual(buildReviewTemplate(candidate), {
    id: candidate.id,
    decision: 'pending',
    reviewer: '',
    reviewedAt: '',
    problemFaithful: null,
    fixRelationshipValid: null,
    goldCommitsComplete: null,
    queryUsable: null,
    queryOverride: '',
    goldCommitIds: [commitId],
    split: '',
    notes: '',
});

const missingCommit = buildGroundedRcaCandidate(issue, new Map());
assert.equal(missingCommit, null);
assert.equal(meaningfulText('React version:\nSteps To Reproduce\nThe current behavior'), '');
assert.deepEqual(rankGroundedRcaCandidates([
    { id: 'low', problem: { closedAt: '2026-01-01' }, qualitySignals: { score: 1 } },
    { id: 'high', problem: { closedAt: '2025-01-01' }, qualitySignals: { score: 2 } },
]).map(item => item.id), ['high', 'low']);
const diverse = selectDiverseGroundedRcaCandidates([
    { id: 'dom-1', problem: { closedAt: '2026-01-03' }, evidence: { affectedAreas: ['React DOM'] }, qualitySignals: { score: 3 } },
    { id: 'dom-2', problem: { closedAt: '2026-01-02' }, evidence: { affectedAreas: ['React DOM'] }, qualitySignals: { score: 3 } },
    { id: 'compiler-1', problem: { closedAt: '2026-01-01' }, evidence: { affectedAreas: ['React Compiler'] }, qualitySignals: { score: 2 } },
], 3, { maximumPerArea: 2, minimumScore: 0 });
assert.deepEqual(diverse.map(item => item.id), ['dom-1', 'compiler-1', 'dom-2']);
assert.equal(groundedRcaSelectionArea({ evidence: { affectedAreas: ['flow-typed', 'React Core'] } }), 'React Core');
assert.equal(groundedRcaSelectionArea({ evidence: { affectedAreas: ['flow-typed'] } }), 'Historical / Other');

console.log('github RCA grounding: PASS');
