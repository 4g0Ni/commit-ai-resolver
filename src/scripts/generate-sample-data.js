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
import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data', 'daily');

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { days: 10, commitsPerDay: 5 };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--days' && args[i + 1]) {
            opts.days = parseInt(args[i + 1], 10) || 10;
            i++;
        } else if (args[i] === '--commits-per-day' && args[i + 1]) {
            opts.commitsPerDay = parseInt(args[i + 1], 10) || 5;
            i++;
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

async function main() {
    const opts = parseArgs();
    const repos = [REPOSITORIES.AdsAppsCampaignUI, REPOSITORIES.AdsAppsMT, REPOSITORIES.AdsAppUI];

    await mkdir(DATA_DIR, { recursive: true });

    // Determine target dates: N weekdays back from today (newest first)
    const targetDates = getWeekdayDates(opts.days);
    console.log(`Target dates (${targetDates.length}): ${targetDates.join(', ')}`);

    // Fetch commits per day per repo
    const allRepoData = {};

    for (const dateStr of targetDates) {
        const dayStart = new Date(dateStr + 'T00:00:00Z');
        const dayEnd = new Date(dateStr + 'T23:59:59Z');

        console.log(`\n--- ${dateStr} ---`);

        for (const repo of repos) {
            const commits = await fetchCommitsBetweenDates(repo, dayStart, dayEnd);
            if (commits.length === 0) {
                console.log(`  ${repo.name}: no commits`);
                continue;
            }

            const dayCommits = commits.slice(0, opts.commitsPerDay);
            console.log(`  ${repo.name}: ${commits.length} total, summarizing ${dayCommits.length}...`);

            const summarized = await summarizeCommits(repo, dayCommits, (i, total, commit) => {
                console.log(`    [${i}/${total}] ${commit.shortId}`);
            });

            if (!allRepoData[dateStr]) allRepoData[dateStr] = {};
            allRepoData[dateStr][repo.name] = {
                repo: repo.name,
                commits: summarized.map(c => ({
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
                })),
                stats: {
                    total: summarized.length,
                    high: summarized.filter(c => c.llmSummary.riskLevel === 'HIGH').length,
                    medium: summarized.filter(c => c.llmSummary.riskLevel === 'MEDIUM').length,
                    low: summarized.filter(c => c.llmSummary.riskLevel === 'LOW').length,
                    configChanges: summarized.filter(c => (c.llmSummary.changeType || 'code') !== 'code').length,
                },
            };
        }
    }

    // Write per-day JSON files (only days that had commits)
    const dates = Object.keys(allRepoData).sort();
    for (const date of dates) {
        const dayReport = {
            date,
            repositories: allRepoData[date],
            summary: {
                totalCommits: Object.values(allRepoData[date]).reduce((s, r) => s + r.stats.total, 0),
                totalHigh: Object.values(allRepoData[date]).reduce((s, r) => s + r.stats.high, 0),
                totalMedium: Object.values(allRepoData[date]).reduce((s, r) => s + r.stats.medium, 0),
                totalLow: Object.values(allRepoData[date]).reduce((s, r) => s + r.stats.low, 0),
                totalConfigChanges: Object.values(allRepoData[date]).reduce((s, r) => s + (r.stats.configChanges || 0), 0),
                reposIncluded: Object.keys(allRepoData[date]),
            },
        };

        const filePath = join(DATA_DIR, `${date}.json`);
        await writeFile(filePath, JSON.stringify(dayReport, null, 2));
        console.log(`\nWrote ${filePath}`);
    }

    // Write an index file listing all available dates
    const index = {
        generatedAt: new Date().toISOString(),
        dates: dates,
        repos: repos.map(r => r.name),
    };
    await writeFile(join(DATA_DIR, 'index.json'), JSON.stringify(index, null, 2));
    console.log(`\nWrote index.json with ${dates.length} dates`);
    console.log('Done!');
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
