/**
 * Reset all data and backfill commits from ADO.
 *
 * Usage:
 *   node scripts/reset-and-refresh.js              — Reset all data + backfill 90 days
 *   node scripts/reset-and-refresh.js --days 60    — Reset + backfill 60 days
 *   node scripts/reset-and-refresh.js --reset-only — Only reset, no backfill
 *   node scripts/reset-and-refresh.js --refresh-only          — Backfill 90 days, skip days that already have data
 *   node scripts/reset-and-refresh.js --refresh-only --days 60 — Backfill 60 days, skip existing
 *   node scripts/reset-and-refresh.js --rebuild-embeddings    — Rebuild vector embeddings from existing daily JSON
 *
 * Backfill semantics:
 *   --refresh-only is the safe, idempotent path. It walks each day in the window and only
 *   processes commits whose IDs are NOT already in the daily JSON for that date. Existing
 *   summaries, embeddings, and vector rows are preserved. Re-running it after a partial run
 *   resumes from where it stopped without touching prior work.
 *
 *   Without --refresh-only, the script first calls resetAllData() which DELETES daily JSON,
 *   vectors.db, diffs cache, the checkpoint, and feedback DB. Use only when you want a full
 *   rebuild from scratch.
 */

import { resetAllData, backfillCommits, rebuildEmbeddings } from '../src/services/scheduled-refresh.js';

const args = process.argv.slice(2);
const resetOnly = args.includes('--reset-only');
const refreshOnly = args.includes('--refresh-only');
const rebuildOnly = args.includes('--rebuild-embeddings');
const daysIdx = args.indexOf('--days');
const days = daysIdx !== -1 ? parseInt(args[daysIdx + 1], 10) || 90 : 90;

const modeCount = [resetOnly, refreshOnly, rebuildOnly].filter(Boolean).length;
if (modeCount > 1) {
    console.error('Cannot combine --reset-only, --refresh-only, and --rebuild-embeddings.');
    process.exit(1);
}

if (rebuildOnly) {
    await rebuildEmbeddings();
    console.log('Done.');
    process.exit(0);
}

if (!refreshOnly) {
    // Try SQL DELETE (works when DB is open locally), fall back to file deletion (for server/SSH)
    let clearFn;
    try {
        const { clearDatabase } = await import('../api/db.js');
        clearFn = clearDatabase;
    } catch {
        // api/db.js not importable (different path on server) — delete files instead
        const { unlinkSync, existsSync } = await import('fs');
        const { join, dirname } = await import('path');
        const { fileURLToPath } = await import('url');
        const __dirname = dirname(fileURLToPath(import.meta.url));
        clearFn = () => {
            const dataDir = join(__dirname, '..', 'data');
            for (const f of ['feedback.db', 'feedback.db-shm', 'feedback.db-wal']) {
                const p = join(dataDir, f);
                if (existsSync(p)) { unlinkSync(p); console.log(`  Deleted ${f}`); }
            }
        };
    }

    await resetAllData(clearFn);
}

if (!resetOnly) {
    await backfillCommits(days, refreshOnly);
}

console.log('Done.');
