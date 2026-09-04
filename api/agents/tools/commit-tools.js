import { tool } from '@openai/agents';
import { z } from 'zod';

function normalizeProviderNull(value) {
    return typeof value === 'string' && /^(?:null|none|n\/a)?$/iu.test(value.trim())
        ? null
        : value;
}

const nullableText = (max = 300) => z.preprocess(
    normalizeProviderNull,
    z.string().max(max).nullable(),
);
const nullableDate = z.preprocess(
    normalizeProviderNull,
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
);
const nullableEnum = values => z.preprocess(
    normalizeProviderNull,
    z.enum(values).nullable(),
);

export const SEARCH_PARAMETERS = z.object({
    semanticQuery: z.string().min(1).max(500),
    secondaryQuery: nullableText(500),
    repo: nullableText(100),
    author: nullableText(200),
    dateFrom: nullableDate,
    dateTo: nullableDate,
    riskLevel: nullableEnum(['HIGH', 'MEDIUM', 'LOW']),
    changeType: nullableEnum(['config', 'code', 'mixed']),
    topK: z.coerce.number().int().min(1).max(20),
});

function getState(runContext) {
    const state = runContext?.context;
    if (!state?.services) throw new Error('Agent tool is missing service dependencies.');
    return state;
}

function presentCandidate(candidate) {
    return {
        candidateKey: candidate.candidateKey || `${candidate.repo}:${candidate.id || candidate.commitId}`,
        shortId: candidate.id || candidate.shortId,
        commitId: candidate.commitId,
        repo: candidate.repo,
        date: candidate.date,
        author: candidate.author || candidate.metadata?.author || null,
        title: candidate.metadata?.title || candidate.title || null,
        summary: candidate.metadata?.summary || candidate.summary || null,
        riskLevel: candidate.metadata?.riskLevel || candidate.riskLevel || null,
        changeType: candidate.metadata?.changeType || candidate.changeType || null,
        url: candidate.metadata?.url || candidate.url || null,
        score: Number.isFinite(candidate.score) ? Number(candidate.score.toFixed(4)) : null,
        channels: candidate._retrievalChannels || candidate.channels || [],
    };
}

async function executeSearch(input, runContext, source) {
    const state = getState(runContext);
    const inherited = source === 'evidence-critic' ? state.primaryRetrievalFilters : null;
    const effectiveInput = inherited ? {
        ...input,
        repo: inherited.repo ?? input.repo,
        author: inherited.author ?? input.author,
        dateFrom: inherited.dateFrom ?? input.dateFrom,
        dateTo: inherited.dateTo ?? input.dateTo,
    } : input;
    const result = await state.services.commitSearch.search({
        query: state.query,
        ...effectiveInput,
    });
    if (source === 'retrieval-agent' && !state.primaryRetrievalFilters) {
        state.primaryRetrievalFilters = {
            repo: result.filters.repo || null,
            author: result.filters.author || null,
            dateFrom: result.filters.effectiveDateFrom || result.filters.dateFrom || null,
            dateTo: result.filters.effectiveDateTo || result.filters.dateTo || null,
        };
    }
    state.candidates.addAll(result.results, source, { evidenceVerdict: result.evidenceGate.verdict });
    state.lastEvidenceGate = result.evidenceGate;
    state.evidenceGates = [
        ...(state.evidenceGates || []),
        { source, ...result.evidenceGate },
    ];
    state.searchAttempts = [
        ...(state.searchAttempts || []),
        {
            source,
            semanticQuery: effectiveInput.semanticQuery,
            candidateKeys: result.results.map(candidate => `${candidate.repo}:${candidate.id || candidate.commitId}`),
            evidenceGate: result.evidenceGate,
        },
    ];
    return {
        ok: true,
        evidenceGate: result.evidenceGate,
        resultCount: result.totalResultCount,
        returnedCount: result.results.length,
        filters: result.filters,
        timings: result.timings,
        candidates: result.results.map(presentCandidate),
    };
}

/** Build the deterministic data tools used by the specialist agents. */
export function createCommitTools() {
    const getIndexStats = tool({
        name: 'get_index_stats',
        description: 'Return indexed repositories, commit count, and indexed date coverage. Use this before inventing repository names or dates.',
        parameters: z.object({ reason: z.string().min(1).max(200) }),
        async execute(_input, runContext) {
            const state = getState(runContext);
            return { ok: true, stats: await state.services.commitSearch.getIndexStats() };
        },
    });

    const searchCommits = tool({
        name: 'search_commits',
        description: 'Hybrid-search indexed commits. You choose the semantic query and explicit filters. Results are evidence-gated and added to the candidate ledger.',
        parameters: SEARCH_PARAMETERS,
        async execute(input, runContext) {
            return executeSearch(input, runContext, 'retrieval-agent');
        },
    });

    const lookupCommits = tool({
        name: 'lookup_commits',
        description: 'Resolve exact commit SHAs or short IDs supplied by the user. Only use identifiers present in the user request or conversation.',
        parameters: z.object({ commitIds: z.array(z.string().regex(/^[0-9a-f]{7,40}$/i)).min(1).max(8) }),
        async execute(input, runContext) {
            const state = getState(runContext);
            const results = await state.services.commitSearch.lookup(input.commitIds);
            state.lastEvidenceGate = results.length > 0
                ? { verdict: 'SEARCH', evidenceScore: 1, reason: 'exact-commit-match' }
                : { verdict: 'ABSTAIN', evidenceScore: 0, reason: 'unrecognized-commit-id' };
            state.evidenceGates = [
                ...(state.evidenceGates || []),
                { source: 'exact-lookup', ...state.lastEvidenceGate },
            ];
            state.candidates.addAll(results, 'exact-lookup', { evidenceVerdict: state.lastEvidenceGate.verdict });
            return { ok: true, candidates: results.map(presentCandidate) };
        },
    });

    const getCommitDiff = tool({
        name: 'get_commit_diff',
        description: 'Fetch a source diff for one candidate already present in the candidate ledger. Never accepts an ungrounded commit.',
        parameters: z.object({
            candidateKey: z.string().min(3).max(200),
            reason: z.string().min(1).max(300),
        }),
        async execute(input, runContext) {
            const state = getState(runContext);
            const candidate = state.candidates.resolve(input.candidateKey);
            if (!candidate) throw new Error(`Candidate not found: ${input.candidateKey}`);
            const evidence = await state.services.commitDiff.getCommitDiff({
                repo: candidate.repo,
                commitId: candidate.commitId,
            });
            state.candidates.attachDiff(candidate.candidateKey, {
                ...evidence,
                reason: input.reason,
            });
            return {
                ok: evidence.available && !evidence.error,
                candidate: presentCandidate(candidate),
                evidence,
            };
        },
    });

    const getEvidenceSnapshot = tool({
        name: 'get_evidence_snapshot',
        description: 'Read the request-local candidate and diff-evidence ledger. It contains only results produced by authorized tools in this run.',
        parameters: z.object({
            includeDiffs: z.boolean(),
            limit: z.number().int().min(1).max(20),
        }),
        async execute(input, runContext) {
            const state = getState(runContext);
            const candidates = state.candidates.list({ limit: input.limit, includeDiff: input.includeDiffs })
                .map(candidate => {
                    if (!candidate.diffEvidence) return candidate;
                    return {
                        ...candidate,
                        diffEvidence: {
                            ...candidate.diffEvidence,
                            diff: String(candidate.diffEvidence.diff || '').slice(0, 6_000),
                        },
                    };
                });
            return {
                ok: true,
                candidates,
                hypotheses: state.hypotheses.slice(-8),
                lastEvidenceGate: state.lastEvidenceGate || null,
            };
        },
    });

    const searchCounterEvidence = tool({
        name: 'search_counter_evidence',
        description: 'Search for alternative commits or counter-evidence using terms that differ from the initial retrieval query.',
        parameters: SEARCH_PARAMETERS,
        async execute(input, runContext) {
            return executeSearch(input, runContext, 'evidence-critic');
        },
    });

    return {
        getIndexStats,
        searchCommits,
        lookupCommits,
        getCommitDiff,
        getEvidenceSnapshot,
        searchCounterEvidence,
    };
}
