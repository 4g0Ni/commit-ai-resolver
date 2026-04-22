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

import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { REPOSITORIES } from '../config/repositories.js';
import { fetchCommitsBetweenDates } from './ado-git-client.js';
import { summarizeCommits } from './commit-summarizer.js';
import { generateEmbeddings } from './embedding-client.js';
import { upsertVectors } from './vector-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data', 'daily');
const CHECKPOINT_PATH = join(__dirname, '..', '..', 'data', 'refresh-checkpoint.json');
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
        const count = await upsertVectors(allEntries);
        return count;
    }
    return 0;
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

    console.log(`  Fetching commits for ${repo.name} (${fromDate.toISOString()} → ${toDate.toISOString()})...`);
    const commits = await fetchCommitsBetweenDates(repo, fromDate, toDate);
    if (commits.length === 0) {
        console.log(`  ${repo.name}: no new commits.`);
        return true;
    }

    // Step 1: Summarize
    console.log(`  ${repo.name}: ${commits.length} commits found. Summarizing...`);
    const summarized = await summarizeCommits(repo, commits);

    // Group by date for daily JSON files
    const byDate = {};
    for (const c of summarized) {
        const dateStr = c.date.substring(0, 10);
        if (!byDate[dateStr]) byDate[dateStr] = [];
        byDate[dateStr].push(c);
    }

    // Step 2 & 3: Write daily JSON + embed per date group
    let totalIndexed = 0;
    for (const [dateStr, dateCommits] of Object.entries(byDate)) {
        const newCount = await mergeDailyJson(dateStr, repo.name, dateCommits);
        console.log(`    ${repo.name}/${dateStr}: ${newCount} new commits written to daily JSON.`);

        if (newCount > 0) {
            const formatted = dateCommits.map(formatCommitForOutput).slice(-newCount);
            const indexed = await embedAndIndex(formatted, repo.name, dateStr);
            totalIndexed += indexed;
            console.log(`    ${repo.name}/${dateStr}: ${indexed} commits indexed to vector store.`);
        }

        await updateIndex(dateStr);
    }

    console.log(`  ${repo.name}: done (${totalIndexed} total indexed).`);
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
