/**
 * Backend API server for Commit AI Resolver dashboard.
 *
 * Serves daily summary JSON files and provides a chat endpoint
 * that uses an OpenAI-compatible API to answer questions about commit summaries.
 *
 * Endpoints:
 *   GET  /api/days           — list available dates
 *   GET  /api/days/:date     — get summary for a specific date
 *   GET  /api/days?from=&to= — get summaries for a date range
 *   POST /api/chat           — chat with LLM about commit summaries
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { logQuery, logQueryStub, recordFeedback, getFeedbackStats, getRecentFeedback, getUsageMetrics } from './db.js';
import { startScheduledRefresh } from '../src/services/scheduled-refresh.js';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { isInitializeRequest } from '@modelcontextprotocol/server';
import { createMcpServer } from './mcp.js';
import { FALLBACK_SYSTEM_PROMPT } from './agents/synthesis-prompt.js';
import { createMultiAgentRuntime } from './agents/multi-agent-runtime.js';
import { orchestrateSearch } from './agents/multi-agent-orchestrator.js';
import { getPromptRegistrySnapshot } from '../src/prompts/prompt-registry.js';
import { createCommitSearchService } from '../src/services/commit-search-service.js';
import { createCommitDiffService } from '../src/services/commit-diff-service.js';
import {
    buildEmbeddingRequest,
    getEmbeddingConfig,
    getEmbeddingProviderConfig,
} from '../src/services/embedding-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(process.env.DATA_DIR || join(__dirname, '..', 'data'), 'daily');
const PORT = process.env.PORT || 4399;
const HOST = process.env.HOST || '127.0.0.1';
const LOCAL_USER_ID = 'local-user';

// --- OpenAI-compatible setup ---
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';
const OPENAI_FAST_MODEL = process.env.OPENAI_FAST_MODEL || 'gpt-4.1-mini';
const EMBEDDING_CONFIG = getEmbeddingConfig();
const EMBEDDING_PROVIDER = getEmbeddingProviderConfig();
const AGENT_MAX_ITERATIONS = Number.parseInt(process.env.AGENT_MAX_ITERATIONS || '3', 10);
const AGENT_SUPERVISOR_MAX_TURNS = Number.parseInt(process.env.AGENT_SUPERVISOR_MAX_TURNS || '8', 10);
const AGENT_ORCHESTRATION_MODE = process.env.AGENT_ORCHESTRATION_MODE || 'workflow';
const AGENT_LEGACY_FALLBACK = process.env.AGENT_LEGACY_FALLBACK !== '0';
const AI_CONFIGURED = Boolean(process.env.OPENAI_API_KEY || OPENAI_BASE_URL);
const ADO_CONFIGURED = Boolean(process.env.ADO_PAT || process.env.ADO_BEARER_TOKEN);

const openaiApiClient = AI_CONFIGURED
    ? new OpenAI({
        apiKey: process.env.OPENAI_API_KEY || 'local',
        ...(OPENAI_BASE_URL ? { baseURL: OPENAI_BASE_URL } : {}),
    })
    : null;

function withDefaultChatModel(client, model) {
    if (!client) return null;
    return {
        chat: {
            completions: {
                create: (params, options) => client.chat.completions.create({ model, ...params }, options),
            },
        },
    };
}

const openaiClient = withDefaultChatModel(openaiApiClient, OPENAI_MODEL);
const openaiMiniClient = withDefaultChatModel(openaiApiClient, OPENAI_FAST_MODEL);
const embeddingClient = EMBEDDING_PROVIDER.configured
    ? new OpenAI({
        apiKey: EMBEDDING_PROVIDER.apiKey,
        ...(EMBEDDING_PROVIDER.baseURL ? { baseURL: EMBEDDING_PROVIDER.baseURL } : {}),
    })
    : null;

const app = express();
const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:4399',
    ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : []),
];
app.use(cors({
    origin: allowedOrigins,
    credentials: true,
    exposedHeaders: ['Mcp-Session-Id'],
}));
app.use(express.json());

// --- Request logging middleware ---
app.use((req, res, next) => {
    const start = Date.now();
    const { method, url } = req;
    res.on('finish', () => {
        const ms = Date.now() - start;
        const status = res.statusCode;
        const color = status >= 500 ? '\x1b[31m' : status >= 400 ? '\x1b[33m' : '\x1b[32m';
        console.log(`${color}${method} ${url} ${status}\x1b[0m ${ms}ms`);
    });
    next();
});

// --- Vector store ---
import { searchVectors, searchLexical, lookupByCommitIds, getVectorStats } from '../src/services/vector-store.js';

// --- Release list ---
import { fetchReleaseList } from '../src/services/ado-git-client.js';
// --- Agentic search ---
import { agenticSearch } from './agents/orchestrator.js';

// --- Deep investigation ---
import { investigateDiffs } from './agents/diff-investigator.js';
import { fetchCommitChanges, fetchCommitDiff, fetchWorkItem } from '../src/services/ado-git-client.js';
import { fetchFilteredDiffs } from '../src/services/commit-summarizer.js';
import { classifyChanges } from '../src/services/diff-filter.js';
import { REPOSITORIES } from '../src/config/repositories.js';
import { detectWorkItemUrls } from '../src/services/workitem-detector.js';

/** Generate a query embedding using the embedding client (with LRU cache). */
const _embeddingCache = new Map();
const EMBEDDING_CACHE_MAX = 100;

async function embedQuery(text) {
    if (!embeddingClient) {
        throw new Error(
            'Embeddings are not configured. Set OPENAI_EMBEDDING_BASE_URL, OPENAI_EMBEDDING_API_KEY, ' +
            'OPENAI_BASE_URL, or OPENAI_API_KEY.'
        );
    }
    if (_embeddingCache.has(text)) {
        return _embeddingCache.get(text);
    }
    const result = await embeddingClient.embeddings.create(buildEmbeddingRequest([text], 'query'));
    const embedding = result.data[0].embedding;
    if (embedding.length !== EMBEDDING_CONFIG.dimensions) {
        throw new Error(
            `Embedding provider returned ${embedding.length} dimensions; configured index expects ${EMBEDDING_CONFIG.dimensions}.`
        );
    }
    _embeddingCache.set(text, embedding);
    // Evict oldest entries if cache exceeds max
    if (_embeddingCache.size > EMBEDDING_CACHE_MAX) {
        const firstKey = _embeddingCache.keys().next().value;
        _embeddingCache.delete(firstKey);
    }
    return embedding;
}

/** Check if vector store has data. */
let _vectorStoreAvailable = null;
async function isVectorStoreAvailable() {
    if (_vectorStoreAvailable !== null) return _vectorStoreAvailable;
    try {
        const stats = await getVectorStats();
        _vectorStoreAvailable = stats.totalCommits > 0;
        console.log(`Vector store: ${stats.totalCommits} commits indexed`);
    } catch {
        _vectorStoreAvailable = false;
    }
    return _vectorStoreAvailable;
}

const commitSearchService = createCommitSearchService({
    embedQuery,
    searchVectors,
    searchLexical,
    lookupByCommitIds,
    getVectorStats,
});
const commitDiffService = createCommitDiffService({
    fetchCommitDiff,
    repositories: REPOSITORIES,
    available: ADO_CONFIGURED,
});
const multiAgentRuntime = AI_CONFIGURED
    ? createMultiAgentRuntime({
        apiKey: process.env.OPENAI_API_KEY || 'local',
        baseURL: OPENAI_BASE_URL,
        qualityModel: OPENAI_MODEL,
        fastModel: OPENAI_FAST_MODEL,
        commitSearchService,
        commitDiffService,
        runTimeoutMs: Number.parseInt(process.env.AGENT_RUN_TIMEOUT_MS || '75000', 10),
        budgets: {
            maxAgentCalls: Number.parseInt(process.env.AGENT_MAX_CALLS || '6', 10),
            maxToolCalls: Number.parseInt(process.env.AGENT_MAX_TOOL_CALLS || '14', 10),
            maxDiffFetches: Number.parseInt(process.env.AGENT_MAX_DIFF_FETCHES || '3', 10),
            maxElapsedMs: Number.parseInt(process.env.AGENT_RUN_TIMEOUT_MS || '75000', 10),
        },
    })
    : null;

// --- Helper: load daily JSON files ---

async function loadDayData(date) {
    const filePath = join(DATA_DIR, `${date}.json`);
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content);
}

async function listAvailableDates() {
    try {
        const files = await readdir(DATA_DIR);
        return files
            .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.json$/))
            .map(f => f.replace('.json', ''))
            .sort();
    } catch {
        return [];
    }
}

async function loadDateRange(from, to) {
    const dates = await listAvailableDates();
    const filtered = dates.filter(d => (!from || d >= from) && (!to || d <= to));
    const results = [];
    for (const date of filtered) {
        results.push(await loadDayData(date));
    }
    return results;
}

// --- Routes ---

// GET /api/days — list dates or filter by range
app.get('/api/days', async (req, res) => {
    try {
        const { from, to } = req.query;
        if (from || to) {
            const data = await loadDateRange(from, to);
            res.json(data);
        } else {
            const dates = await listAvailableDates();
            res.json({ dates });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/days/:date — get specific day
app.get('/api/days/:date', async (req, res) => {
    try {
        const data = await loadDayData(req.params.date);
        res.json(data);
    } catch (err) {
        if (err.code === 'ENOENT') {
            res.status(404).json({ error: `No data for ${req.params.date}` });
        } else {
            res.status(500).json({ error: err.message });
        }
    }
});

// GET /api/releases — list recent release builds (cached 5 min)
let _releaseCache = { data: null, expiresAt: 0 };

app.get('/api/releases', async (req, res) => {
    if (!ADO_CONFIGURED) {
        return res.json([]);
    }
    try {
        const now = Date.now();
        if (_releaseCache.data && now < _releaseCache.expiresAt) {
            return res.json(_releaseCache.data);
        }
        const all = await fetchReleaseList(14);
        const releases = all.filter(r => {
            const result = (r.build.result ?? '').toLowerCase();
            const status = (r.build.status ?? '').toLowerCase();
            return result !== 'canceled' && result !== 'cancelled'
                && status !== 'canceled' && status !== 'cancelled';
        });
        _releaseCache = { data: releases, expiresAt: now + 5 * 60 * 1000 };
        res.json(releases);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Intent extraction is handled exclusively by api/agents/intent-extractor.js.

// POST /api/chat — Agentic search pipeline with iterative refinement
app.post('/api/chat', async (req, res) => {
    if (!AI_CONFIGURED) {
        return res.status(503).json({
            error: 'AI features are disabled. Set OPENAI_API_KEY or OPENAI_BASE_URL to enable chat.',
        });
    }
    try {
        const { message, history = [] } = req.body;
        if (!message) {
            return res.status(400).json({ error: 'message is required' });
        }

        const useVectors = await isVectorStoreAvailable();
        console.log(`  Chat query: "${message.slice(0, 100)}${message.length > 100 ? '...' : ''}"`);

        // --- Work item detection & fetching ---
        let workItemContext = null;
        const detected = detectWorkItemUrls(message);
        if (detected.workItemIds.length > 0 && ADO_CONFIGURED) {
            try {
                const wi = await fetchWorkItem(detected.workItemIds[0]);
                if (wi) {
                    workItemContext = wi;
                    console.log(`  Work item ${wi.id}: "${wi.title}" (${wi.type}, ${wi.state}, created ${wi.createdDate})`);
                }
            } catch (err) {
                console.warn(`  Failed to fetch work item ${detected.workItemIds[0]}: ${err.message}`);
            }
        }

        const queryId = randomUUID();
        const wantsStream = req.headers.accept?.includes('text/event-stream');
        const wantsEvalTrace = req.headers['x-eval-harness'] === '1';
        const clientSource = req.headers['x-client'] === 'ui' ? 'ui' : 'api';
        const requestAbortController = new AbortController();
        const abortDisconnectedRequest = () => {
            if (res.writableEnded || requestAbortController.signal.aborted) return;
            const error = new Error('Client disconnected before the agent run completed.');
            error.name = 'AbortError';
            requestAbortController.abort(error);
        };
        req.once('aborted', abortDisconnectedRequest);
        res.once('close', abortDisconnectedRequest);

        if (useVectors && wantsStream) {
            // --- SSE streaming agentic pipeline ---
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders();

            const sendEvent = (event, data) => {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            };

            sendEvent('status', { stage: 'starting', message: 'Analyzing your question...' });

            const t0 = Date.now();
            const result = await orchestrateSearch({
                configuredMode: AGENT_ORCHESTRATION_MODE,
                multiAgentRuntime,
                legacySearch: agenticSearch,
                enableLegacyFallback: AGENT_LEGACY_FALLBACK,
                params: {
                    llm: openaiClient,
                    llmFast: openaiMiniClient,
                    embedQuery,
                    searchVectors,
                    searchLexical,
                    lookupByCommitIds,
                    getVectorStats,
                    buildFullContext,
                    query: message,
                    history,
                    maxIterations: AGENT_MAX_ITERATIONS,
                    maxTurns: AGENT_SUPERVISOR_MAX_TURNS,
                    workItemContext,
                    correlationId: queryId,
                    signal: requestAbortController.signal,
                    onProgress: (iteration, stage, details) => {
                        const stageMessages = {
                            'intent-extractor': 'Extracting intent...',
                            'rag-search': details.status === 'done'
                                ? `Found ${details.resultCount} results`
                                : 'Searching commits...',
                            'rag-search-secondary': 'Running secondary search...',
                            'rag-search-title': 'Searching by title...',
                            'rag-search-lexical': 'Matching identifiers and file paths...',
                            'answer-synthesizer': details.status === 'running'
                                ? 'Generating answer...'
                                : undefined,
                            'answer-evaluator': 'Evaluating answer quality...',
                            'retry': `Refining search (attempt ${iteration})...`,
                            'multi-agent-run': details.status === 'running'
                                ? 'Planning an evidence investigation...'
                                : undefined,
                            'delegate_commit_retrieval': details.status === 'running'
                                ? 'Delegating commit retrieval...'
                                : undefined,
                            'delegate_diff_investigation': details.status === 'running'
                                ? 'Inspecting candidate diffs...'
                                : undefined,
                            'delegate_evidence_critique': details.status === 'running'
                                ? 'Challenging the evidence...'
                                : undefined,
                            'multi-agent-fallback': 'Falling back to the baseline workflow...',
                        };
                        const msg = stageMessages[stage];
                        if (msg) sendEvent('status', { stage, iteration, message: msg });
                    },
                    onToken: (token) => {
                        sendEvent('token', { token });
                    },
                },
            });
            const totalMs = Date.now() - t0;
            console.log(`  Agentic search (SSE): ${result.searchMethod}, ${result.iterations} iteration(s), ${totalMs}ms`);

            if (!wantsEvalTrace) {
                try {
                    logQuery({
                        id: queryId, query: message, response: result.reply,
                        confidence: result.confidence, iterations: result.iterations,
                        searchMethod: result.searchMethod, resultCount: result.resultCount,
                        iterationLog: result.iterationLog,
                        workItemId: workItemContext?.id?.toString(), workItemTitle: workItemContext?.title,
                        elapsedMs: totalMs, userId: LOCAL_USER_ID, source: clientSource,
                        promptVersions: result.promptVersions,
                        promptMetrics: result.promptMetrics,
                    });
                } catch (dbErr) {
                    console.error('  [Local DB] Failed to log query:', dbErr.message);
                }
            }

            sendEvent('complete', {
                queryId,
                reply: result.reply,
                searchMethod: result.searchMethod,
                type: result.type,
                confidence: result.confidence,
                iterations: result.iterations,
                suggestedActions: result.suggestedActions || [],
                resultCount: result.resultCount,
                suspects: result.suspects || [],
                workItem: result.workItem || undefined,
                orchestrationMode: result.orchestrationMode,
                orchestrationFallback: result.orchestrationFallback,
                ...(result.type === 'clarification' ? { question: result.question } : {}),
            });
            res.end();

        } else if (useVectors) {
            // --- Agentic pipeline ---
            const t0 = Date.now();
            const result = await orchestrateSearch({
                configuredMode: AGENT_ORCHESTRATION_MODE,
                multiAgentRuntime,
                legacySearch: agenticSearch,
                enableLegacyFallback: AGENT_LEGACY_FALLBACK,
                params: {
                    llm: openaiClient,
                    llmFast: openaiMiniClient,
                    embedQuery,
                    searchVectors,
                    searchLexical,
                    lookupByCommitIds,
                    getVectorStats,
                    buildFullContext,
                    query: message,
                    history,
                    maxIterations: AGENT_MAX_ITERATIONS,
                    maxTurns: AGENT_SUPERVISOR_MAX_TURNS,
                    workItemContext,
                    correlationId: queryId,
                    signal: requestAbortController.signal,
                    onProgress: () => {
                        // Progress is recorded by the harness and agents.
                    },
                },
            });
            const totalMs = Date.now() - t0;
            console.log(`  Agentic search: ${result.searchMethod}, ${result.iterations} iteration(s), ${totalMs}ms`);

            // Log to the local usage database.
            if (!wantsEvalTrace) {
                try {
                    logQuery({
                        id: queryId, query: message, response: result.reply,
                        confidence: result.confidence, iterations: result.iterations,
                        searchMethod: result.searchMethod, resultCount: result.resultCount,
                        iterationLog: result.iterationLog,
                        workItemId: workItemContext?.id?.toString(), workItemTitle: workItemContext?.title,
                        elapsedMs: totalMs, userId: LOCAL_USER_ID, source: clientSource,
                        promptVersions: result.promptVersions,
                        promptMetrics: result.promptMetrics,
                    });
                } catch (dbErr) {
                    console.error('  [Local DB] Failed to log query:', dbErr.message);
                }
            }

            res.json({
                queryId,
                reply: result.reply,
                searchMethod: result.searchMethod,
                type: result.type,
                confidence: result.confidence,
                iterations: result.iterations,
                suggestedActions: result.suggestedActions || [],
                resultCount: result.resultCount,
                suspects: result.suspects || [],
                workItem: result.workItem || undefined,
                orchestrationMode: result.orchestrationMode,
                orchestrationFallback: result.orchestrationFallback,
                ...(result.type === 'clarification' ? { question: result.question } : {}),
                ...(wantsEvalTrace ? {
                    iterationLog: result.iterationLog || [],
                    evidenceGate: result.evidenceGate || null,
                    agentTrace: result.agentTrace || null,
                    evalMetadata: {
                        chatModel: OPENAI_MODEL,
                        fastModel: OPENAI_FAST_MODEL,
                        embeddingModel: EMBEDDING_CONFIG.model,
                        embeddingDimensions: EMBEDDING_CONFIG.dimensions,
                        maxIterations: AGENT_MAX_ITERATIONS,
                        supervisorMaxTurns: AGENT_SUPERVISOR_MAX_TURNS,
                        orchestrationMode: result.orchestrationMode,
                    },
                } : {}),
            });
        } else {
            // --- Fallback: stuff all data into context (no vector store) ---
            const contextText = await buildFullContext();

            const messages = [
                { role: 'system', content: FALLBACK_SYSTEM_PROMPT },
                ...history.map(h => ({ role: h.role, content: h.content })),
                { role: 'user', content: JSON.stringify({ query: message, commitSummaries: contextText }) },
            ];

            const t2 = Date.now();
            const result = await openaiClient.chat.completions.create({
                messages,
                temperature: 0.3,
                max_completion_tokens: 2048,
            });
            console.log(`  LLM (full): ${Date.now() - t2}ms, tokens: ${result.usage?.total_tokens ?? '?'}`);

            const reply = result.choices?.[0]?.message?.content ?? 'No response from LLM.';

            // Log fallback query to telemetry DB
            try {
                logQuery({
                    id: queryId,
                    query: message,
                    response: reply,
                    confidence: null,
                    iterations: 1,
                    searchMethod: 'full',
                    resultCount: null,
                    iterationLog: [],
                    workItemId: workItemContext?.id?.toString(),
                    workItemTitle: workItemContext?.title,
                    elapsedMs: Date.now() - t2,
                    userId: LOCAL_USER_ID,
                    source: clientSource,
                    promptVersions: { fallback: 'fallback-v1' },
                    promptMetrics: { structuredCalls: 0, structuredFallbacks: 0, parseErrors: 0, validationRejections: 0 },
                });
            } catch (dbErr) {
                console.error('  [Local DB] Failed to log query:', dbErr.message);
            }

            res.json({ queryId, reply, searchMethod: 'full', type: 'answer' });
        }
    } catch (err) {
        console.error('Chat error:', err);
        res.status(500).json({ error: err.message });
    }
});

/** Build full context from all daily JSON files (fallback when no vector store). */
async function buildFullContext() {
    const dates = await listAvailableDates();
    const allData = [];
    for (const date of dates) {
        allData.push(await loadDayData(date));
    }
    return allData.map(day => {
        const repos = Object.entries(day.repositories).map(([name, repo]) => {
            const commits = repo.commits.map(c =>
                `  - [${c.summary.riskLevel}] ${c.shortId} by ${c.author}: ${c.summary.title}\n    URL: ${c.url || 'N/A'}\n    ${c.summary.summary}${c.summary.flags?.length ? `\n    Flags: ${c.summary.flags.join(', ')}` : ''}`
            ).join('\n');
            return `### ${name} (${repo.stats.total} commits: ${repo.stats.high} HIGH, ${repo.stats.medium} MEDIUM, ${repo.stats.low} LOW)\n${commits}`;
        }).join('\n\n');
        return `## ${day.date}\n${repos}`;
    }).join('\n\n---\n\n');
}

// GET /api/vectors/stats — vector store stats
app.get('/api/vectors/stats', async (req, res) => {
    try {
        const stats = await getVectorStats();
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/investigate — Deep investigation: fetch commit diffs and analyze root cause
app.post('/api/investigate', async (req, res) => {
    if (!AI_CONFIGURED) {
        return res.status(503).json({
            error: 'AI features are disabled. Set OPENAI_API_KEY or OPENAI_BASE_URL to enable investigation.',
        });
    }
    if (!ADO_CONFIGURED) {
        return res.status(503).json({
            error: 'Live ADO access is disabled. Set ADO_PAT or ADO_BEARER_TOKEN to fetch commit diffs.',
        });
    }
    try {
        const { message, suspects = [], history = [] } = req.body;
        if (!message || suspects.length === 0) {
            return res.status(400).json({ error: 'message and suspects are required' });
        }

        console.log(`  Investigate: "${message.slice(0, 80)}" — ${suspects.length} suspect(s)`);
        const t0 = Date.now();
        const investigateId = randomUUID();

        // Fetch diffs for each suspect (cap at 5)
        const suspectsWithDiffs = [];
        for (const suspect of suspects.slice(0, 5)) {
            const repoConfig = REPOSITORIES[suspect.repo];
            if (!repoConfig) {
                console.warn(`    Skipping ${suspect.shortId}: unknown repo "${suspect.repo}"`);
                suspectsWithDiffs.push({ ...suspect, diff: '(unknown repository)' });
                continue;
            }

            try {
                console.log(`    Fetching diff for ${suspect.shortId} (${suspect.repo})...`);
                const diffStart = Date.now();
                const diffs = await fetchCommitDiff(repoConfig, suspect.commitId);
                const diffText = diffs.join('\n\n');
                const diffMs = Date.now() - diffStart;
                console.log(`    ${suspect.shortId}: ${diffs.length} file(s), ${diffText.length} chars, ${diffMs}ms`);

                // Cap diff size to avoid token explosion
                const cappedDiff = diffText.length > 10000
                    ? diffText.slice(0, 10000) + '\n... (diff truncated, ' + diffText.length + ' total chars)'
                    : diffText;

                suspectsWithDiffs.push({ ...suspect, diff: cappedDiff });
            } catch (err) {
                console.warn(`    Failed to fetch diff for ${suspect.shortId}: ${err.message}`);
                suspectsWithDiffs.push({ ...suspect, diff: '(failed to fetch diff: ' + err.message + ')' });
            }
        }

        const diffMs = Date.now() - t0;
        console.log(`  Diffs fetched in ${diffMs}ms, sending to investigator...`);

        // Run diff investigator agent
        const result = await investigateDiffs(openaiClient, {
            query: message,
            suspects: suspectsWithDiffs,
            history,
        });

        const totalMs = Date.now() - t0;
        console.log(`  Investigation complete: ${totalMs}ms, confidence: ${result.confidence}, root cause: ${result.rootCauseCandidate || 'none'}`);
        try {
            const iterationLog = [{
                iteration: 1,
                stage: 'diff-investigator',
                status: 'done',
                promptVersion: result._promptVersion,
                promptVariant: result._promptVariant,
                structuredOutput: result._structuredOutput,
                structuredFallback: result._structuredFallback,
                parseError: result._parseError,
                elapsed: result._elapsed,
                promptTokens: result._promptTokens,
                completionTokens: result._completionTokens,
                totalTokens: result._tokens,
            }];
            logQuery({
                id: investigateId,
                query: message,
                response: result.analysis,
                confidence: result.confidence,
                iterations: 1,
                searchMethod: 'diff-investigation',
                resultCount: result.suspectsAnalyzed,
                iterationLog,
                elapsedMs: totalMs,
                userId: LOCAL_USER_ID,
                source: req.headers['x-client'] === 'ui' ? 'ui' : 'api',
                promptVersions: { 'diff-investigator': result._promptVersion },
                promptMetrics: {
                    structuredCalls: result._structuredOutput ? 1 : 0,
                    structuredFallbacks: result._structuredFallback ? 1 : 0,
                    parseErrors: result._parseError ? 1 : 0,
                    validationRejections: 0,
                    promptTokens: result._promptTokens || 0,
                    completionTokens: result._completionTokens || 0,
                    totalTokens: result._tokens || 0,
                },
            });
        } catch (dbErr) {
            console.error('  [Local DB] Failed to log investigation:', dbErr.message);
        }
        res.json({
            queryId: investigateId,
            reply: result.analysis,
            type: 'investigation',
            rootCauseCandidate: result.rootCauseCandidate,
            rootCauseRepo: result.rootCauseRepo,
            confidence: result.confidence,
            mechanism: result.mechanism,
            nextSteps: result.nextSteps || [],
            suspectsAnalyzed: result.suspectsAnalyzed,
        });
    } catch (err) {
        console.error('Investigate error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/feedback — record user vote on a chat response
app.post('/api/feedback', async (req, res) => {
    try {
        const { queryId, vote, comment, metadata } = req.body;
        if (!queryId || !vote || !['up', 'down'].includes(vote)) {
            return res.status(400).json({ error: 'queryId and vote (up/down) are required' });
        }

        try {
            recordFeedback({ queryId, vote, comment });
        } catch (err) {
            // FK constraint failure — queryId not in chat_queries (e.g. from old localStorage)
            if (err.message?.includes('FOREIGN KEY')) {
                console.warn(`  [Feedback] Unknown queryId ${queryId}, inserting stub`);
                logQueryStub({
                    id: queryId,
                    query: metadata?.query,
                    response: metadata?.response,
                    confidence: metadata?.confidence,
                    searchMethod: metadata?.searchMethod,
                    source: req.headers['x-client'] === 'ui' ? 'ui' : 'api',
                });
                recordFeedback({ queryId, vote, comment });
            } else {
                throw err;
            }
        }

        console.log(`  [Feedback] ${vote} for ${queryId}${comment ? ' — ' + comment.slice(0, 50) : ''}`);
        res.json({ ok: true });
    } catch (err) {
        console.error('Feedback error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/feedback/stats — aggregated feedback statistics
app.get('/api/feedback/stats', async (req, res) => {
    try {
        const stats = getFeedbackStats();
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/feedback/recent — recent queries with feedback
app.get('/api/feedback/recent', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const rows = getRecentFeedback(limit);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Usage Metrics ──
app.get('/api/metrics/usage', (req, res) => {
    try {
        const metrics = getUsageMetrics();
        res.json({ ...metrics, promptRegistry: getPromptRegistrySnapshot() });
    } catch (err) {
        console.error('Metrics error:', err);
        res.status(500).json({ error: 'Failed to get usage metrics' });
    }
});

// --- MCP Streamable HTTP endpoint ---
// Each MCP session gets its own McpServer + transport pair.
// McpServer binds to one transport, so we create one per session and reuse it.
const mcpSessions = new Map(); // sessionId → { server, transport }

const mcpDeps = {
    embedQuery,
    searchVectors,
    searchLexical,
    lookupByCommitIds,
    getVectorStats,
    listAvailableDates,
    loadDayData,
    fetchCommitChanges,
    fetchFilteredDiffs,
    classifyChanges,
    REPOSITORIES,
};

// Public download for the MCP setup script. Resolves the same way UI_DIST does:
// in dev the script lives in ../deploy; in the deployed package it sits in ./install
// (placed there by deploy/prepare-api.ps1).
const INSTALL_SCRIPT = existsSync(join(__dirname, 'install', 'setup-commit-resolver.ps1'))
    ? join(__dirname, 'install', 'setup-commit-resolver.ps1')
    : join(__dirname, '..', 'deploy', 'setup-commit-resolver.ps1');

// Skill source for standalone installs (script downloaded from /install/...
// won't have the skill files alongside it). Same dev/deployed lookup pattern.
const SKILL_SOURCE_DIR = existsSync(join(__dirname, 'install', 'skills', 'commit-resolver'))
    ? join(__dirname, 'install', 'skills', 'commit-resolver')
    : join(__dirname, '..', 'deploy', 'skills', 'commit-resolver');

// Whitelist of skill files served via /install/skills/commit-resolver/:file.
// Anything not in this list 404s — guards against path traversal and keeps
// the contract explicit when the skill grows new files.
const SKILL_FILES = ['SKILL.md'];

app.get('/install/setup-commit-resolver.ps1', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (!existsSync(INSTALL_SCRIPT)) {
        return res.status(404).type('text/plain').send('Setup script not bundled with this deployment.');
    }
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="setup-commit-resolver.ps1"');
    res.sendFile(INSTALL_SCRIPT);
});

// Manifest the installer reads first to discover which files make up the skill.
// Lets us add files without re-shipping the installer.
app.get('/install/skills/commit-resolver/manifest.json', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.json({ name: 'commit-resolver', files: SKILL_FILES });
});

// Serves the commit-resolver skill files so the standalone installer can pull
// them down on demand.
app.get('/install/skills/commit-resolver/:file', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    const fileName = req.params.file;
    if (!SKILL_FILES.includes(fileName)) {
        return res.status(404).type('text/plain').send('Not found.');
    }
    const filePath = join(SKILL_SOURCE_DIR, fileName);
    if (!existsSync(filePath)) {
        return res.status(404).type('text/plain').send('Skill file not bundled with this deployment.');
    }
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.sendFile(filePath);
});

app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    try {
        if (sessionId && mcpSessions.has(sessionId)) {
            const { transport } = mcpSessions.get(sessionId);
            await transport.handleRequest(req, res, req.body);
            return;
        }

        if (!sessionId && isInitializeRequest(req.body)) {
            const transport = new NodeStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid) => {
                    mcpSessions.set(sid, { server, transport });
                    console.log(`[MCP] Session initialized: ${sid}`);
                },
            });
            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid) {
                    mcpSessions.delete(sid);
                    console.log(`[MCP] Session closed: ${sid}`);
                }
            };
            const sessionDeps = { ...mcpDeps, userEmail: LOCAL_USER_ID };
            const server = createMcpServer(sessionDeps);
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            return;
        }

        if (sessionId) {
            return res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
        }
        return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: missing session ID' }, id: null });
    } catch (err) {
        console.error('[MCP] Error:', err);
        if (!res.headersSent) {
            res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
        }
    }
});

app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !mcpSessions.has(sessionId)) {
        return res.status(404).send('Session not found');
    }
    await mcpSessions.get(sessionId).transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !mcpSessions.has(sessionId)) {
        return res.status(404).send('Session not found');
    }
    await mcpSessions.get(sessionId).transport.handleRequest(req, res);
});

// --- Serve UI static files (production) ---
// In dev: ui/dist is at ../ui/dist relative to api/
// In prod (App Service): ui/dist is at ./ui/dist inside wwwroot
const UI_DIST = existsSync(join(__dirname, 'ui', 'dist'))
    ? join(__dirname, 'ui', 'dist')
    : join(__dirname, '..', 'ui', 'dist');
if (existsSync(UI_DIST)) {
    app.use(express.static(UI_DIST));
    // SPA fallback: serve index.html for non-API routes
    app.use((req, res, next) => {
        if (req.method !== 'GET'
            || req.path.startsWith('/api/')
            || req.path.startsWith('/mcp')
            || req.path.startsWith('/install/')
            || req.path.startsWith('/oauth')
            || req.path.startsWith('/.well-known/')) return next();
        res.sendFile(join(UI_DIST, 'index.html'));
    });
}

app.listen(PORT, HOST, () => {
    console.log(`Commit AI Resolver API running on http://${HOST}:${PORT}`);
    console.log(`MCP endpoint: http://${HOST}:${PORT}/mcp`);
    console.log(`Data directory: ${DATA_DIR}`);
    console.log(`AI features: ${AI_CONFIGURED ? 'enabled' : 'disabled (set OPENAI_API_KEY or OPENAI_BASE_URL)'}`);
    console.log(`Live ADO access: ${ADO_CONFIGURED ? 'enabled' : 'disabled (set ADO_PAT or ADO_BEARER_TOKEN)'}`);
    if (process.env.ENABLE_SCHEDULED_REFRESH === '1') {
        startScheduledRefresh();
    } else {
        console.log('Scheduled commit refresh disabled (set ENABLE_SCHEDULED_REFRESH=1 to enable)');
    }
});
