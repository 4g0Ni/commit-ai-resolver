/**
 * Enrich imported public daily commits from a local Git repository.
 * Writes a separate DATA_DIR-compatible output and never mutates the source corpus.
 *
 * Example:
 *   node src/scripts/enrich-public-commits.js --git-dir data/public/react.git \
 *     --output data/enriched/public-react-v3-spike --sample-size 200
 */

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGitCommitAvailability, fetchMissingGitCommits, readGitCommitMetadata } from '../services/git-commit-metadata.js';
import { enrichPublicCommit } from '../services/public-commit-enrichment.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

function parseArgs(argv) {
    const options = {
        input: join(projectRoot, 'data', 'daily'),
        output: join(projectRoot, 'data', 'enriched', 'public-react-v3-spike'),
        gitDir: join(projectRoot, 'data', 'public', 'react.git'),
        cache: join(projectRoot, 'data', 'public', 'react-git-metadata.jsonl'),
        sampleSize: null,
        fetchMissing: false,
    };
    for (let index = 0; index < argv.length; index++) {
        const key = argv[index];
        if (key === '--input') options.input = resolve(argv[++index]);
        else if (key === '--output') options.output = resolve(argv[++index]);
        else if (key === '--git-dir') options.gitDir = resolve(argv[++index]);
        else if (key === '--cache') options.cache = resolve(argv[++index]);
        else if (key === '--sample-size') options.sampleSize = Number.parseInt(argv[++index], 10);
        else if (key === '--fetch-missing') options.fetchMissing = true;
        else if (key === '--help') {
            console.log('node scripts/enrich-public-commits.js [--input data/daily] [--output data/enriched/public-react-v3] [--git-dir data/public/react.git] [--cache file.jsonl] [--sample-size N] [--fetch-missing]');
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${key}`);
        }
    }
    if (options.sampleSize !== null && (!Number.isInteger(options.sampleSize) || options.sampleSize < 1)) {
        throw new Error('--sample-size must be a positive integer');
    }
    const outputRelativeToInput = relative(resolve(options.input), resolve(options.output));
    if (!outputRelativeToInput || (!outputRelativeToInput.startsWith('..') && !isAbsolute(outputRelativeToInput))) {
        throw new Error('--output must be separate from --input');
    }
    return options;
}

async function loadCorpus(dailyDir) {
    const files = (await readdir(dailyDir)).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
    const entries = [];
    for (const file of files) {
        const report = JSON.parse(await readFile(join(dailyDir, file), 'utf8'));
        for (const [repo, value] of Object.entries(report.repositories || {})) {
            for (const commit of value.commits || []) {
                entries.push({ file, day: report.date || file.slice(0, 10), repo, commit });
            }
        }
    }
    entries.sort((left, right) => `${left.commit.date}:${left.repo}:${left.commit.commitId}`.localeCompare(`${right.commit.date}:${right.repo}:${right.commit.commitId}`));
    return entries;
}

function spreadSample(entries, size) {
    if (!size || size >= entries.length) return entries;
    if (size === 1) return [entries[0]];
    const selected = [];
    const used = new Set();
    for (let index = 0; index < size; index++) {
        let position = Math.round(index * (entries.length - 1) / (size - 1));
        while (used.has(position) && position + 1 < entries.length) position++;
        used.add(position);
        selected.push(entries[position]);
    }
    return selected;
}

async function loadCache(path) {
    const cache = new Map();
    if (!existsSync(path)) return cache;
    const lines = (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
        const item = JSON.parse(line);
        if (item.commitId && item.extractorVersion === 3) cache.set(String(item.commitId).toLowerCase(), item);
    }
    return cache;
}

function repoStats(commits) {
    return {
        total: commits.length,
        high: commits.filter(item => item.summary?.riskLevel === 'HIGH').length,
        medium: commits.filter(item => item.summary?.riskLevel === 'MEDIUM').length,
        low: commits.filter(item => item.summary?.riskLevel === 'LOW').length,
        configChanges: commits.filter(item => item.summary?.changeType !== 'code').length,
        breakingChanges: commits.filter(item => item.summary?.breakingChange).length,
    };
}

function buildReports(entries) {
    const reports = new Map();
    for (const entry of entries) {
        if (!reports.has(entry.file)) reports.set(entry.file, { date: entry.day, repositories: {} });
        const report = reports.get(entry.file);
        report.repositories[entry.repo] ||= { commits: [] };
        report.repositories[entry.repo].commits.push(entry.commit);
    }
    for (const report of reports.values()) {
        for (const value of Object.values(report.repositories)) {
            value.commits.sort((left, right) => String(left.date).localeCompare(String(right.date)));
            value.stats = repoStats(value.commits);
        }
        const stats = Object.values(report.repositories).map(value => value.stats);
        report.summary = {
            totalCommits: stats.reduce((sum, item) => sum + item.total, 0),
            totalHigh: stats.reduce((sum, item) => sum + item.high, 0),
            totalMedium: stats.reduce((sum, item) => sum + item.medium, 0),
            totalLow: stats.reduce((sum, item) => sum + item.low, 0),
            totalConfigChanges: stats.reduce((sum, item) => sum + item.configChanges, 0),
            reposIncluded: Object.keys(report.repositories),
        };
    }
    return reports;
}

function displayPath(path) {
    const result = relative(projectRoot, path);
    return result.startsWith('..') ? path : result.replace(/\\/g, '/');
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const outputDaily = join(options.output, 'daily');
    if (!existsSync(options.input)) throw new Error(`Input daily directory not found: ${options.input}`);
    if (!existsSync(options.gitDir)) throw new Error(`Git repository not found: ${options.gitDir}`);
    if (existsSync(outputDaily)) throw new Error(`Output already exists; choose a new directory: ${outputDaily}`);

    const allEntries = await loadCorpus(options.input);
    const selected = spreadSample(allEntries, options.sampleSize);
    const cache = await loadCache(options.cache);
    const selectedIds = selected.map(entry => String(entry.commit.commitId).toLowerCase());
    const needed = selectedIds.filter(commitId => !cache.has(commitId));

    console.log(`Selected ${selected.length}/${allEntries.length} commits; ${needed.length} require Git extraction.`);
    let fetchResult = { fetched: [], failed: [] };
    if (options.fetchMissing && needed.length) {
        const availability = checkGitCommitAvailability(options.gitDir, needed);
        if (availability.missing.length) {
            console.log(`Fetching ${availability.missing.length} unadvertised corpus SHAs into refs/enrichment/...`);
            fetchResult = fetchMissingGitCommits(options.gitDir, availability.missing);
        }
    }
    const gitResult = readGitCommitMetadata(options.gitDir, needed);
    if (gitResult.metadata.size) {
        await mkdir(dirname(options.cache), { recursive: true });
        const records = [...gitResult.metadata.values()];
        await appendFile(options.cache, `${records.map(item => JSON.stringify(item)).join('\n')}\n`);
        for (const item of records) cache.set(item.commitId, item);
    }

    const outputEntries = selected.map(entry => {
        const commitId = String(entry.commit.commitId).toLowerCase();
        const metadata = cache.get(commitId);
        if (!metadata) {
            return {
                ...entry,
                commit: {
                    ...entry.commit,
                    enrichment: { version: 1, source: 'unavailable', filesComplete: false },
                },
            };
        }
        return { ...entry, commit: enrichPublicCommit(entry.commit, metadata) };
    });

    const reports = buildReports(outputEntries);
    await mkdir(outputDaily, { recursive: true });
    for (const [file, report] of reports) {
        await writeFile(join(outputDaily, file), `${JSON.stringify(report, null, 2)}\n`);
    }

    const enriched = outputEntries.filter(entry => entry.commit.enrichment?.filesComplete);
    const withFiles = enriched.filter(entry => entry.commit.changedFiles?.length > 0);
    const withAreas = enriched.filter(entry => entry.commit.summary?.affectedAreas?.length > 0);
    const countMatches = enriched.filter(entry => entry.commit.enrichment?.pathCountMatchesSource === true);
    const countMismatches = enriched.filter(entry => entry.commit.enrichment?.pathCountMatchesSource === false);
    const areaCounts = new Map();
    for (const entry of enriched) {
        for (const area of entry.commit.summary?.affectedAreas || []) {
            areaCounts.set(area, (areaCounts.get(area) || 0) + 1);
        }
    }
    const manifest = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        source: {
            input: displayPath(options.input),
            gitDir: displayPath(options.gitDir),
            cache: displayPath(options.cache),
            commits: allEntries.length,
        },
        selection: {
            strategy: options.sampleSize && options.sampleSize < allEntries.length ? 'date-spread' : 'all',
            requested: options.sampleSize || allEntries.length,
            commits: selected.length,
            dateRange: { from: selected[0]?.day || null, to: selected.at(-1)?.day || null },
        },
        coverage: {
            enriched: enriched.length,
            unavailable: outputEntries.length - enriched.length,
            changedFilesNonEmpty: withFiles.length,
            affectedAreasNonEmpty: withAreas.length,
            sourceFileCountMatches: countMatches.length,
            sourceFileCountMismatches: countMismatches.length,
            mismatchCommitIds: countMismatches.slice(0, 50).map(entry => entry.commit.commitId),
            multilineFullMessages: enriched.filter(entry => String(entry.commit.fullMessage || '').includes('\n')).length,
            testOnly: enriched.filter(entry => entry.commit.summary?.testOnly).length,
            parentStrategies: Object.fromEntries(['empty-tree', 'single-parent', 'first-parent'].map(strategy => [
                strategy,
                enriched.filter(entry => entry.commit.enrichment?.parentStrategy === strategy).length,
            ])),
            topAffectedAreas: Object.fromEntries([...areaCounts].sort((left, right) => right[1] - left[1]).slice(0, 20)),
        },
        gitExtraction: {
            requested: needed.length,
            found: gitResult.metadata.size,
            missing: gitResult.missing,
            fetchedUnadvertised: fetchResult.fetched.length,
            fetchFailures: fetchResult.failed,
        },
        output: { path: displayPath(options.output), dailyFiles: reports.size },
    };
    await writeFile(join(options.output, 'enrichment-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify(manifest, null, 2));
}

main().catch(error => {
    console.error(`Public commit enrichment failed: ${error.message}`);
    process.exitCode = 1;
});
