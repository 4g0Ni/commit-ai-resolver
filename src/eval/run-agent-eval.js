/** Run the frozen eval cases through a live Commit Resolver API. */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { percentile } from './lib/metrics.js';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
    const args = {
        baseUrl: 'http://127.0.0.1:4399',
        dataset: join(here, 'datasets', 'public-react-v1'),
        output: join(here, 'reports', `agent-${new Date().toISOString().replace(/[:.]/g, '-')}`),
        split: 'test',
        concurrency: 2,
        repeat: 1,
        timeoutMs: 180_000,
        resume: false,
        dryRun: false,
        score: true,
    };
    for (let index = 0; index < argv.length; index++) {
        const key = argv[index];
        if (key === '--base-url') args.baseUrl = argv[++index].replace(/\/$/, '');
        else if (key === '--dataset') args.dataset = resolve(argv[++index]);
        else if (key === '--output') args.output = resolve(argv[++index]);
        else if (key === '--split') args.split = argv[++index];
        else if (key === '--concurrency') args.concurrency = Number.parseInt(argv[++index], 10);
        else if (key === '--repeat') args.repeat = Number.parseInt(argv[++index], 10);
        else if (key === '--timeout-ms') args.timeoutMs = Number.parseInt(argv[++index], 10);
        else if (key === '--resume') args.resume = true;
        else if (key === '--dry-run') args.dryRun = true;
        else if (key === '--no-score') args.score = false;
    }
    if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw new Error('--concurrency must be a positive integer');
    if (!Number.isInteger(args.repeat) || args.repeat < 1) throw new Error('--repeat must be a positive integer');
    return args;
}

async function readJsonl(path) {
    try {
        return (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

function expectedVerdict(evalCase) {
    if (evalCase.expectedBehavior === 'clarify') return 'ASK_USER';
    if (evalCase.expectedBehavior === 'abstain') return 'ABSTAIN';
    return 'SEARCH';
}

function actualVerdict(response) {
    if (response.evidenceGate?.verdict) return response.evidenceGate.verdict;
    if (response.type === 'clarification') return 'ASK_USER';
    return 'SEARCH';
}

async function callCase(task, args) {
    const started = performance.now();
    try {
        const response = await fetch(`${args.baseUrl}/api/chat`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-client': 'eval',
                'x-eval-harness': '1',
            },
            body: JSON.stringify({ message: task.evalCase.query, history: task.evalCase.history || [] }),
            signal: AbortSignal.timeout(args.timeoutMs),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${payload.error || JSON.stringify(payload)}`);
        const intentEntry = (payload.iterationLog || []).find(entry => entry.stage === 'intent-extractor' && entry.status === 'done');
        return {
            caseId: task.evalCase.id,
            category: task.evalCase.category,
            split: task.evalCase.split,
            repeat: task.repeat,
            query: task.evalCase.query,
            expectedBehavior: task.evalCase.expectedBehavior,
            expectedVerdict: expectedVerdict(task.evalCase),
            actualVerdict: actualVerdict(payload),
            behaviorCorrect: actualVerdict(payload) === expectedVerdict(task.evalCase),
            elapsedMs: performance.now() - started,
            ok: true,
            ...payload,
            extractedIntent: intentEntry?.intent || null,
        };
    } catch (error) {
        return {
            caseId: task.evalCase.id,
            category: task.evalCase.category,
            split: task.evalCase.split,
            repeat: task.repeat,
            query: task.evalCase.query,
            expectedBehavior: task.evalCase.expectedBehavior,
            expectedVerdict: expectedVerdict(task.evalCase),
            elapsedMs: performance.now() - started,
            ok: false,
            error: error.message,
        };
    }
}

async function runPool(tasks, concurrency, worker) {
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
        while (next < tasks.length) {
            const index = next++;
            await worker(tasks[index], index);
        }
    });
    await Promise.all(workers);
}

const args = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(await readFile(join(args.dataset, 'manifest.json'), 'utf8'));
const allCases = await readJsonl(join(args.dataset, 'cases.jsonl'));
const selected = args.split === 'all' ? allCases : allCases.filter(item => item.split === args.split);
const tasks = selected.flatMap(evalCase => Array.from({ length: args.repeat }, (_, repeat) => ({ evalCase, repeat: repeat + 1 })));
await mkdir(args.output, { recursive: true });
const rawPath = join(args.output, 'raw-responses.jsonl');
const previous = args.resume ? await readJsonl(rawPath) : [];
if (!args.resume) await writeFile(rawPath, '');
const completed = new Set(previous.filter(item => item.ok).map(item => `${item.caseId}:${item.repeat}`));
const pending = tasks.filter(task => !completed.has(`${task.evalCase.id}:${task.repeat}`));

if (args.dryRun) {
    const preview = { dataset: manifest.dataset, split: args.split, cases: selected.length, repeats: args.repeat, requests: tasks.length, pending: pending.length, output: args.output };
    await writeFile(join(args.output, 'dry-run.json'), `${JSON.stringify(preview, null, 2)}\n`);
    console.log(JSON.stringify(preview, null, 2));
    process.exit(0);
}

const statsResponse = await fetch(`${args.baseUrl}/api/vectors/stats`, { signal: AbortSignal.timeout(10_000) });
if (!statsResponse.ok) throw new Error(`Vector health check failed: HTTP ${statsResponse.status}`);
const vectorStats = await statsResponse.json();
const current = [...previous];
await runPool(pending, args.concurrency, async (task, index) => {
    const result = await callCase(task, args);
    current.push(result);
    await appendFile(rawPath, `${JSON.stringify(result)}\n`);
    console.log(`[${index + 1}/${pending.length}] ${result.caseId}#${result.repeat}: ${result.ok ? result.actualVerdict : `ERROR ${result.error}`}`);
});

const successful = current.filter(item => item.ok);
const responsesPath = join(args.output, 'responses.jsonl');
const intentsPath = join(args.output, 'intents.jsonl');
await writeFile(responsesPath, `${successful.map(item => JSON.stringify({
    caseId: item.caseId,
    reply: item.reply,
    confidence: item.confidence,
    iterations: item.iterations,
    iterationLog: item.iterationLog || [],
})).join('\n')}\n`);
await writeFile(intentsPath, `${successful.filter(item => item.extractedIntent).map(item => JSON.stringify({ caseId: item.caseId, intent: item.extractedIntent })).join('\n')}\n`);

const latencies = successful.map(item => item.elapsedMs);
const summary = {
    dataset: manifest.dataset,
    datasetCaseHash: manifest.cases.sha256,
    split: args.split,
    repeats: args.repeat,
    requested: tasks.length,
    succeeded: successful.length,
    failed: current.filter(item => !item.ok).length,
    behaviorAccuracy: successful.length ? successful.filter(item => item.behaviorCorrect).length / successful.length : null,
    latencyMs: {
        mean: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null,
        p50: percentile(latencies, 0.50),
        p95: percentile(latencies, 0.95),
    },
    api: args.baseUrl,
    vectorStats,
    evalMetadata: successful.find(item => item.evalMetadata)?.evalMetadata || null,
};
await writeFile(join(args.output, 'agent-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

if (args.score && successful.length) {
    const scoreOutput = join(args.output, 'scored');
    const result = spawnSync(process.execPath, [
        join(here, 'run-eval.js'), '--mode', 'index', '--dataset', args.dataset,
        '--responses', responsesPath, '--intents', intentsPath, '--output', scoreOutput,
    ], { cwd: resolve(here, '..'), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`Scoring failed:\n${result.stderr || result.stdout}`);
    summary.scoredOutput = scoreOutput;
    await writeFile(join(args.output, 'agent-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

console.log(JSON.stringify(summary, null, 2));
if (summary.failed) process.exitCode = 1;

