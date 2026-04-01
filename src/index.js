/**
 * Commit AI Resolver — Entry point
 *
 * Fetches the latest 10 commits from each tracked repository and prints a summary.
 * Usage: ADO_PAT=<your-pat> node index.js
 */

import { REPOSITORIES } from './config/repositories.js';
import { fetchLatestCommits } from './services/ado-git-client.js';

async function main() {
    const reposToFetch = [REPOSITORIES.AdsAppsCampaignUI, REPOSITORIES.AdsAppsMT];

    for (const repo of reposToFetch) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Repository: ${repo.name}`);
        console.log(`${'='.repeat(60)}`);

        try {
            const commits = await fetchLatestCommits(repo, 10);
            console.log(`Found ${commits.length} commits:\n`);

            for (const commit of commits) {
                console.log(`  [${commit.shortId}] ${commit.date?.toISOString?.() ?? commit.date}`);
                console.log(`  Author: ${commit.author}`);
                console.log(`  Title:  ${commit.title}`);
                console.log(`  URL:    ${commit.url ?? 'N/A'}`);
                console.log();
            }
        } catch (err) {
            console.error(`  Error fetching commits for ${repo.name}: ${err.message}`);
        }
    }
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
