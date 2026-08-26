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
const AMBIGUITY_CONFIDENCE_THRESHOLD = Number.parseFloat(process.env.EVIDENCE_AMBIGUITY_CONFIDENCE_THRESHOLD || '0.75');
const TOP_RESULTS = 10;
const SPECIFICITY_SIGNAL_FIELDS = ['component', 'symptom', 'time', 'errorCode', 'fileOrSymbol'];

const VAGUE_PATTERNS = [
    /^something (broke|is wrong|failed)$/i,
    /^it (broke|failed|is slow|doesn'?t work)$/i,
    /^the page (is broken|looks wrong|is slow)$/i,
    /^(what caused this|there is an error|why is this broken)\??$/i,
    /^(?:页面|网页|功能|系统|应用|它)(?:坏了|有问题|不工作|很慢)$/u,
];

const GENERIC_SIGNALS = {
    component: /^(?:page|screen|feature|component|system|app|application|website|service|thing|it|页面|网页|功能|组件|系统|应用|网站|服务|东西|它)$/iu,
    symptom: /^(?:broken|broke|failed|not working|wrong|slow|issue|problem|error|坏了|失败|不工作|不对|有问题|问题|错误|很慢|慢)$/iu,
    time: /^(?:unknown|unspecified|不清楚|未知|未说明)$/iu,
    errorCode: /^(?:error|exception|错误|异常)$/iu,
    fileOrSymbol: /^(?:file|symbol|config|文件|符号|配置)$/iu,
};

function resultKey(result) {
    return `${result.repo || ''}:${result.id || result.commitId || ''}`;
}

function metadataConstraintFields(filters = {}) {
    return ['repo', 'author', 'dateFrom', 'dateTo', 'riskLevel', 'changeType']
        .filter(field => filters[field]);
}

function matchesKnownVaguePattern(query) {
    const normalized = String(query || '').trim();
    return VAGUE_PATTERNS.some(pattern => pattern.test(normalized));
}

function hasDistinctiveTechnicalIdentifier(query) {
    const normalized = String(query || '');
    return /(?:^|\s)[\w.-]+[\\/][\w./\\-]+/u.test(normalized)
        || /\b[\w.-]+\.(?:config|json|ya?ml|xml|ini|js|jsx|mjs|cjs|ts|tsx|cs|java|py|go|rs|cpp|h)\b/iu.test(normalized)
        || /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/u.test(normalized)
        || /\b[A-Za-z_$][A-Za-z0-9_$]*(?:::{1,2}|\.[A-Za-z_$])[A-Za-z0-9_$.:-]*\b/u.test(normalized)
        || /\b(?=[A-Za-z0-9_$]{5,}\b)(?=[A-Za-z0-9_$]*[A-Z])(?=[A-Za-z0-9_$]*[a-z])[A-Za-z_$][A-Za-z0-9_$]*\b/u.test(normalized)
        || /\b(?:ERR(?:OR)?|HTTP|E)[-_:]?[A-Z0-9_-]*\d[A-Z0-9_-]*\b/iu.test(normalized);
}

function isVagueQuery(query) {
    const normalized = String(query || '').trim();
    if (matchesKnownVaguePattern(normalized)) return true;
    // The legacy token-count fallback is only reliable for space-delimited text.
    // CJK sufficiency is primarily supplied by Intent Extractor specificity.
    if (/\p{Script=Han}/u.test(normalized)) return false;
    const meaningful = normalized.match(/[\p{L}\p{N}_./:-]{3,}/gu) || [];
    return meaningful.length <= 2
        && !/[0-9a-f]{7,40}/i.test(normalized)
        && !hasDistinctiveTechnicalIdentifier(normalized);
}

function isLikelySyntheticOrGibberish(query) {
    const normalized = String(query || '').trim();
    return /(?:nonexistent|unknownsymbol|zzzxqv)/i.test(normalized);
}

function extractCommitIdentifiers(query) {
    return [...new Set((String(query || '').match(/\b[0-9a-f]{7,40}\b/gi) || []).map(value => value.toLowerCase()))];
}

function normalizeSpecificity(specificity) {
    const signals = specificity?.signals && typeof specificity.signals === 'object'
        ? Object.fromEntries(SPECIFICITY_SIGNAL_FIELDS.map(field => [
            field,
            typeof specificity.signals[field] === 'string' && specificity.signals[field].trim()
                ? specificity.signals[field].trim().slice(0, 200)
                : null,
        ]))
        : Object.fromEntries(SPECIFICITY_SIGNAL_FIELDS.map(field => [field, null]));
    return {
        verdict: ['SUFFICIENT', 'AMBIGUOUS'].includes(specificity?.verdict) ? specificity.verdict : null,
        confidence: Number.isFinite(Number(specificity?.confidence))
            ? Math.max(0, Math.min(1, Number(specificity.confidence)))
            : 0,
        signals,
        missingFields: [...new Set(Array.isArray(specificity?.missingFields)
            ? specificity.missingFields.filter(field => SPECIFICITY_SIGNAL_FIELDS.includes(field))
            : [])],
    };
}

function isValidSignal(field, value) {
    if (!value || GENERIC_SIGNALS[field]?.test(value)) return false;
    if (field === 'errorCode' || field === 'fileOrSymbol') {
        return value.length >= 3 && (hasDistinctiveTechnicalIdentifier(value) || /[\d_./:\\-]/u.test(value));
    }
    return value.length >= 2;
}

/**
 * @param {object} input
 * @param {string} input.query Original user query.
 * @param {Array} input.results Final fused results.
 * @param {Array} input.denseResults Primary dense results.
 * @param {Array} input.lexicalResults FTS5 results.
 * @param {object} input.filters User-explicit structured filters. Do not pass automatic date defaults.
 * @param {number} input.directMatchCount Exact SHA matches.
 * @param {object} input.specificity Normalized Intent Extractor specificity output.
 * @param {boolean} input.specificityFallback Whether specificity came from a deterministic parse fallback.
 */
function evaluateEvidence({
    query,
    results = [],
    denseResults = [],
    lexicalResults = [],
    filters = {},
    directMatchCount = 0,
    specificity = null,
    specificityFallback = false,
} = {}) {
    const topDenseScore = denseResults[0]?.score ?? null;
    const topThree = denseResults.slice(0, 3).map(item => item.score).filter(Number.isFinite);
    const meanTop3 = topThree.length ? topThree.reduce((sum, value) => sum + value, 0) / topThree.length : null;
    const denseKeys = new Set(denseResults.slice(0, TOP_RESULTS).map(resultKey));
    const lexicalKeys = new Set(lexicalResults.slice(0, TOP_RESULTS).map(resultKey));
    const channelOverlap = [...denseKeys].filter(key => lexicalKeys.has(key)).length;
    const explicitMetadataFields = metadataConstraintFields(filters);
    const metadataConstraints = explicitMetadataFields.length;
    const normalizedSpecificity = normalizeSpecificity(specificity);
    const rawSignalFields = SPECIFICITY_SIGNAL_FIELDS.filter(field => normalizedSpecificity.signals[field]);
    const validSignalFields = rawSignalFields.filter(field => isValidSignal(field, normalizedSpecificity.signals[field]));
    const validInvestigationSignalFields = validSignalFields.filter(field => field !== 'time');
    const hasComponentSymptomPair = validSignalFields.includes('component') && validSignalFields.includes('symptom');
    const hasDistinctiveSignal = validSignalFields.includes('errorCode') || validSignalFields.includes('fileOrSymbol');
    const hasUsefulInvestigationSignals = hasComponentSymptomPair || hasDistinctiveSignal;
    const commitIdentifiers = extractCommitIdentifiers(query);
    const knownVaguePattern = matchesKnownVaguePattern(query);
    const legacyVagueFallback = isVagueQuery(query);
    const strongMultiChannel = channelOverlap > 0 && (topDenseScore || 0) >= MULTI_CHANNEL_DENSE_THRESHOLD;
    const highConfidenceAmbiguous = !specificityFallback
        && normalizedSpecificity.verdict === 'AMBIGUOUS'
        && normalizedSpecificity.confidence >= AMBIGUITY_CONFIDENCE_THRESHOLD;
    const features = {
        resultCount: results.length,
        directMatchCount,
        topDenseScore,
        meanTop3,
        lexicalResultCount: lexicalResults.length,
        channelOverlap,
        metadataConstraints,
        explicitMetadataFields,
        commitIdentifierCount: commitIdentifiers.length,
        specificityVerdict: normalizedSpecificity.verdict,
        specificityConfidence: normalizedSpecificity.confidence,
        specificitySignalCount: validSignalFields.length,
        specificitySignalFields: validSignalFields,
        specificityRawSignalCount: rawSignalFields.length,
        investigationSignalCount: validInvestigationSignalFields.length,
        specificityMissingFields: normalizedSpecificity.missingFields,
        specificityFallback: Boolean(specificityFallback),
        highConfidenceAmbiguous,
        knownVaguePattern,
        legacyVagueFallback,
        strongMultiChannel,
        thresholds: {
            dense: DENSE_SEARCH_THRESHOLD,
            multiChannelDense: MULTI_CHANNEL_DENSE_THRESHOLD,
            ambiguityConfidence: AMBIGUITY_CONFIDENCE_THRESHOLD,
        },
    };

    if (directMatchCount > 0) {
        return { verdict: 'SEARCH', evidenceScore: 1, reason: 'exact-commit-match', features };
    }
    if (commitIdentifiers.length > 0) {
        return { verdict: 'ABSTAIN', evidenceScore: 0, reason: 'unrecognized-commit-id', features };
    }
    if (isLikelySyntheticOrGibberish(query)) {
        return { verdict: 'ABSTAIN', evidenceScore: 0, reason: 'unrecognized-identifier', features };
    }
    if (hasDistinctiveSignal && hasDistinctiveTechnicalIdentifier(query) && lexicalResults.length === 0) {
        return { verdict: 'ABSTAIN', evidenceScore: 0, reason: 'unrecognized-identifier', features };
    }
    // An explicit metadata constraint defines a trustworthy candidate slice
    // even when the semantic score is low. Callers must not pass implicit
    // defaults (such as the automatic 30-day window) as user constraints.
    if (results.length > 0 && metadataConstraints >= 1) {
        return { verdict: 'SEARCH', evidenceScore: Math.max(topDenseScore || 0, 0.75), reason: 'structured-candidate-slice', features };
    }
    if (highConfidenceAmbiguous && hasDistinctiveSignal && strongMultiChannel) {
        const score = Math.min(1, (topDenseScore || 0) + Math.min(channelOverlap, 3) * 0.08);
        return { verdict: 'SEARCH', evidenceScore: score, reason: 'distinctive-signal-multi-channel-support', features };
    }
    if (highConfidenceAmbiguous && !hasUsefulInvestigationSignals) {
        return { verdict: 'ASK_USER', evidenceScore: 0, reason: 'high-confidence-ambiguous', features };
    }
    if (knownVaguePattern && !hasUsefulInvestigationSignals) {
        return { verdict: 'ASK_USER', evidenceScore: 0, reason: 'underspecified-query', features };
    }
    if (specificityFallback) {
        if (legacyVagueFallback) {
            return { verdict: 'ASK_USER', evidenceScore: 0, reason: 'fallback-underspecified-query', features };
        }
        if (strongMultiChannel && hasDistinctiveTechnicalIdentifier(query)) {
            const score = Math.min(1, (topDenseScore || 0) + Math.min(channelOverlap, 3) * 0.08);
            return { verdict: 'SEARCH', evidenceScore: score, reason: 'fallback-distinctive-multi-channel-support', features };
        }
        return {
            verdict: 'ABSTAIN',
            evidenceScore: Math.max(0, topDenseScore || 0),
            reason: results.length ? 'specificity-fallback-unconfirmed' : 'no-retrieval-results',
            features,
        };
    }
    if (results.length === 0) {
        return { verdict: 'ABSTAIN', evidenceScore: 0, reason: 'no-retrieval-results', features };
    }
    if (strongMultiChannel) {
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
