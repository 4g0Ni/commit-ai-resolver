/**
 * Commit AI Resolver — Entry point
 *
 * Modes:
 *   node index.js                    — Fetch commits between latest two release tags (all repos)
 *   node index.js --latest [N]       — Fetch latest N commits per repo (default: 10)
 *   node index.js --tags             — List recent release tags per repo
 *   node index.js --summarize        — Fetch release commits + LLM summary for each
 *   node index.js --releaseInfo 20260407 — Show release build info for a date
 *   node index.js --releaseList          — List release builds from the last 7 days
 *   node index.js --repos r1,r2      — Limit to specific repos (comma-separated)
 */

import { REPOSITORIES } from './config/repositories.js';
import {
    fetchLatestCommits,
    fetchCommitsBetweenReleaseTags,
    resolveReleaseTags,
    fetchReleaseInfo,
    fetchReleaseList,
} from './services/ado-git-client.js';
import { summarizeCommits } from './services/commit-summarizer.js';

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { mode: 'release', repos: null, top: 10, maxSummarize: 5, releaseDate: null };

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--latest') {
            opts.mode = 'latest';
            if (args[i + 1] && !args[i + 1].startsWith('--')) {
                opts.top = parseInt(args[i + 1], 10) || 10;
                i++;
            }
        } else if (args[i] === '--tags') {
            opts.mode = 'tags';
        } else if (args[i] === '--summarize') {
            opts.mode = 'summarize';
            if (args[i + 1] && !args[i + 1].startsWith('--')) {
                opts.maxSummarize = parseInt(args[i + 1], 10) || 5;
                i++;
            }
        } else if (args[i] === '--repos' && args[i + 1]) {
            opts.repos = args[i + 1].split(',').map(s => s.trim());
            i++;
        } else if (args[i] === '--releaseInfo') {
            opts.mode = 'releaseInfo';
            if (args[i + 1] && !args[i + 1].startsWith('--')) {
                opts.releaseDate = args[i + 1];
                i++;
            } else {
                console.error('Error: --releaseInfo requires a date argument in yyyyMMdd format');
                process.exit(1);
            }
        } else if (args[i] === '--releaseList') {
            opts.mode = 'releaseList';
        }
    }
    return opts;
}

function getRepos(filter) {
    if (!filter) return Object.values(REPOSITORIES);
    return filter
        .map(name => REPOSITORIES[name])
        .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Mode: release — commits between latest two release tags
// ---------------------------------------------------------------------------
async function modeRelease(repos) {
    for (const repo of repos) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Repository: ${repo.name}`);
        console.log(`${'='.repeat(60)}`);

        try {
            const result = await fetchCommitsBetweenReleaseTags(repo);

            if (result.error) {
                console.log(`  ⚠ ${result.error}`);
                continue;
            }

            console.log(`  Tags: ${result.fromTag} → ${result.toTag}`);
            console.log(`  Commits: ${result.fromCommit} → ${result.toCommit}`);
            console.log(`  Total: ${result.commitCount} commits\n`);

            for (const commit of result.commits) {
                console.log(`  [${commit.shortId}] ${commit.date}`);
                console.log(`  Author: ${commit.author}`);
                console.log(`  Title:  ${commit.title}`);
                console.log(`  URL:    ${commit.url ?? 'N/A'}`);
                console.log();
            }
        } catch (err) {
            console.error(`  Error: ${err.message}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Mode: latest — N most recent commits
// ---------------------------------------------------------------------------
async function modeLatest(repos, top) {
    for (const repo of repos) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Repository: ${repo.name}`);
        console.log(`${'='.repeat(60)}`);

        try {
            const commits = await fetchLatestCommits(repo, top);
            console.log(`  Found ${commits.length} commits:\n`);

            for (const commit of commits) {
                console.log(`  [${commit.shortId}] ${commit.date}`);
                console.log(`  Author: ${commit.author}`);
                console.log(`  Title:  ${commit.title}`);
                console.log(`  URL:    ${commit.url ?? 'N/A'}`);
                console.log();
            }
        } catch (err) {
            console.error(`  Error: ${err.message}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Mode: tags — list recent release tags
// ---------------------------------------------------------------------------
async function modeTags(repos) {
    for (const repo of repos) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Repository: ${repo.name}`);
        console.log(`${'='.repeat(60)}`);

        try {
            const { today, yesterday, allTags } = await resolveReleaseTags(repo);
            console.log(`  Latest tag:   ${today?.shortName ?? 'none'} (${today?.objectId?.substring(0, 8) ?? '-'})`);
            console.log(`  Previous tag: ${yesterday?.shortName ?? 'none'} (${yesterday?.objectId?.substring(0, 8) ?? '-'})`);
            console.log(`  Recent tags:`);
            for (const tag of allTags) {
                console.log(`    - ${tag.shortName} (${tag.objectId.substring(0, 8)})`);
            }
        } catch (err) {
            console.error(`  Error: ${err.message}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Mode: summarize — release commits + LLM summary
// ---------------------------------------------------------------------------
const RISK_ICON = { HIGH: '🔴', MEDIUM: '🟡', LOW: '🟢' };

async function modeSummarize(repos, maxSummarize) {
    for (const repo of repos) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Repository: ${repo.name}`);
        console.log(`${'='.repeat(60)}`);

        try {
            const result = await fetchCommitsBetweenReleaseTags(repo);

            if (result.error) {
                console.log(`  ⚠ ${result.error}`);
                continue;
            }

            const commitsToSummarize = result.commits.slice(0, maxSummarize);

            console.log(`  Tags: ${result.fromTag} → ${result.toTag}`);
            console.log(`  Commits: ${result.commitCount} total, summarizing ${commitsToSummarize.length}\n`);
            console.log(`  Generating LLM summaries...\n`);

            const summarized = await summarizeCommits(repo, commitsToSummarize, (i, total, commit) => {
                console.log(`  [${i}/${total}] Summarizing ${commit.shortId}...`);
            });

            for (const commit of summarized) {
                const s = commit.llmSummary;
                const icon = RISK_ICON[s.riskLevel] || '⚪';
                console.log(`  ${icon} [${s.riskLevel}] ${commit.shortId} — ${s.title}`);
                console.log(`     Author: ${commit.author} | ${commit.date}`);
                console.log(`     ${s.summary}`);
                if (s.affectedAreas?.length) {
                    console.log(`     Areas: ${s.affectedAreas.join(', ')}`);
                }
                if (s.flags?.length) {
                    console.log(`     Flags: ${s.flags.join(', ')}`);
                }
                console.log(`     PR: ${commit.url ?? 'N/A'}`);
                console.log();
            }

            // Summary stats
            const high = summarized.filter(c => c.llmSummary.riskLevel === 'HIGH').length;
            const medium = summarized.filter(c => c.llmSummary.riskLevel === 'MEDIUM').length;
            const low = summarized.filter(c => c.llmSummary.riskLevel === 'LOW').length;
            console.log(`  --- Summary: ${high} HIGH, ${medium} MEDIUM, ${low} LOW ---`);
        } catch (err) {
            console.error(`  Error: ${err.message}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Mode: releaseInfo — release build info by date
// ---------------------------------------------------------------------------
async function modeReleaseInfo(dateStr) {
    if (!/^\d{8}$/.test(dateStr)) {
        console.error(`Invalid date format: "${dateStr}". Expected yyyyMMdd (e.g. 20260407)`);
        process.exit(1);
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Release Info for: ${dateStr}`);
    console.log(`${'='.repeat(60)}`);

    try {
        const result = await fetchReleaseInfo(dateStr);

        if (result.error) {
            console.log(`  Error: ${result.error}`);
            return;
        }

        const { build, logResults } = result;

        console.log(`\n  Build ID:     ${build.id}`);
        console.log(`  Build Number: ${build.buildNumber}`);
        console.log(`  Status:       ${build.status} / ${build.result}`);
        console.log(`  Started:      ${build.startTime}`);
        console.log(`  Finished:     ${build.finishTime}`);
        if (build.url) {
            console.log(`  URL:          ${build.url}`);
        }

        for (const [repoKey, info] of Object.entries(logResults)) {
            console.log(`\n  ${'-'.repeat(40)}`);
            console.log(`  ${repoKey} (${info.taskName}):`);

            if (!info.found) {
                console.log(`    Not found: ${info.error}`);
                continue;
            }

            console.log(`    Source Commit:  ${info.sourceCommit ?? 'N/A'}`);
            console.log(`    Run ID:        ${info.runId ?? 'N/A'}`);
            console.log(`    Source Branch:  ${info.sourceBranch ?? 'N/A'}`);
        }

        console.log();
    } catch (err) {
        console.error(`  Error: ${err.message}`);
    }
}

// ---------------------------------------------------------------------------
// Mode: releaseList — list recent release builds
// ---------------------------------------------------------------------------
async function modeReleaseList() {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`Release Builds (last 7 days)`);
    console.log(`${'='.repeat(80)}`);

    try {
        const releases = await fetchReleaseList(7);

        if (releases.length === 0) {
            console.log('  No release builds found in the last 7 days.');
            return;
        }

        // Table header
        const hdr = [
            'Release Name'.padEnd(28),
            'Build ID'.padEnd(10),
            'Status'.padEnd(12),
            'CampaignUI Build'.padEnd(18),
            'CampaignUI SHA'.padEnd(16),
            'AppUI Build'.padEnd(18),
            'AppUI SHA'.padEnd(16),
        ].join(' | ');
        console.log(`\n  ${hdr}`);
        console.log(`  ${'-'.repeat(hdr.length)}`);

        for (const { build, logResults } of releases) {
            const campaignRunId = logResults.AdsAppsCampaignUI?.runId ?? 'N/A';
            const campaignSHA = (logResults.AdsAppsCampaignUI?.sourceCommit ?? 'N/A').substring(0, 12);
            const appUIRunId = logResults.AdsAppUI?.runId ?? 'N/A';
            const appUISHA = (logResults.AdsAppUI?.sourceCommit ?? 'N/A').substring(0, 12);
            const status = build.result ?? build.status;

            const row = [
                build.buildNumber.padEnd(28),
                String(build.id).padEnd(10),
                status.padEnd(12),
                campaignRunId.padEnd(18),
                campaignSHA.padEnd(16),
                appUIRunId.padEnd(18),
                appUISHA.padEnd(16),
            ].join(' | ');
            console.log(`  ${row}`);
        }

        console.log(`\n  Total: ${releases.length} releases\n`);
    } catch (err) {
        console.error(`  Error: ${err.message}`);
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    const opts = parseArgs();

    if (opts.mode === 'releaseInfo') {
        console.log(`Mode: releaseInfo | Date: ${opts.releaseDate}`);
        await modeReleaseInfo(opts.releaseDate);
        return;
    }

    if (opts.mode === 'releaseList') {
        console.log(`Mode: releaseList`);
        await modeReleaseList();
        return;
    }

    const repos = getRepos(opts.repos);

    if (repos.length === 0) {
        console.error('No matching repositories found. Available:', Object.keys(REPOSITORIES).join(', '));
        process.exit(1);
    }

    console.log(`Mode: ${opts.mode} | Repos: ${repos.map(r => r.name).join(', ')}`);

    switch (opts.mode) {
        case 'release':   await modeRelease(repos); break;
        case 'latest':    await modeLatest(repos, opts.top); break;
        case 'tags':      await modeTags(repos); break;
        case 'summarize': await modeSummarize(repos, opts.maxSummarize); break;
    }
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
