/**
 * Backend API server for Commit AI Resolver dashboard.
 *
 * Serves daily summary JSON files and provides a chat endpoint
 * that uses Azure OpenAI to answer questions about commit summaries.
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
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { randomUUID } from 'crypto';
import { readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DefaultAzureCredential } from '@azure/identity';
import { AzureOpenAI } from 'openai';
import { logQuery, logQueryStub, recordFeedback, getFeedbackStats, getRecentFeedback, getUsageMetrics } from './db.js';
import { initAria } from './telemetry/aria-client.js';
import { logInfo, logError } from './telemetry/column-whitelist.js';
import { startScheduledRefresh } from '../src/services/scheduled-refresh.js';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { isInitializeRequest } from '@modelcontextprotocol/server';
import { createMcpServer } from './mcp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data', 'daily');
const NO_AUTH = process.argv.includes('--no-auth') || process.env.NO_AUTH === '1';
const PORT = process.env.PORT || 4399;

// --- Azure OpenAI setup ---
const AZURE_OPENAI_ENDPOINT = 'https://yizha-maz2xf24-swedencentral.openai.azure.com/';
const AZURE_OPENAI_DEPLOYMENT = 'gpt-5.4';
const AZURE_OPENAI_MINI_DEPLOYMENT = 'gpt-5.4-mini';
const AZURE_OPENAI_API_VERSION = '2025-04-01-preview';
const EMBEDDING_DEPLOYMENT = 'text-embedding-3-large';
const EMBEDDING_API_VERSION = '2023-05-15';
const COGNITIVE_SERVICES_SCOPE = 'https://cognitiveservices.azure.com/.default';

const credential = new DefaultAzureCredential();
const openaiClient = new AzureOpenAI({
    endpoint: AZURE_OPENAI_ENDPOINT,
    apiKey: '',
    azureADTokenProvider: () =>
        credential.getToken(COGNITIVE_SERVICES_SCOPE).then(at => at.token),
    apiVersion: AZURE_OPENAI_API_VERSION,
    deployment: AZURE_OPENAI_DEPLOYMENT,
});

const embeddingClient = new AzureOpenAI({
    endpoint: AZURE_OPENAI_ENDPOINT,
    apiKey: '',
    azureADTokenProvider: () =>
        credential.getToken(COGNITIVE_SERVICES_SCOPE).then(at => at.token),
    apiVersion: EMBEDDING_API_VERSION,
    deployment: EMBEDDING_DEPLOYMENT,
});

const openaiMiniClient = new AzureOpenAI({
    endpoint: AZURE_OPENAI_ENDPOINT,
    apiKey: '',
    azureADTokenProvider: () =>
        credential.getToken(COGNITIVE_SERVICES_SCOPE).then(at => at.token),
    apiVersion: AZURE_OPENAI_API_VERSION,
    deployment: AZURE_OPENAI_MINI_DEPLOYMENT,
});

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

// --- Azure AD JWT auth middleware ---
const AZURE_CLIENT_ID = 'bc4d2d3c-b205-42f4-90f6-8bac756fd7f5';
const AZURE_TENANT_ID = '72f988bf-86f1-41af-91ab-2d7cd011db47';

const jwksRsaClient = jwksClient({
    jwksUri: `https://login.microsoftonline.com/${AZURE_TENANT_ID}/discovery/v2.0/keys`,
    cache: true,
    rateLimit: true,
});

function getSigningKey(header, callback) {
    jwksRsaClient.getSigningKey(header.kid, (err, key) => {
        if (err) return callback(err);
        callback(null, key.getPublicKey());
    });
}

function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    const token = authHeader.slice(7);
    jwt.verify(token, getSigningKey, {
        audience: AZURE_CLIENT_ID,
        issuer: `https://login.microsoftonline.com/${AZURE_TENANT_ID}/v2.0`,
        algorithms: ['RS256'],
    }, (err, decoded) => {
        if (err) return res.status(401).json({ error: 'Invalid token' });
        req.user = {
            id: decoded.oid,
            email: decoded.preferred_username || decoded.upn || decoded.email,
            name: decoded.name,
        };
        next();
    });
}

app.use('/api', NO_AUTH ? (req, res, next) => {
    req.user = { id: 'test-user', email: 'test@test.local', name: 'Test User' };
    next();
} : authMiddleware);

if (NO_AUTH) console.log('⚠ Auth disabled (--no-auth)');

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
import { searchVectors, lookupByCommitIds, getVectorStats } from '../src/services/vector-store.js';

// --- Release list ---
import { fetchReleaseList } from '../src/services/ado-git-client.js';
// --- Agentic search ---
import { agenticSearch } from './agents/orchestrator.js';

// --- Deep investigation ---
import { investigateDiffs } from './agents/diff-investigator.js';
import { fetchCommitChanges, fetchCommitDiff, fetchWorkItem } from '../src/services/ado-git-client.js';
import { REPOSITORIES } from '../src/config/repositories.js';
import { detectWorkItemUrls } from '../src/services/workitem-detector.js';

/** Generate a query embedding using the embedding client (with LRU cache). */
const _embeddingCache = new Map();
const EMBEDDING_CACHE_MAX = 100;

async function embedQuery(text) {
    if (_embeddingCache.has(text)) {
        return _embeddingCache.get(text);
    }
    const result = await embeddingClient.embeddings.create({
        input: [text],
        model: EMBEDDING_DEPLOYMENT,
    });
    const embedding = result.data[0].embedding;
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

/**
 * Use a lightweight LLM call to extract structured search filters from a natural language query.
 * Returns: { author, repo, dateFrom, dateTo, searchQuery }
 * @deprecated Kept for backward compatibility. The agentic pipeline uses intent-extractor agent instead.
 */
async function extractQueryIntent(query) {
    const today = new Date().toISOString().slice(0, 10);
    const repoList = 'AdsAppsCampaignUI, AdsAppsMT, AdsAppUI, AnB, AdsAppsDB';
    const prompt = `Extract search filters from the user's question about code commits. Today is ${today}.

Return ONLY a JSON object with these fields (use null for missing):
- "author": full person name if the user is asking about a specific person's commits (null if not person-specific)
- "repo": exact repo name from [${repoList}] if mentioned (null if not repo-specific)
- "dateFrom": start date YYYY-MM-DD if a time range is mentioned (null if open-ended)
- "dateTo": end date YYYY-MM-DD if a time range is mentioned (null if open-ended)
- "searchQuery": a rewritten version of the query optimized for semantic search against commit summaries. Remove person names and date references, keep the technical intent. This should be what we embed for vector similarity search.

Examples:
User: "what did Beina Zhang change last week"
{"author":"Beina Zhang","repo":null,"dateFrom":"${daysAgo(7, today)}","dateTo":"${today}","searchQuery":"code changes and modifications"}

User: "any store page crashes in CampaignUI recently"
{"author":null,"repo":"AdsAppsCampaignUI","dateFrom":null,"dateTo":null,"searchQuery":"store page crash error bug"}

User: "what high risk changes were deployed yesterday"
{"author":null,"repo":null,"dateFrom":"${daysAgo(1, today)}","dateTo":"${daysAgo(1, today)}","searchQuery":"high risk changes deployment"}

User: "show pilot flag changes"
{"author":null,"repo":null,"dateFrom":null,"dateTo":null,"searchQuery":"pilot flag feature gate config changes"}

Now extract from:
User: "${query.replace(/"/g, '\\"')}"`;

    try {
        const result = await openaiClient.chat.completions.create({
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            max_completion_tokens: 256,
        });
        const text = result.choices?.[0]?.message?.content?.trim() || '{}';
        // Extract JSON from response (handle markdown code blocks)
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { searchQuery: query };
        const parsed = JSON.parse(jsonMatch[0]);
        return {
            author: parsed.author || null,
            repo: parsed.repo || null,
            dateFrom: parsed.dateFrom || null,
            dateTo: parsed.dateTo || null,
            searchQuery: parsed.searchQuery || query,
        };
    } catch (err) {
        console.error('  Intent extraction failed:', err.message);
        return { searchQuery: query };
    }
}

function daysAgo(n, today) {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
}

// POST /api/chat — Agentic search pipeline with iterative refinement
app.post('/api/chat', async (req, res) => {
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
        if (detected.workItemIds.length > 0) {
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
            const result = await agenticSearch({
                llm: openaiClient,
                llmFast: openaiMiniClient,
                embedQuery,
                searchVectors,
                lookupByCommitIds,
                buildFullContext,
                query: message,
                history,
                maxIterations: 5,
                workItemContext,
                correlationId: queryId,
                onProgress: (iteration, stage, details) => {
                    const stageMessages = {
                        'intent-extractor': 'Extracting intent...',
                        'rag-search': details.status === 'done'
                            ? `Found ${details.resultCount} results`
                            : 'Searching commits...',
                        'rag-search-secondary': 'Running secondary search...',
                        'rag-search-title': 'Searching by title...',
                        'answer-synthesizer': details.status === 'running'
                            ? 'Generating answer...'
                            : undefined,
                        'answer-evaluator': 'Evaluating answer quality...',
                        'retry': `Refining search (attempt ${iteration})...`,
                    };
                    const msg = stageMessages[stage];
                    if (msg) sendEvent('status', { stage, iteration, message: msg });
                },
                onToken: (token) => {
                    sendEvent('token', { token });
                },
            });
            const totalMs = Date.now() - t0;
            console.log(`  Agentic search (SSE): ${result.searchMethod}, ${result.iterations} iteration(s), ${totalMs}ms`);

            logInfo('ChatQuery', {
                CorrelationId: queryId,
                Component: 'chat-sse',
                Query: message.slice(0, 500),
                ResultCount: result.resultCount,
                Confidence: result.confidence,
                Verdict: result.searchMethod,
                ElapsedMs: totalMs,
                SuspectsCount: result.suspects?.length || 0,
                SessionId: req.headers['x-session-id'] || null,
            });

            try {
                logQuery({
                    id: queryId,
                    query: message,
                    response: result.reply,
                    confidence: result.confidence,
                    iterations: result.iterations,
                    searchMethod: result.searchMethod,
                    resultCount: result.resultCount,
                    iterationLog: result.iterationLog,
                    workItemId: workItemContext?.id?.toString(),
                    workItemTitle: workItemContext?.title,
                    elapsedMs: totalMs,
                    userId: req.user?.email || req.user?.id,
                });
            } catch (dbErr) {
                console.error('  [Telemetry] Failed to log query:', dbErr.message);
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
                ...(result.type === 'clarification' ? { question: result.question } : {}),
            });
            res.end();

        } else if (useVectors) {
            // --- Agentic pipeline ---
            const t0 = Date.now();
            const result = await agenticSearch({
                llm: openaiClient,
                llmFast: openaiMiniClient,
                embedQuery,
                searchVectors,
                lookupByCommitIds,
                buildFullContext,
                query: message,
                history,
                maxIterations: 5,
                workItemContext,
                correlationId: queryId,
                onProgress: (iteration, stage, details) => {
                    // Log progress server-side
                },
            });
            const totalMs = Date.now() - t0;
            console.log(`  Agentic search: ${result.searchMethod}, ${result.iterations} iteration(s), ${totalMs}ms`);

            logInfo('ChatQuery', {
                CorrelationId: queryId,
                Component: 'chat-json',
                Query: message.slice(0, 500),
                ResultCount: result.resultCount,
                Confidence: result.confidence,
                Verdict: result.searchMethod,
                ElapsedMs: totalMs,
                SuspectsCount: result.suspects?.length || 0,
                SessionId: req.headers['x-session-id'] || null,
            });

            // Log to telemetry DB
            try {
                logQuery({
                    id: queryId,
                    query: message,
                    response: result.reply,
                    confidence: result.confidence,
                    iterations: result.iterations,
                    searchMethod: result.searchMethod,
                    resultCount: result.resultCount,
                    iterationLog: result.iterationLog,
                    workItemId: workItemContext?.id?.toString(),
                    workItemTitle: workItemContext?.title,
                    elapsedMs: totalMs,
                    userId: req.user?.email || req.user?.id,
                });
            } catch (dbErr) {
                console.error('  [Telemetry] Failed to log query:', dbErr.message);
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
                ...(result.type === 'clarification' ? { question: result.question } : {}),
            });
        } else {
            // --- Fallback: stuff all data into context (no vector store) ---
            const contextText = await buildFullContext();

            const systemPrompt = `You are an expert change analysis assistant for the Microsoft Advertising engineering team.
You have access to commit summaries across repositories.
Use this data to answer questions about:
- What changed on a specific day or date range
- Which commits might be related to an incident or regression
- Risk assessment of recent changes
- Pilot flag and feature flag changes
- Identifying suspect commits for latency, errors, or crashes

When correlating incidents with changes, consider a 2-day buffer (releases take up to 2 days to reach production).
Always cite specific commit SHAs and authors when referencing changes.
For EVERY commit you mention, include a clickable markdown link using the URL from the data. Format: [shortId](url). If a URL is "N/A" or missing, just show the SHA.
Be concise and actionable.

--- COMMIT SUMMARIES (full) ---
${contextText}
--- END SUMMARIES ---`;

            const messages = [
                { role: 'system', content: systemPrompt },
                ...history.map(h => ({ role: h.role, content: h.content })),
                { role: 'user', content: message },
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
                    userId: req.user?.email || req.user?.id,
                });
            } catch (dbErr) {
                console.error('  [Telemetry] Failed to log query:', dbErr.message);
            }

            res.json({ queryId, reply, searchMethod: 'full', type: 'answer' });
        }
    } catch (err) {
        console.error('Chat error:', err);
        logError('ChatError', {
            CorrelationId: req.body?.message ? randomUUID() : undefined,
            Component: 'chat',
            ErrorMessage: err.message,
            ErrorStack: err.stack?.slice(0, 1000),
            Query: req.body?.message?.slice(0, 500),
            HttpStatus: 500,
        });
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

        logInfo('Investigation', {
            CorrelationId: investigateId,
            Component: 'investigate',
            Query: message.slice(0, 500),
            Confidence: result.confidence,
            ElapsedMs: totalMs,
            SuspectsCount: result.suspectsAnalyzed,
        });
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
        logError('InvestigateError', {
            Component: 'investigate',
            ErrorMessage: err.message,
            ErrorStack: err.stack?.slice(0, 1000),
            Query: req.body?.message?.slice(0, 500),
            HttpStatus: 500,
        });
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
                });
                recordFeedback({ queryId, vote, comment });
            } else {
                throw err;
            }
        }

        console.log(`  [Feedback] ${vote} for ${queryId}${comment ? ' — ' + comment.slice(0, 50) : ''}`);
        logInfo('Feedback', {
            CorrelationId: queryId,
            Component: 'feedback',
            Message: vote,
            Query: comment?.slice(0, 500) || null,
        });
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
        res.json(metrics);
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
    lookupByCommitIds,
    getVectorStats,
    listAvailableDates,
    loadDayData,
};

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
            const server = createMcpServer(mcpDeps);
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
        if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/mcp')) return next();
        res.sendFile(join(UI_DIST, 'index.html'));
    });
}

app.listen(PORT, () => {
    console.log(`Commit AI Resolver API running on http://localhost:${PORT}`);
    console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log(`Data directory: ${DATA_DIR}`);
    initAria();
    startScheduledRefresh();
});
