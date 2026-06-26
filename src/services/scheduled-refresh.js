/**
 * Scheduled refresh service — fetches, summarizes, persists, and indexes commits.
 *
 * Pipeline per repo:
 *   1. Fetch commits via ADO date-range query
 *   2. Summarize with LLM
 *   3. Write/merge daily JSON to data/daily/YYYY-MM-DD.json
 *   4. Generate embeddings and upsert into LanceDB vector store
 *   5. Update data/daily/index.json
 *
 * Persists per-repo checkpoints to disk for retry and backfill on restart.
 */

import { readFile, writeFile, readdir, mkdir, rm, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { REPOSITORIES } from '../config/repositories.js';
import { fetchCommitsBetweenDates } from './ado-git-client.js';
import { summarizeCommits } from './commit-summarizer.js';
import { compactPathTokens, cleanCommitSubject } from './commit-paths.js';
import { generateEmbeddings } from './embedding-client.js';
import { upsertVectors, closeVectorStore } from './vector-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = process.env.DATA_DIR || join(__dirname, '..', '..', 'data');
const DATA_DIR = join(DATA_ROOT, 'daily');
const CHECKPOINT_PATH = join(DATA_ROOT, 'refresh-checkpoint.json');
const VECTORS_DB_PATH = process.env.VECTORS_DB || join(DATA_ROOT, 'vectors.db');
const DIFFS_DIR = join(DATA_ROOT, 'diffs');
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_RETRIES = 3;
const EMBEDDING_BATCH_SIZE = 16;

let intervalHandle = null;

// ── Checkpoint persistence ──

async function loadCheckpoint() {
    try {
        const raw = await readFile(CHECKPOINT_PATH, 'utf-8');
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

async function saveCheckpoint(checkpoint) {
    await mkdir(dirname(CHECKPOINT_PATH), { recursive: true });
    await writeFile(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2));
}

// ── Daily JSON helpers (same format as generate-sample-data.js) ──

function formatCommitForOutput(c) {
    return {
        commitId: c.commitId,
        shortId: c.shortId,
        author: c.author,
        authorEmail: c.authorEmail,
        date: c.date,
        message: c.message,
        title: c.title,
        url: c.url,
        changedFiles: c.changedFiles || [],
        summary: {
            ...c.llmSummary,
            changeType: c.llmSummary.changeType || 'code',
            configChanges: c.llmSummary.configChanges || [],
        },
    };
}

function buildRepoStats(commits) {
    return {
        total: commits.length,
        high: commits.filter(c => (c.summary || c.llmSummary)?.riskLevel === 'HIGH').length,
        medium: commits.filter(c => (c.summary || c.llmSummary)?.riskLevel === 'MEDIUM').length,
        low: commits.filter(c => (c.summary || c.llmSummary)?.riskLevel === 'LOW').length,
        configChanges: commits.filter(c => ((c.summary || c.llmSummary)?.changeType || 'code') !== 'code').length,
        breakingChanges: commits.filter(c => (c.summary || c.llmSummary)?.breakingChange === true).length,
    };
}

/**
 * Load existing daily JSON, merge new repo commits, and write back.
 */
async function mergeDailyJson(dateStr, repoName, summarizedCommits) {
    await mkdir(DATA_DIR, { recursive: true });
    const filePath = join(DATA_DIR, `${dateStr}.json`);

    let existing = { date: dateStr, repositories: {}, summary: {} };
    if (existsSync(filePath)) {
        try {
            existing = JSON.parse(await readFile(filePath, 'utf-8'));
        } catch { /* start fresh if corrupt */ }
    }

    const formatted = summarizedCommits.map(formatCommitForOutput);

    // Merge: add new commits, avoid duplicates by commitId
    const existingCommits = existing.repositories[repoName]?.commits || [];
    const existingIds = new Set(existingCommits.map(c => c.commitId));
    const newCommits = formatted.filter(c => !existingIds.has(c.commitId));
    const mergedCommits = [...existingCommits, ...newCommits];

    existing.repositories[repoName] = {
        repo: repoName,
        commits: mergedCommits,
        stats: buildRepoStats(mergedCommits),
    };

    // Rebuild summary
    const repos = Object.values(existing.repositories);
    existing.summary = {
        totalCommits: repos.reduce((s, r) => s + r.stats.total, 0),
        totalHigh: repos.reduce((s, r) => s + r.stats.high, 0),
        totalMedium: repos.reduce((s, r) => s + r.stats.medium, 0),
        totalLow: repos.reduce((s, r) => s + r.stats.low, 0),
        totalConfigChanges: repos.reduce((s, r) => s + (r.stats.configChanges || 0), 0),
        reposIncluded: Object.keys(existing.repositories),
    };

    await writeFile(filePath, JSON.stringify(existing, null, 2));
    return newCommits.length;
}

/**
 * Update data/daily/index.json to include a date if not already present.
 */
async function updateIndex(dateStr) {
    const indexPath = join(DATA_DIR, 'index.json');
    let index = { generatedAt: new Date().toISOString(), dates: [], repos: [] };

    if (existsSync(indexPath)) {
        try {
            index = JSON.parse(await readFile(indexPath, 'utf-8'));
        } catch { /* start fresh */ }
    }

    if (!index.dates.includes(dateStr)) {
        index.dates.push(dateStr);
        index.dates.sort();
    }
    index.repos = Object.keys(REPOSITORIES);
    index.generatedAt = new Date().toISOString();

    await writeFile(indexPath, JSON.stringify(index, null, 2));
}

// ── Embedding helpers (same format as generate-embeddings.js) ──

function buildCommitText(commit, repoName, date) {
    const s = commit.summary || commit.llmSummary;
    const parts = [
        `[${date}] ${repoName}`,
        s.title,
        s.summary,
        `Risk: ${s.riskLevel}`,
        `Author: ${commit.author}`,
    ];
    if (s.affectedAreas?.length) parts.push(`Areas: ${s.affectedAreas.join(', ')}`);
    if (s.flags?.length) parts.push(`Flags: ${s.flags.join(', ')}`);
    if (s.changeType !== 'code') parts.push(`Type: ${s.changeType}`);
    if (s.configChanges?.length) {
        const configs = s.configChanges.map(c => {
            let desc = `${c.action} ${c.key}: ${c.detail}`;
            if (c.from || c.to) desc += ` (${c.from || '?'} → ${c.to || '?'})`;
            return desc;
        }).join('; ');
        parts.push(`Config: ${configs}`);
    }
    const subject = cleanCommitSubject(commit.message);
    if (subject && subject !== s.title) parts.push(`PR: ${subject}`);
    const pathTokens = compactPathTokens(commit.changedFiles);
    if (pathTokens.length) parts.push(`Files: ${pathTokens.join(', ')}`);
    return parts.join('\n');
}

async function embedAndIndex(formattedCommits, repoName, dateStr) {
    if (formattedCommits.length === 0) return 0;

    const toEmbed = formattedCommits.map(c => ({
        id: c.shortId,
        commitId: c.commitId,
        repo: repoName,
        date: dateStr,
        author: c.author,
        text: buildCommitText(c, repoName, dateStr),
        metadata: {
            author: c.author,
            title: c.summary.title,
            summary: c.summary.summary,
            riskLevel: c.summary.riskLevel,
            changeType: c.summary.changeType,
            affectedAreas: c.summary.affectedAreas || [],
            flags: c.summary.flags || [],
            changedFiles: c.changedFiles || [],
            url: c.url,
        },
    }));

    const allEntries = [];
    for (let i = 0; i < toEmbed.length; i += EMBEDDING_BATCH_SIZE) {
        const batch = toEmbed.slice(i, i + EMBEDDING_BATCH_SIZE);
        const texts = batch.map(c => c.text);
        try {
            const embeddings = await generateEmbeddings(texts);
            for (let j = 0; j < batch.length; j++) {
                allEntries.push({
                    id: batch[j].id,
                    commitId: batch[j].commitId,
                    repo: batch[j].repo,
                    date: batch[j].date,
                    text: batch[j].text,
                    embedding: embeddings[j],
                    metadata: batch[j].metadata,
                });
            }
        } catch (err) {
            console.error(`    Embedding error: ${err.message}`);
        }
    }

    if (allEntries.length > 0) {
        try {
            const count = await upsertVectors(allEntries);
            return count;
        } catch (err) {
            console.error(`    Vector upsert error: ${err.message}`);
            return 0;
        }
    }
    return 0;
}

// ── Reset & Backfill ──

/**
 * Delete all data: daily JSON, LanceDB, SQLite tables, checkpoint, diffs.
 * Requires clearDatabase from api/db.js to be passed in (avoids circular import).
 */
export async function resetAllData(clearDatabaseFn) {
    console.log('Resetting all data...');

    // 1. Daily JSON files
    if (existsSync(DATA_DIR)) {
        const files = await readdir(DATA_DIR);
        for (const f of files) {
            await unlink(join(DATA_DIR, f));
        }
        console.log(`  Deleted ${files.length} daily JSON files.`);
    }

    // 2. SQLite vector store (close connection first to release Windows file lock)
    closeVectorStore();
    let vecDeleted = 0;
    for (const suffix of ['', '-wal', '-shm']) {
        const p = VECTORS_DB_PATH + suffix;
        if (existsSync(p)) {
            await unlink(p);
            vecDeleted++;
        }
    }
    if (vecDeleted > 0) console.log('  Deleted vector store (vectors.db).');

    // 3. SQLite database
    if (clearDatabaseFn) {
        clearDatabaseFn();
        console.log('  Cleared SQLite database.');
    }

    // 4. Checkpoint
    if (existsSync(CHECKPOINT_PATH)) {
        await unlink(CHECKPOINT_PATH);
        console.log('  Deleted refresh checkpoint.');
    }

    // 5. Diffs cache
    if (existsSync(DIFFS_DIR)) {
        await rm(DIFFS_DIR, { recursive: true, force: true });
        console.log('  Deleted diffs cache.');
    }

    console.log('Reset complete.\n');
}

/**
 * Split a [fromDate, toDate] span into 1-day windows (oldest first).
 * Querying ADO one day at a time keeps each request well under the API's
 * default 100-result page cap (which silently drops older commits when a
 * multi-day span is fetched in a single call) and matches the per-day output.
 *
 * @param {Date} fromDate
 * @param {Date} toDate
 * @returns {Array<{from: Date, to: Date, dateStr: string}>}
 */
function buildDailyWindows(fromDate, toDate) {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const windows = [];
    let windowStart = new Date(fromDate);
    while (windowStart < toDate) {
        const windowEnd = new Date(Math.min(windowStart.getTime() + DAY_MS, toDate.getTime()));
        windows.push({ from: new Date(windowStart), to: windowEnd, dateStr: windowStart.toISOString().slice(0, 10) });
        windowStart = windowEnd;
    }
    return windows;
}

/**
 * Backfill commits for all repos from `days` days ago until now.
 * Fetches day by day to stay well under the ADO API's default 100-result limit.
 * Runs the full pipeline: fetch → summarize → daily JSON → embed → index.
 *
 * @param {number} days - Number of days to backfill (default: 90)
 * @param {boolean} skipExisting - If true, skip commits already stored in daily JSON (default: false)
 */
export async function backfillCommits(days = 90, skipExisting = false) {
    const toDate = new Date();
    const fromDate = new Date(toDate.getTime() - days * 24 * 60 * 60 * 1000);
    console.log(`Backfilling commits from ${fromDate.toISOString()} to ${toDate.toISOString()} (${days} days, skipExisting=${skipExisting})...\n`);

    // Build daily windows (oldest first)
    const windows = buildDailyWindows(fromDate, toDate);

    // Pre-load existing commit IDs per repo+date for skip checking
    const existingCommitIds = {}; // { "repoName/dateStr": Set<commitId> }
    if (skipExisting && existsSync(DATA_DIR)) {
        const files = await readdir(DATA_DIR);
        for (const f of files) {
            if (!f.endsWith('.json') || f === 'index.json') continue;
            try {
                const raw = await readFile(join(DATA_DIR, f), 'utf-8');
                const day = JSON.parse(raw);
                const dateStr = f.replace('.json', '');
                for (const [repoName, repoData] of Object.entries(day.repositories || {})) {
                    const ids = new Set((repoData.commits || []).map(c => c.commitId));
                    if (ids.size > 0) existingCommitIds[`${repoName}/${dateStr}`] = ids;
                }
            } catch { /* skip corrupt files */ }
        }
        const totalExisting = Object.values(existingCommitIds).reduce((s, ids) => s + ids.size, 0);
        console.log(`  Loaded ${totalExisting} existing commit IDs from daily JSON.\n`);
    }

    const checkpoint = {};

    for (const repo of Object.values(REPOSITORIES)) {
        console.log(`  Fetching ${repo.name} (${windows.length} days)...`);
        let totalCommits = 0;
        let totalIndexed = 0;
        let totalSkipped = 0;

        try {
            for (let i = 0; i < windows.length; i++) {
                const { from: wFrom, to: wTo, dateStr } = windows[i];
                const commits = await fetchCommitsBetweenDates(repo, wFrom, wTo);
                if (commits.length === 0) continue;

                // Filter out commits that already exist in daily JSON
                let toProcess = commits;
                if (skipExisting) {
                    const existingIds = existingCommitIds[`${repo.name}/${dateStr}`];
                    if (existingIds) {
                        toProcess = commits.filter(c => !existingIds.has(c.commitId));
                        const skipped = commits.length - toProcess.length;
                        totalSkipped += skipped;
                        if (toProcess.length === 0) continue;
                    }
                }

                totalCommits += toProcess.length;
                console.log(`    [${i + 1}/${windows.length}] ${dateStr}: ${toProcess.length} new commits${commits.length !== toProcess.length ? ` (${commits.length - toProcess.length} existing skipped)` : ''}. Summarizing...`);
                const summarized = await summarizeCommits(repo, toProcess);

                const formatted = summarized.map(formatCommitForOutput);
                const newCount = await mergeDailyJson(dateStr, repo.name, summarized);
                if (newCount > 0) {
                    const indexed = await embedAndIndex(formatted, repo.name, dateStr);
                    totalIndexed += indexed;
                }
                await updateIndex(dateStr);
            }

            const skipMsg = totalSkipped > 0 ? `, ${totalSkipped} existing skipped` : '';
            console.log(`  ${repo.name}: done (${totalCommits} new commits, ${totalIndexed} indexed${skipMsg}).\n`);
            checkpoint[repo.name] = { lastSuccessAt: new Date().toISOString(), retryCount: 0 };
        } catch (err) {
            console.error(`  ${repo.name}: ERROR — ${err.message}`);
            checkpoint[repo.name] = { lastSuccessAt: null, retryCount: 1, lastError: err.message };
        }
    }

    await mkdir(dirname(CHECKPOINT_PATH), { recursive: true });
    await saveCheckpoint(checkpoint);
    console.log('Backfill complete.\n');
}

/**
 * Rebuild all vector embeddings from existing daily JSON files.
 * Useful after deleting lancedb/ without re-fetching from ADO.
 */
export async function rebuildEmbeddings() {
    console.log('Rebuilding embeddings from existing daily JSON...\n');

    if (!existsSync(DATA_DIR)) {
        console.log('  No daily JSON directory found. Nothing to rebuild.');
        return;
    }

    const files = (await readdir(DATA_DIR)).filter(f => f.endsWith('.json') && f !== 'index.json').sort();
    console.log(`  Found ${files.length} daily JSON files.\n`);

    let totalIndexed = 0;
    for (const file of files) {
        const dateStr = file.replace('.json', '');
        try {
            const raw = await readFile(join(DATA_DIR, file), 'utf-8');
            const day = JSON.parse(raw);
            for (const [repoName, repoData] of Object.entries(day.repositories || {})) {
                const commits = repoData.commits || [];
                if (commits.length === 0) continue;

                const formatted = commits.map(c => ({
                    shortId: c.shortId,
                    commitId: c.commitId,
                    author: c.author,
                    message: c.message,
                    changedFiles: c.changedFiles || [],
                    summary: c.summary,
                    url: c.url,
                }));
                const indexed = await embedAndIndex(formatted, repoName, dateStr);
                totalIndexed += indexed;
            }
            console.log(`  ${dateStr}: embedded`);
        } catch (err) {
            console.error(`  ${dateStr}: ERROR — ${err.message}`);
        }
    }

    console.log(`\nRebuild complete. ${totalIndexed} commits embedded.\n`);
}

// ── Core refresh logic ──

/**
 * Refresh a single repo: fetch → summarize → write daily JSON → embed → index.
 * @param {object} repo - repo config from REPOSITORIES
 * @param {string|null} lastSuccessAt - ISO timestamp of last successful refresh
 */
async function refreshRepo(repo, lastSuccessAt) {
    const toDate = new Date();
    const fromDate = lastSuccessAt ? new Date(lastSuccessAt) : new Date(toDate.getTime() - DEFAULT_INTERVAL_MS);

    // Split the (possibly multi-day) gap into per-day windows. Fetching the
    // whole span in one ADO call hits the API's default 100-result page cap and
    // silently drops older commits; querying one day at a time avoids that and
    // matches the per-day output model.
    const windows = buildDailyWindows(fromDate, toDate);
    console.log(`  Fetching commits for ${repo.name} (${fromDate.toISOString()} → ${toDate.toISOString()}, ${windows.length} day window(s))...`);

    let totalCommits = 0;
    let totalIndexed = 0;

    for (let i = 0; i < windows.length; i++) {
        const { from: wFrom, to: wTo, dateStr } = windows[i];
        const commits = await fetchCommitsBetweenDates(repo, wFrom, wTo);
        if (commits.length === 0) continue;
        if (commits.length >= 100) {
            console.warn(`    ⚠ ${repo.name}/${dateStr}: ${commits.length} commits — may be hitting ADO's 100-result cap for a single day.`);
        }

        totalCommits += commits.length;
        console.log(`    [${i + 1}/${windows.length}] ${repo.name}/${dateStr}: ${commits.length} commits found. Summarizing...`);
        const summarized = await summarizeCommits(repo, commits);

        // Group by actual commit date for daily JSON (a window may straddle a
        // day boundary, so group rather than assume all belong to dateStr).
        const byDate = {};
        for (const c of summarized) {
            const d = c.date.substring(0, 10);
            if (!byDate[d]) byDate[d] = [];
            byDate[d].push(c);
        }

        for (const [d, dateCommits] of Object.entries(byDate)) {
            const newCount = await mergeDailyJson(d, repo.name, dateCommits);
            console.log(`    ${repo.name}/${d}: ${newCount} new commits written to daily JSON.`);

            if (newCount > 0) {
                const formatted = dateCommits.map(formatCommitForOutput).slice(-newCount);
                const indexed = await embedAndIndex(formatted, repo.name, d);
                totalIndexed += indexed;
                console.log(`    ${repo.name}/${d}: ${indexed} commits indexed to vector store.`);
            }

            await updateIndex(d);
        }
    }

    if (totalCommits === 0) {
        console.log(`  ${repo.name}: no new commits.`);
    } else {
        console.log(`  ${repo.name}: done (${totalCommits} commits, ${totalIndexed} total indexed).`);
    }
    return true;
}

/**
 * Refresh all repos, tracking per-repo checkpoint and retry count.
 * @param {number} [intervalMs] — used to detect stale checkpoints for backfill
 */
export async function refreshAllCommits(intervalMs = DEFAULT_INTERVAL_MS) {
    const timestamp = new Date().toISOString();
    console.log(`\n[${timestamp}] Starting scheduled commit refresh for all repos...`);

    const checkpoint = await loadCheckpoint();
    const now = Date.now();

    for (const repo of Object.values(REPOSITORIES)) {
        const entry = checkpoint[repo.name] || {};
        const lastSuccess = entry.lastSuccessAt ? new Date(entry.lastSuccessAt).getTime() : 0;
        const retries = entry.retryCount || 0;

        // Skip if successfully refreshed within the current interval
        if (lastSuccess && (now - lastSuccess) < intervalMs * 0.9) {
            console.log(`  ${repo.name}: skipped — last refreshed ${entry.lastSuccessAt}`);
            continue;
        }

        // Skip if exceeded max retries this cycle (will reset next cycle)
        if (retries >= MAX_RETRIES && entry.lastAttemptAt) {
            const lastAttempt = new Date(entry.lastAttemptAt).getTime();
            if ((now - lastAttempt) < intervalMs) {
                console.log(`  ${repo.name}: skipped — failed ${retries} times, will retry next cycle.`);
                continue;
            }
            entry.retryCount = 0;
        }

        entry.lastAttemptAt = new Date().toISOString();

        try {
            await refreshRepo(repo, entry.lastSuccessAt || null);
            entry.lastSuccessAt = new Date().toISOString();
            entry.retryCount = 0;
            entry.lastError = null;
        } catch (err) {
            entry.retryCount = (entry.retryCount || 0) + 1;
            entry.lastError = err.message;
            console.error(`  ${repo.name}: ERROR (attempt ${entry.retryCount}/${MAX_RETRIES}) — ${err.message}`);
        }

        checkpoint[repo.name] = entry;
        await saveCheckpoint(checkpoint);
    }

    console.log(`[${new Date().toISOString()}] Refresh complete.\n`);
}

/**
 * Start the hourly refresh interval. Safe to call multiple times — only one interval runs.
 * @param {number} [intervalMs] — interval in milliseconds (default: 1 hour)
 */
export function startScheduledRefresh(intervalMs = DEFAULT_INTERVAL_MS) {
    if (intervalHandle) {
        console.log('Scheduled refresh already running, skipping duplicate start.');
        return;
    }

    const minutes = Math.round(intervalMs / 60000);
    console.log(`Scheduled commit refresh enabled — every ${minutes} minutes (with checkpoint/retry).`);

    // Run first refresh after a short delay so server startup isn't blocked
    setTimeout(() => {
        refreshAllCommits(intervalMs);
        intervalHandle = setInterval(() => refreshAllCommits(intervalMs), intervalMs);
    }, 10_000);
}

export function stopScheduledRefresh() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
        console.log('Scheduled refresh stopped.');
    }
}
