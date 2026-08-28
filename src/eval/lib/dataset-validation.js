function isGitHubUrl(value, kind) {
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:' && parsed.hostname === 'github.com' && parsed.pathname.includes(`/${kind}/`);
    } catch {
        return false;
    }
}

export function validateEvalCaseProvenance(evalCase) {
    if (!['issue_rca', 'issue_rca_pilot'].includes(evalCase.category)) return [];
    const errors = [];
    const isPilot = evalCase.category === 'issue_rca_pilot';
    const expectedSource = isPilot ? 'model-prescreened-github-issue-closing-pr' : 'human-reviewed-github-issue-closing-pr';
    if (evalCase.source !== expectedSource) errors.push(`source is not ${isPilot ? 'model-prescreened' : 'human-reviewed'} GitHub provenance`);
    if (!isGitHubUrl(evalCase.provenance?.issue?.url, 'issues')) errors.push('issue URL is missing or invalid');
    if (isPilot) {
        if (evalCase.labelStatus !== 'model-prescreened') errors.push('pilot labelStatus must be model-prescreened');
        if (evalCase.gold !== false) errors.push('pilot gold flag must be false');
        if (evalCase.releaseGateEligible !== false) errors.push('pilot releaseGateEligible flag must be false');
        if (evalCase.evaluationPolicy?.labelStatus !== 'model-prescreened') errors.push('pilot evaluation policy labelStatus must be model-prescreened');
        if (evalCase.evaluationPolicy?.gold !== false) errors.push('pilot evaluation policy gold flag must be false');
        if (evalCase.evaluationPolicy?.releaseGateEligible !== false) errors.push('pilot evaluation policy releaseGateEligible flag must be false');
        if (evalCase.provenance?.reviewStatus !== 'model-prescreened') errors.push('pilot provenance reviewStatus must be model-prescreened');
    } else {
        if (!String(evalCase.provenance?.reviewer || '').trim()) errors.push('reviewer is missing');
        if (Number.isNaN(Date.parse(evalCase.provenance?.reviewedAt))) errors.push('reviewedAt is missing or invalid');
    }
    if (evalCase.provenance?.relationship !== 'Issue.closedByPullRequestsReferences') errors.push('closing relationship is missing');
    const pullRequests = evalCase.provenance?.pullRequests || [];
    if (!pullRequests.length) errors.push('closing PR provenance is missing');
    if (pullRequests.some(item => !isGitHubUrl(item.url, 'pull'))) errors.push('a closing PR URL is invalid');
    const mergeCommitIds = new Set(pullRequests.map(item => String(item.mergeCommitId || '').toLowerCase()));
    const goldCommits = evalCase.relevantCommits || [];
    if (!goldCommits.length) errors.push('gold commits are missing');
    for (const commit of goldCommits) {
        if (commit.relationship !== 'fix') errors.push(`gold commit ${commit.commitId} lacks fix relationship`);
        if (!mergeCommitIds.has(String(commit.commitId || '').toLowerCase())) errors.push(`gold commit ${commit.commitId} is not a closing PR merge commit`);
    }
    return errors;
}

export function inspectEvalDataset(cases) {
    const issueRcaCases = cases.filter(item => ['issue_rca', 'issue_rca_pilot'].includes(item.category));
    const pilotCases = issueRcaCases.filter(item => item.category === 'issue_rca_pilot');
    const invalidCases = issueRcaCases
        .map(item => ({ id: item.id, errors: validateEvalCaseProvenance(item) }))
        .filter(item => item.errors.length);
    return {
        passed: invalidCases.length === 0,
        issueRcaCases: issueRcaCases.length,
        issueRcaPilotCases: pilotCases.length,
        invalidIssueRcaCases: invalidCases.length,
        errors: invalidCases.slice(0, 20),
    };
}

export function assertDatasetGateEligibility(manifest, gateRequested) {
    if (!gateRequested) return;
    if (manifest.evaluationPolicy?.releaseGateEligible === false) {
        throw new Error(`Dataset ${manifest.dataset || 'unknown'} is marked non-gold and releaseGateEligible=false; it cannot be used with --gate`);
    }
}
