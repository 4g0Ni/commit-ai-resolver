const PROMPT_REGISTRY = Object.freeze({
    'intent-extractor': Object.freeze({
        stable: Object.freeze({ version: 'intent-v3', appendix: '' }),
        candidate: Object.freeze({
            version: 'intent-v3-candidate1',
            appendix: 'Experiment rule: preserve concrete code identifiers and UI feature names before generic semantic terms.',
        }),
    }),
    'answer-synthesizer': Object.freeze({
        stable: Object.freeze({ version: 'synthesizer-v4', appendix: '' }),
        candidate: Object.freeze({
            version: 'synthesizer-v4-candidate1',
            appendix: 'Experiment rule: lead with the strongest supported conclusion, then present evidence and uncertainty.',
        }),
    }),
    'answer-evaluator': Object.freeze({
        stable: Object.freeze({ version: 'evaluator-v2', appendix: '' }),
        candidate: Object.freeze({
            version: 'evaluator-v2-candidate1',
            appendix: 'Experiment rule: treat unsupported commit references and non-canonical citations as blocking quality issues.',
        }),
    }),
    'diff-investigator': Object.freeze({
        stable: Object.freeze({ version: 'diff-investigator-v3', appendix: '' }),
        candidate: Object.freeze({
            version: 'diff-investigator-v3-candidate1',
            appendix: 'Experiment rule: order suspects by the completeness of their concrete causal mechanism.',
        }),
    }),
    'commit-summary': Object.freeze({
        stable: Object.freeze({ version: 'commit-summary-v2', appendix: '' }),
        candidate: Object.freeze({
            version: 'commit-summary-v2-candidate1',
            appendix: 'Experiment rule: prioritize observable behavioral changes over inferred intent, and make risk evidence explicit.',
        }),
    }),
    fallback: Object.freeze({
        stable: Object.freeze({ version: 'fallback-v1', appendix: '' }),
        candidate: Object.freeze({ version: 'fallback-v1', appendix: '' }),
    }),
});

const runtimeState = new Map();
let rollbackListener = null;

function experimentConfig() {
    try {
        const parsed = JSON.parse(process.env.PROMPT_EXPERIMENTS || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function percentageFor(agent) {
    const raw = experimentConfig()[agent];
    const value = typeof raw === 'object' ? raw?.candidatePercent : raw;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0;
}

function hashBucket(seed) {
    let hash = 2166136261;
    for (const char of String(seed || '')) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % 100;
}

function stateFor(agent) {
    if (!runtimeState.has(agent)) {
        runtimeState.set(agent, { disabled: false, consecutiveFailures: 0, rollbackReason: null });
    }
    return runtimeState.get(agent);
}

export function selectPromptVariant(agent, seed = '') {
    const entry = PROMPT_REGISTRY[agent];
    if (!entry) throw new Error(`Unknown prompt agent: ${agent}`);
    const state = stateFor(agent);
    const killed = process.env.PROMPT_EXPERIMENT_KILL_SWITCH === '1';
    const candidatePercent = percentageFor(agent);
    const useCandidate = !killed && !state.disabled && candidatePercent > 0 && hashBucket(seed) < candidatePercent;
    return {
        agent,
        variant: useCandidate ? 'candidate' : 'stable',
        candidatePercent,
        ...(useCandidate ? entry.candidate : entry.stable),
    };
}

export function applyPromptVariant(systemPrompt, descriptor) {
    const versioned = String(systemPrompt).replace(/Prompt version:\s*[^\n]+/, `Prompt version: ${descriptor.version}`);
    return descriptor.appendix ? `${versioned}\n${descriptor.appendix}` : versioned;
}

export function reportPromptOutcome(agent, variant, { failed = false } = {}) {
    if (variant !== 'candidate') return;
    const state = stateFor(agent);
    state.consecutiveFailures = failed ? state.consecutiveFailures + 1 : 0;
    const threshold = Math.max(1, Number.parseInt(process.env.PROMPT_AUTO_ROLLBACK_FAILURES || '3', 10) || 3);
    if (state.consecutiveFailures >= threshold) {
        state.disabled = true;
        state.rollbackReason = `${state.consecutiveFailures} consecutive candidate failures`;
        console.error(`  [PromptExperiment] auto-rollback ${agent}: ${state.rollbackReason}`);
        if (rollbackListener) rollbackListener({ agent, reason: state.rollbackReason });
    }
}

export function restorePromptRollback(agent, reason) {
    const state = stateFor(agent);
    state.disabled = true;
    state.rollbackReason = reason || 'persisted automatic rollback';
}

export function registerPromptRollbackListener(listener) {
    rollbackListener = typeof listener === 'function' ? listener : null;
}

export function getPromptRegistrySnapshot() {
    return Object.fromEntries(Object.entries(PROMPT_REGISTRY).map(([agent, entry]) => {
        const state = stateFor(agent);
        return [agent, {
            stableVersion: entry.stable.version,
            candidateVersion: entry.candidate.version,
            candidatePercent: percentageFor(agent),
            candidateDisabled: state.disabled || process.env.PROMPT_EXPERIMENT_KILL_SWITCH === '1',
            rollbackReason: state.rollbackReason,
        }];
    }));
}

export function resetPromptExperimentState() {
    runtimeState.clear();
}

export const PROMPT_VERSIONS = Object.freeze(Object.fromEntries(
    Object.entries(PROMPT_REGISTRY).map(([agent, entry]) => [agent, entry.stable.version]),
));

export { PROMPT_REGISTRY };
