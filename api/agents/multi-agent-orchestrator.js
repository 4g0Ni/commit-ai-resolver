import { runWithFallback } from './harness/fallback-controller.js';

const VALID_MODES = new Set(['workflow', 'multi_agent', 'auto']);

function looksLikeInvestigation(query) {
    return /\b(why|root cause|caused|regression|incident|broke|failure|outage|spike|crash)\b/iu.test(String(query || ''))
        || /(?:为什么|根因|导致|回归|事故|故障|崩溃|报错|线上问题)/u.test(String(query || ''));
}

/** Resolve the feature-flag mode for one query. */
export function selectOrchestrationMode(configuredMode, query) {
    const normalized = String(configuredMode || 'workflow').trim().toLowerCase();
    const mode = VALID_MODES.has(normalized) ? normalized : 'workflow';
    if (mode !== 'auto') return mode;
    return looksLikeInvestigation(query) ? 'multi_agent' : 'workflow';
}

/**
 * Route to the new manager runtime or the frozen workflow baseline, with a
 * deterministic legacy fallback when the manager path fails.
 */
export async function orchestrateSearch({
    configuredMode,
    multiAgentRuntime,
    legacySearch,
    params,
    enableLegacyFallback = true,
}) {
    const selectedMode = selectOrchestrationMode(configuredMode, params.query);
    if (selectedMode === 'workflow') {
        const result = await legacySearch(params);
        return {
            ...result,
            orchestrationMode: 'workflow',
            requestedOrchestrationMode: configuredMode,
        };
    }
    if (!multiAgentRuntime?.run) {
        throw new Error('Multi-agent runtime is unavailable.');
    }

    return runWithFallback({
        primary: async () => ({
            ...(await multiAgentRuntime.run(params)),
            orchestrationMode: 'multi_agent',
            requestedOrchestrationMode: configuredMode,
        }),
        fallback: enableLegacyFallback
            ? async () => ({
                ...(await legacySearch(params)),
                orchestrationMode: 'workflow',
                requestedOrchestrationMode: configuredMode,
            })
            : null,
        onFallback(error) {
            params.onProgress?.(0, 'multi-agent-fallback', {
                status: 'fallback',
                reason: error?.code || error?.name || 'multi_agent_failure',
            });
            console.warn(`  [MultiAgent] Falling back to workflow: ${error?.message || error}`);
        },
    });
}

