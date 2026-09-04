/**
 * Deterministic relationship verifier for closed GitHub Issue RCA cases.
 *
 * This verifier confirms that an LTR candidate is the merge commit of a PR
 * listed by GitHub's Issue.closedByPullRequestsReferences relationship. It is
 * useful at runtime for closed Issues, but is not an independent evaluator for
 * datasets whose labels were mined from the same relationship.
 */

const EXPECTED_RELATIONSHIP = 'Issue.closedByPullRequestsReferences';
const FULL_SHA = /^[0-9a-f]{40}$/i;

function normalizeSha(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return FULL_SHA.test(normalized) ? normalized : null;
}

/**
 * Verify closing-PR merge commits against an already ranked candidate list.
 *
 * @param {object} input
 * @param {object} input.provenance Dataset/runtime GitHub relationship payload.
 * @param {Array} input.results LTR-ranked candidates.
 * @param {number} input.limit Maximum candidates that downstream verification can inspect.
 * @returns {object} Verification payload accepted by evaluateIssueRcaEvidence.
 */
export function verifyIssueRcaClosingPrRelationship({
    provenance = {},
    results = [],
    limit = 20,
} = {}) {
    const depth = Number.isInteger(limit) && limit > 0 ? limit : 20;
    if (provenance.relationship !== EXPECTED_RELATIONSHIP) {
        return {
            status: 'UNAVAILABLE',
            supportingCandidateIds: [],
            evidenceTypes: [],
            confidence: 0,
            reason: 'closing-pr-relationship-unavailable',
            verificationDepth: depth,
        };
    }

    const pullRequests = Array.isArray(provenance.pullRequests) ? provenance.pullRequests : [];
    const closingCommits = new Map();
    for (const pullRequest of pullRequests) {
        const mergeCommitId = normalizeSha(pullRequest?.mergeCommitId);
        if (mergeCommitId) closingCommits.set(mergeCommitId, pullRequest);
    }
    if (closingCommits.size === 0) {
        return {
            status: 'UNAVAILABLE',
            supportingCandidateIds: [],
            evidenceTypes: [],
            confidence: 0,
            reason: 'closing-pr-merge-commit-unavailable',
            verificationDepth: depth,
        };
    }

    const matches = [];
    for (const candidate of (Array.isArray(results) ? results : []).slice(0, depth)) {
        const commitId = normalizeSha(candidate?.commitId);
        if (!commitId || !closingCommits.has(commitId)) continue;
        const pullRequest = closingCommits.get(commitId);
        matches.push({
            repo: candidate.repo || '',
            commitId,
            candidateId: candidate.id || commitId.slice(0, 8),
            pullRequestNumber: pullRequest.number ?? null,
            pullRequestUrl: pullRequest.url || null,
        });
    }
    if (matches.length === 0) {
        return {
            status: 'INSUFFICIENT',
            supportingCandidateIds: [],
            evidenceTypes: ['github-closing-pr-relationship-checked'],
            confidence: 0,
            reason: 'closing-pr-merge-commit-not-in-verification-depth',
            verificationDepth: depth,
        };
    }

    return {
        status: 'SUPPORTED',
        supportingCandidateIds: matches.map(match => `${match.repo}:${match.commitId}`.toLowerCase()),
        evidenceTypes: ['github-closing-pr-merge-commit'],
        confidence: 1,
        reason: 'retrieved-closing-pr-merge-commit',
        verificationDepth: depth,
        matches,
        independentCausalValidation: false,
    };
}

export const ISSUE_RCA_RELATIONSHIP_POLICY = Object.freeze({
    relationship: EXPECTED_RELATIONSHIP,
    requiresFullCommitId: true,
    independentCausalValidation: false,
    releaseGateEligible: false,
});
