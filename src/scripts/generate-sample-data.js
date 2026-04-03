/**
 * Generate sample daily summary JSON files for UI development.
 *
 * Fetches real commits from ADO for AdsAppsCampaignUI and AdsAppsMT
 * using date-range queries, summarizes them with LLM, and writes
 * per-day JSON files to data/daily/.
 *
 * Usage:
 *   node scripts/generate-sample-data.js [--days 10] [--commits-per-day 5]
 */

import { REPOSITORIES } from '../config/repositories.js';
import { fetchCommitsBetweenDates } from '../services/ado-git-client.js';
import { summarizeCommits } from '../services/commit-summarizer.js';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data', 'daily');

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { days: 10, force: false };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--days' && args[i + 1]) {
            opts.days = parseInt(args[i + 1], 10) || 10;
            i++;
        } else if (args[i] === '--force') {
            opts.force = true;
        }
    }
    return opts;
}

/**
 * Group commits by date (YYYY-MM-DD based on commit date).
 */
function groupByDate(commits) {
    const groups = {};
    for (const c of commits) {
        const date = c.date.substring(0, 10); // YYYY-MM-DD
        if (!groups[date]) groups[date] = [];
        groups[date].push(c);
    }
    return groups;
}

/**
 * Generate an array of weekday dates going back N days from today.
 */
function getWeekdayDates(days) {
    const dates = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; dates.length < days; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) { // skip weekends
            dates.push(d.toISOString().substring(0, 10));
        }
    }
    return dates; // newest first
}

/**
 * Load existing day JSON from disk, returning a map of commitId → summarized commit data.
 */
async function loadExistingCommits(dateStr) {
    const filePath = join(DATA_DIR, `${dateStr}.json`);
    if (!existsSync(filePath)) return {};

    try {
        const raw = JSON.parse(await readFile(filePath, 'utf-8'));
        const cache = {};
        for (const repoData of Object.values(raw.repositories || {})) {
            for (const commit of repoData.commits || []) {
                // Only cache commits with real summaries (not error placeholders)
                if (commit.summary && !commit.summary._error) {
                    cache[commit.commitId] = commit;
                }
            }
        }
        return cache;
    } catch {
        return {};
    }
}

/**
 * Build a day report object from repo data map.
 */
function buildDayReport(dateStr, dayRepoData) {
    return {
        date: dateStr,
        repositories: dayRepoData,
        summary: {
            totalCommits: Object.values(dayRepoData).reduce((s, r) => s + r.stats.total, 0),
            totalHigh: Object.values(dayRepoData).reduce((s, r) => s + r.stats.high, 0),
            totalMedium: Object.values(dayRepoData).reduce((s, r) => s + r.stats.medium, 0),
            totalLow: Object.values(dayRepoData).reduce((s, r) => s + r.stats.low, 0),
            totalConfigChanges: Object.values(dayRepoData).reduce((s, r) => s + (r.stats.configChanges || 0), 0),
            reposIncluded: Object.keys(dayRepoData),
        },
    };
}

/**
 * Write day report to disk.
 */
async function writeDayReport(dateStr, dayRepoData) {
    const report = buildDayReport(dateStr, dayRepoData);
    const filePath = join(DATA_DIR, `${dateStr}.json`);
    await writeFile(filePath, JSON.stringify(report, null, 2));
    return report;
}

/**
 * Format a summarized commit for JSON output.
 */
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

/**
 * Build repo stats from summarized commits.
 */
function buildRepoStats(summarized) {
    return {
        total: summarized.length,
        high: summarized.filter(c => c.llmSummary.riskLevel === 'HIGH').length,
        medium: summarized.filter(c => c.llmSummary.riskLevel === 'MEDIUM').length,
        low: summarized.filter(c => c.llmSummary.riskLevel === 'LOW').length,
        configChanges: summarized.filter(c => (c.llmSummary.changeType || 'code') !== 'code').length,
    };
}

async function main() {
    const opts = parseArgs();
    const repos = [REPOSITORIES.AdsAppsCampaignUI, REPOSITORIES.AdsAppsMT, REPOSITORIES.AdsAppUI];

    await mkdir(DATA_DIR, { recursive: true });

    const targetDates = getWeekdayDates(opts.days);
    console.log(`Target dates (${targetDates.length}): ${targetDates.join(', ')}`);
    if (opts.force) console.log('  --force: regenerating all commits');

    const allDates = [];

    for (const dateStr of targetDates) {
        const dayStart = new Date(dateStr + 'T00:00:00Z');
        const dayEnd = new Date(dateStr + 'T23:59:59Z');

        // Load existing cached summaries for this day
        const existingCache = opts.force ? {} : await loadExistingCommits(dateStr);
        const cachedCount = Object.keys(existingCache).length;
        if (cachedCount > 0) {
            console.log(`\n--- ${dateStr} --- (${cachedCount} cached commits)`);
        } else {
            console.log(`\n--- ${dateStr} ---`);
        }

        const dayRepoData = {};

        for (const repo of repos) {
            const commits = await fetchCommitsBetweenDates(repo, dayStart, dayEnd);
            if (commits.length === 0) {
                console.log(`  ${repo.name}: no commits`);
                continue;
            }

            // Split into cached vs new
            const newCommits = [];
            const cachedCommits = [];
            for (const c of commits) {
                if (existingCache[c.commitId]) {
                    cachedCommits.push(c);
                } else {
                    newCommits.push(c);
                }
            }

            if (newCommits.length === 0) {
                console.log(`  ${repo.name}: ${commits.length} commits (all cached, skipping)`);
                // Rebuild from cache — need to create fake llmSummary wrapper
                const allSummarized = commits.map(c => ({
                    ...c,
                    llmSummary: existingCache[c.commitId].summary,
                }));
                dayRepoData[repo.name] = {
                    repo: repo.name,
                    commits: allSummarized.map(formatCommitForOutput),
                    stats: buildRepoStats(allSummarized),
                };
                continue;
            }

            console.log(`  ${repo.name}: ${commits.length} commits (${cachedCommits.length} cached, ${newCommits.length} new)`);

            // Summarize only new commits with parallel batching
            const summarizedNew = await summarizeCommits(repo, newCommits, (i, total, commit) => {
                console.log(`    [${i}/${total}] ${commit.shortId}`);
            });

            // Merge: cached (with summary wrapper) + newly summarized
            const allSummarized = commits.map(c => {
                if (existingCache[c.commitId]) {
                    return { ...c, llmSummary: existingCache[c.commitId].summary };
                }
                return summarizedNew.find(s => s.commitId === c.commitId) || c;
            });

            dayRepoData[repo.name] = {
                repo: repo.name,
                commits: allSummarized.map(formatCommitForOutput),
                stats: buildRepoStats(allSummarized),
            };

            // Incremental write after each repo completes
            const report = await writeDayReport(dateStr, dayRepoData);
            console.log(`    → saved ${report.summary.totalCommits} commits to ${dateStr}.json`);
        }

        if (Object.keys(dayRepoData).length === 0) {
            console.log(`  (no commits from any repo, skipping)`);
            continue;
        }

        // Final write for the day (ensures all repos are in)
        const finalReport = await writeDayReport(dateStr, dayRepoData);
        allDates.push(dateStr);
        console.log(`  ✓ ${dateStr}: ${finalReport.summary.totalCommits} commits (H:${finalReport.summary.totalHigh} M:${finalReport.summary.totalMedium} L:${finalReport.summary.totalLow} C:${finalReport.summary.totalConfigChanges})`);
    }

    // Update index
    const sortedDates = allDates.sort();
    const index = {
        generatedAt: new Date().toISOString(),
        dates: sortedDates,
        repos: repos.map(r => r.name),
    };
    await writeFile(join(DATA_DIR, 'index.json'), JSON.stringify(index, null, 2));
    console.log(`\nWrote index.json with ${sortedDates.length} dates`);
    console.log('Done!');
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
