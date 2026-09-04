import { ToolRegistry } from './tool-registry.js';
import { createAgentRunContext } from './run-context.js';

/**
 * Runtime shell around the Agents SDK. It owns state, tools, budgets, deadlines,
 * local trajectory recording, and the boundary between model decisions and code.
 */
export class AgentHarness {
    constructor({ runner, budgets = {}, runTimeoutMs = 75_000 }) {
        if (!runner || typeof runner.run !== 'function') throw new Error('AgentHarness requires an Agents SDK Runner.');
        this.runner = runner;
        this.defaultBudgets = budgets;
        this.runTimeoutMs = Number.isFinite(Number(runTimeoutMs)) && Number(runTimeoutMs) > 0
            ? Number(runTimeoutMs)
            : 75_000;
        this.registry = new ToolRegistry();
    }

    registerTool(registration) {
        this.registry.register(registration);
        return this;
    }

    toolsFor(agentName) {
        return this.registry.toolsFor(agentName);
    }

    createContext(options) {
        return this.registry.attachPermissions(createAgentRunContext({
            ...options,
            budgets: { ...this.defaultBudgets, ...(options.budgets || {}) },
        }));
    }

    /** Execute the top-level supervisor under a hard deadline. */
    async run({ agent, input, context, maxTurns = 8 }) {
        const safeMaxTurns = Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : 8;
        context.budgets.consumeAgentCall(agent.name);
        context.trajectory.record({
            agent: 'harness',
            stage: 'multi-agent-run',
            status: 'running',
            details: { supervisor: agent.name, maxTurns: safeMaxTurns },
        });

        const controller = new AbortController();
        const timeoutMs = Math.max(1, Math.min(this.runTimeoutMs, context.budgets.remainingMs()));
        const timeoutId = setTimeout(() => controller.abort(new Error('multi-agent run deadline exceeded')), timeoutMs);
        const onExternalAbort = () => controller.abort(context.signal?.reason);
        if (context.signal) {
            if (context.signal.aborted) onExternalAbort();
            else context.signal.addEventListener('abort', onExternalAbort, { once: true });
        }

        try {
            const result = await this.runner.run(agent, input, {
                context,
                maxTurns: safeMaxTurns,
                signal: controller.signal,
            });
            context.trajectory.record({
                agent: 'harness',
                stage: 'multi-agent-run',
                status: 'done',
                details: {
                    usage: result.state?.usage || null,
                    budgets: context.budgets.snapshot(),
                },
            });
            return result;
        } catch (error) {
            context.trajectory.record({
                agent: 'harness',
                stage: 'multi-agent-run',
                status: 'error',
                details: {
                    name: error?.name,
                    message: error?.message,
                    budgets: context.budgets.snapshot(),
                },
            });
            throw error;
        } finally {
            clearTimeout(timeoutId);
            context.signal?.removeEventListener?.('abort', onExternalAbort);
        }
    }
}
