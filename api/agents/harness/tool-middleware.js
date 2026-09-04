import { BudgetExceededError } from './budget-manager.js';

const DEFAULT_TOOL_TIMEOUT_MS = 20_000;
const MAX_MODEL_STRING = 12_000;

/** Error raised when a tool call violates a harness policy. */
export class ToolPolicyError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ToolPolicyError';
        this.code = code;
    }
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
    }
    return value;
}

function toolCacheKey(caller, toolName, input) {
    return `${caller}:${toolName}:${JSON.stringify(stableValue(input))}`;
}

function sanitizeToolOutput(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (depth > 6) return '[max-depth]';
    if (typeof value === 'string') {
        return value.length > MAX_MODEL_STRING
            ? `${value.slice(0, MAX_MODEL_STRING)}... [truncated by harness]`
            : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitizeToolOutput(item, depth + 1));
    if (typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .filter(([key]) => !/(api.?key|authorization|password|secret)/iu.test(key))
            .map(([key, item]) => [key, sanitizeToolOutput(item, depth + 1)]));
    }
    return String(value);
}

function getHarnessState(runContext) {
    const state = runContext?.context || runContext;
    if (!state?.budgets || !state?.trajectory || !state?.candidates) {
        throw new ToolPolicyError('missing_run_context', 'Tool call is missing its request-local harness context.');
    }
    return state;
}

function validateCandidateReferences(state, input, fields) {
    for (const field of fields || []) {
        const references = Array.isArray(input?.[field]) ? input[field] : [input?.[field]];
        for (const reference of references.filter(Boolean)) {
            if (!state.candidates.hasAuthorized(reference)) {
                throw new ToolPolicyError(
                    'candidate_not_in_ledger',
                    `Candidate ${reference} was not authorized by a successful evidence-gated retrieval.`,
                );
            }
        }
    }
}

async function withTimeout(operation, timeoutMs, toolName) {
    let timeoutId;
    try {
        return await Promise.race([
            operation(),
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new ToolPolicyError(
                    'tool_timeout',
                    `${toolName} exceeded its ${timeoutMs}ms timeout.`,
                )), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timeoutId);
    }
}

function modelVisibleError(error) {
    const expected = error instanceof ToolPolicyError || error instanceof BudgetExceededError;
    return JSON.stringify({
        ok: false,
        error: {
            code: error?.code || 'tool_execution_failed',
            message: expected ? error.message : 'The tool failed. Choose another safe action or return a partial answer.',
            retryable: !['candidate_not_in_ledger', 'permission_denied', 'diff_budget_exceeded'].includes(error?.code),
        },
    });
}

/**
 * Wrap an Agents SDK tool with permission, budget, dedupe, timeout, validation,
 * sanitization, and trajectory middleware.
 */
export function wrapToolWithHarness(baseTool, {
    caller,
    kind = 'tool',
    timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
    cache = false,
    candidateFields = [],
    validateInput,
    validateOutput,
    onResult,
}) {
    if (!baseTool?.name || typeof baseTool.invoke !== 'function') {
        throw new Error('A named executable Agents SDK tool is required.');
    }

    const originalIsEnabled = baseTool.isEnabled;
    return {
        ...baseTool,
        isEnabled: async (runContext, agent) => {
            const state = runContext?.context;
            if (!state?.allowedTools?.[caller]?.has(baseTool.name)) return false;
            if (typeof originalIsEnabled === 'function') {
                return Boolean(await originalIsEnabled(runContext, agent));
            }
            return originalIsEnabled !== false;
        },
        invoke: async (runContext, rawInput, details) => {
            const state = getHarnessState(runContext);
            let input = rawInput;
            if (typeof rawInput === 'string') {
                try {
                    input = JSON.parse(rawInput);
                } catch {
                    input = rawInput;
                }
            }
            const startedAt = Date.now();
            const cacheKey = toolCacheKey(caller, baseTool.name, input);

            if (!state.allowedTools?.[caller]?.has(baseTool.name)) {
                const error = new ToolPolicyError(
                    'permission_denied',
                    `${caller} is not allowed to call ${baseTool.name}.`,
                );
                state.trajectory.record({
                    agent: caller,
                    stage: baseTool.name,
                    status: 'blocked',
                    details: { code: error.code },
                });
                return modelVisibleError(error);
            }

            if (cache && state.toolCache.has(cacheKey)) {
                state.trajectory.record({
                    agent: caller,
                    stage: baseTool.name,
                    status: 'deduplicated',
                    details: { cacheHit: true },
                });
                return state.toolCache.get(cacheKey);
            }

            state.trajectory.record({
                agent: caller,
                stage: baseTool.name,
                status: 'running',
                details: { input },
            });

            try {
                state.budgets.consumeToolCall(baseTool.name, { isDiff: kind === 'diff' });
                if (kind === 'agent') state.budgets.consumeAgentCall(baseTool.name);
                validateCandidateReferences(state, input, candidateFields);
                if (typeof validateInput === 'function') await validateInput(input, state);

                const effectiveTimeout = Math.max(1, Math.min(timeoutMs, state.budgets.remainingMs()));
                const output = await withTimeout(
                    () => baseTool.invoke(runContext, rawInput, details),
                    effectiveTimeout,
                    baseTool.name,
                );
                const validatedOutput = typeof validateOutput === 'function'
                    ? await validateOutput(output, state)
                    : output;
                const sanitizedOutput = sanitizeToolOutput(validatedOutput);
                if (typeof onResult === 'function') await onResult(sanitizedOutput, state, input);
                if (cache) state.toolCache.set(cacheKey, sanitizedOutput);

                state.trajectory.record({
                    agent: caller,
                    stage: baseTool.name,
                    status: 'done',
                    details: { elapsed: Date.now() - startedAt },
                });
                return sanitizedOutput;
            } catch (error) {
                state.trajectory.record({
                    agent: caller,
                    stage: baseTool.name,
                    status: 'error',
                    details: {
                        code: error?.code || 'tool_execution_failed',
                        message: error?.message,
                        elapsed: Date.now() - startedAt,
                    },
                });
                return modelVisibleError(error);
            }
        },
    };
}

export { modelVisibleError, sanitizeToolOutput, toolCacheKey };
