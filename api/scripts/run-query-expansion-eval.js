/** Evaluate LLM hypothetical-fix queries as recall-only candidate supplements. */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { expandRetrievalQuery } from '../agents/retrieval-query-expander.js';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '..');
const repoRoot = resolve(apiRoot, '..');
const evalRoot = join(repoRoot, 'src', 'eval');
dotenv.config({ path: join(apiRoot, '.env') });

function parseArgs(argv) {
    const args = {
        dataset: join(evalRoot, 'datasets', 'public-react-rca-pilot-v1'),
        rawReport: join(evalRoot, 'reports', 'public-react-rca-pilot-v1-stage1-raw-k100'),
        compactReport: join(evalRoot, 'reports', 'public-react-rca-pilot-v1-stage1-compact-k100'),
        tfidfReport: join(evalRoot, 'reports', 'public-react-rca-pilot-v1-stage1-char-tfidf-title-k100'),
        vectorsDb: join(repoRoot, 'data', 'enriched', 'public-react-v3-20260827', 'vectors.db'),
        output: join(evalRoot, 'reports', 'public-react-rca-pilot-v1-stage1-query-expansion-dev'),
        split: 'dev',
        mode: 'explore',
        baseDepth: 100,
        tfidfDepth: 50,
        expansionDepth: 50,
        channels: ['mechanismQuery', 'fixQuery'],
        concurrency: 4,
        device: 'cuda',
        condaEnv: 'hello-agents',
        caseLimit: null,
    };
    for (let index = 0; index < argv.length; index++) {
        const key = argv[index];
        if (key === '--dataset') args.dataset = resolve(argv[++index]);
        else if (key === '--raw-report') args.rawReport = resolve(argv[++index]);
        else if (key === '--compact-report') args.compactReport = resolve(argv[++index]);
        else if (key === '--tfidf-report') args.tfidfReport = resolve(argv[++index]);
        else if (key === '--vectors-db') args.vectorsDb = resolve(argv[++index]);
        else if (key === '--output') args.output = resolve(argv[++index]);
        else if (key === '--split') args.split = argv[++index];
        else if (key === '--mode') args.mode = argv[++index];
        else if (key === '--base-depth') args.baseDepth = Number.parseInt(argv[++index], 10);
        else if (key === '--tfidf-depth') args.tfidfDepth = Number.parseInt(argv[++index], 10);
        else if (key === '--expansion-depth') args.expansionDepth = Number.parseInt(argv[++index], 10);
        else if (key === '--channels') args.channels = argv[++index].split(',').map(value => value.trim()).filter(Boolean);
        else if (key === '--concurrency') args.concurrency = Number.parseInt(argv[++index], 10);
        else if (key === '--device') args.device = argv[++index];
        else if (key === '--conda-env') args.condaEnv = argv[++index];
        else if (key === '--case-limit') args.caseLimit = Number.parseInt(argv[++index], 10);
        else if (key === '--help') {
            console.log('node scripts/run-query-expansion-eval.js --split dev|test --mode explore|frozen [--channels mechanismQuery,fixQuery] [--expansion-depth 50]');
            process.exit(0);
        } else throw new Error(`Unknown argument: ${key}`);
    }
    const validChannels = new Set(['symptomQuery', 'mechanismQuery', 'fixQuery']);
    if (!['dev', 'test'].includes(args.split)) throw new Error('--split must be dev or test');
    if (!['explore', 'frozen'].includes(args.mode)) throw new Error('--mode must be explore or frozen');
    if (args.channels.length < 1 || args.channels.some(channel => !validChannels.has(channel))) throw new Error('--channels contains an unsupported query field');
    for (const [name, value] of Object.entries({ baseDepth: args.baseDepth, tfidfDepth: args.tfidfDepth, expansionDepth: args.expansionDepth })) {
        if (!Number.isInteger(value) || value < 0 || value > 200) throw new Error(`--${name} must be between 0 and 200`);
    }
    if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 8) throw new Error('--concurrency must be between 1 and 8');
    if (!['cuda', 'cpu'].includes(args.device)) throw new Error('--device must be cuda or cpu');
    return args;
}

function readJsonl(value) {
    return String(value || '').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function identity(item) {
    return `${item.repo || ''}:${item.commitId || item.id || ''}`;
}

function safeProvider(baseURL) {
    if (!baseURL) return 'openai-default';
    try {
        return new URL(baseURL).hostname;
    } catch {
        return 'custom-openai-compatible';
    }
}

async function runPool(items, concurrency, task) {
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const index = next++;
            await task(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

function encodeQueries(queries, args) {
    if (!queries.length) return { model: 'Qwen/Qwen3-Embedding-0.6B', dimensions: 1024, embeddings: [] };
    const payload = JSON.stringify({ queries, device: args.device, batchSize: 32 });
    const python = process.env.EVAL_PYTHON;
    const command = python || 'conda';
    const commandArgs = python
        ? [join(evalRoot, 'embed-queries.py')]
        : ['run', '-n', args.condaEnv, '--no-capture-output', 'python', join(evalRoot, 'embed-queries.py')];
    const result = spawnSync(command, commandArgs, {
        cwd: repoRoot,
        input: payload,
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    if (result.status !== 0) throw new Error(`Query embedding failed:\n${result.stderr || result.stdout}`);
    return JSON.parse(result.stdout);
}

function basePool(evalCase, raw, compact, tfidf, args) {
    const pool = new Set();
    for (const report of [raw, compact]) {
        for (const channel of ['dense', 'lexical']) {
            for (const result of report.get(evalCase.id).channels[channel].topResults.slice(0, args.baseDepth)) pool.add(identity(result));
        }
    }
    if (args.tfidfDepth > 0) {
        for (const result of tfidf.get(evalCase.id).supplementalResults.slice(0, args.tfidfDepth)) pool.add(identity(result));
    }
    return pool;
}

function availability(cases, pools) {
    const recalls = [];
    const sizes = [];
    for (const evalCase of cases) {
        const gold = new Set(evalCase.relevantCommits.map(identity));
        const pool = pools.get(evalCase.id);
        recalls.push([...gold].filter(key => pool.has(key)).length / gold.size);
        sizes.push(pool.size);
    }
    sizes.sort((left, right) => left - right);
    return {
        cases: cases.length,
        recall: recalls.reduce((sum, value) => sum + value, 0) / recalls.length,
        hitRate: recalls.filter(value => value > 0).length / recalls.length,
        missedCases: recalls.filter(value => value === 0).length,
        averagePoolSize: sizes.reduce((sum, value) => sum + value, 0) / sizes.length,
        p95PoolSize: sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.95))],
    };
}

function augmentedPools(cases, basePools, expansionResults, channels, depth) {
    return new Map(cases.map(evalCase => {
        const pool = new Set(basePools.get(evalCase.id));
        const byField = expansionResults.get(evalCase.id) || {};
        for (const channel of channels) {
            for (const result of (byField[channel] || []).slice(0, depth)) pool.add(identity(result));
        }
        return [evalCase.id, pool];
    }));
}

function rescuedCases(cases, before, after) {
    return cases.filter(evalCase => {
        const gold = new Set(evalCase.relevantCommits.map(identity));
        return ![...gold].some(key => before.get(evalCase.id).has(key))
            && [...gold].some(key => after.get(evalCase.id).has(key));
    }).map(item => item.id);
}

const args = parseArgs(process.argv.slice(2));
if (!process.env.OPENAI_API_KEY && !process.env.OPENAI_BASE_URL) throw new Error('No OpenAI-compatible chat configuration found');
const model = process.env.QUERY_EXPANSION_MODEL || process.env.OPENAI_FAST_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const baseURL = process.env.OPENAI_BASE_URL;
const provider = safeProvider(baseURL);
const nonThinking = provider.endsWith('deepseek.com');
const apiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'local',
    ...(baseURL ? { baseURL } : {}),
    timeout: 120_000,
    maxRetries: 2,
});
const llm = {
    chat: {
        completions: {
            create: (params, options) => apiClient.chat.completions.create({
                model,
                ...params,
                ...(nonThinking ? { thinking: { type: 'disabled' } } : {}),
            }, options),
        },
    },
};

const allCases = readJsonl(await readFile(join(args.dataset, 'cases.jsonl'), 'utf8'));
let cases = allCases.filter(item => item.split === args.split);
if (args.caseLimit !== null) cases = cases.slice(0, args.caseLimit);
const raw = new Map(readJsonl(await readFile(join(args.rawReport, 'case-results.jsonl'), 'utf8')).map(item => [item.id, item]));
const compact = new Map(readJsonl(await readFile(join(args.compactReport, 'case-results.jsonl'), 'utf8')).map(item => [item.id, item]));
const tfidf = new Map(readJsonl(await readFile(join(args.tfidfReport, 'case-results.jsonl'), 'utf8')).map(item => [item.id, item]));

await mkdir(args.output, { recursive: true });
const runConfig = {
    schemaVersion: 1,
    dataset: args.dataset,
    selectedCaseHash: createHash('sha256').update(cases.map(item => item.id).join('\n')).digest('hex'),
    model,
    provider,
    split: args.split,
    mode: args.mode,
    baseDepth: args.baseDepth,
    tfidfDepth: args.tfidfDepth,
    expansionDepth: args.expansionDepth,
    channels: args.channels,
    thinkingMode: nonThinking ? 'disabled' : 'provider-default',
};
const configPath = join(args.output, 'run-config.json');
try {
    const existing = JSON.parse(await readFile(configPath, 'utf8'));
    if (JSON.stringify(existing) !== JSON.stringify(runConfig)) throw new Error(`Output directory contains a different run configuration: ${configPath}`);
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(configPath, `${JSON.stringify(runConfig, null, 2)}\n`, 'utf8');
}

const expansionPath = join(args.output, 'expansions.jsonl');
let completed = [];
try {
    completed = readJsonl(await readFile(expansionPath, 'utf8'));
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
const completedIds = new Set(completed.map(item => item.id));
const pending = cases.filter(item => !completedIds.has(item.id));
console.log(JSON.stringify({ model, provider, split: args.split, mode: args.mode, selected: cases.length, resumed: completed.length, pending: pending.length }, null, 2));
await runPool(pending, args.concurrency, async evalCase => {
    const expansion = await expandRetrievalQuery(llm, evalCase.query);
    const row = {
        id: evalCase.id,
        split: evalCase.split,
        applied: expansion.applied,
        queries: expansion.queries,
        reason: expansion.reason || null,
        elapsedMs: expansion._elapsed,
        promptTokens: expansion._promptTokens || 0,
        completionTokens: expansion._completionTokens || 0,
        tokens: expansion._tokens || 0,
        structuredOutput: Boolean(expansion._structuredOutput),
        structuredFallback: Boolean(expansion._structuredFallback),
        promptVersion: expansion._promptVersion,
    };
    await appendFile(expansionPath, `${JSON.stringify(row)}\n`, 'utf8');
    console.log(`[${completedIds.size + 1}/${cases.length}] ${evalCase.id} applied=${row.applied} elapsedMs=${row.elapsedMs} tokens=${row.tokens}${row.reason ? ` reason=${row.reason}` : ''}`);
    completedIds.add(evalCase.id);
});

completed = readJsonl(await readFile(expansionPath, 'utf8'));
const expansionById = new Map(completed.map(item => [item.id, item]));
const requests = [];
for (const evalCase of cases) {
    for (const item of expansionById.get(evalCase.id)?.queries || []) {
        requests.push({ caseId: evalCase.id, field: item.field, query: item.query, embeddingIndex: requests.length });
    }
}
const encoded = encodeQueries(requests.map(item => item.query), args);
if (encoded.model !== 'Qwen/Qwen3-Embedding-0.6B' || encoded.dimensions !== 1024) throw new Error('Unexpected query embedding contract');
process.env.OPENAI_EMBEDDING_MODEL = encoded.model;
process.env.OPENAI_EMBEDDING_DIMENSIONS = String(encoded.dimensions);
process.env.EMBEDDING_DOCUMENT_TEMPLATE_VERSION = '2';
process.env.VECTORS_DB = args.vectorsDb;
const vectorStore = await import(pathToFileURL(join(repoRoot, 'src', 'services', 'vector-store.js')).href);
const caseById = new Map(cases.map(item => [item.id, item]));
const expansionResults = new Map(cases.map(item => [item.id, {}]));
for (let index = 0; index < requests.length; index++) {
    const request = requests[index];
    const evalCase = caseById.get(request.caseId);
    expansionResults.get(request.caseId)[request.field] = await vectorStore.searchVectors(
        encoded.embeddings[request.embeddingIndex],
        { ...(evalCase.filters || {}), topK: args.expansionDepth, minScore: 0 },
    );
    process.stdout.write(`\rExpansion retrieval ${index + 1}/${requests.length}`);
}
process.stdout.write('\n');
vectorStore.closeVectorStore();

const basePools = new Map(cases.map(evalCase => [evalCase.id, basePool(evalCase, raw, compact, tfidf, args)]));
const configurations = {};
if (args.mode === 'explore') {
    const channelSets = [
        ['symptomQuery'],
        ['mechanismQuery'],
        ['fixQuery'],
        ['mechanismQuery', 'fixQuery'],
        ['symptomQuery', 'mechanismQuery', 'fixQuery'],
    ];
    const depths = [...new Set([10, 25, args.expansionDepth].filter(value => value > 0 && value <= args.expansionDepth))].sort((a, b) => a - b);
    for (const channels of channelSets) {
        for (const depth of depths) {
            const name = `${channels.join('+')}@${depth}`;
            const pools = augmentedPools(cases, basePools, expansionResults, channels, depth);
            configurations[name] = { channels, depth, metrics: availability(cases, pools), rescuedCases: rescuedCases(cases, basePools, pools) };
        }
    }
} else {
    const name = `${args.channels.join('+')}@${args.expansionDepth}`;
    const pools = augmentedPools(cases, basePools, expansionResults, args.channels, args.expansionDepth);
    configurations[name] = { channels: args.channels, depth: args.expansionDepth, metrics: availability(cases, pools), rescuedCases: rescuedCases(cases, basePools, pools) };
}

const resultRows = cases.map(evalCase => ({
    id: evalCase.id,
    split: evalCase.split,
    gold: evalCase.relevantCommits.map(identity),
    basePoolSize: basePools.get(evalCase.id).size,
    queries: expansionById.get(evalCase.id)?.queries || [],
    expansionResults: Object.fromEntries(Object.entries(expansionResults.get(evalCase.id)).map(([field, results]) => [field, results.map((item, rank) => ({
        rank: rank + 1,
        repo: item.repo,
        id: item.id,
        commitId: item.commitId,
        score: item.score,
    }))])),
}));
await writeFile(join(args.output, 'case-results.jsonl'), `${resultRows.map(item => JSON.stringify(item)).join('\n')}\n`, 'utf8');

const selectedExpansions = cases.map(item => expansionById.get(item.id)).filter(Boolean);
const summary = {
    schemaVersion: 1,
    evaluationPolicy: 'model-prescreened, non-gold, release-gate-ineligible',
    generatedAt: new Date().toISOString(),
    model,
    provider,
    split: args.split,
    mode: args.mode,
    generation: {
        cases: cases.length,
        applied: selectedExpansions.filter(item => item.applied).length,
        applicationRate: selectedExpansions.filter(item => item.applied).length / cases.length,
        meanLatencyMs: selectedExpansions.reduce((sum, item) => sum + item.elapsedMs, 0) / cases.length,
        tokens: {
            prompt: selectedExpansions.reduce((sum, item) => sum + item.promptTokens, 0),
            completion: selectedExpansions.reduce((sum, item) => sum + item.completionTokens, 0),
            total: selectedExpansions.reduce((sum, item) => sum + item.tokens, 0),
        },
    },
    embedding: { model: encoded.model, dimensions: encoded.dimensions, queries: requests.length },
    basePool: {
        rawCompactDepthPerChannel: args.baseDepth,
        charTfidfTitleDepth: args.tfidfDepth,
        metrics: availability(cases, basePools),
    },
    configurations,
};
await writeFile(join(args.output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(summary, null, 2));
