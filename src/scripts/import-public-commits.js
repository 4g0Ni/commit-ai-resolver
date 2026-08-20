/**
 * Import an offline JSONL or Parquet commit corpus into the daily JSON
 * source-of-truth format.
 *
 * The default field mapping targets Hugging Face `adhyanshaa/github-major-repos`,
 * while accepting common aliases used by other GitHub commit exports.
 *
 * Usage:
 *   node src/scripts/import-public-commits.js --input D:\data\facebook_react.parquet --limit 10000
 *   node src/scripts/import-public-commits.js --input D:\data\commits.jsonl --repo facebook/react --force
 */

import { createReadStream, existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { createInterface } from 'readline';
import { extname, join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = process.env.DATA_DIR || join(__dirname, '..', '..', 'data');
const DAILY_DIR = join(DATA_ROOT, 'daily');

function parseArgs(argv) {
    const options = { input: null, limit: 10000, repos: new Set(), force: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--input' && argv[i + 1]) options.input = resolve(argv[++i]);
        else if (argv[i] === '--limit' && argv[i + 1]) options.limit = Number.parseInt(argv[++i], 10);
        else if (argv[i] === '--repo' && argv[i + 1]) options.repos.add(argv[++i].toLowerCase());
        else if (argv[i] === '--force') options.force = true;
    }
    if (!options.input) throw new Error('--input is required');
    if (!existsSync(options.input)) {
        throw new Error(
            `Input file not found: ${options.input}\n` +
            'The --input value must be an existing local .jsonl or .parquet file. ' +
            'Paths such as D:\\data\\commits.jsonl in examples are placeholders, not bundled data.'
        );
    }
    if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error('--limit must be a positive integer');
    if (!['.jsonl', '.ndjson', '.parquet'].includes(extname(options.input).toLowerCase())) {
        throw new Error('--input must be a .jsonl, .ndjson, or .parquet file');
    }
    return options;
}

async function* readRecords(path, limit) {
    if (extname(path).toLowerCase() === '.parquet') {
        const file = await asyncBufferFromFile(path);
        const records = await parquetReadObjects({ file, compressors, rowEnd: limit });
        yield* records;
        return;
    }

    const input = createInterface({ input: createReadStream(path, 'utf-8'), crlfDelay: Infinity });
    for await (const line of input) {
        if (!line.trim()) continue;
        try {
            yield JSON.parse(line);
        } catch {
            yield null;
        }
    }
}

function pathsFrom(record) {
    const candidates = record.changed_files || record.files || record.paths || record.modified_files || [];
    if (!Array.isArray(candidates)) return [];
    return candidates
        .map(item => typeof item === 'string' ? item : item?.path || item?.filename || item?.name)
        .filter(Boolean)
        .slice(0, 100);
}

function affectedAreas(paths) {
    return [...new Set(paths.map(path => path.replace(/\\/g, '/').split('/').filter(Boolean)[0]).filter(Boolean))]
        .slice(0, 8);
}

function classify(subject, paths, additions, deletions) {
    const text = `${subject} ${paths.join(' ')}`.toLowerCase();
    const totalChanges = additions + deletions;
    const config = /\b(config|configuration|flag|feature.?gate|rollout|yaml|yml|json|toml|ini|env)\b/.test(text);
    const code = paths.some(path => /\.(js|jsx|ts|tsx|py|java|go|rb|php|cs|cpp|c|h|rs)$/i.test(path));
    const highRisk = /\b(auth|security|permission|migration|schema|payment|breaking|rollback|outage)\b/.test(text)
        || totalChanges >= 1000;
    const lowRisk = /\b(test|tests|doc|docs|readme|typo|lint|format|comment|chore)\b/.test(text)
        && totalChanges < 300;
    return {
        riskLevel: highRisk ? 'HIGH' : (lowRisk ? 'LOW' : 'MEDIUM'),
        changeType: config && code ? 'mixed' : (config ? 'config' : 'code'),
    };
}

function normalizeRecord(record) {
    if (!record || typeof record !== 'object') return null;
    // github-major-repos stores searchable text beside a nested metadata object.
    record = record.metadata && typeof record.metadata === 'object'
        ? { ...record, ...record.metadata }
        : record;
    const commitId = record.hash || record.sha || record.commitId || record.commit_id;
    const repo = record.repo || record.repository || record.project;
    const subject = String(record.subject || record.message || record.commit_message || '').split(/\r?\n/)[0].trim();
    const rawDate = record.date || record.timestamp || record.committed_at || record.commit_date;
    const parsedDate = rawDate ? new Date(rawDate) : null;
    if (!commitId || !repo || !subject || !parsedDate || Number.isNaN(parsedDate.getTime())) return null;

    const date = parsedDate.toISOString().slice(0, 10);
    if (date === '1970-01-01') return null;
    const paths = pathsFrom(record);
    const additions = Number(record.insertions ?? record.additions ?? 0) || 0;
    const deletions = Number(record.deletions ?? 0) || 0;
    const classification = classify(subject, paths, additions, deletions);
    const author = record.author || record.author_name || 'Unknown';
    const url = record.url || record.commit_url || record.diff_url || `https://github.com/${repo}/commit/${commitId}`;
    const commitIdText = String(commitId);

    return {
        repo,
        date,
        commit: {
            commitId: commitIdText,
            shortId: commitIdText.slice(0, 8),
            author,
            authorEmail: record.email || record.author_email || '',
            date: parsedDate.toISOString(),
            message: subject,
            title: subject,
            changedFiles: paths,
            url,
            summary: {
                title: subject,
                summary: `${subject}. ${paths.length || record.files_changed || 0} files changed, +${additions}/-${deletions}.`,
                riskLevel: classification.riskLevel,
                changeType: classification.changeType,
                affectedAreas: affectedAreas(paths),
                flags: [],
                configChanges: [],
                breakingChange: /\bbreaking\b/i.test(subject),
                source: 'public-corpus-rule-based',
            },
        },
    };
}

function repoStats(commits) {
    return {
        total: commits.length,
        high: commits.filter(item => item.summary.riskLevel === 'HIGH').length,
        medium: commits.filter(item => item.summary.riskLevel === 'MEDIUM').length,
        low: commits.filter(item => item.summary.riskLevel === 'LOW').length,
        configChanges: commits.filter(item => item.summary.changeType !== 'code').length,
        breakingChanges: commits.filter(item => item.summary.breakingChange).length,
    };
}

function daySummary(repositories) {
    const stats = Object.values(repositories).map(repo => repo.stats);
    return {
        totalCommits: stats.reduce((sum, item) => sum + item.total, 0),
        totalHigh: stats.reduce((sum, item) => sum + item.high, 0),
        totalMedium: stats.reduce((sum, item) => sum + item.medium, 0),
        totalLow: stats.reduce((sum, item) => sum + item.low, 0),
        totalConfigChanges: stats.reduce((sum, item) => sum + item.configChanges, 0),
        reposIncluded: Object.keys(repositories),
    };
}

async function loadExisting(date) {
    const path = join(DAILY_DIR, `${date}.json`);
    if (!existsSync(path)) return { date, repositories: {} };
    return JSON.parse(await readFile(path, 'utf-8'));
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const grouped = new Map();
    let imported = 0;
    let skipped = 0;

    for await (const record of readRecords(options.input, options.limit)) {
        if (!record) {
            skipped++;
            continue;
        }
        const normalized = normalizeRecord(record);
        if (!normalized || (options.repos.size && !options.repos.has(normalized.repo.toLowerCase()))) {
            skipped++;
            continue;
        }
        if (!grouped.has(normalized.date)) grouped.set(normalized.date, new Map());
        const repos = grouped.get(normalized.date);
        if (!repos.has(normalized.repo)) repos.set(normalized.repo, []);
        repos.get(normalized.repo).push(normalized.commit);
        imported++;
        if (imported >= options.limit) break;
    }

    await mkdir(DAILY_DIR, { recursive: true });
    for (const [date, repoMap] of grouped) {
        const report = options.force ? { date, repositories: {} } : await loadExisting(date);
        for (const [repo, newCommits] of repoMap) {
            const existing = report.repositories[repo]?.commits || [];
            const merged = new Map(existing.map(commit => [commit.commitId, commit]));
            for (const commit of newCommits) merged.set(commit.commitId, commit);
            const commits = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
            report.repositories[repo] = { commits, stats: repoStats(commits) };
        }
        report.summary = daySummary(report.repositories);
        await writeFile(join(DAILY_DIR, `${date}.json`), JSON.stringify(report, null, 2));
    }

    console.log(`Imported ${imported} commits into ${grouped.size} daily files; skipped ${skipped} records.`);
    console.log('Next (from project root): python src/scripts/generate-embedding.py --force');
}

main().catch(err => {
    console.error(`Import failed: ${err.message}`);
    process.exit(1);
});
