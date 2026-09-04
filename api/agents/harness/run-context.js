import { randomUUID } from 'crypto';
import { BudgetManager } from './budget-manager.js';
import { TrajectoryRecorder } from './trajectory-recorder.js';

function keyForCandidate(candidate) {
    return `${candidate.repo}:${candidate.id || candidate.shortId || candidate.commitId}`;
}

function publicCandidate(candidate) {
    return {
        candidateKey: candidate.candidateKey,
        commitId: candidate.commitId,
        shortId: candidate.id || candidate.shortId,
        repo: candidate.repo,
        date: candidate.date,
        author: candidate.author || candidate.metadata?.author || null,
        title: candidate.metadata?.title || candidate.title || null,
        summary: candidate.metadata?.summary || candidate.summary || null,
        riskLevel: candidate.metadata?.riskLevel || candidate.riskLevel || null,
        changeType: candidate.metadata?.changeType || candidate.changeType || null,
        url: candidate.metadata?.url || candidate.url || null,
        score: Number.isFinite(candidate.score) ? candidate.score : null,
        rrfScore: Number.isFinite(candidate._rrfScore) ? candidate._rrfScore : null,
        channels: candidate._retrievalChannels || candidate.channels || [],
        evidenceAuthorized: Boolean(candidate._evidenceAuthorized),
    };
}

/** Request-local ledger of candidates that tools have actually returned. */
export class CandidateLedger {
    constructor() {
        this.candidates = new Map();
        this.order = [];
        this.diffEvidence = new Map();
    }

    addAll(candidates, source = 'unknown', { evidenceVerdict = null } = {}) {
        for (const rawCandidate of candidates || []) {
            if (!rawCandidate?.repo || !(rawCandidate.id || rawCandidate.shortId || rawCandidate.commitId)) continue;
            const candidateKey = keyForCandidate(rawCandidate);
            const existing = this.candidates.get(candidateKey);
            const candidate = {
                ...(existing || {}),
                ...rawCandidate,
                candidateKey,
                _sources: [...new Set([...(existing?._sources || []), source])],
                _evidenceAuthorized: Boolean(existing?._evidenceAuthorized || evidenceVerdict === 'SEARCH'),
            };
            this.candidates.set(candidateKey, candidate);
            if (!existing) this.order.push(candidateKey);
        }
    }

    resolve(reference) {
        const normalized = String(reference || '').trim().toLowerCase();
        if (!normalized) return null;
        const direct = [...this.candidates.entries()]
            .find(([key]) => key.toLowerCase() === normalized)?.[1];
        if (direct) return direct;

        const matches = [...this.candidates.values()].filter(candidate => [
            candidate.id,
            candidate.shortId,
            candidate.commitId,
        ].some(value => String(value || '').toLowerCase() === normalized));
        return matches.length === 1 ? matches[0] : null;
    }

    has(reference) {
        return Boolean(this.resolve(reference));
    }

    hasAuthorized(reference) {
        return Boolean(this.resolve(reference)?._evidenceAuthorized);
    }

    attachDiff(reference, diffEvidence) {
        const candidate = this.resolve(reference);
        if (!candidate) return false;
        this.diffEvidence.set(candidate.candidateKey, { ...diffEvidence });
        return true;
    }

    getDiff(reference) {
        const candidate = this.resolve(reference);
        return candidate ? this.diffEvidence.get(candidate.candidateKey) || null : null;
    }

    list({ limit = 20, includeDiff = false, authorizedOnly = false } = {}) {
        const keys = authorizedOnly
            ? this.order.filter(key => this.candidates.get(key)?._evidenceAuthorized)
            : this.order;
        return keys.slice(0, limit).map(key => {
            const candidate = publicCandidate(this.candidates.get(key));
            if (!includeDiff) return candidate;
            const evidence = this.diffEvidence.get(key);
            return evidence ? { ...candidate, diffEvidence: evidence } : candidate;
        });
    }

    toSuspects(preferredKeys = [], limit = 10) {
        const preferred = preferredKeys
            .map(reference => {
                const candidate = this.resolve(reference);
                return candidate?._evidenceAuthorized ? candidate.candidateKey : null;
            })
            .filter(Boolean);
        const authorizedOrder = this.order.filter(key => this.candidates.get(key)?._evidenceAuthorized);
        const orderedKeys = [...new Set([...preferred, ...authorizedOrder])].slice(0, limit);
        return orderedKeys.map(key => {
            const candidate = this.candidates.get(key);
            return {
                commitId: candidate.commitId,
                shortId: candidate.id || candidate.shortId,
                repo: candidate.repo,
                date: candidate.date,
                author: candidate.author || candidate.metadata?.author,
                title: candidate.metadata?.title || candidate.title,
                summary: candidate.metadata?.summary || candidate.summary,
                riskLevel: candidate.metadata?.riskLevel || candidate.riskLevel,
                url: candidate.metadata?.url || candidate.url,
                score: candidate.score,
            };
        });
    }
}

/** Create all mutable state owned by one multi-agent request. */
export function createAgentRunContext({
    runId = randomUUID(),
    query,
    history = [],
    workItemContext = null,
    services,
    budgets,
    onProgress,
    signal,
}) {
    const trajectory = new TrajectoryRecorder({ runId, onProgress });
    return {
        runId,
        query: String(query || ''),
        history: history.slice(-6).map(item => ({
            role: item.role,
            content: String(item.content || '').slice(0, 1_000),
        })),
        workItemContext,
        services,
        budgets: new BudgetManager(budgets),
        trajectory,
        candidates: new CandidateLedger(),
        hypotheses: [],
        critiques: [],
        structuredFallbacks: 0,
        toolCache: new Map(),
        signal,
        startedAt: Date.now(),
    };
}

export { keyForCandidate, publicCandidate };
