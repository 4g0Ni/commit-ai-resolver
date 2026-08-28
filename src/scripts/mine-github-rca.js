/** Mine provenance-backed GitHub issue -> closing PR -> corpus commit candidates. */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDailyCorpus } from '../eval/lib/corpus.js';
import { buildGroundedRcaCandidate, buildReviewTemplate, groundedRcaSelectionArea, selectDiverseGroundedRcaCandidates } from '../services/github-rca-grounding.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

const GITHUB_QUERY = `
query($searchQuery: String!, $cursor: String, $pageSize: Int!) {
  rateLimit { cost remaining resetAt }
  search(query: $searchQuery, type: ISSUE, first: $pageSize, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue {
        number title url bodyText createdAt closedAt
        author { login }
        labels(first: 30) { nodes { name } }
        closedByPullRequestsReferences(first: 5) {
          nodes {
            number title url bodyText mergedAt
            author { login }
            mergeCommit { oid }
          }
        }
      }
    }
  }
}`;

function parseArgs(argv) {
    const options = {
        githubRepo: 'react/react',
        corpusRepo: 'facebook/react',
        dataRoot: join(projectRoot, 'data', 'enriched', 'public-react-v3-20260827'),
        output: join(projectRoot, 'data', 'eval', 'grounded-react-rca', 'candidates.jsonl'),
        cache: join(projectRoot, 'data', 'public', 'github-react-issue-pr-pages.jsonl'),
        reviewTemplate: join(projectRoot, 'data', 'eval', 'grounded-react-rca', 'review-template.jsonl'),
        reviewPacket: join(projectRoot, 'data', 'eval', 'grounded-react-rca', 'review-packet.md'),
        limit: 50,
        pageSize: 50,
        maxPages: 20,
        offline: false,
    };
    for (let index = 0; index < argv.length; index++) {
        const key = argv[index];
        if (key === '--github-repo') options.githubRepo = argv[++index];
        else if (key === '--corpus-repo') options.corpusRepo = argv[++index];
        else if (key === '--data-dir') options.dataRoot = resolve(argv[++index]);
        else if (key === '--output') options.output = resolve(argv[++index]);
        else if (key === '--cache') options.cache = resolve(argv[++index]);
        else if (key === '--review-template') options.reviewTemplate = resolve(argv[++index]);
        else if (key === '--review-packet') options.reviewPacket = resolve(argv[++index]);
        else if (key === '--limit') options.limit = Number.parseInt(argv[++index], 10);
        else if (key === '--page-size') options.pageSize = Number.parseInt(argv[++index], 10);
        else if (key === '--max-pages') options.maxPages = Number.parseInt(argv[++index], 10);
        else if (key === '--offline') options.offline = true;
        else if (key === '--help') {
            console.log('node scripts/mine-github-rca.js [--github-repo react/react] [--corpus-repo facebook/react] [--data-dir enriched-root] [--limit 50] [--max-pages 20] [--offline]');
            process.exit(0);
        } else throw new Error(`Unknown argument: ${key}`);
    }
    if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error('--limit must be a positive integer');
    if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100) throw new Error('--page-size must be between 1 and 100');
    if (!Number.isInteger(options.maxPages) || options.maxPages < 1) throw new Error('--max-pages must be a positive integer');
    return options;
}

function githubToken() {
    const fromEnvironment = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (fromEnvironment) return fromEnvironment;
    const result = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0 || !result.stdout.trim()) throw new Error('GitHub token unavailable; run gh auth login or set GH_TOKEN');
    return result.stdout.trim();
}

async function graphql(token, variables) {
    const response = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'user-agent': 'commit-ai-resolver-rca-miner',
        },
        body: JSON.stringify({ query: GITHUB_QUERY, variables }),
    });
    const payload = await response.json();
    if (!response.ok || payload.errors?.length) {
        throw new Error(`GitHub GraphQL failed (${response.status}): ${JSON.stringify(payload.errors || payload.message)}`);
    }
    return payload.data;
}

async function loadCachedPages(path, searchQuery) {
    if (!existsSync(path)) return [];
    const pages = [];
    for (const line of (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean)) {
        const record = JSON.parse(line);
        if (record.searchQuery === searchQuery) pages.push(record);
    }
    return pages;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const corpus = await loadDailyCorpus(join(options.dataRoot, 'daily'));
    const corpusCommits = corpus.commits.filter(commit => commit.repo === options.corpusRepo);
    const corpusByCommitId = new Map(corpusCommits.map(commit => [String(commit.commitId).toLowerCase(), commit]));
    const dateTo = corpus.dateRange.to;
    const searchQuery = `repo:${options.githubRepo} is:issue is:closed linked:pr closed:<=${dateTo} sort:created-desc`;
    const cached = await loadCachedPages(options.cache, searchQuery);
    const pages = [...cached];
    let pageInfo = cached.at(-1)?.pageInfo || { hasNextPage: true, endCursor: null };
    let rateLimit = cached.at(-1)?.rateLimit || null;

    if (!options.offline && pageInfo.hasNextPage && pages.length < options.maxPages) {
        const token = githubToken();
        await mkdir(dirname(options.cache), { recursive: true });
        while (pageInfo.hasNextPage && pages.length < options.maxPages) {
            const data = await graphql(token, { searchQuery, cursor: pageInfo.endCursor, pageSize: options.pageSize });
            pageInfo = data.search.pageInfo;
            rateLimit = data.rateLimit;
            const record = {
                schemaVersion: 1,
                searchQuery,
                page: pages.length + 1,
                fetchedAt: new Date().toISOString(),
                pageInfo,
                rateLimit,
                nodes: data.search.nodes,
            };
            pages.push(record);
            await appendFile(options.cache, `${JSON.stringify(record)}\n`);
            console.log(`Fetched page ${pages.length}: ${data.search.nodes.length} issues; rate remaining ${rateLimit.remaining}.`);
        }
    }

    const byId = new Map();
    for (const page of pages) {
        for (const issue of page.nodes || []) {
            const candidate = buildGroundedRcaCandidate(issue, corpusByCommitId, options);
            if (candidate) byId.set(candidate.id, candidate);
        }
    }
    const candidates = selectDiverseGroundedRcaCandidates([...byId.values()], options.limit);
    if (!candidates.length) throw new Error('No grounded candidates found; fetch more pages or inspect corpus/repo aliases');
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${candidates.map(item => JSON.stringify(item)).join('\n')}\n`);
    await mkdir(dirname(options.reviewTemplate), { recursive: true });
    await writeFile(options.reviewTemplate, `${candidates.map(buildReviewTemplate).map(item => JSON.stringify(item)).join('\n')}\n`);
    const packetLines = [
        '# React GitHub-grounded RCA candidate review',
        '',
        'These rows are provenance-verified candidates, not gold labels. Copy `review-template.jsonl` to `reviews.jsonl` and approve a row only after checking the linked Issue, closing PR, and commit.',
        '',
        'Approval requires `problemFaithful`, `fixRelationshipValid`, `goldCommitsComplete`, and `queryUsable` to all be `true`, plus reviewer and ISO reviewedAt fields.',
        '',
        '| Candidate | Issue | Closing PR | Commit | Areas | Score |',
        '|---|---|---|---|---|---:|',
        ...candidates.map(candidate => {
            const escape = value => String(value || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
            const issue = `[#${candidate.problem.issueNumber}](${candidate.problem.url}) ${escape(candidate.problem.title)}`;
            const pullRequests = candidate.resolution.pullRequests.map(item => `[#${item.number}](${item.url})`).join(', ');
            const commits = candidate.relevantCommits.map(item => `[${item.id}](https://github.com/${candidate.repository.github}/commit/${item.commitId})`).join(', ');
            return `| ${candidate.id} | ${issue} | ${pullRequests} | ${commits} | ${escape(candidate.evidence.affectedAreas.join(', '))} | ${candidate.qualitySignals.score} |`;
        }),
        '',
    ];
    await writeFile(options.reviewPacket, packetLines.join('\n'));

    const manifest = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        searchQuery,
        corpus: { sha256: corpus.corpusHash, commits: corpus.commits.length, dateRange: corpus.dateRange },
        pages: pages.length,
        issuesInspected: pages.reduce((sum, page) => sum + (page.nodes?.length || 0), 0),
        groundedCandidatesFound: byId.size,
        candidatesWritten: candidates.length,
        qualityScores: Object.fromEntries([...new Set(candidates.map(item => item.qualitySignals.score))]
            .sort((left, right) => right - left)
            .map(score => [score, candidates.filter(item => item.qualitySignals.score === score).length])),
        selectionAreas: Object.fromEntries([...new Set(candidates.map(groundedRcaSelectionArea))]
            .sort()
            .map(area => [area, candidates.filter(item => groundedRcaSelectionArea(item) === area).length])),
        rateLimit,
        output: options.output,
        reviewTemplate: options.reviewTemplate,
        reviewPacket: options.reviewPacket,
    };
    await writeFile(join(dirname(options.output), 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify(manifest, null, 2));
}

main().catch(error => {
    console.error(`GitHub RCA mining failed: ${error.message}`);
    process.exitCode = 1;
});
