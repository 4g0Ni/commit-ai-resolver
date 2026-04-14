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

import express from 'express';
import cors from 'cors';
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DefaultAzureCredential } from '@azure/identity';
import { AzureOpenAI } from 'openai';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data', 'daily');
const PORT = process.env.PORT || 4399;

// --- Azure OpenAI setup ---
const AZURE_OPENAI_ENDPOINT = 'https://yizha-maz2xf24-swedencentral.openai.azure.com/';
const AZURE_OPENAI_DEPLOYMENT = 'gpt-5.4';
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

const app = express();
app.use(cors());
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
    const repoList = 'AdsAppsCampaignUI, AdsAppsMT, AdsAppUI';
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

        if (useVectors) {
            // --- Agentic pipeline ---
            const t0 = Date.now();
            const result = await agenticSearch({
                llm: openaiClient,
                embedQuery,
                searchVectors,
                lookupByCommitIds,
                buildFullContext,
                query: message,
                history,
                maxIterations: 5,
                workItemContext,
                onProgress: (iteration, stage, details) => {
                    // Log progress server-side
                },
            });
            const totalMs = Date.now() - t0;
            console.log(`  Agentic search: ${result.searchMethod}, ${result.iterations} iteration(s), ${totalMs}ms`);

            res.json({
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
            res.json({ reply, searchMethod: 'full', type: 'answer' });
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
    try {
        const { message, suspects = [], history = [] } = req.body;
        if (!message || suspects.length === 0) {
            return res.status(400).json({ error: 'message and suspects are required' });
        }

        console.log(`  Investigate: "${message.slice(0, 80)}" — ${suspects.length} suspect(s)`);
        const t0 = Date.now();

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

        res.json({
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

app.listen(PORT, () => {
    console.log(`Commit AI Resolver API running on http://localhost:${PORT}`);
    console.log(`Data directory: ${DATA_DIR}`);
});
