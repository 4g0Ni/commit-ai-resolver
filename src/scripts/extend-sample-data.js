/**
 * Extend sample data by creating synthetic past days from existing real data.
 * Duplicates existing day files with varied dates to fill out the timeline for UI testing.
 *
 * Usage: node scripts/extend-sample-data.js [--days 10]
 */

import { readdir, readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data', 'daily');

function parseArgs() {
    const args = process.argv.slice(2);
    let days = 10;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--days' && args[i + 1]) {
            days = parseInt(args[i + 1], 10) || 10;
            i++;
        }
    }
    return { days };
}

function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().substring(0, 10);
}

/** Slightly vary commit counts and risk levels for realism */
function varyData(dayData, newDate) {
    const varied = JSON.parse(JSON.stringify(dayData));
    varied.date = newDate;

    const riskLevels = ['LOW', 'MEDIUM', 'HIGH'];

    for (const [repoName, repo] of Object.entries(varied.repositories)) {
        // Randomly drop 0-2 commits or keep all
        const dropCount = Math.floor(Math.random() * 2);
        if (repo.commits.length > 2) {
            repo.commits.splice(0, dropCount);
        }

        // Vary risk levels on ~30% of commits
        for (const commit of repo.commits) {
            if (Math.random() < 0.3) {
                const newRisk = riskLevels[Math.floor(Math.random() * 3)];
                commit.summary.riskLevel = newRisk;
            }
            // Adjust date in commit
            commit.date = newDate + commit.date.substring(10);
        }

        // Recalculate stats
        repo.stats = {
            total: repo.commits.length,
            high: repo.commits.filter(c => c.summary.riskLevel === 'HIGH').length,
            medium: repo.commits.filter(c => c.summary.riskLevel === 'MEDIUM').length,
            low: repo.commits.filter(c => c.summary.riskLevel === 'LOW').length,
        };
    }

    // Recalculate summary
    const repos = Object.values(varied.repositories);
    varied.summary = {
        totalCommits: repos.reduce((s, r) => s + r.stats.total, 0),
        totalHigh: repos.reduce((s, r) => s + r.stats.high, 0),
        totalMedium: repos.reduce((s, r) => s + r.stats.medium, 0),
        totalLow: repos.reduce((s, r) => s + r.stats.low, 0),
        reposIncluded: Object.keys(varied.repositories),
    };

    return varied;
}

async function main() {
    const { days } = parseArgs();

    // Load existing files
    const files = await readdir(DATA_DIR);
    const existingDates = files
        .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.json$/))
        .map(f => f.replace('.json', ''))
        .sort();

    if (existingDates.length === 0) {
        console.error('No existing data files found. Run generate-sample-data.js first.');
        process.exit(1);
    }

    console.log(`Existing dates: ${existingDates.join(', ')}`);

    // Load all existing day data as templates
    const templates = [];
    for (const date of existingDates) {
        const content = await readFile(join(DATA_DIR, `${date}.json`), 'utf-8');
        templates.push(JSON.parse(content));
    }

    // Generate days going backwards from the earliest existing date
    const earliest = existingDates[0];
    const allDates = [...existingDates];
    let daysToAdd = days - existingDates.length;

    for (let i = 1; daysToAdd > 0; i++) {
        const newDate = addDays(earliest, -i);

        // Skip weekends for realism
        const dow = new Date(newDate + 'T00:00:00Z').getUTCDay();
        if (dow === 0 || dow === 6) continue;

        // Pick a random template and vary it
        const template = templates[i % templates.length];
        const newData = varyData(template, newDate);

        const filePath = join(DATA_DIR, `${newDate}.json`);
        await writeFile(filePath, JSON.stringify(newData, null, 2));
        console.log(`Created ${newDate} (${newData.summary.totalCommits} commits)`);

        allDates.push(newDate);
        daysToAdd--;
    }

    // Update index
    allDates.sort();
    const index = {
        generatedAt: new Date().toISOString(),
        dates: allDates,
        repos: templates[0].summary.reposIncluded,
    };
    await writeFile(join(DATA_DIR, 'index.json'), JSON.stringify(index, null, 2));
    console.log(`\nIndex updated: ${allDates.length} dates total`);
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
