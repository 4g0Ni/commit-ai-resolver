const TEMPLATE_ONLY_LINES = new Set([
    'react version:',
    'steps to reproduce',
    'link to code example:',
    'the current behavior',
    'the expected behavior',
]);
const CANONICAL_AREAS = new Set([
    'React DevTools', 'React Server Components / Flight', 'React DOM', 'Fiber / Reconciler',
    'React Native Renderer', 'Scheduler', 'React Compiler', 'Test Renderers', 'React ART',
    'Shared React Infrastructure', 'React Events', 'React Hooks ESLint', 'Test Infrastructure',
    'React Core', 'React Addons', 'Vendored Dependencies', 'Generated / Build Output', 'Fixtures',
    'Documentation', 'Build / Tooling',
]);

function cleanText(value) {
    return String(value || '')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function meaningfulText(value) {
    return cleanText(value)
        .split('\n')
        .filter(line => !TEMPLATE_ONLY_LINES.has(line.trim().toLowerCase()))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function truncateAtWord(value, maximum) {
    const text = cleanText(value);
    if (text.length <= maximum) return text;
    const prefix = text.slice(0, maximum + 1);
    const boundary = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('\n'));
    return `${prefix.slice(0, boundary > maximum * 0.7 ? boundary : maximum).trim()}…`;
}

function candidateId(corpusRepo, issueNumber) {
    return `${corpusRepo.replace(/[^a-z0-9]+/gi, '-')}-issue-${issueNumber}`.toLowerCase();
}

function buildQuery(issue) {
    const title = cleanText(issue.title);
    const body = truncateAtWord(issue.bodyText, 1400);
    if (!body || body.toLowerCase() === title.toLowerCase()) return title;
    return `${title}\n\n${body}`;
}

function scoreCandidate(issue, pullRequests, commits) {
    const labels = (issue.labels?.nodes || []).map(item => item.name);
    const searchable = `${issue.title}\n${issue.bodyText}`.toLowerCase();
    const resolutionText = pullRequests.map(item => `${item.title}\n${item.bodyText}`).join('\n').toLowerCase();
    const changedFiles = new Set(commits.flatMap(item => item.changedFiles || []));
    let score = 0;
    const reasons = [];
    if (labels.some(label => /type:\s*bug/i.test(label))) {
        score += 3;
        reasons.push('bug-label');
    }
    if (/\b(?:bug|crash|error|warning|incorrect|fails?|broken|regression|hydration|performance)\b/i.test(searchable)) {
        score += 2;
        reasons.push('problem-signal');
    }
    if (/\b(?:repro|reproduce|current behavior|expected behavior)\b/i.test(searchable)) {
        score += 2;
        reasons.push('reproduction-signal');
    }
    if (/\b(?:fix|root cause|because|test|regression coverage)\b/i.test(resolutionText)) {
        score += 2;
        reasons.push('resolution-signal');
    }
    if (changedFiles.size > 0 && changedFiles.size <= 30) {
        score += 1;
        reasons.push('focused-diff');
    }
    if (meaningfulText(issue.bodyText).length >= 300) {
        score += 1;
        reasons.push('detailed-problem');
    }
    return { score, reasons, changedFileCount: changedFiles.size };
}

/**
 * Convert a GitHub Issue and its explicit closing PR references into a review candidate.
 * Only commits present in the supplied corpus are accepted as gold evidence.
 * @param {object} issue - GitHub GraphQL Issue node
 * @param {Map<string, object>} corpusByCommitId - Full SHA to enriched corpus commit
 * @param {object} options
 * @returns {object|null}
 */
export function buildGroundedRcaCandidate(issue, corpusByCommitId, options = {}) {
    const githubRepo = options.githubRepo || 'react/react';
    const corpusRepo = options.corpusRepo || 'facebook/react';
    const minimumIssueLength = options.minimumIssueLength || 120;
    const minimumResolutionLength = options.minimumResolutionLength || 60;
    const issueBody = meaningfulText(issue.bodyText);
    if (!Number.isInteger(issue.number) || cleanText(issue.title).length < 8 || issueBody.length < minimumIssueLength) return null;

    const pullRequests = [];
    const relevantCommits = [];
    const corpusCommits = [];
    for (const pullRequest of issue.closedByPullRequestsReferences?.nodes || []) {
        const commitId = String(pullRequest.mergeCommit?.oid || '').toLowerCase();
        const commit = corpusByCommitId.get(commitId);
        if (!pullRequest.mergedAt || !commit || meaningfulText(pullRequest.bodyText).length < minimumResolutionLength) continue;
        pullRequests.push({
            number: pullRequest.number,
            title: cleanText(pullRequest.title),
            bodyText: cleanText(pullRequest.bodyText),
            url: pullRequest.url,
            mergedAt: pullRequest.mergedAt,
            author: pullRequest.author?.login || null,
            mergeCommitId: commitId,
        });
        relevantCommits.push({
            repo: corpusRepo,
            id: commit.id || commit.shortId || commitId.slice(0, 8),
            commitId,
            relevance: 3,
            required: true,
            relationship: 'fix',
        });
        corpusCommits.push(commit);
    }
    if (!pullRequests.length) return null;

    const affectedAreas = [...new Set(corpusCommits.flatMap(commit => commit.summary?.affectedAreas || []))];
    const changedFiles = [...new Set(corpusCommits.flatMap(commit => commit.changedFiles || []))];
    const qualitySignals = scoreCandidate(issue, pullRequests, corpusCommits);
    return {
        schemaVersion: 1,
        id: candidateId(corpusRepo, issue.number),
        category: 'issue_rca',
        reviewStatus: 'pending',
        query: buildQuery(issue),
        expectedBehavior: 'answer',
        source: 'github-issue-closing-pr',
        repository: { github: githubRepo, corpus: corpusRepo },
        problem: {
            issueNumber: issue.number,
            title: cleanText(issue.title),
            bodyText: cleanText(issue.bodyText),
            url: issue.url,
            author: issue.author?.login || null,
            createdAt: issue.createdAt,
            closedAt: issue.closedAt,
            labels: (issue.labels?.nodes || []).map(item => item.name).sort(),
        },
        resolution: { pullRequests },
        relevantCommits,
        evidence: { affectedAreas, changedFiles },
        provenance: {
            relationship: 'Issue.closedByPullRequestsReferences',
            issueUrl: issue.url,
            pullRequestUrls: pullRequests.map(item => item.url),
            commitUrls: relevantCommits.map(item => `https://github.com/${githubRepo}/commit/${item.commitId}`),
        },
        qualitySignals,
    };
}

export function rankGroundedRcaCandidates(candidates) {
    return [...candidates].sort((left, right) =>
        right.qualitySignals.score - left.qualitySignals.score
        || String(right.problem.closedAt).localeCompare(String(left.problem.closedAt))
        || left.id.localeCompare(right.id));
}

export function selectDiverseGroundedRcaCandidates(candidates, limit, options = {}) {
    const ranked = rankGroundedRcaCandidates(candidates);
    const maximumPerArea = options.maximumPerArea || Math.max(3, Math.ceil(limit / 5));
    const minimumScore = options.minimumScore ?? 8;
    const eligible = ranked.filter(candidate => candidate.qualitySignals.score >= minimumScore);
    const selectable = eligible.length >= limit ? eligible : ranked;
    const groups = new Map();
    for (const candidate of selectable) {
        const area = groundedRcaSelectionArea(candidate);
        if (!groups.has(area)) groups.set(area, []);
        groups.get(area).push(candidate);
    }
    const groupNames = [...groups]
        .sort((left, right) => right[1][0].qualitySignals.score - left[1][0].qualitySignals.score || left[0].localeCompare(right[0]))
        .map(([name]) => name);
    const selected = [];
    const selectedIds = new Set();
    const areaCounts = new Map();
    let progress = true;
    while (selected.length < limit && progress) {
        progress = false;
        for (const area of groupNames) {
            if (selected.length >= limit) break;
            if ((areaCounts.get(area) || 0) >= maximumPerArea) continue;
            const candidate = groups.get(area).shift();
            if (!candidate) continue;
            selected.push(candidate);
            selectedIds.add(candidate.id);
            areaCounts.set(area, (areaCounts.get(area) || 0) + 1);
            progress = true;
        }
    }
    if (selected.length < limit) {
        for (const candidate of ranked) {
            if (selected.length >= limit) break;
            if (!selectedIds.has(candidate.id)) selected.push(candidate);
        }
    }
    return selected;
}

export function groundedRcaSelectionArea(candidate) {
    return (candidate.evidence?.affectedAreas || []).find(area => CANONICAL_AREAS.has(area)) || 'Historical / Other';
}

export function buildReviewTemplate(candidate) {
    return {
        id: candidate.id,
        decision: 'pending',
        reviewer: '',
        reviewedAt: '',
        problemFaithful: null,
        fixRelationshipValid: null,
        goldCommitsComplete: null,
        queryUsable: null,
        queryOverride: '',
        goldCommitIds: candidate.relevantCommits.map(item => item.commitId),
        split: '',
        notes: '',
    };
}

export { cleanText, meaningfulText, truncateAtWord };
