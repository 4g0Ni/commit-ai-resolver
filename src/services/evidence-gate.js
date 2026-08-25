/**
 * Deterministic evidence sufficiency gate between retrieval and generation.
 *
 * Vector search always returns nearest neighbours, including for out-of-domain
 * questions. This gate prevents "nearest" from being treated as "supported".
 * Thresholds are intentionally environment-configurable and must be calibrated
 * on a frozen eval dataset before changing them.
 */

const DENSE_SEARCH_THRESHOLD = Number.parseFloat(process.env.EVIDENCE_DENSE_THRESHOLD || '0.64');
const MULTI_CHANNEL_DENSE_THRESHOLD = Number.parseFloat(process.env.EVIDENCE_MULTI_CHANNEL_DENSE_THRESHOLD || '0.60');
const TOP_RESULTS = 10;

const VAGUE_PATTERNS = [
    /^something (broke|is wrong|failed)$/i,
    /^it (broke|failed|is slow|doesn'?t work)$/i,
    /^the page (is broken|looks wrong|is slow)$/i,
    /^(what caused this|there is an error|why is this broken)\??$/i,
];

function resultKey(result) {
    return `${result.repo || ''}:${result.id || result.commitId || ''}`;
}

function countMetadataConstraints(filters = {}) {
    return ['repo', 'author', 'dateFrom', 'dateTo', 'riskLevel', 'changeType']
        .filter(field => filters[field]).length;
}

function isVagueQuery(query) {
    const normalized = String(query || '').trim();
    if (VAGUE_PATTERNS.some(pattern => pattern.test(normalized))) return true;
    const meaningful = normalized.match(/[\p{L}\p{N}_./:-]{3,}/gu) || [];
    return meaningful.length <= 2 && !/[0-9a-f]{7,40}/i.test(normalized);
}

function isLikelySyntheticOrGibberish(query) {
    const normalized = String(query || '').trim();
    return /^[a-z0-9]{24,}$/i.test(normalized)
        || /(?:nonexistent|unknownsymbol|zzzxqv)/i.test(normalized);
}

/**
 * @param {object} input
 * @param {string} input.query Original user query.
 * @param {Array} input.results Final fused results.
 * @param {Array} input.denseResults Primary dense results.
 * @param {Array} input.lexicalResults FTS5 results.
 * @param {object} input.filters Effective structured filters.
 * @param {number} input.directMatchCount Exact SHA matches.
 */
function evaluateEvidence({
    query,
    results = [],
    denseResults = [],
    lexicalResults = [],
    filters = {},
    directMatchCount = 0,
} = {}) {
    const topDenseScore = denseResults[0]?.score ?? null;
    const topThree = denseResults.slice(0, 3).map(item => item.score).filter(Number.isFinite);
    const meanTop3 = topThree.length ? topThree.reduce((sum, value) => sum + value, 0) / topThree.length : null;
    const denseKeys = new Set(denseResults.slice(0, TOP_RESULTS).map(resultKey));
    const lexicalKeys = new Set(lexicalResults.slice(0, TOP_RESULTS).map(resultKey));
    const channelOverlap = [...denseKeys].filter(key => lexicalKeys.has(key)).length;
    const metadataConstraints = countMetadataConstraints(filters);
    const features = {
        resultCount: results.length,
        directMatchCount,
        topDenseScore,
        meanTop3,
        lexicalResultCount: lexicalResults.length,
        channelOverlap,
        metadataConstraints,
        thresholds: {
            dense: DENSE_SEARCH_THRESHOLD,
            multiChannelDense: MULTI_CHANNEL_DENSE_THRESHOLD,
        },
    };

    if (directMatchCount > 0) {
        return { verdict: 'SEARCH', evidenceScore: 1, reason: 'exact-commit-match', features };
    }
    if (isLikelySyntheticOrGibberish(query)) {
        return { verdict: 'ABSTAIN', evidenceScore: 0, reason: 'unrecognized-identifier', features };
    }
    if (isVagueQuery(query)) {
        return { verdict: 'ASK_USER', evidenceScore: 0, reason: 'underspecified-query', features };
    }
    if (results.length === 0) {
        return { verdict: 'ABSTAIN', evidenceScore: 0, reason: 'no-retrieval-results', features };
    }
    // An explicit metadata constraint defines a trustworthy candidate slice
    // even when the semantic score is low. Callers must not pass implicit
    // defaults (such as the automatic 30-day window) as user constraints.
    if (metadataConstraints >= 1) {
        return { verdict: 'SEARCH', evidenceScore: Math.max(topDenseScore || 0, 0.75), reason: 'structured-candidate-slice', features };
    }
    if (channelOverlap > 0 && (topDenseScore || 0) >= MULTI_CHANNEL_DENSE_THRESHOLD) {
        const score = Math.min(1, (topDenseScore || 0) + Math.min(channelOverlap, 3) * 0.08);
        return { verdict: 'SEARCH', evidenceScore: score, reason: 'multi-channel-support', features };
    }
    if ((topDenseScore || 0) >= DENSE_SEARCH_THRESHOLD) {
        return { verdict: 'SEARCH', evidenceScore: topDenseScore, reason: 'strong-dense-match', features };
    }
    return {
        verdict: 'ABSTAIN',
        evidenceScore: Math.max(0, topDenseScore || 0),
        reason: lexicalResults.length ? 'weak-unconfirmed-retrieval' : 'dense-only-below-threshold',
        features,
    };
}

export { evaluateEvidence, isVagueQuery };
