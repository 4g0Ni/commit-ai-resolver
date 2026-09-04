/**
 * Evidence gate for Issue-grounded RCA retrieval.
 *
 * This contract is intentionally separate from evidence-gate.js. The legacy
 * gate serves generic text-only search and uses calibrated Dense/Lexical
 * thresholds. Issue RCA uses a lifecycle window, four retrieval channels, and
 * a local LTR score whose distribution is not a calibrated probability.
 * Retrieval evidence can therefore request verification, but cannot directly
 * authorize answer synthesis.
 */

const ISSUE_RCA_GATE_VERSION = 'issue-rca-v2-shadow';
const ISSUE_WINDOW_SOURCE = 'issue-lifecycle';
const BEFORE_CREATED_DAYS = 7;
const AFTER_CLOSED_DAYS = 30;
const RETRIEVAL_CHANNELS = ['rawDense', 'rawLexical', 'compactDense', 'compactLexical'];
const VERIFICATION_STATUSES = new Set(['SUPPORTED', 'INSUFFICIENT', 'UNAVAILABLE']);

function parseInstant(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const instant = new Date(value);
    return Number.isNaN(instant.getTime()) ? null : instant;
}

function utcDateWithOffset(instant, days) {
    const shifted = new Date(instant);
    shifted.setUTCDate(shifted.getUTCDate() + days);
    return shifted.toISOString().slice(0, 10);
}

/**
 * Derive the dev-selected lifecycle window for a closed Issue.
 *
 * @param {object} issue Issue lifecycle metadata.
 * @param {string} issue.createdAt ISO creation timestamp.
 * @param {string} issue.closedAt ISO close timestamp.
 * @returns {object} Validated window or a machine-readable failure reason.
 */
export function deriveIssueRcaWindow(issue = {}) {
    const createdAt = parseInstant(issue.createdAt);
    const closedAt = parseInstant(issue.closedAt);
    if (!createdAt) return { valid: false, reason: 'missing-or-invalid-created-at' };
    if (!closedAt) return { valid: false, reason: 'open-or-invalid-closed-at' };
    if (closedAt < createdAt) return { valid: false, reason: 'closed-before-created' };
    return {
        valid: true,
        source: ISSUE_WINDOW_SOURCE,
        dateFrom: utcDateWithOffset(createdAt, -BEFORE_CREATED_DAYS),
        dateTo: utcDateWithOffset(closedAt, AFTER_CLOSED_DAYS),
        beforeCreatedDays: BEFORE_CREATED_DAYS,
        afterClosedDays: AFTER_CLOSED_DAYS,
        issueLifetimeDays: Math.ceil((closedAt - createdAt) / 86_400_000),
    };
}

function candidateKeys(result = {}) {
    const keys = new Set();
    for (const value of [result.id, result.commitId]) {
        if (!value) continue;
        const normalized = String(value).toLowerCase();
        keys.add(normalized);
        if (result.repo) keys.add(`${result.repo}:${normalized}`.toLowerCase());
    }
    return keys;
}

function resultScore(result = {}) {
    for (const value of [result.ltrScore, result.learnedRerankerScore, result.score]) {
        if (value !== null && value !== undefined && Number.isFinite(Number(value))) return Number(value);
    }
    return null;
}

function sourceRanks(result = {}) {
    const ranks = result.sourceRanks || result.ranks || {};
    return Object.fromEntries(RETRIEVAL_CHANNELS
        .filter(channel => Number.isFinite(Number(ranks[channel])) && Number(ranks[channel]) > 0)
        .map(channel => [channel, Number(ranks[channel])]));
}

function summarizeRetrieval(results) {
    const top = results[0] || null;
    const topRanks = sourceRanks(top || {});
    const topScore = top ? resultScore(top) : null;
    const secondScore = results[1] ? resultScore(results[1]) : null;
    const topTwenty = results.slice(0, 20);
    const channelCounts = topTwenty.map(result => Object.keys(sourceRanks(result)).length);
    return {
        resultCount: results.length,
        topScore,
        secondScore,
        scoreMargin: topScore !== null && secondScore !== null ? topScore - secondScore : null,
        scoreCalibratedAsProbability: false,
        topChannelCount: Object.keys(topRanks).length,
        topChannels: Object.keys(topRanks),
        topDenseConsensus: 'rawDense' in topRanks && 'compactDense' in topRanks,
        topLexicalConsensus: 'rawLexical' in topRanks && 'compactLexical' in topRanks,
        fourChannelCandidatesAt20: channelCounts.filter(count => count === RETRIEVAL_CHANNELS.length).length,
        multiChannelCandidatesAt20: channelCounts.filter(count => count >= 2).length,
    };
}

function normalizeWindow(window = {}) {
    return {
        source: typeof window.source === 'string' ? window.source : null,
        dateFrom: typeof window.dateFrom === 'string' ? window.dateFrom.slice(0, 10) : null,
        dateTo: typeof window.dateTo === 'string' ? window.dateTo.slice(0, 10) : null,
    };
}

function summarizeVerification(verification) {
    const status = typeof verification?.status === 'string'
        ? verification.status.toUpperCase()
        : null;
    const supportingCandidateIds = [...new Set(Array.isArray(verification?.supportingCandidateIds)
        ? verification.supportingCandidateIds.filter(Boolean).map(value => String(value).toLowerCase())
        : [])];
    const evidenceTypes = [...new Set(Array.isArray(verification?.evidenceTypes)
        ? verification.evidenceTypes.filter(Boolean).map(value => String(value))
        : [])];
    const confidence = Number.isFinite(Number(verification?.confidence))
        ? Math.max(0, Math.min(1, Number(verification.confidence)))
        : null;
    return { status, supportingCandidateIds, evidenceTypes, confidence };
}

function response(verdict, reason, features, evidenceScore = 0) {
    return {
        gateVersion: ISSUE_RCA_GATE_VERSION,
        verdict,
        reason,
        evidenceScore,
        features,
    };
}

/**
 * Evaluate evidence for the Issue RCA path.
 *
 * Verdict semantics differ deliberately from the legacy gate:
 * - VERIFY: retrieval produced candidates, but causal verification is required.
 * - SEARCH: verified evidence may be sent to the answer synthesizer.
 * - ABSTAIN: no support is available after retrieval or verification.
 * - ASK_USER: required Issue/query context is missing.
 *
 * @param {object} input
 * @param {string} input.query Full Issue-grounded query text.
 * @param {object} input.issue Issue metadata containing createdAt and closedAt.
 * @param {object} input.retrievalWindow Applied retrieval window and provenance.
 * @param {Array} input.results LTR-ranked candidates.
 * @param {object|null} input.verification Optional downstream diff/relationship result.
 * @returns {object} Versioned gate decision and diagnostic features.
 */
export function evaluateIssueRcaEvidence({
    query,
    issue = {},
    retrievalWindow = {},
    results = [],
    verification = null,
} = {}) {
    const rankedResults = Array.isArray(results) ? results : [];
    const lifecycle = deriveIssueRcaWindow(issue);
    const appliedWindow = normalizeWindow(retrievalWindow);
    const retrieval = summarizeRetrieval(rankedResults);
    const verified = summarizeVerification(verification);
    const features = {
        mode: 'issue-rca',
        lifecycle,
        retrievalWindow: appliedWindow,
        retrieval,
        verification: verified,
    };

    if (typeof query !== 'string' || !query.trim()) {
        return response('ASK_USER', 'missing-issue-query', features);
    }
    if (!lifecycle.valid) {
        const verdict = lifecycle.reason === 'open-or-invalid-closed-at' ? 'ABSTAIN' : 'ASK_USER';
        return response(verdict, lifecycle.reason, features);
    }
    if (appliedWindow.source !== ISSUE_WINDOW_SOURCE) {
        return response('ABSTAIN', 'untrusted-window-provenance', features);
    }
    if (appliedWindow.dateFrom !== lifecycle.dateFrom || appliedWindow.dateTo !== lifecycle.dateTo) {
        return response('ABSTAIN', 'issue-window-mismatch', features);
    }
    if (retrieval.resultCount === 0) {
        return response('ABSTAIN', 'no-retrieval-results', features);
    }

    // A high LTR score or lifecycle-constrained slice is retrieval evidence,
    // not proof that a candidate caused or fixed the reported behavior.
    if (verification === null || verification === undefined) {
        return response('VERIFY', 'candidate-verification-required', features);
    }
    if (!VERIFICATION_STATUSES.has(verified.status)) {
        return response('ABSTAIN', 'invalid-verification-status', features);
    }
    if (verified.status !== 'SUPPORTED') {
        return response('ABSTAIN', verified.status === 'UNAVAILABLE'
            ? 'causal-verification-unavailable'
            : 'causal-evidence-insufficient', features);
    }
    if (verified.supportingCandidateIds.length === 0 || verified.evidenceTypes.length === 0) {
        return response('ABSTAIN', 'incomplete-causal-verification', features);
    }

    const retrievedKeys = new Set(rankedResults.flatMap(candidate => [...candidateKeys(candidate)]));
    const hasRetrievedSupport = verified.supportingCandidateIds.some(key => retrievedKeys.has(key));
    if (!hasRetrievedSupport) {
        return response('ABSTAIN', 'verification-candidate-not-retrieved', features);
    }
    return response(
        'SEARCH',
        'causal-evidence-supported',
        features,
        verified.confidence ?? 1,
    );
}

export const ISSUE_RCA_EVIDENCE_POLICY = Object.freeze({
    version: ISSUE_RCA_GATE_VERSION,
    windowSource: ISSUE_WINDOW_SOURCE,
    beforeCreatedDays: BEFORE_CREATED_DAYS,
    afterClosedDays: AFTER_CLOSED_DAYS,
    retrievalChannels: [...RETRIEVAL_CHANNELS],
    ltrScoreIsCalibratedProbability: false,
    releaseGateEligible: false,
});
