/**
 * Commit AI Resolver — Entry point
 *
 * Modes:
 *   node index.js                    — Fetch commits between latest two release tags (all repos)
 *   node index.js --latest [N]       — Fetch latest N commits per repo (default: 10)
 *   node index.js --tags             — List recent release tags per repo
 *   node index.js --summarize        — Fetch release commits + LLM summary for each
 *   node index.js --repos r1,r2      — Limit to specific repos (comma-separated)
 */

import { REPOSITORIES } from './config/repositories.js';
import {
    fetchLatestCommits,
    fetchCommitsBetweenReleaseTags,
    resolveReleaseTags,
} from './services/ado-git-client.js';
import { summarizeCommits } from './services/commit-summarizer.js';

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { mode: 'release', repos: null, top: 10 };

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
        } else if (args[i] === '--repos' && args[i + 1]) {
            opts.repos = args[i + 1].split(',').map(s => s.trim());
            i++;
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

async function modeSummarize(repos) {
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
            console.log(`  Commits: ${result.commitCount}\n`);
            console.log(`  Generating LLM summaries...\n`);

            const summarized = await summarizeCommits(repo, result.commits, (i, total, commit) => {
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
// Main
// ---------------------------------------------------------------------------
async function main() {
    const opts = parseArgs();
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
        case 'summarize': await modeSummarize(repos); break;
    }
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
