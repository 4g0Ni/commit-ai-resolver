import { createHash } from 'node:crypto';

function stableSplit(id) {
    const value = createHash('sha256').update(id).digest().readUInt32BE(0);
    return value % 4 === 0 ? 'test' : 'dev';
}

function assertHttpUrl(value, label) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error(`${label} must be a valid URL`);
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') throw new Error(`${label} must be an https://github.com URL`);
}

export function validateGroundedRcaReview(candidate, review, corpusByCommitId) {
    if (!candidate) throw new Error(`Review references unknown candidate: ${review?.id || 'missing id'}`);
    if (review?.decision !== 'approve') throw new Error(`${candidate.id}: review decision must be approve`);
    if (!String(review.reviewer || '').trim()) throw new Error(`${candidate.id}: reviewer is required`);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(String(review.reviewedAt || '')) || Number.isNaN(Date.parse(review.reviewedAt))) {
        throw new Error(`${candidate.id}: reviewedAt must be an ISO timestamp`);
    }
    for (const field of ['problemFaithful', 'fixRelationshipValid', 'goldCommitsComplete', 'queryUsable']) {
        if (review[field] !== true) throw new Error(`${candidate.id}: ${field} must be true before approval`);
    }
    assertHttpUrl(candidate.problem?.url, `${candidate.id}: issue URL`);
    for (const pullRequest of candidate.resolution?.pullRequests || []) assertHttpUrl(pullRequest.url, `${candidate.id}: PR URL`);
    const requestedCommitIds = Array.isArray(review.goldCommitIds) && review.goldCommitIds.length
        ? review.goldCommitIds.map(value => String(value).toLowerCase())
        : candidate.relevantCommits.map(item => String(item.commitId).toLowerCase());
    const candidateCommitIds = new Set(candidate.relevantCommits.map(item => String(item.commitId).toLowerCase()));
    for (const commitId of requestedCommitIds) {
        if (!candidateCommitIds.has(commitId)) throw new Error(`${candidate.id}: reviewed gold commit is not linked by the candidate: ${commitId}`);
        if (!corpusByCommitId.has(commitId)) throw new Error(`${candidate.id}: reviewed gold commit is absent from corpus: ${commitId}`);
    }
    if (!requestedCommitIds.length) throw new Error(`${candidate.id}: at least one gold commit is required`);
    if (review.split && !['dev', 'test'].includes(review.split)) throw new Error(`${candidate.id}: split must be dev or test`);
    const query = String(review.queryOverride || candidate.query || '').trim();
    if (query.length < 20) throw new Error(`${candidate.id}: reviewed query is too short`);
    return { requestedCommitIds, query };
}

export function buildReviewedRcaCase(candidate, review, corpusByCommitId) {
    const { requestedCommitIds, query } = validateGroundedRcaReview(candidate, review, corpusByCommitId);
    const relevantCommits = candidate.relevantCommits.filter(item => requestedCommitIds.includes(String(item.commitId).toLowerCase()));
    return {
        id: candidate.id,
        category: 'issue_rca',
        query,
        expectedBehavior: 'answer',
        relevantCommits,
        filters: {},
        commitIds: [],
        source: 'human-reviewed-github-issue-closing-pr',
        tags: ['rca', 'github-issue', 'closing-pr', 'human-reviewed', ...(candidate.evidence?.affectedAreas || []).map(area => `area:${area}`)],
        expectedIntent: { verdict: 'GOOD' },
        split: review.split || stableSplit(candidate.id),
        provenance: {
            issue: {
                number: candidate.problem.issueNumber,
                title: candidate.problem.title,
                url: candidate.problem.url,
            },
            pullRequests: candidate.resolution.pullRequests.map(item => ({
                number: item.number,
                title: item.title,
                url: item.url,
                mergeCommitId: item.mergeCommitId,
            })),
            relationship: candidate.provenance.relationship,
            reviewer: String(review.reviewer).trim(),
            reviewedAt: review.reviewedAt,
            reviewNotes: String(review.notes || '').trim(),
        },
    };
}

export function buildModelPrescreenedRcaCase(candidate, corpusByCommitId) {
    if (!candidate?.id) throw new Error('Pilot candidate id is required');
    assertHttpUrl(candidate.problem?.url, `${candidate.id}: issue URL`);
    const pullRequests = candidate.resolution?.pullRequests || [];
    if (!pullRequests.length) throw new Error(`${candidate.id}: at least one closing PR is required`);
    for (const pullRequest of pullRequests) assertHttpUrl(pullRequest.url, `${candidate.id}: PR URL`);
    if (candidate.provenance?.relationship !== 'Issue.closedByPullRequestsReferences') {
        throw new Error(`${candidate.id}: closing relationship is missing`);
    }
    const query = String(candidate.query || '').trim();
    if (query.length < 20) throw new Error(`${candidate.id}: pilot query is too short`);
    const relevantCommits = (candidate.relevantCommits || []).map(item => ({
        ...item,
        commitId: String(item.commitId || '').toLowerCase(),
    }));
    if (!relevantCommits.length) throw new Error(`${candidate.id}: at least one linked commit is required`);
    for (const commit of relevantCommits) {
        if (!corpusByCommitId.has(commit.commitId)) throw new Error(`${candidate.id}: linked commit is absent from corpus: ${commit.commitId}`);
    }
    return {
        id: candidate.id,
        category: 'issue_rca_pilot',
        query,
        expectedBehavior: 'answer',
        relevantCommits,
        filters: {},
        commitIds: [],
        source: 'model-prescreened-github-issue-closing-pr',
        pilotLabel: '模型预审、非 gold、不可用于 release gate',
        labelStatus: 'model-prescreened',
        gold: false,
        releaseGateEligible: false,
        tags: ['rca', 'github-issue', 'closing-pr', 'model-prescreened', 'non-gold', ...(candidate.evidence?.affectedAreas || []).map(area => `area:${area}`)],
        expectedIntent: { verdict: 'GOOD' },
        split: 'pilot',
        provenance: {
            issue: {
                number: candidate.problem.issueNumber,
                title: candidate.problem.title,
                url: candidate.problem.url,
            },
            pullRequests: pullRequests.map(item => ({
                number: item.number,
                title: item.title,
                url: item.url,
                mergeCommitId: item.mergeCommitId,
            })),
            relationship: candidate.provenance.relationship,
            reviewStatus: 'model-prescreened',
        },
        evaluationPolicy: {
            labelStatus: 'model-prescreened',
            gold: false,
            releaseGateEligible: false,
        },
        pilot: {
            qualityScore: candidate.qualitySignals?.score ?? null,
            qualityReasons: candidate.qualitySignals?.reasons || [],
            affectedAreas: candidate.evidence?.affectedAreas || [],
            changedFileCount: candidate.qualitySignals?.changedFileCount ?? candidate.evidence?.changedFiles?.length ?? 0,
            queryLength: query.length,
            goldCommitCount: relevantCommits.length,
            issueClosedAt: candidate.problem?.closedAt || null,
        },
    };
}

export function reviewDecisionCounts(reviews) {
    const counts = {};
    for (const review of reviews) counts[review.decision || 'missing'] = (counts[review.decision || 'missing'] || 0) + 1;
    return counts;
}

export { stableSplit };
