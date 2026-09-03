/** Build an issue-time-window retrieval experiment from the frozen RCA pilot. */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectEvalDataset } from '../eval/lib/dataset-validation.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

function parseArgs(argv) {
    const options = {
        baseDataset: join(projectRoot, 'src', 'eval', 'datasets', 'public-react-rca-pilot-v1'),
        candidates: join(projectRoot, 'data', 'eval', 'grounded-react-rca-all', 'candidates.jsonl'),
        output: join(projectRoot, 'src', 'eval', 'datasets', 'public-react-rca-pilot-v1-time-window-7d-30d'),
        datasetName: 'public-react-rca-pilot-v1-time-window-7d-30d',
        daysBeforeCreated: 7,
        daysAfterClosed: 30,
        force: false,
    };
    for (let index = 0; index < argv.length; index++) {
        const key = argv[index];
        if (key === '--base-dataset') options.baseDataset = resolve(argv[++index]);
        else if (key === '--candidates') options.candidates = resolve(argv[++index]);
        else if (key === '--output') options.output = resolve(argv[++index]);
        else if (key === '--dataset-name') options.datasetName = argv[++index];
        else if (key === '--days-before-created') options.daysBeforeCreated = Number.parseInt(argv[++index], 10);
        else if (key === '--days-after-closed') options.daysAfterClosed = Number.parseInt(argv[++index], 10);
        else if (key === '--force') options.force = true;
        else throw new Error(`Unknown argument: ${key}`);
    }
    for (const [name, value] of Object.entries({
        daysBeforeCreated: options.daysBeforeCreated,
        daysAfterClosed: options.daysAfterClosed,
    })) {
        if (!Number.isInteger(value) || value < 0 || value > 365) throw new Error(`${name} must be between 0 and 365`);
    }
    return options;
}

function displayPath(path) {
    const value = relative(projectRoot, path);
    return value.startsWith('..') ? path : value.replace(/\\/g, '/');
}

function shiftDays(value, days) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid issue timestamp: ${value}`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString();
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (existsSync(options.output) && !options.force) {
        throw new Error(`Output exists: ${options.output}; pass --force deliberately to replace it`);
    }
    const [baseCasesRaw, baseManifestRaw, candidatesRaw] = await Promise.all([
        readFile(join(options.baseDataset, 'cases.jsonl'), 'utf8'),
        readFile(join(options.baseDataset, 'manifest.json'), 'utf8'),
        readFile(options.candidates, 'utf8'),
    ]);
    const baseCases = baseCasesRaw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const baseManifest = JSON.parse(baseManifestRaw);
    const candidates = new Map(
        candidatesRaw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).map(item => [item.id, item]),
    );
    const cases = baseCases.map(baseCase => {
        const problem = candidates.get(baseCase.id)?.problem;
        if (!problem?.createdAt || !problem?.closedAt) throw new Error(`${baseCase.id}: issue timestamps are missing`);
        const dateFrom = shiftDays(problem.createdAt, -options.daysBeforeCreated);
        const dateTo = shiftDays(problem.closedAt, options.daysAfterClosed);
        return {
            ...baseCase,
            filters: { ...(baseCase.filters || {}), dateFrom, dateTo },
            provenance: {
                ...baseCase.provenance,
                issue: { ...baseCase.provenance.issue, createdAt: problem.createdAt, closedAt: problem.closedAt },
            },
            pilot: {
                ...baseCase.pilot,
                retrievalWindow: {
                    source: 'issue-created-and-closed-timestamps',
                    daysBeforeCreated: options.daysBeforeCreated,
                    daysAfterClosed: options.daysAfterClosed,
                    dateFrom,
                    dateTo,
                },
            },
        };
    });
    const validation = inspectEvalDataset(cases);
    if (!validation.passed) throw new Error(`Generated dataset validation failed: ${JSON.stringify(validation.errors)}`);
    const casesRaw = `${cases.map(item => JSON.stringify(item)).join('\n')}\n`;
    const manifest = {
        ...baseManifest,
        dataset: options.datasetName,
        generatedAt: new Date().toISOString(),
        generator: 'src/scripts/build-rca-time-window-dataset.js',
        cases: { ...baseManifest.cases, count: cases.length, sha256: createHash('sha256').update(casesRaw).digest('hex') },
        derivedFrom: {
            dataset: baseManifest.dataset,
            path: displayPath(options.baseDataset),
            caseSha256: createHash('sha256').update(baseCasesRaw).digest('hex'),
        },
        retrievalExperiment: {
            selectedOn: 'dev',
            source: 'GitHub issue createdAt/closedAt; no PR or commit timestamps used',
            daysBeforeCreated: options.daysBeforeCreated,
            daysAfterClosed: options.daysAfterClosed,
            rationale: 'Smallest tested dev window with at least 0.98 relevant-commit coverage.',
        },
    };
    await mkdir(options.output, { recursive: true });
    await writeFile(join(options.output, 'cases.jsonl'), casesRaw);
    await writeFile(join(options.output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify({
        output: displayPath(options.output),
        dataset: manifest.dataset,
        cases: cases.length,
        validation,
        retrievalExperiment: manifest.retrievalExperiment,
    }, null, 2));
}

main().catch(error => {
    console.error(`Time-window dataset build failed: ${error.message}`);
    process.exitCode = 1;
});
