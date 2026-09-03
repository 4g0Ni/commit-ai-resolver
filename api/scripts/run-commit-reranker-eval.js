/** Run the optional LLM commit reranker against a cached retrieval report. */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { rerankCommits, rerankCommitsBatched } from '../agents/commit-reranker.js';
import { percentile, scoreRanking } from '../../src/eval/lib/metrics.js';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '..');
const repoRoot = resolve(apiRoot, '..');
dotenv.config({ path: join(apiRoot, '.env') });

function parseArgs(argv) {
    const args = {
        dataset: join(repoRoot, 'src', 'eval', 'datasets', 'public-react-rca-pilot-v1'),
        report: join(repoRoot, 'src', 'eval', 'reports', 'public-react-rca-pilot-v1-final'),
        vectorsDb: join(repoRoot, 'data', 'enriched', 'public-react-v3-20260827', 'vectors.db'),
        output: join(repoRoot, 'src', 'eval', 'reports', 'public-react-rca-pilot-v1-llm-reranker-k50'),
        channel: 'hybrid',
        candidates: 50,
        concurrency: 1,
        strategy: 'batched-scores',
        batchSize: 5,
        batchConcurrency: 5,
        caseLimit: null,
        split: 'all',
    };
    for (let index = 0; index < argv.length; index++) {
        const key = argv[index];
        if (key === '--dataset') args.dataset = resolve(argv[++index]);
        else if (key === '--report') args.report = resolve(argv[++index]);
        else if (key === '--vectors-db') args.vectorsDb = resolve(argv[++index]);
        else if (key === '--output') args.output = resolve(argv[++index]);
        else if (key === '--channel') args.channel = argv[++index];
        else if (key === '--candidates') args.candidates = Number.parseInt(argv[++index], 10);
        else if (key === '--concurrency') args.concurrency = Number.parseInt(argv[++index], 10);
        else if (key === '--strategy') args.strategy = argv[++index];
        else if (key === '--batch-size') args.batchSize = Number.parseInt(argv[++index], 10);
        else if (key === '--batch-concurrency') args.batchConcurrency = Number.parseInt(argv[++index], 10);
        else if (key === '--case-limit') args.caseLimit = Number.parseInt(argv[++index], 10);
        else if (key === '--split') args.split = argv[++index];
        else if (key === '--help') {
            console.log('node scripts/run-commit-reranker-eval.js [--strategy batched-scores|full-list] [--split all|dev|test] [--case-limit 10] [--candidates 50] [--concurrency 1]');
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${key}`);
        }
    }
    if (!['all', 'dev', 'test'].includes(args.split)) throw new Error('--split must be all, dev, or test');
    if (!['batched-scores', 'full-list'].includes(args.strategy)) throw new Error('--strategy must be batched-scores or full-list');
    if (!Number.isInteger(args.candidates) || args.candidates < 2 || args.candidates > 50) throw new Error('--candidates must be between 2 and 50');
    if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 8) throw new Error('--concurrency must be between 1 and 8');
    if (!Number.isInteger(args.batchSize) || args.batchSize < 2 || args.batchSize > 10) throw new Error('--batch-size must be between 2 and 10');
    if (!Number.isInteger(args.batchConcurrency) || args.batchConcurrency < 1 || args.batchConcurrency > 10) throw new Error('--batch-concurrency must be between 1 and 10');
    if (args.caseLimit !== null && (!Number.isInteger(args.caseLimit) || args.caseLimit < 1)) throw new Error('--case-limit must be positive');
    return args;
}

function readJsonl(value) {
    return String(value || '').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function identity(item) {
    return `${item.repo || ''}:${item.id || String(item.commitId || '').slice(0, 8)}`;
}

function loadMetadata(path) {
    const database = new Database(path, { readonly: true });
    try {
        return new Map(database.prepare('SELECT repo, id, commitId, text, metadata FROM commit_metadata').all().map(row => [
            `${row.repo}:${row.id}`,
            { ...row, metadata: JSON.parse(row.metadata) },
        ]));
    } finally {
        database.close();
    }
}

function enrichCandidates(results, metadata, limit) {
    return results.slice(0, limit).map(result => {
        const record = metadata.get(identity(result));
        if (!record) throw new Error(`Missing metadata for ${identity(result)}`);
        return {
            ...record,
            ...result,
            metadata: record.metadata,
            _retrievalChannels: result.channels || result._retrievalChannels,
        };
    });
}

function metrics(results, gold) {
    return Object.fromEntries([10, 20, 50].map(k => {
        const scored = scoreRanking(results, gold, k);
        return [k, { recall: scored.recallAtK, mrr: scored.mrr, ndcg: scored.ndcg, hit: scored.hitAtK }];
    }));
}

function mean(values) {
    const finite = values.filter(Number.isFinite);
    return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function aggregate(rows, split = null) {
    const selected = rows.filter(row => !split || row.split === split);
    const output = {
        cases: selected.length,
        applied: selected.filter(row => row.applied).length,
        applicationRate: selected.length ? selected.filter(row => row.applied).length / selected.length : null,
        structuredOutputRate: selected.length ? selected.filter(row => row.structuredOutput).length / selected.length : null,
        fallbackRate: selected.length ? selected.filter(row => row.structuredFallback).length / selected.length : null,
        promptOnlyRate: selected.length ? selected.filter(row => !row.structuredOutput && !row.structuredFallback).length / selected.length : null,
        latencyMs: {
            mean: mean(selected.map(row => row.elapsedMs)),
            p95: percentile(selected.map(row => row.elapsedMs), 0.95),
        },
        tokens: {
            prompt: selected.reduce((sum, row) => sum + (row.promptTokens || 0), 0),
            completion: selected.reduce((sum, row) => sum + (row.completionTokens || 0), 0),
            total: selected.reduce((sum, row) => sum + (row.tokens || 0), 0),
            meanPerCase: mean(selected.map(row => row.tokens)),
        },
    };
    for (const ranker of ['original', 'reranked']) {
        output[ranker] = {};
        for (const k of [10, 20, 50]) {
            for (const metric of ['recall', 'mrr', 'ndcg']) {
                output[ranker][`${metric}At${k}`] = mean(selected.map(row => row[`${ranker}Metrics`][k][metric]));
            }
        }
    }
    output.delta = Object.fromEntries(Object.keys(output.reranked).map(key => [key, output.reranked[key] - output.original[key]]));
    return output;
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

const args = parseArgs(process.argv.slice(2));
if (!process.env.OPENAI_API_KEY && !process.env.OPENAI_BASE_URL) {
    throw new Error('No OpenAI-compatible chat configuration found in api/.env or process environment');
}
const model = process.env.LLM_RERANK_MODEL || process.env.OPENAI_FAST_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
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

const cases = readJsonl(await readFile(join(args.dataset, 'cases.jsonl'), 'utf8'));
const retrievalRows = readJsonl(await readFile(join(args.report, 'case-results.jsonl'), 'utf8'));
const retrievalById = new Map(retrievalRows.map(item => [item.id, item]));
const metadata = loadMetadata(args.vectorsDb);
let selected = cases.filter(item => args.split === 'all' || item.split === args.split);
if (args.caseLimit !== null) selected = selected.slice(0, args.caseLimit);

await mkdir(args.output, { recursive: true });
const runConfig = {
    schemaVersion: 1,
    dataset: args.dataset,
    sourceReport: args.report,
    vectorsDb: args.vectorsDb,
    selectedCaseHash: createHash('sha256').update(selected.map(item => item.id).join('\n')).digest('hex'),
    model,
    provider,
    channel: args.channel,
    candidateCount: args.candidates,
    strategy: args.strategy,
    batchSize: args.batchSize,
    thinkingMode: nonThinking ? 'disabled' : 'provider-default',
    structuredOutputMode: process.env.OPENAI_STRUCTURED_OUTPUTS === '0' ? 'prompt-only' : 'json-schema-when-supported',
};
const configPath = join(args.output, 'run-config.json');
try {
    const existingConfig = JSON.parse(await readFile(configPath, 'utf8'));
    if (JSON.stringify(existingConfig) !== JSON.stringify(runConfig)) {
        throw new Error(`Output directory contains a different run configuration: ${configPath}`);
    }
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(configPath, `${JSON.stringify(runConfig, null, 2)}\n`, 'utf8');
}
const resultPath = join(args.output, 'case-results.jsonl');
let completed = [];
try {
    completed = readJsonl(await readFile(resultPath, 'utf8'));
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
const completedIds = new Set(completed.map(item => item.id));
const pending = selected.filter(item => !completedIds.has(item.id));
console.log(JSON.stringify({
    model,
    provider,
    selectedCases: selected.length,
    resumedCases: completed.length,
    pendingCases: pending.length,
    candidates: args.candidates,
    concurrency: args.concurrency,
    strategy: args.strategy,
    batchSize: args.batchSize,
    batchConcurrency: args.batchConcurrency,
    thinkingMode: nonThinking ? 'disabled' : 'provider-default',
    structuredOutputMode: runConfig.structuredOutputMode,
}, null, 2));

await runPool(pending, args.concurrency, async (evalCase, index) => {
    const retrieval = retrievalById.get(evalCase.id);
    if (!retrieval?.channels?.[args.channel]) throw new Error(`Missing ${args.channel} results for ${evalCase.id}`);
    const candidates = enrichCandidates(retrieval.channels[args.channel].topResults, metadata, args.candidates);
    const reranking = args.strategy === 'batched-scores'
        ? await rerankCommitsBatched(llm, evalCase.query, candidates, {
            limit: args.candidates,
            batchSize: args.batchSize,
            concurrency: args.batchConcurrency,
            correlationId: evalCase.id,
        })
        : await rerankCommits(llm, evalCase.query, candidates, {
            limit: args.candidates,
            correlationId: evalCase.id,
        });
    const row = {
        id: evalCase.id,
        split: evalCase.split,
        applied: reranking.applied,
        reason: reranking.reason || null,
        candidateCount: candidates.length,
        strategy: args.strategy,
        batchCount: reranking.batchCount || null,
        batchSize: reranking.batchSize || null,
        scoreHistogram: reranking.scoreHistogram || null,
        promptVersion: reranking._promptVersion || null,
        promptVariant: reranking._promptVariant || null,
        structuredOutput: Boolean(reranking._structuredOutput),
        structuredFallback: Boolean(reranking._structuredFallback),
        promptTokens: reranking._promptTokens || null,
        completionTokens: reranking._completionTokens || null,
        tokens: reranking._tokens || null,
        elapsedMs: reranking._elapsed,
        rationale: reranking.rationale || null,
        originalMetrics: metrics(candidates, evalCase.relevantCommits),
        rerankedMetrics: metrics(reranking.results, evalCase.relevantCommits),
        originalTop20: candidates.slice(0, 20).map(identity),
        rerankedTop20: reranking.results.slice(0, 20).map(identity),
    };
    await appendFile(resultPath, `${JSON.stringify(row)}\n`, 'utf8');
    completed.push(row);
    console.log(`[${completed.length}/${selected.length}] ${evalCase.id} applied=${row.applied} elapsedMs=${row.elapsedMs} tokens=${row.tokens ?? 'n/a'}${row.reason ? ` reason=${row.reason}` : ''}`);
});

// Re-read append order so interrupted/resumed runs have a canonical result set.
const selectedIds = new Set(selected.map(item => item.id));
const finalRows = readJsonl(await readFile(resultPath, 'utf8')).filter(item => selectedIds.has(item.id));
const summary = {
    schemaVersion: 1,
    evaluationPolicy: 'model-prescreened, non-gold, release-gate-ineligible',
    generatedAt: new Date().toISOString(),
    model,
    provider,
    sourceReport: args.report,
    channel: args.channel,
    candidateCount: args.candidates,
    concurrency: args.concurrency,
    strategy: args.strategy,
    batchSize: args.batchSize,
    batchConcurrency: args.batchConcurrency,
    thinkingMode: nonThinking ? 'disabled' : 'provider-default',
    structuredOutputMode: runConfig.structuredOutputMode,
    requestedSplit: args.split,
    requestedCaseLimit: args.caseLimit,
    metrics: {
        all: aggregate(finalRows),
        ...Object.fromEntries(['dev', 'test'].filter(split => finalRows.some(row => row.split === split)).map(split => [split, aggregate(finalRows, split)])),
    },
    failureReasons: Object.fromEntries([...new Set(finalRows.filter(row => !row.applied).map(row => row.reason || 'unknown'))].map(reason => [
        reason,
        finalRows.filter(row => !row.applied && (row.reason || 'unknown') === reason).length,
    ])),
};
await writeFile(join(args.output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(summary, null, 2));
