/** Build a non-gold pilot eval dataset from model-prescreened GitHub RCA candidates. */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDailyCorpus } from '../eval/lib/corpus.js';
import { inspectEvalDataset } from '../eval/lib/dataset-validation.js';
import { groundedRcaSelectionArea } from '../services/github-rca-grounding.js';
import { buildModelPrescreenedRcaCase } from '../services/grounded-rca-review.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

function parseArgs(argv) {
    const options = {
        dataRoot: join(projectRoot, 'data', 'enriched', 'public-react-v3-20260827'),
        candidates: join(projectRoot, 'data', 'eval', 'grounded-react-rca-all', 'candidates.jsonl'),
        datasetName: 'public-react-rca-pilot-v1',
        output: null,
        force: false,
    };
    for (let index = 0; index < argv.length; index++) {
        const key = argv[index];
        if (key === '--data-dir') options.dataRoot = resolve(argv[++index]);
        else if (key === '--candidates') options.candidates = resolve(argv[++index]);
        else if (key === '--dataset-name') options.datasetName = argv[++index];
        else if (key === '--output') options.output = resolve(argv[++index]);
        else if (key === '--force') options.force = true;
        else if (key === '--help') {
            console.log('node scripts/build-rca-pilot-dataset.js [--data-dir enriched-root] [--candidates file] [--dataset-name public-react-rca-pilot-v1] [--output directory] [--force]');
            process.exit(0);
        } else throw new Error(`Unknown argument: ${key}`);
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(options.datasetName)) throw new Error('--dataset-name must be filesystem-safe');
    options.output ||= join(projectRoot, 'src', 'eval', 'datasets', options.datasetName);
    return options;
}

function displayPath(path) {
    const result = relative(projectRoot, path);
    return result.startsWith('..') ? path : result.replace(/\\/g, '/');
}

function countBy(values) {
    const counts = {};
    for (const value of values) counts[value] = (counts[value] || 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (!existsSync(options.candidates)) throw new Error(`Candidate file not found: ${options.candidates}`);
    if (existsSync(options.output) && !options.force) throw new Error(`Pilot dataset output already exists: ${options.output}; choose a new version or pass --force deliberately`);

    const corpus = await loadDailyCorpus(join(options.dataRoot, 'daily'));
    const corpusByCommitId = new Map(corpus.commits.map(commit => [String(commit.commitId).toLowerCase(), commit]));
    const candidatesRaw = await readFile(options.candidates, 'utf8');
    const candidates = candidatesRaw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    if (!candidates.length) throw new Error('Candidate file is empty');
    if (new Set(candidates.map(item => item.id)).size !== candidates.length) throw new Error('Candidate IDs must be unique');

    const cases = candidates.map(candidate => {
        const evalCase = buildModelPrescreenedRcaCase(candidate, corpusByCommitId);
        evalCase.pilot.primaryArea = groundedRcaSelectionArea(candidate);
        return evalCase;
    });
    const validation = inspectEvalDataset(cases);
    if (!validation.passed) throw new Error(`Generated pilot provenance validation failed: ${JSON.stringify(validation.errors)}`);
    const jsonl = `${cases.map(item => JSON.stringify(item)).join('\n')}\n`;
    const qualityScores = countBy(cases.map(item => String(item.pilot.qualityScore ?? 'missing')));
    const selectionAreas = countBy(cases.map(item => item.pilot.primaryArea));
    const evaluationPolicy = {
        displayLabel: '模型预审、非 gold、不可用于 release gate',
        labelStatus: 'model-prescreened',
        gold: false,
        releaseGateEligible: false,
        intendedUse: ['pipeline shakeout', 'retrieval diagnostics', 'failure analysis', 'human-review prioritization'],
        prohibitedUse: ['release gate', 'production quality claim', 'baseline promotion without human review'],
    };
    const manifest = {
        schemaVersion: 1,
        dataset: options.datasetName,
        generatedAt: new Date().toISOString(),
        generator: 'src/scripts/build-rca-pilot-dataset.js',
        corpus: {
            path: displayPath(join(options.dataRoot, 'daily')),
            sha256: corpus.corpusHash,
            files: corpus.files.length,
            commits: corpus.commits.length,
            repos: [...new Set(corpus.commits.map(item => item.repo))].sort(),
            dateRange: corpus.dateRange,
        },
        cases: {
            count: cases.length,
            sha256: createHash('sha256').update(jsonl).digest('hex'),
            byCategory: { issue_rca_pilot: cases.length },
            bySplit: { pilot: cases.length },
        },
        candidates: {
            source: displayPath(options.candidates),
            sha256: createHash('sha256').update(candidatesRaw).digest('hex'),
            qualityScores,
            selectionAreas,
        },
        evaluationPolicy,
        labelPolicy: 'Issue-to-closing-PR-to-corpus-commit provenance is machine-verifiable, but problem fidelity, fix completeness, and query usability have not received human approval. Every case is model-prescreened and non-gold.',
    };
    await mkdir(options.output, { recursive: true });
    await writeFile(join(options.output, 'cases.jsonl'), jsonl);
    await writeFile(join(options.output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify(manifest, null, 2));
}

main().catch(error => {
    console.error(`RCA pilot dataset build failed: ${error.message}`);
    process.exitCode = 1;
});
