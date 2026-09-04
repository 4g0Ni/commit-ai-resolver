import { evaluateEvidence } from './evidence-gate.js';
import { fuseRankedResults } from './rank-fusion.js';
import { getRankFusionConfig } from './retrieval-config.js';

const DEFAULT_RESULT_LIMIT = 12;
const MAX_RESULT_LIMIT = 30;
const MAX_DATE_RANGE_DAYS = 180;
const DEFAULT_INCIDENT_DAYS = 7;
const DEFAULT_GENERAL_DAYS = 30;
const VECTOR_MIN_SCORE = Number.parseFloat(process.env.VECTOR_MIN_SCORE || '0');

function daysBefore(n, referenceDate) {
    const date = new Date(`${referenceDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - n);
    return date.toISOString().slice(0, 10);
}

function isIncidentQuery(query) {
    return /\b(spike|broke|break|error|crash|regression|outage|down|incident|live.?site|production.?issue|root cause|why)\b/iu.test(String(query || ''))
        || /(?:故障|事故|回归|崩溃|报错|根因|为什么|线上问题)/u.test(String(query || ''));
}

function extractCommitIds(query) {
    return [...new Set((String(query || '').match(/\b[0-9a-f]{7,40}\b/giu) || [])
        .map(value => value.toLowerCase()))];
}

function normalizeLimit(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_RESULT_LIMIT;
    return Math.max(1, Math.min(MAX_RESULT_LIMIT, parsed));
}

function candidateKey(result) {
    return `${result.repo}:${result.id || result.commitId}`;
}

/**
 * Create the shared deterministic commit-search data plane used by agents.
 *
 * @param {object} dependencies
 * @param {Function} dependencies.embedQuery
 * @param {Function} dependencies.searchVectors
 * @param {Function} dependencies.searchLexical
 * @param {Function} dependencies.lookupByCommitIds
 * @param {Function} dependencies.getVectorStats
 */
export function createCommitSearchService({
    embedQuery,
    searchVectors,
    searchLexical,
    lookupByCommitIds,
    getVectorStats,
}) {
    if (typeof embedQuery !== 'function' || typeof searchVectors !== 'function') {
        throw new Error('commit search requires embedQuery and searchVectors');
    }

    const fusion = getRankFusionConfig();

    /** Return the indexed repositories and date coverage. */
    async function getIndexStats() {
        if (typeof getVectorStats !== 'function') {
            return { totalCommits: null, repos: [], dateRange: null };
        }
        return getVectorStats();
    }

    /**
     * Search commits using dense, lexical, secondary-query, and exact-ID channels.
     * The method applies the existing deterministic evidence gate before results
     * become usable by an LLM agent.
     */
    async function search({
        query,
        semanticQuery,
        secondaryQuery = null,
        repo = null,
        author = null,
        dateFrom = null,
        dateTo = null,
        riskLevel = null,
        changeType = null,
        topK = DEFAULT_RESULT_LIMIT,
        specificity = null,
        specificityFallback = false,
    }) {
        const originalQuery = String(query || '').trim();
        const primaryQuery = String(semanticQuery || originalQuery).trim();
        if (!primaryQuery) throw new Error('semanticQuery or query is required');

        const stats = await getIndexStats();
        const referenceDate = stats?.dateRange?.to || new Date().toISOString().slice(0, 10);
        const requestedLimit = normalizeLimit(topK);
        const searchTopK = Math.max(requestedLimit, 30);
        const explicitFilters = {
            repo: repo || undefined,
            author: author || undefined,
            dateFrom: dateFrom || undefined,
            dateTo: dateTo || undefined,
            riskLevel: riskLevel || undefined,
            changeType: changeType || undefined,
        };

        let effectiveDateFrom = dateFrom || daysBefore(
            isIncidentQuery(`${originalQuery} ${primaryQuery}`) ? DEFAULT_INCIDENT_DAYS : DEFAULT_GENERAL_DAYS,
            referenceDate,
        );
        const effectiveDateTo = dateTo || referenceDate;
        const sixMonthsAgo = daysBefore(MAX_DATE_RANGE_DAYS, referenceDate);
        if (effectiveDateFrom < sixMonthsAgo) effectiveDateFrom = sixMonthsAgo;

        const commonSearchOptions = {
            topK: searchTopK,
            minScore: VECTOR_MIN_SCORE,
            repo: repo || undefined,
            author: author || undefined,
            dateFrom: effectiveDateFrom,
            dateTo: effectiveDateTo,
            riskLevel: riskLevel || undefined,
            changeType: changeType || undefined,
        };
        const broadSearchOptions = {
            topK: searchTopK,
            minScore: VECTOR_MIN_SCORE,
            repo: commonSearchOptions.repo,
            author: commonSearchOptions.author,
            dateFrom: commonSearchOptions.dateFrom,
            dateTo: commonSearchOptions.dateTo,
        };

        const embeddingStartedAt = Date.now();
        const [primaryEmbedding, secondaryEmbedding] = await Promise.all([
            embedQuery(primaryQuery),
            secondaryQuery ? embedQuery(String(secondaryQuery)) : Promise.resolve(null),
        ]);
        const embeddingMs = Date.now() - embeddingStartedAt;

        const searchStartedAt = Date.now();
        const [denseResults, lexicalResults, secondaryResults] = await Promise.all([
            searchVectors(primaryEmbedding, commonSearchOptions),
            typeof searchLexical === 'function'
                ? searchLexical(`${originalQuery}\n${primaryQuery}`, { ...commonSearchOptions, minScore: 0 })
                : Promise.resolve([]),
            secondaryEmbedding
                ? searchVectors(secondaryEmbedding, broadSearchOptions)
                : Promise.resolve([]),
        ]);
        const searchMs = Date.now() - searchStartedAt;

        let results = fuseRankedResults([
            { results: denseResults, weight: fusion.denseWeight, channel: 'dense-primary' },
            { results: lexicalResults, weight: fusion.lexicalWeight, channel: 'lexical' },
            { results: secondaryResults, weight: fusion.secondaryWeight, channel: 'dense-secondary' },
        ], { k: fusion.k });

        const commitIds = extractCommitIds(originalQuery);
        let directMatches = [];
        if (commitIds.length > 0 && typeof lookupByCommitIds === 'function') {
            directMatches = await lookupByCommitIds(commitIds);
            const existingKeys = new Set(results.map(candidateKey));
            results = [
                ...directMatches.filter(result => !existingKeys.has(candidateKey(result))),
                ...results,
            ];
        }

        const evidenceGate = evaluateEvidence({
            query: originalQuery,
            results,
            denseResults,
            lexicalResults,
            filters: explicitFilters,
            directMatchCount: directMatches.length,
            specificity,
            specificityFallback,
        });

        return {
            query: originalQuery,
            semanticQuery: primaryQuery,
            secondaryQuery: secondaryQuery || null,
            results: results.slice(0, requestedLimit),
            totalResultCount: results.length,
            directMatchCount: directMatches.length,
            evidenceGate,
            referenceDate,
            filters: {
                ...explicitFilters,
                effectiveDateFrom,
                effectiveDateTo,
            },
            timings: { embeddingMs, searchMs },
        };
    }

    /** Resolve exact commit identifiers without semantic search. */
    async function lookup(commitIds) {
        if (typeof lookupByCommitIds !== 'function') return [];
        return lookupByCommitIds(commitIds);
    }

    return { getIndexStats, search, lookup };
}

