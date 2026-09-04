import { strict as assert } from 'node:assert';
import {
    ISSUE_RCA_RELATIONSHIP_POLICY,
    verifyIssueRcaClosingPrRelationship,
} from '../services/issue-rca-relationship-verifier.js';

const commitId = '49cd77d24a5244d159be14671654da63932ea9be';
const provenance = {
    relationship: 'Issue.closedByPullRequestsReferences',
    pullRequests: [{
        number: 19614,
        url: 'https://github.com/react/react/pull/19614',
        mergeCommitId: commitId,
    }],
};
const matchingCandidate = {
    repo: 'facebook/react',
    id: '49cd77d2',
    commitId,
};

const supported = verifyIssueRcaClosingPrRelationship({
    provenance,
    results: [matchingCandidate],
});
assert.equal(supported.status, 'SUPPORTED');
assert.deepEqual(supported.supportingCandidateIds, [`facebook/react:${commitId}`]);
assert.deepEqual(supported.evidenceTypes, ['github-closing-pr-merge-commit']);
assert.equal(supported.matches[0].pullRequestNumber, 19614);
assert.equal(supported.independentCausalValidation, false);

const outsideDepth = verifyIssueRcaClosingPrRelationship({
    provenance,
    results: [
        ...Array.from({ length: 20 }, (_, index) => ({
            repo: 'facebook/react',
            commitId: String(index).padStart(40, '0'),
        })),
        matchingCandidate,
    ],
    limit: 20,
});
assert.equal(outsideDepth.status, 'INSUFFICIENT');
assert.equal(outsideDepth.reason, 'closing-pr-merge-commit-not-in-verification-depth');

assert.equal(verifyIssueRcaClosingPrRelationship({
    provenance: { relationship: 'manual-label', pullRequests: provenance.pullRequests },
    results: [matchingCandidate],
}).status, 'UNAVAILABLE');

assert.equal(verifyIssueRcaClosingPrRelationship({
    provenance: {
        relationship: provenance.relationship,
        pullRequests: [{ number: 1, mergeCommitId: '49cd77d2' }],
    },
    results: [matchingCandidate],
}).reason, 'closing-pr-merge-commit-unavailable');

assert.equal(ISSUE_RCA_RELATIONSHIP_POLICY.independentCausalValidation, false);
assert.equal(ISSUE_RCA_RELATIONSHIP_POLICY.releaseGateEligible, false);

console.log('issue RCA closing-PR relationship verifier: PASS');
