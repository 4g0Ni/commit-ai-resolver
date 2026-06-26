/**
 * Generate text embeddings for commit summaries and store in the local vector DB.
 *
 * Reads daily JSON files from data/daily/, builds a text representation of each commit,
 * generates embeddings via Azure OpenAI text-embedding-3-large, and stores in data/embeddings/vectors.json.
 *
 * Usage:
 *   node scripts/generate-embeddings.js [--days 7] [--from 2026-03-25 --to 2026-03-31] [--force]
 *
 * Options:
 *   --days N       Number of days to process (default: all available)
 *   --from DATE    Start date YYYY-MM-DD (inclusive)
 *   --to DATE      End date YYYY-MM-DD (inclusive)
 *   --force        Re-embed all commits even if already in the vector store
 */

import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateEmbeddings } from '../services/embedding-client.js';
import { loadVectorStore, upsertVectors, getVectorStats } from '../services/vector-store.js';
import { compactPathTokens, cleanCommitSubject } from '../services/commit-paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data', 'daily');

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { days: null, force: false, from: null, to: null };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--days' && args[i + 1]) {
            opts.days = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--from' && args[i + 1]) {
            opts.from = args[i + 1];
            i++;
        } else if (args[i] === '--to' && args[i + 1]) {
            opts.to = args[i + 1];
            i++;
        } else if (args[i] === '--force') {
            opts.force = true;
        }
    }
    return opts;
}

/**
 * Build a searchable text representation of a commit for embedding.
 * Includes title, summary, risk, areas, flags — optimized for semantic search.
 */
function buildCommitText(commit, repoName, date) {
    const parts = [
        `[${date}] ${repoName}`,
        `${commit.summary.title}`,
        commit.summary.summary,
        `Risk: ${commit.summary.riskLevel}`,
        `Author: ${commit.author}`,
    ];
    if (commit.summary.affectedAreas?.length) {
        parts.push(`Areas: ${commit.summary.affectedAreas.join(', ')}`);
    }
    if (commit.summary.flags?.length) {
        parts.push(`Flags: ${commit.summary.flags.join(', ')}`);
    }
    if (commit.summary.changeType !== 'code') {
        parts.push(`Type: ${commit.summary.changeType}`);
    }
    if (commit.summary.configChanges?.length) {
        const configs = commit.summary.configChanges.map(c => {
            let desc = `${c.action} ${c.key}: ${c.detail}`;
            if (c.from || c.to) desc += ` (${c.from || '?'} → ${c.to || '?'})`;
            return desc;
        }).join('; ');
        parts.push(`Config: ${configs}`);
    }
    const subject = cleanCommitSubject(commit.message);
    if (subject && subject !== commit.summary.title) parts.push(`PR: ${subject}`);
    const pathTokens = compactPathTokens(commit.changedFiles);
    if (pathTokens.length) parts.push(`Files: ${pathTokens.join(', ')}`);
    return parts.join('\n');
}

async function main() {
    const opts = parseArgs();

    // List available daily files
    let files;
    try {
        files = (await readdir(DATA_DIR))
            .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.json$/))
            .sort()
            .reverse(); // newest first
    } catch {
        console.error('No data directory found. Run generate-sample-data.js first.');
        process.exit(1);
    }

    // Filter by --from/--to date range
    if (opts.from || opts.to) {
        files = files.filter(f => {
            const date = f.replace('.json', '');
            if (opts.from && date < opts.from) return false;
            if (opts.to && date > opts.to) return false;
            return true;
        });
    }

    if (opts.days) {
        files = files.slice(0, opts.days);
    }

    console.log(`Processing ${files.length} daily files...`);

    // Load existing store to check what's already embedded
    const store = await loadVectorStore();
    const existingKeys = new Set(store.commits.map(c => `${c.repo}:${c.id}`));
    console.log(`Existing vector store: ${existingKeys.size} commits`);

    // Collect all commits to embed
    const toEmbed = [];

    for (const file of files) {
        const date = file.replace('.json', '');
        const raw = JSON.parse(await readFile(join(DATA_DIR, file), 'utf-8'));

        for (const [repoName, repoData] of Object.entries(raw.repositories || {})) {
            for (const commit of repoData.commits || []) {
                const key = `${repoName}:${commit.shortId}`;
                if (!opts.force && existingKeys.has(key)) continue;

                toEmbed.push({
                    id: commit.shortId,
                    commitId: commit.commitId,
                    repo: repoName,
                    date,
                    author: commit.author,
                    text: buildCommitText(commit, repoName, date),
                    metadata: {
                        author: commit.author,
                        title: commit.summary.title,
                        summary: commit.summary.summary,
                        riskLevel: commit.summary.riskLevel,
                        changeType: commit.summary.changeType,
                        affectedAreas: commit.summary.affectedAreas || [],
                        flags: commit.summary.flags || [],
                        changedFiles: commit.changedFiles || [],
                        url: commit.url,
                    },
                });
            }
        }
    }

    if (toEmbed.length === 0) {
        console.log('All commits already embedded. Use --force to re-embed.');
        const stats = await getVectorStats();
        console.log(`Vector store: ${stats.totalCommits} commits, ${stats.repos.length} repos`);
        return;
    }

    console.log(`Generating embeddings for ${toEmbed.length} commits...`);

    // Generate embeddings in batches
    const BATCH_SIZE = 16;
    const allEntries = [];
    for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
        const batch = toEmbed.slice(i, i + BATCH_SIZE);
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
            console.log(`  [${Math.min(i + BATCH_SIZE, toEmbed.length)}/${toEmbed.length}] embedded`);
        } catch (err) {
            console.error(`  Error embedding batch at index ${i}: ${err.message}`);
            // Continue with remaining batches
        }
    }

    // Upsert into vector store
    const count = await upsertVectors(allEntries);
    console.log(`Upserted ${count} vectors`);

    const stats = await getVectorStats();
    console.log(`\nVector store stats:`);
    console.log(`  Total commits: ${stats.totalCommits}`);
    console.log(`  Repos: ${stats.repos.join(', ')}`);
    console.log(`  Date range: ${stats.dateRange?.from} → ${stats.dateRange?.to}`);
    console.log(`  Model: ${stats.model}`);
    console.log('Done!');
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
