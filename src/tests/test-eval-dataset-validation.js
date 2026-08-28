import { strict as assert } from 'node:assert';
import { assertDatasetGateEligibility, inspectEvalDataset, validateEvalCaseProvenance } from '../eval/lib/dataset-validation.js';

const commitId = 'a'.repeat(40);
const valid = {
    id: 'facebook-react-issue-1',
    category: 'issue_rca',
    source: 'human-reviewed-github-issue-closing-pr',
    provenance: {
        issue: { url: 'https://github.com/react/react/issues/1' },
        pullRequests: [{ url: 'https://github.com/react/react/pull/2', mergeCommitId: commitId }],
        relationship: 'Issue.closedByPullRequestsReferences',
        reviewer: 'Human',
        reviewedAt: '2026-08-27T10:00:00Z',
    },
    relevantCommits: [{ commitId, relationship: 'fix' }],
};
assert.deepEqual(validateEvalCaseProvenance(valid), []);
assert.deepEqual(inspectEvalDataset([valid]), { passed: true, issueRcaCases: 1, issueRcaPilotCases: 0, invalidIssueRcaCases: 0, errors: [] });
const invalid = structuredClone(valid);
invalid.provenance.pullRequests[0].mergeCommitId = 'b'.repeat(40);
assert.match(validateEvalCaseProvenance(invalid).join('; '), /not a closing PR merge commit/);
assert.equal(inspectEvalDataset([invalid]).passed, false);
assert.deepEqual(validateEvalCaseProvenance({ category: 'semantic_title' }), []);

const pilot = {
    ...structuredClone(valid),
    category: 'issue_rca_pilot',
    source: 'model-prescreened-github-issue-closing-pr',
    labelStatus: 'model-prescreened',
    gold: false,
    releaseGateEligible: false,
    split: 'pilot',
    evaluationPolicy: { labelStatus: 'model-prescreened', gold: false, releaseGateEligible: false },
};
delete pilot.provenance.reviewer;
delete pilot.provenance.reviewedAt;
pilot.provenance.reviewStatus = 'model-prescreened';
assert.deepEqual(validateEvalCaseProvenance(pilot), []);
assert.equal(inspectEvalDataset([pilot]).issueRcaPilotCases, 1);
assert.doesNotThrow(() => assertDatasetGateEligibility({ dataset: 'pilot', evaluationPolicy: { releaseGateEligible: false } }, false));
assert.throws(
    () => assertDatasetGateEligibility({ dataset: 'pilot', evaluationPolicy: { releaseGateEligible: false } }, true),
    /cannot be used with --gate/,
);

console.log('eval dataset validation: PASS');
