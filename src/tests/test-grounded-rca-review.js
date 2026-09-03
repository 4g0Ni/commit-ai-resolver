import { strict as assert } from 'node:assert';
import { assignGroupedCaseSplits, buildModelPrescreenedRcaCase, buildReviewedRcaCase, reviewDecisionCounts, stableSplit, validateGroundedRcaReview } from '../services/grounded-rca-review.js';

const commitId = 'b'.repeat(40);
const candidate = {
    id: 'facebook-react-issue-123',
    query: 'Bug: the toggle source is missing\n\nDispatching a toggle event loses its source element.',
    problem: { issueNumber: 123, title: 'Bug: source missing', url: 'https://github.com/react/react/issues/123' },
    resolution: { pullRequests: [{ number: 124, title: 'Copy toggle source', url: 'https://github.com/react/react/pull/124', mergeCommitId: commitId }] },
    relevantCommits: [{ repo: 'facebook/react', id: commitId.slice(0, 8), commitId, relevance: 3, required: true, relationship: 'fix' }],
    evidence: { affectedAreas: ['React DOM'] },
    provenance: { relationship: 'Issue.closedByPullRequestsReferences' },
};
const review = {
    id: candidate.id,
    decision: 'approve',
    reviewer: 'Human Reviewer',
    reviewedAt: '2026-08-27T10:00:00Z',
    problemFaithful: true,
    fixRelationshipValid: true,
    goldCommitsComplete: true,
    queryUsable: true,
    notes: 'Issue and closing PR were inspected.',
};
const corpus = new Map([[commitId, { commitId }]]);
assert.deepEqual(validateGroundedRcaReview(candidate, review, corpus).requestedCommitIds, [commitId]);
const evalCase = buildReviewedRcaCase(candidate, review, corpus);
assert.equal(evalCase.category, 'issue_rca');
assert.equal(evalCase.relevantCommits[0].commitId, commitId);
assert.equal(evalCase.provenance.reviewer, 'Human Reviewer');
assert.ok(['dev', 'test'].includes(evalCase.split));
assert.equal(stableSplit(candidate.id), stableSplit(candidate.id));
const pilotCase = buildModelPrescreenedRcaCase(candidate, corpus);
assert.equal(pilotCase.category, 'issue_rca_pilot');
assert.equal(pilotCase.labelStatus, 'model-prescreened');
assert.equal(pilotCase.gold, false);
assert.equal(pilotCase.releaseGateEligible, false);
assert.equal(pilotCase.split, 'pilot');
assert.equal(pilotCase.pilot.qualityScore, null);
assert.deepEqual(reviewDecisionCounts([{ decision: 'approve' }, { decision: 'reject' }, {}]), { approve: 1, reject: 1, missing: 1 });

const secondCommitId = 'c'.repeat(40);
const grouped = assignGroupedCaseSplits([
    { id: 'one', relevantCommits: [{ repo: 'facebook/react', commitId }] },
    { id: 'two', relevantCommits: [{ repo: 'facebook/react', commitId }, { repo: 'facebook/react', commitId: secondCommitId }] },
    { id: 'three', relevantCommits: [{ repo: 'facebook/react', commitId: secondCommitId }] },
    { id: 'independent', relevantCommits: [{ repo: 'facebook/react', commitId: 'd'.repeat(40) }] },
]);
assert.equal(grouped[0].split, grouped[1].split);
assert.equal(grouped[1].split, grouped[2].split);
assert.deepEqual(grouped, assignGroupedCaseSplits(grouped));

assert.throws(() => validateGroundedRcaReview(candidate, { ...review, problemFaithful: false }, corpus), /problemFaithful/);
assert.throws(() => validateGroundedRcaReview(candidate, { ...review, reviewer: '' }, corpus), /reviewer/);
assert.throws(() => validateGroundedRcaReview(candidate, { ...review, goldCommitIds: ['c'.repeat(40)] }, corpus), /not linked/);

console.log('grounded RCA review: PASS');
