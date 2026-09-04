import { OpenAIProvider, Runner } from '@openai/agents';
import { AgentHarness } from './harness/agent-harness.js';
import { validateSupervisorOutput } from './harness/output-validator.js';
import { createCommitTools } from './tools/commit-tools.js';
import { createRetrievalAgent, RETRIEVAL_AGENT_NAME } from './retrieval-agent.js';
import {
    createDiffInvestigatorAgent,
    DIFF_INVESTIGATOR_AGENT_NAME,
} from './diff-investigator-agent.js';
import {
    createEvidenceCriticAgent,
    EVIDENCE_CRITIC_AGENT_NAME,
} from './evidence-critic-agent.js';
import { createSupervisorAgent, SUPERVISOR_AGENT_NAME } from './supervisor-agent.js';

const PROMPT_VERSION = 'multi-agent-v1';

function parseAgentToolOutput(output) {
    if (typeof output !== 'string') return output;
    try {
        return JSON.parse(output);
    } catch {
        return null;
    }
}

function compactWorkItem(workItem) {
    if (!workItem) return null;
    return {
        id: workItem.id,
        type: workItem.type,
        title: workItem.title,
        state: workItem.state,
        createdDate: workItem.createdDate,
        areaPath: workItem.areaPath || null,
        description: String(workItem.description || '').slice(0, 1_200),
        reproSteps: String(workItem.reproSteps || '').slice(0, 800),
        url: workItem.url,
    };
}

function toIterationLog(events) {
    return events.map(event => ({
        iteration: event.sequence,
        stage: event.stage,
        status: event.status,
        agent: event.agent,
        timestamp: event.timestamp,
        elapsed: event.details?.elapsed ?? event.elapsedMs,
        ...event.details,
    }));
}

function usageSnapshot(result) {
    const usage = result?.state?.usage;
    return {
        requests: usage?.requests || 0,
        promptTokens: usage?.inputTokens || 0,
        completionTokens: usage?.outputTokens || 0,
        totalTokens: usage?.totalTokens || 0,
    };
}

function emitReply(onToken, reply) {
    if (typeof onToken !== 'function') return;
    const chunks = String(reply || '').match(/[\s\S]{1,160}/g) || [];
    for (const token of chunks) onToken(token);
}

/**
 * Create a reusable OpenAI Agents SDK runtime with request-local Harness state.
 */
export function createMultiAgentRuntime({
    apiKey,
    baseURL,
    qualityModel,
    fastModel,
    commitSearchService,
    commitDiffService,
    budgets = {},
    runTimeoutMs,
}) {
    const provider = new OpenAIProvider({
        apiKey: apiKey || 'local',
        ...(baseURL ? { baseURL } : {}),
        useResponses: false,
    });
    const runner = new Runner({
        modelProvider: provider,
        tracingDisabled: true,
        traceIncludeSensitiveData: false,
        workflowName: 'Commit AI Resolver Multi-Agent',
        toolNameCollisionPolicy: 'error',
        toolNotFoundBehavior: 'return_error_to_model',
    });
    const harness = new AgentHarness({ runner, budgets, runTimeoutMs });
    const baseTools = createCommitTools();

    harness
        .registerTool({ tool: baseTools.getIndexStats, caller: RETRIEVAL_AGENT_NAME, cache: true })
        .registerTool({ tool: baseTools.searchCommits, caller: RETRIEVAL_AGENT_NAME, cache: true })
        .registerTool({ tool: baseTools.lookupCommits, caller: RETRIEVAL_AGENT_NAME, cache: true })
        .registerTool({
            tool: baseTools.getEvidenceSnapshot,
            caller: DIFF_INVESTIGATOR_AGENT_NAME,
            cache: false,
        })
        .registerTool({
            tool: baseTools.getCommitDiff,
            caller: DIFF_INVESTIGATOR_AGENT_NAME,
            kind: 'diff',
            timeoutMs: 25_000,
            cache: true,
            candidateFields: ['candidateKey'],
        })
        .registerTool({
            tool: baseTools.getEvidenceSnapshot,
            caller: EVIDENCE_CRITIC_AGENT_NAME,
            cache: false,
        })
        .registerTool({
            tool: baseTools.searchCounterEvidence,
            caller: EVIDENCE_CRITIC_AGENT_NAME,
            cache: true,
        });

    const retrievalAgent = createRetrievalAgent({
        model: fastModel,
        tools: harness.toolsFor(RETRIEVAL_AGENT_NAME),
    });
    const diffInvestigatorAgent = createDiffInvestigatorAgent({
        model: qualityModel,
        tools: harness.toolsFor(DIFF_INVESTIGATOR_AGENT_NAME),
    });
    const evidenceCriticAgent = createEvidenceCriticAgent({
        model: fastModel,
        tools: harness.toolsFor(EVIDENCE_CRITIC_AGENT_NAME),
    });

    const retrievalAgentTool = retrievalAgent.asTool({
        toolName: 'delegate_commit_retrieval',
        toolDescription: 'Delegate commit discovery to the retrieval specialist. This must be the first specialist for commit questions.',
        runOptions: { maxTurns: 5 },
    });
    const diffInvestigatorTool = diffInvestigatorAgent.asTool({
        toolName: 'delegate_diff_investigation',
        toolDescription: 'Ask the diff specialist to inspect grounded candidate commits and build causal hypotheses.',
        runOptions: { maxTurns: 6 },
        isEnabled: ({ runContext }) => Boolean(runContext.context?.services?.commitDiff?.available),
    });
    const evidenceCriticTool = evidenceCriticAgent.asTool({
        toolName: 'delegate_evidence_critique',
        toolDescription: 'Ask an independent critic to challenge the current evidence or causal hypothesis.',
        runOptions: { maxTurns: 5 },
    });

    harness
        .registerTool({
            tool: retrievalAgentTool,
            caller: SUPERVISOR_AGENT_NAME,
            kind: 'agent',
            timeoutMs: 50_000,
            onResult(output, state) {
                const parsed = parseAgentToolOutput(output);
                if (parsed) state.retrievalReports = [...(state.retrievalReports || []), parsed];
            },
        })
        .registerTool({
            tool: diffInvestigatorTool,
            caller: SUPERVISOR_AGENT_NAME,
            kind: 'agent',
            timeoutMs: 55_000,
            onResult(output, state) {
                const parsed = parseAgentToolOutput(output);
                if (!parsed) return;
                state.investigationReports = [...(state.investigationReports || []), parsed];
                state.hypotheses.push(...(parsed.hypotheses || []).map(hypothesis => ({
                    ...hypothesis,
                    candidateKey: state.candidates.resolve(hypothesis.candidateKey)?.candidateKey || null,
                })).filter(hypothesis => hypothesis.candidateKey));
            },
        })
        .registerTool({
            tool: evidenceCriticTool,
            caller: SUPERVISOR_AGENT_NAME,
            kind: 'agent',
            timeoutMs: 45_000,
            onResult(output, state) {
                const parsed = parseAgentToolOutput(output);
                if (!parsed) return;
                const supportedCandidateKeys = (parsed.supportedCandidateKeys || [])
                    .map(reference => {
                        const candidate = state.candidates.resolve(reference);
                        return candidate?._evidenceAuthorized ? candidate.candidateKey : null;
                    })
                    .filter(Boolean);
                state.critiques.push({
                    ...parsed,
                    verdict: parsed.verdict === 'PASS' && supportedCandidateKeys.length === 0
                        ? 'PARTIAL'
                        : parsed.verdict,
                    supportedCandidateKeys: [...new Set(supportedCandidateKeys)],
                });
            },
        });

    const supervisor = createSupervisorAgent({
        model: qualityModel,
        tools: harness.toolsFor(SUPERVISOR_AGENT_NAME),
    });

    return {
        /** Run one request through the manager and whichever specialists it chooses. */
        async run({
            query,
            history = [],
            workItemContext = null,
            correlationId,
            onProgress,
            onToken,
            signal,
            maxTurns = 8,
        }) {
            const context = harness.createContext({
                runId: correlationId,
                query,
                history,
                workItemContext,
                services: {
                    commitSearch: commitSearchService,
                    commitDiff: commitDiffService,
                },
                onProgress,
                signal,
            });
            const input = JSON.stringify({
                userQuery: String(query || ''),
                recentConversation: context.history,
                workItem: compactWorkItem(workItemContext),
                availableCapabilities: {
                    commitSearch: true,
                    diffInvestigation: Boolean(commitDiffService?.available),
                    independentEvidenceCritic: true,
                },
            });

            const sdkResult = await harness.run({
                agent: supervisor,
                input,
                context,
                maxTurns,
            });
            const output = validateSupervisorOutput(sdkResult.finalOutput, context);
            const usage = usageSnapshot(sdkResult);
            const trajectory = context.trajectory.snapshot();
            const evidenceGate = [...(context.evidenceGates || [])]
                .reverse()
                .find((gate) => gate?.verdict === 'SEARCH')
                || context.lastEvidenceGate
                || null;
            const suspects = output.type === 'clarification'
                ? []
                : context.candidates.toSuspects(output.citedCandidateKeys, workItemContext ? 20 : 10);
            emitReply(onToken, output.reply);

            return {
                type: output.type,
                reply: output.reply,
                ...(output.type === 'clarification' ? { question: output.reply } : {}),
                confidence: output.confidence,
                searchMethod: 'multi-agent',
                iterations: context.budgets.agentCalls,
                resultCount: context.candidates.list({ limit: 10_000 }).length,
                suspects,
                suggestedActions: output.suggestedActions,
                workItem: workItemContext ? {
                    id: workItemContext.id,
                    title: workItemContext.title,
                    url: workItemContext.url,
                    type: workItemContext.type,
                    state: workItemContext.state,
                    createdDate: workItemContext.createdDate,
                } : undefined,
                evidenceGate,
                iterationLog: toIterationLog(trajectory),
                promptVersions: {
                    supervisor: PROMPT_VERSION,
                    retrieval: PROMPT_VERSION,
                    investigator: PROMPT_VERSION,
                    critic: PROMPT_VERSION,
                },
                promptMetrics: {
                    structuredCalls: usage.requests,
                    structuredFallbacks: 0,
                    parseErrors: 0,
                    validationRejections: output.validationRejections,
                    promptTokens: usage.promptTokens,
                    completionTokens: usage.completionTokens,
                    totalTokens: usage.totalTokens,
                },
                agentTrace: {
                    runId: context.runId,
                    decisionSummary: output.decisionSummary,
                    budgets: context.budgets.snapshot(),
                    agentCalls: trajectory
                        .filter(event => event.status === 'done' && event.stage.startsWith('delegate_'))
                        .map(event => event.stage),
                },
            };
        },

        async close() {
            await provider.close();
        },

        harness,
        supervisor,
    };
}
