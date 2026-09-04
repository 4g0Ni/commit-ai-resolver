const DEFAULT_LIMITS = Object.freeze({
    maxAgentCalls: 6,
    maxToolCalls: 14,
    maxDiffFetches: 3,
    maxElapsedMs: 75_000,
    perTool: {
        get_index_stats: 2,
        search_commits: 4,
        lookup_commits: 2,
        get_commit_diff: 3,
        get_evidence_snapshot: 4,
        search_counter_evidence: 2,
    },
});

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Error raised when an agent run reaches a deterministic harness limit. */
export class BudgetExceededError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'BudgetExceededError';
        this.code = code;
    }
}

/** Tracks request-local agent, tool, diff, and wall-clock budgets. */
export class BudgetManager {
    constructor(limits = {}) {
        this.limits = {
            maxAgentCalls: positiveInteger(limits.maxAgentCalls, DEFAULT_LIMITS.maxAgentCalls),
            maxToolCalls: positiveInteger(limits.maxToolCalls, DEFAULT_LIMITS.maxToolCalls),
            maxDiffFetches: positiveInteger(limits.maxDiffFetches, DEFAULT_LIMITS.maxDiffFetches),
            maxElapsedMs: positiveInteger(limits.maxElapsedMs, DEFAULT_LIMITS.maxElapsedMs),
            perTool: { ...DEFAULT_LIMITS.perTool, ...(limits.perTool || {}) },
        };
        this.startedAt = Date.now();
        this.agentCalls = 0;
        this.toolCalls = 0;
        this.diffFetches = 0;
        this.toolCounts = new Map();
    }

    assertWithinDeadline() {
        if (Date.now() - this.startedAt >= this.limits.maxElapsedMs) {
            throw new BudgetExceededError('deadline_exceeded', 'The agent run exceeded its wall-clock budget.');
        }
    }

    consumeAgentCall(agentName) {
        this.assertWithinDeadline();
        if (this.agentCalls >= this.limits.maxAgentCalls) {
            throw new BudgetExceededError(
                'agent_budget_exceeded',
                `Agent-call budget exhausted before calling ${agentName}.`,
            );
        }
        this.agentCalls += 1;
    }

    consumeToolCall(toolName, { isDiff = false } = {}) {
        this.assertWithinDeadline();
        if (this.toolCalls >= this.limits.maxToolCalls) {
            throw new BudgetExceededError(
                'tool_budget_exceeded',
                `Tool-call budget exhausted before calling ${toolName}.`,
            );
        }

        const currentCount = this.toolCounts.get(toolName) || 0;
        const toolLimit = positiveInteger(this.limits.perTool[toolName], Number.MAX_SAFE_INTEGER);
        if (currentCount >= toolLimit) {
            throw new BudgetExceededError(
                'per_tool_budget_exceeded',
                `Per-tool budget exhausted for ${toolName}.`,
            );
        }
        if (isDiff && this.diffFetches >= this.limits.maxDiffFetches) {
            throw new BudgetExceededError('diff_budget_exceeded', 'Commit-diff fetch budget exhausted.');
        }

        this.toolCalls += 1;
        this.toolCounts.set(toolName, currentCount + 1);
        if (isDiff) this.diffFetches += 1;
    }

    remainingMs() {
        return Math.max(0, this.limits.maxElapsedMs - (Date.now() - this.startedAt));
    }

    snapshot() {
        return {
            limits: { ...this.limits, perTool: { ...this.limits.perTool } },
            used: {
                agentCalls: this.agentCalls,
                toolCalls: this.toolCalls,
                diffFetches: this.diffFetches,
                elapsedMs: Date.now() - this.startedAt,
                perTool: Object.fromEntries(this.toolCounts),
            },
            remainingMs: this.remainingMs(),
        };
    }
}

export { DEFAULT_LIMITS };

