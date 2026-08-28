/** Build a frozen eval dataset from explicitly human-approved GitHub RCA candidates. */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDailyCorpus } from '../eval/lib/corpus.js';
import { buildReviewedRcaCase, reviewDecisionCounts } from '../services/grounded-rca-review.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

function parseArgs(argv) {
    const options = {
        dataRoot: join(projectRoot, 'data', 'enriched', 'public-react-v3-20260827'),
        candidates: join(projectRoot, 'data', 'eval', 'grounded-react-rca', 'candidates.jsonl'),
        reviews: join(projectRoot, 'data', 'eval', 'grounded-react-rca', 'reviews.jsonl'),
        datasetName: 'public-react-rca-v1',
        output: null,
        minimumApproved: 30,
        force: false,
    };
    for (let index = 0; index < argv.length; index++) {
        const key = argv[index];
        if (key === '--data-dir') options.dataRoot = resolve(argv[++index]);
        else if (key === '--candidates') options.candidates = resolve(argv[++index]);
        else if (key === '--reviews') options.reviews = resolve(argv[++index]);
        else if (key === '--dataset-name') options.datasetName = argv[++index];
        else if (key === '--output') options.output = resolve(argv[++index]);
        else if (key === '--minimum-approved') options.minimumApproved = Number.parseInt(argv[++index], 10);
        else if (key === '--force') options.force = true;
        else if (key === '--help') {
            console.log('node scripts/build-grounded-rca-dataset.js [--data-dir enriched-root] [--candidates file] [--reviews file] [--dataset-name public-react-rca-v1] [--minimum-approved 30] [--force]');
            process.exit(0);
        } else throw new Error(`Unknown argument: ${key}`);
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(options.datasetName)) throw new Error('--dataset-name must be filesystem-safe');
    if (!Number.isInteger(options.minimumApproved) || options.minimumApproved < 1) throw new Error('--minimum-approved must be a positive integer');
    options.output ||= join(projectRoot, 'src', 'eval', 'datasets', options.datasetName);
    return options;
}

async function readJsonl(path) {
    return (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function displayPath(path) {
    const result = relative(projectRoot, path);
    return result.startsWith('..') ? path : result.replace(/\\/g, '/');
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (!existsSync(options.candidates)) throw new Error(`Candidate file not found: ${options.candidates}`);
    if (!existsSync(options.reviews)) {
        throw new Error(`Review file not found: ${options.reviews}. Copy review-template.jsonl to reviews.jsonl and complete the rubric first.`);
    }
    if (existsSync(options.output) && !options.force) throw new Error(`Frozen dataset output already exists: ${options.output}; choose a new version or pass --force deliberately`);
    const corpus = await loadDailyCorpus(join(options.dataRoot, 'daily'));
    const corpusByCommitId = new Map(corpus.commits.map(commit => [String(commit.commitId).toLowerCase(), commit]));
    const candidates = await readJsonl(options.candidates);
    const reviewsRaw = await readFile(options.reviews, 'utf8');
    const reviews = reviewsRaw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const candidateById = new Map(candidates.map(item => [item.id, item]));
    if (candidateById.size !== candidates.length) throw new Error('Candidate IDs must be unique');
    const reviewById = new Map();
    for (const review of reviews) {
        if (!review.id || reviewById.has(review.id)) throw new Error(`Review IDs must be present and unique: ${review.id || 'missing'}`);
        if (!candidateById.has(review.id)) throw new Error(`Review references unknown candidate: ${review.id}`);
        reviewById.set(review.id, review);
    }
    const approvedReviews = reviews.filter(item => item.decision === 'approve');
    if (approvedReviews.length < options.minimumApproved) {
        throw new Error(`Only ${approvedReviews.length} approved reviews; at least ${options.minimumApproved} are required to freeze ${options.datasetName}`);
    }
    const cases = approvedReviews.map(review => buildReviewedRcaCase(candidateById.get(review.id), review, corpusByCommitId));
    const jsonl = `${cases.map(item => JSON.stringify(item)).join('\n')}\n`;
    const bySplit = Object.fromEntries(['dev', 'test'].map(split => [split, cases.filter(item => item.split === split).length]));
    const reviewers = [...new Set(approvedReviews.map(item => String(item.reviewer).trim()))].sort();
    const manifest = {
        schemaVersion: 1,
        dataset: options.datasetName,
        generatedAt: new Date().toISOString(),
        generator: 'src/scripts/build-grounded-rca-dataset.js',
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
            byCategory: { issue_rca: cases.length },
            bySplit,
        },
        reviews: {
            source: displayPath(options.reviews),
            sha256: createHash('sha256').update(reviewsRaw).digest('hex'),
            decisions: reviewDecisionCounts(reviews),
            reviewers,
        },
        labelPolicy: 'Every case requires explicit human approval of problem fidelity, closing-PR relationship, gold commit completeness, and query usability. GitHub Issue.closedByPullRequestsReferences plus a corpus-resident merge commit provides machine-verifiable provenance.',
    };
    await mkdir(options.output, { recursive: true });
    await writeFile(join(options.output, 'cases.jsonl'), jsonl);
    await writeFile(join(options.output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify(manifest, null, 2));
}

main().catch(error => {
    console.error(`Grounded RCA dataset build failed: ${error.message}`);
    process.exitCode = 1;
});
