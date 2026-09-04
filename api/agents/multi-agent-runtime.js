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
import {
    DIFF_INVESTIGATOR_OUTPUT,
    EVIDENCE_CRITIC_OUTPUT,
    RETRIEVAL_AGENT_OUTPUT,
    SUPERVISOR_OUTPUT,
} from './agent-schemas.js';
import {
    createRequiredToolModelSettings,
    createStructuredOutputContract,
    resolveStructuredOutputMode,
    validateStructuredAgentOutput,
} from './structured-output.js';

const PROMPT_VERSION = 'multi-agent-v1';

function parseAgentToolOutput(output) {
    if (typeof output !== 'string') return output;
    try {
        return JSON.parse(output);
    } catch {
        return null;
    }
}

function normalizeRetrievalReport(parsedReport, state, validationError = null) {
    const attempts = state.searchAttempts || [];
    const latestAttempt = [...attempts]
        .reverse()
        .find(attempt => attempt.source === 'retrieval-agent') || attempts.at(-1);
    const gate = latestAttempt?.evidenceGate || state.lastEvidenceGate;
    if (!gate) {
        if (validationError) throw validationError;
        return parsedReport;
    }

    const authoritativeKeys = state.candidates
        .list({ limit: 12, authorizedOnly: gate.verdict === 'SEARCH' })
        .map(candidate => candidate.candidateKey);
    const reportedKeys = (parsedReport?.candidateKeys || [])
        .map(reference => state.candidates.resolve(reference))
        .filter(candidate => candidate?._evidenceAuthorized)
        .map(candidate => candidate.candidateKey);
    const candidateKeys = gate.verdict === 'SEARCH'
        ? [...new Set([...reportedKeys, ...authoritativeKeys])].slice(0, 12)
        : [];
    const verdict = gate.verdict;
    const report = RETRIEVAL_AGENT_OUTPUT.parse({
        evidenceSummary: verdict === 'SEARCH'
            ? `${parsedReport?.evidenceSummary || 'Retrieval completed.'} Authoritative harness result: ${candidateKeys.length} evidence-authorized candidate(s), gate=SEARCH.`
            : `Retrieval completed with evidence gate ${verdict}: ${gate.reason || 'no reason supplied'}.`,
        candidateKeys,
        confidence: Math.max(0, Math.min(1, Number(gate.evidenceScore) || 0)),
        evidenceVerdict: verdict,
        needsClarification: verdict === 'ASK_USER',
        clarificationQuestion: verdict === 'ASK_USER'
            ? 'Please add a narrower time window, repository, component, file, symbol, or exact error text.'
            : null,
        recommendedNextStep: verdict === 'SEARCH'
            ? state.services?.commitDiff?.available ? 'investigate' : 'answer'
            : verdict === 'ASK_USER' ? 'clarify' : 'abstain',
        queriesUsed: [...new Set(attempts.map(attempt => attempt.semanticQuery).filter(Boolean))].slice(0, 6),
    });
    if (validationError) {
        state.structuredFallbacks += 1;
        state.trajectory.record({
            agent: 'harness',
            stage: 'structured-output-fallback',
            status: 'recovered',
            details: {
                specialist: RETRIEVAL_AGENT_NAME,
                gateVerdict: verdict,
                candidateCount: candidateKeys.length,
                originalError: validationError.code,
            },
        });
    }
    return report;
}

function normalizeCriticReport(parsedReport, state, validationError = null) {
    const authorizedKeys = state.candidates
        .list({ limit: 12, authorizedOnly: true })
        .map(candidate => candidate.candidateKey);
    const reportedKeys = (parsedReport?.supportedCandidateKeys || [])
        .map(reference => state.candidates.resolve(reference))
        .filter(candidate => candidate?._evidenceAuthorized)
        .map(candidate => candidate.candidateKey);
    const supportedCandidateKeys = reportedKeys.length > 0
        ? [...new Set(reportedKeys)].slice(0, 12)
        : validationError || parsedReport?.verdict === 'PASS'
            ? authorizedKeys.slice(0, 3)
            : [];
    const hasGroundedDiff = supportedCandidateKeys.some(key => state.candidates.getDiff(key));
    const requestedVerdict = validationError ? 'PARTIAL' : parsedReport.verdict;
    const verdict = requestedVerdict === 'PASS' && !hasGroundedDiff
        ? 'PARTIAL'
        : requestedVerdict;
    const missingDiff = 'No grounded source diff was available, so metadata alignment does not prove causality.';
    const report = EVIDENCE_CRITIC_OUTPUT.parse({
        verdict,
        qualityScore: hasGroundedDiff
            ? Math.max(0, Math.min(1, Number(parsedReport?.qualityScore) || 0.5))
            : Math.min(0.6, Math.max(0, Number(parsedReport?.qualityScore) || 0.45)),
        supportedCandidateKeys,
        unsupportedClaims: (parsedReport?.unsupportedClaims || []).slice(0, 8),
        missingEvidence: [...new Set([
            ...(parsedReport?.missingEvidence || []),
            ...(!hasGroundedDiff ? [missingDiff] : []),
        ])].slice(0, 8),
        recommendedAction: supportedCandidateKeys.length > 0 ? 'answer' : 'abstain',
        feedback: validationError
            ? `The harness recovered a conservative PARTIAL critique from ${supportedCandidateKeys.length} authorized candidate(s). ${missingDiff}`
            : `${parsedReport.feedback} Harness validation: ${supportedCandidateKeys.length} supported candidate key(s); grounded diff=${hasGroundedDiff}.`,
    });
    if (validationError) {
        state.structuredFallbacks += 1;
        state.trajectory.record({
            agent: 'harness',
            stage: 'structured-output-fallback',
            status: 'recovered',
            details: {
                specialist: EVIDENCE_CRITIC_AGENT_NAME,
                verdict,
                candidateCount: supportedCandidateKeys.length,
                originalError: validationError.code,
            },
        });
    }
    return report;
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
    structuredOutputMode = 'auto',
}) {
    const resolvedStructuredOutputMode = resolveStructuredOutputMode(structuredOutputMode, baseURL);
    const requiredToolModelSettings = createRequiredToolModelSettings(
        baseURL,
        resolvedStructuredOutputMode,
    );
    const outputContracts = {
        retrieval: createStructuredOutputContract(
            RETRIEVAL_AGENT_OUTPUT,
            'retrieval_agent_output',
            resolvedStructuredOutputMode,
        ),
        investigator: createStructuredOutputContract(
            DIFF_INVESTIGATOR_OUTPUT,
            'diff_investigator_output',
            resolvedStructuredOutputMode,
        ),
        critic: createStructuredOutputContract(
            EVIDENCE_CRITIC_OUTPUT,
            'evidence_critic_output',
            resolvedStructuredOutputMode,
        ),
        supervisor: createStructuredOutputContract(
            SUPERVISOR_OUTPUT,
            'supervisor_output',
            resolvedStructuredOutputMode,
        ),
    };
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
        outputType: outputContracts.retrieval.outputType,
        outputInstructions: outputContracts.retrieval.instructions,
        modelSettings: requiredToolModelSettings,
    });
    const diffInvestigatorAgent = createDiffInvestigatorAgent({
        model: qualityModel,
        tools: harness.toolsFor(DIFF_INVESTIGATOR_AGENT_NAME),
        outputType: outputContracts.investigator.outputType,
        outputInstructions: outputContracts.investigator.instructions,
        modelSettings: requiredToolModelSettings,
    });
    const evidenceCriticAgent = createEvidenceCriticAgent({
        model: fastModel,
        tools: harness.toolsFor(EVIDENCE_CRITIC_AGENT_NAME),
        outputType: outputContracts.critic.outputType,
        outputInstructions: outputContracts.critic.instructions,
        modelSettings: requiredToolModelSettings,
    });

    const retrievalAgentTool = retrievalAgent.asTool({
        toolName: 'delegate_commit_retrieval',
        toolDescription: 'Delegate commit discovery to the retrieval specialist. This must be the first specialist for commit questions.',
        runOptions: { maxTurns: 5 },
        isEnabled: ({ runContext }) => !runContext.context?.retrievalReports?.length,
    });
    const diffInvestigatorTool = diffInvestigatorAgent.asTool({
        toolName: 'delegate_diff_investigation',
        toolDescription: 'Ask the diff specialist to inspect grounded candidate commits and build causal hypotheses.',
        runOptions: { maxTurns: 6 },
        isEnabled: ({ runContext }) => Boolean(
            runContext.context?.services?.commitDiff?.available
            && runContext.context?.candidates
                ?.list({ limit: 20, authorizedOnly: true })
                .some(candidate => runContext.context.services.commitDiff.canFetch?.(candidate.repo) !== false),
        ),
    });
    const evidenceCriticTool = evidenceCriticAgent.asTool({
        toolName: 'delegate_evidence_critique',
        toolDescription: 'Ask an independent critic to challenge the current evidence or causal hypothesis.',
        runOptions: { maxTurns: 5 },
        isEnabled: ({ runContext }) => Boolean(
            runContext.context?.candidates?.list({ limit: 1, authorizedOnly: true }).length,
        ) && !runContext.context?.critiques?.length,
    });

    harness
        .registerTool({
            tool: retrievalAgentTool,
            caller: SUPERVISOR_AGENT_NAME,
            kind: 'agent',
            timeoutMs: 50_000,
            validateOutput(output, state) {
                try {
                    return normalizeRetrievalReport(
                        validateStructuredAgentOutput(
                            output,
                            RETRIEVAL_AGENT_OUTPUT,
                            'Retrieval agent',
                        ),
                        state,
                    );
                } catch (error) {
                    return normalizeRetrievalReport(null, state, error);
                }
            },
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
            validateOutput: output => validateStructuredAgentOutput(
                output,
                DIFF_INVESTIGATOR_OUTPUT,
                'Diff investigator agent',
            ),
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
            validateOutput(output, state) {
                try {
                    return normalizeCriticReport(
                        validateStructuredAgentOutput(
                            output,
                            EVIDENCE_CRITIC_OUTPUT,
                            'Evidence critic agent',
                        ),
                        state,
                    );
                } catch (error) {
                    return normalizeCriticReport(null, state, error);
                }
            },
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
        outputType: outputContracts.supervisor.outputType,
        outputInstructions: outputContracts.supervisor.instructions,
        modelSettings: requiredToolModelSettings,
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
            const latestCritique = context.critiques.at(-1) || null;
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
                    structuredFallbacks: context.structuredFallbacks,
                    parseErrors: 0,
                    validationRejections: output.validationRejections,
                    promptTokens: usage.promptTokens,
                    completionTokens: usage.completionTokens,
                    totalTokens: usage.totalTokens,
                },
                agentTrace: {
                    runId: context.runId,
                    decisionSummary: output.decisionSummary,
                    structuredOutputMode: resolvedStructuredOutputMode,
                    budgets: context.budgets.snapshot(),
                    agentCalls: trajectory
                        .filter(event => event.status === 'done' && event.stage.startsWith('delegate_'))
                        .map(event => event.stage),
                    critic: latestCritique ? {
                        verdict: latestCritique.verdict,
                        qualityScore: latestCritique.qualityScore,
                        supportedCandidateKeys: latestCritique.supportedCandidateKeys,
                        unsupportedClaims: latestCritique.unsupportedClaims,
                        missingEvidence: latestCritique.missingEvidence,
                        recommendedAction: latestCritique.recommendedAction,
                    } : null,
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
