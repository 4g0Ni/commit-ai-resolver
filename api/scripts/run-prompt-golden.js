import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { extractIntent } from '../agents/intent-extractor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const evalDir = join(__dirname, '..', '..', 'src', 'evals');
const cases = JSON.parse(readFileSync(join(evalDir, 'prompt-golden.json'), 'utf8'));
const baselinePath = join(evalDir, 'prompt-golden-baseline.json');
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
const updateBaseline = args.includes('--update-baseline');
const baseURL = process.env.OPENAI_BASE_URL;
if (!process.env.OPENAI_API_KEY && !baseURL) {
    console.error('Set OPENAI_API_KEY or OPENAI_BASE_URL before running the live golden evaluation.');
    process.exit(2);
}

const model = process.env.OPENAI_FAST_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'local', ...(baseURL ? { baseURL } : {}) });
const llm = {
    chat: { completions: { create: params => client.chat.completions.create({ model, ...params }) } },
};

function evaluate(actual, expected) {
    const failures = [];
    for (const key of ['verdict', 'author', 'repo', 'dateFrom', 'dateTo', 'riskLevel', 'changeType']) {
        if (key in expected && actual[key] !== expected[key]) failures.push(`${key}: expected ${expected[key]}, got ${actual[key]}`);
    }
    if (expected.commitIds) {
        for (const id of expected.commitIds) if (!actual.commitIds.includes(id)) failures.push(`missing commit ID ${id}`);
    }
    const searchText = [actual.searchQuery, actual.secondarySearchQuery, ...(actual.keywords || [])].filter(Boolean).join(' ').toLowerCase();
    for (const term of expected.searchTerms || []) {
        if (!searchText.includes(term.toLowerCase())) failures.push(`missing search term ${term}`);
    }
    for (const term of expected.forbiddenTerms || []) {
        if (searchText.includes(term.toLowerCase())) failures.push(`retained forbidden term ${term}`);
    }
    if (expected.secondarySearchRequired && !actual.secondarySearchQuery) failures.push('secondarySearchQuery is required');
    return failures;
}

let passed = 0;
const results = [];
for (const item of cases) {
    const actual = await extractIntent(llm, {
        query: item.query,
        history: item.history || [],
        workItemContext: item.workItemContext || null,
        referenceDate: item.today,
    });
    const failures = evaluate(actual, item.expected);
    if (failures.length === 0) {
        passed++;
        console.log(`✓ ${item.id}`);
    } else {
        console.error(`✗ ${item.id}: ${failures.join('; ')}`);
    }
    results.push({ id: item.id, passed: failures.length === 0, failures, actual });
}

const passRate = passed / cases.length;
const referenceRate = Number(baseline.reference?.passRate);
const hasReference = Number.isFinite(referenceRate) && baseline.reference?.passRate !== null;
const requiredRate = Math.max(
    Number(baseline.minimumPassRate) || 0,
    hasReference ? referenceRate - (Number(baseline.maximumRegression) || 0) : 0,
);
const report = {
    datasetVersion: baseline.datasetVersion,
    model,
    passed,
    total: cases.length,
    passRate,
    requiredRate,
    generatedAt: new Date().toISOString(),
    results,
};

if (outputPath) writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
if (updateBaseline) {
    writeFileSync(baselinePath, `${JSON.stringify({
        ...baseline,
        reference: { model, passRate, recordedAt: report.generatedAt },
    }, null, 2)}\n`);
}

console.log(`\n${passed}/${cases.length} golden cases passed with ${model}; required ${(requiredRate * 100).toFixed(1)}%.`);
process.exit(passRate >= requiredRate ? 0 : 1);
