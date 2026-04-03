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
const PORT = process.env.PORT || 3001;

// --- Azure OpenAI setup ---
const AZURE_OPENAI_ENDPOINT = 'https://chezh-m7lorxce-eastus2.openai.azure.com/';
const AZURE_OPENAI_DEPLOYMENT = 'gpt-4.1';
const AZURE_OPENAI_API_VERSION = '2025-01-01-preview';
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

const app = express();
app.use(cors());
app.use(express.json());

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

// POST /api/chat — chat with LLM about summaries
app.post('/api/chat', async (req, res) => {
    try {
        const { message, history = [] } = req.body;
        if (!message) {
            return res.status(400).json({ error: 'message is required' });
        }

        // Load all available day data as context
        const dates = await listAvailableDates();
        const allData = [];
        for (const date of dates) {
            allData.push(await loadDayData(date));
        }

        const contextText = allData.map(day => {
            const repos = Object.entries(day.repositories).map(([name, repo]) => {
                const commits = repo.commits.map(c =>
                    `  - [${c.summary.riskLevel}] ${c.shortId} by ${c.author}: ${c.summary.title}\n    ${c.summary.summary}${c.summary.flags?.length ? `\n    Flags: ${c.summary.flags.join(', ')}` : ''}`
                ).join('\n');
                return `### ${name} (${repo.stats.total} commits: ${repo.stats.high} HIGH, ${repo.stats.medium} MEDIUM, ${repo.stats.low} LOW)\n${commits}`;
            }).join('\n\n');
            return `## ${day.date}\n${repos}`;
        }).join('\n\n---\n\n');

        const systemPrompt = `You are an expert change analysis assistant for the Microsoft Advertising engineering team.
You have access to daily commit summaries across repositories. Use this data to answer questions about:
- What changed on a specific day or date range
- Which commits might be related to an incident or regression
- Risk assessment of recent changes
- Pilot flag and feature flag changes
- Identifying suspect commits for latency, errors, or crashes

When correlating incidents with changes, consider a 2-day buffer (releases take up to 2 days to reach production).
Always cite specific commit SHAs and authors when referencing changes.
Be concise and actionable.

--- DAILY COMMIT SUMMARIES ---
${contextText}
--- END SUMMARIES ---`;

        const messages = [
            { role: 'system', content: systemPrompt },
            ...history.map(h => ({ role: h.role, content: h.content })),
            { role: 'user', content: message },
        ];

        const result = await openaiClient.chat.completions.create({
            messages,
            temperature: 0.3,
            max_tokens: 2048,
        });

        const reply = result.choices?.[0]?.message?.content ?? 'No response from LLM.';
        res.json({ reply });
    } catch (err) {
        console.error('Chat error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Commit AI Resolver API running on http://localhost:${PORT}`);
    console.log(`Data directory: ${DATA_DIR}`);
});
