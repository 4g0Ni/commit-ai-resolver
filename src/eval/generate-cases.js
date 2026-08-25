import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupBy, loadDailyCorpus, mulberry32, sampleStable } from './lib/corpus.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const dailyDir = process.env.DATA_DIR ? join(resolve(process.env.DATA_DIR), 'daily') : join(projectRoot, 'data', 'daily');
const datasetDir = resolve(here, 'datasets', 'public-react-v1');
const seed = 20260820;
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
    dataset: 'public-react-v1',
    generator: 'src/eval/generate-cases.js',
    seed,
    corpus: {
        path: 'data/daily',
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
