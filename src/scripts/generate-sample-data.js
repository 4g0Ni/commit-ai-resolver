/**
 * Generate sample daily summary JSON files for UI development.
 *
 * Fetches real commits from ADO for AdsAppsCampaignUI and AdsAppsMT,
 * summarizes them with LLM, and writes per-day JSON files to data/daily/.
 *
 * Usage:
 *   node scripts/generate-sample-data.js [--days 5] [--commits-per-day 5]
 */

import { REPOSITORIES } from '../config/repositories.js';
import { fetchLatestCommits } from '../services/ado-git-client.js';
import { summarizeCommits } from '../services/commit-summarizer.js';
import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data', 'daily');

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { days: 5, commitsPerDay: 5 };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--days' && args[i + 1]) {
            opts.days = parseInt(args[i + 1], 10) || 5;
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

async function main() {
    const opts = parseArgs();
    const repos = [REPOSITORIES.AdsAppsCampaignUI, REPOSITORIES.AdsAppsMT];
    const totalCommits = opts.days * opts.commitsPerDay;

    await mkdir(DATA_DIR, { recursive: true });

    // Collect all commits per repo, grouped by date
    const allRepoData = {};

    for (const repo of repos) {
        console.log(`\nFetching ${totalCommits} commits from ${repo.name}...`);
        const commits = await fetchLatestCommits(repo, totalCommits + 10); // fetch extra to ensure enough days
        const byDate = groupByDate(commits);
        const dates = Object.keys(byDate).sort().reverse(); // newest first

        console.log(`  Found commits across ${dates.length} dates`);

        // Take up to opts.days dates, each with up to opts.commitsPerDay commits
        const selectedDates = dates.slice(0, opts.days);

        for (const date of selectedDates) {
            const dayCommits = byDate[date].slice(0, opts.commitsPerDay);
            console.log(`  ${date}: ${dayCommits.length} commits — summarizing...`);

            const summarized = await summarizeCommits(repo, dayCommits, (i, total, commit) => {
                console.log(`    [${i}/${total}] ${commit.shortId}`);
            });

            if (!allRepoData[date]) allRepoData[date] = {};
            allRepoData[date][repo.name] = {
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
                    summary: c.llmSummary,
                })),
                stats: {
                    total: summarized.length,
                    high: summarized.filter(c => c.llmSummary.riskLevel === 'HIGH').length,
                    medium: summarized.filter(c => c.llmSummary.riskLevel === 'MEDIUM').length,
                    low: summarized.filter(c => c.llmSummary.riskLevel === 'LOW').length,
                },
            };
        }
    }

    // Write per-day JSON files
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
