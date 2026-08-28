import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupBy, loadDailyCorpus, mulberry32, sampleStable } from './lib/corpus.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

function parseArgs(argv) {
    const options = {
        dataRoot: process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(projectRoot, 'data'),
        datasetName: 'public-react-v2',
        datasetDir: null,
        seed: 20260820,
    };
    for (let index = 0; index < argv.length; index++) {
        const key = argv[index];
        if (key === '--data-dir') options.dataRoot = resolve(argv[++index]);
        else if (key === '--dataset-name') options.datasetName = argv[++index];
        else if (key === '--output') options.datasetDir = resolve(argv[++index]);
        else if (key === '--seed') options.seed = Number.parseInt(argv[++index], 10);
        else if (key === '--help') {
            console.log('node eval/generate-cases.js [--data-dir data-root] [--dataset-name public-react-v3] [--output dataset-dir] [--seed N]');
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${key}`);
        }
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(options.datasetName)) throw new Error('--dataset-name must be filesystem-safe');
    if (!Number.isInteger(options.seed)) throw new Error('--seed must be an integer');
    options.datasetDir ||= resolve(here, 'datasets', options.datasetName);
    return options;
}

function displayPath(path) {
    const result = relative(projectRoot, path);
    return result.startsWith('..') ? path : result.replace(/\\/g, '/');
}

const args = parseArgs(process.argv.slice(2));
const dailyDir = join(args.dataRoot, 'daily');
const { datasetName, datasetDir, seed } = args;
const random = mulberry32(seed);

function gold(commits, relevance = 3) {
    return commits.map(commit => ({
        repo: commit.repo,
        id: commit.id,
        commitId: commit.commitId,
        relevance,
        required: true,
    }));
}

function paraphraseTitle(title) {
    const replacements = [
        [/\bfix(?:es|ed|ing)?\b/gi, 'resolve'],
        [/\badd(?:s|ed|ing)?\b/gi, 'introduce'],
        [/\bremove(?:s|d|ing)?\b/gi, 'eliminate'],
        [/\bupdate(?:s|d|ing)?\b/gi, 'change'],
        [/\bchange(?:s|d|ing)?\b/gi, 'update'],
        [/\bsupport(?:s|ed|ing)?\b/gi, 'handle'],
        [/\buse(?:s|d|ing)?\b/gi, 'adopt'],
    ];
    let result = title.replace(/^\s*(chore|refactor|feat|feature|bugfix|fix)\s*[:(-]\s*/i, '');
    for (const [pattern, replacement] of replacements) result = result.replace(pattern, replacement);
    return `Find the commit that would ${result.replace(/[.!]+$/, '').toLowerCase()}`;
}

function makeCase(id, category, query, relevantCommits, extra = {}) {
    const result = {
        id,
        category,
        query,
        expectedBehavior: relevantCommits.length ? 'answer' : 'abstain',
        relevantCommits,
        filters: {},
        commitIds: [],
        source: 'deterministic-public-corpus',
        ...extra,
    };
    result.expectedIntent ||= {
        ...result.filters,
        commitIds: result.commitIds,
        verdict: 'GOOD',
    };
    return result;
}

const corpus = await loadDailyCorpus(dailyDir);
if (!corpus.commits.length) throw new Error(`No commits found in ${dailyDir}`);
const cases = [];

const titleCandidates = corpus.commits.filter(commit => {
    const words = String(commit.title || commit.message).match(/[A-Za-z][A-Za-z0-9_-]+/g) || [];
    return words.length >= 5 && words.length <= 18 && !/^(merge|revert)\b/i.test(commit.title || commit.message);
});

for (const [index, commit] of sampleStable(titleCandidates, 12, random).entries()) {
    cases.push(makeCase(`sha-${String(index + 1).padStart(3, '0')}`, 'exact_sha', `Explain commit ${commit.commitId}`, gold([commit]), {
        commitIds: [commit.commitId],
        tags: ['deterministic', 'identifier'],
    }));
}

for (const [index, commit] of sampleStable(titleCandidates, 18, random).entries()) {
    cases.push(makeCase(`semantic-title-${String(index + 1).padStart(3, '0')}`, 'semantic_title', paraphraseTitle(commit.title || commit.message), gold([commit]), {
        tags: ['semantic', 'paraphrased-title'],
        provenance: { title: commit.title || commit.message },
    }));
}

const authorDayGroups = [...groupBy(corpus.commits, commit => `${commit.repo}\0${commit.author}\0${commit.day}`).values()]
    .filter(items => items.length >= 2 && items.length <= 8 && items[0].author && items[0].author !== 'Unknown');
for (const [index, commits] of sampleStable(authorDayGroups, 10, random).entries()) {
    const { author, day, repo } = commits[0];
    cases.push(makeCase(`author-date-${String(index + 1).padStart(3, '0')}`, 'author_date', `What did ${author} change on ${day}?`, gold(commits), {
        filters: { author, repo, dateFrom: day, dateTo: day },
        tags: ['metadata-filter', 'author', 'date'],
    }));
}

const riskDayGroups = [...groupBy(corpus.commits, commit => `${commit.repo}\0${commit.riskLevel}\0${commit.day}`).values()]
    .filter(items => items.length >= 1 && items.length <= 8 && items[0].riskLevel);
for (const [index, commits] of sampleStable(riskDayGroups, 10, random).entries()) {
    const { riskLevel, day, repo } = commits[0];
    cases.push(makeCase(`risk-date-${String(index + 1).padStart(3, '0')}`, 'risk_date', `Show ${riskLevel} risk changes on ${day}`, gold(commits), {
        filters: { riskLevel, repo, dateFrom: day, dateTo: day },
        tags: ['metadata-filter', 'risk', 'date'],
    }));
}

const repoDayGroups = [...groupBy(corpus.commits, commit => `${commit.repo}\0${commit.day}`).values()]
    .filter(items => items.length >= 2 && items.length <= 8);
for (const [index, commits] of sampleStable(repoDayGroups, 5, random).entries()) {
    const { day, repo } = commits[0];
    cases.push(makeCase(`repo-date-${String(index + 1).padStart(3, '0')}`, 'repo_date', `What changed in ${repo} on ${day}?`, gold(commits), {
        filters: { repo, dateFrom: day, dateTo: day },
        tags: ['metadata-filter', 'repo', 'date'],
    }));
}

for (let index = 0; index < 5; index++) {
    const token = `zzzxqvnonexistenttoken${seed}case${index + 1}`;
    cases.push(makeCase(`negative-${String(index + 1).padStart(3, '0')}`, 'negative', token, [], {
        tags: ['negative', 'abstain'],
    }));
}

const naturalOodQueries = [
    'Which commit added the Kubernetes ingress retry policy?',
    'Find the checkout payment webhook idempotency change',
    'Why did the PostgreSQL replica lag increase after deployment?',
    'Which commit fixed Android Bluetooth disconnects?',
    'Show the OAuth refresh token rotation change',
    'Find the Terraform S3 bucket encryption update',
    'Which commit changed Kafka consumer offsets?',
    'Why did the image upload antivirus scan fail?',
    'Find the iOS push notification entitlement update',
    'Which commit modified the Redis eviction policy?',
];
for (const [index, query] of naturalOodQueries.entries()) {
    cases.push(makeCase(`negative-natural-${String(index + 1).padStart(3, '0')}`, 'negative_natural', query, [], {
        tags: ['negative', 'out-of-domain', 'human-authored'],
        source: 'human-authored-public-corpus-ood',
        rationale: 'The frozen corpus contains React source commits, not the named infrastructure or mobile subsystem.',
    }));
}

const ambiguousQueries = [
    'something broke',
    'it is slow',
    'the page looks wrong',
    'there is an error',
    'what caused this?',
];
for (const [index, query] of ambiguousQueries.entries()) {
    cases.push(makeCase(`ambiguous-${String(index + 1).padStart(3, '0')}`, 'ambiguous', query, [], {
        expectedBehavior: 'clarify',
        expectedIntent: { verdict: 'ASK_USER' },
        tags: ['clarification', 'underspecified', 'human-authored'],
        source: 'human-authored-ambiguous-query',
    }));
}

if (cases.length !== 75) throw new Error(`Expected 75 cases, generated ${cases.length}`);
for (const categoryCases of groupBy(cases, item => item.category).values()) {
    categoryCases.forEach((item, index) => {
        item.split = index % 4 === 0 ? 'test' : 'dev';
    });
}
const jsonl = `${cases.map(item => JSON.stringify(item)).join('\n')}\n`;
const caseHash = createHash('sha256').update(jsonl).digest('hex');
const byCategory = Object.fromEntries([...groupBy(cases, item => item.category)].map(([key, value]) => [key, value.length]));
const bySplit = Object.fromEntries([...groupBy(cases, item => item.split)].map(([key, value]) => [key, value.length]));
const repos = [...new Set(corpus.commits.map(item => item.repo))].sort();
const manifest = {
    schemaVersion: 1,
    dataset: datasetName,
    generator: 'src/eval/generate-cases.js',
    seed,
    corpus: {
        path: displayPath(dailyDir),
        sha256: corpus.corpusHash,
        files: corpus.files.length,
        commits: corpus.commits.length,
        repos,
        dateRange: corpus.dateRange,
    },
    cases: { count: cases.length, sha256: caseHash, byCategory, bySplit },
    labelPolicy: 'Positive commit IDs and filters are deterministically derived from public corpus metadata. OOD and ambiguous cases are fixed human-authored labels. No LLM output is treated as ground truth.',
};

await mkdir(datasetDir, { recursive: true });
await writeFile(join(datasetDir, 'cases.jsonl'), jsonl);
await writeFile(join(datasetDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
