/** Integration test for configurable dimensions, exact metadata filtering, FTS5, and RRF. */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { rmSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, 'hybrid-search-test.db');
process.env.VECTORS_DB = dbPath;
process.env.OPENAI_EMBEDDING_MODEL = 'test-embedding-model';
process.env.OPENAI_EMBEDDING_DIMENSIONS = '4';

rmSync(dbPath, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });

const {
    upsertVectors,
    searchVectors,
    searchLexical,
    lookupByCommitIds,
    getVectorStats,
    closeVectorStore,
} = await import('../services/vector-store.js');
const { fuseRankedResults } = await import('../services/rank-fusion.js');
const { buildSearchableCommitText } = await import('../services/commit-embedding-text.js');

let passed = 0;
function assert(condition, message) {
    if (!condition) throw new Error(message);
    console.log(`  ✓ ${message}`);
    passed++;
}

try {
    const searchableText = buildSearchableCommitText({
        author: 'Alice', date: '2021-06-01', message: 'Fix AuthConfig rollout crash',
        changedFiles: ['src/auth/AuthConfig.ts'],
        summary: { title: 'Fix auth crash', summary: 'Guard rollout state', riskLevel: 'HIGH', changeType: 'code' },
    }, 'demo/ui');
    assert(!searchableText.includes('Alice') && !searchableText.includes('2021-06-01'), 'document text keeps author/date in metadata only');
    assert(searchableText.includes('AuthConfig.ts'), 'document text retains compact code paths');

    await upsertVectors([
        {
            id: 'aaaaaaaa', commitId: 'a'.repeat(40), repo: 'demo/ui', date: '2021-06-01', author: 'Alice',
            text: 'Fix AuthConfig rollout crash\nFiles: src/auth/AuthConfig.ts',
            embedding: [1, 0, 0, 0],
            metadata: { title: 'Fix auth config crash', summary: 'Guard null rollout state', riskLevel: 'HIGH', changeType: 'config' },
        },
        {
            id: 'bbbbbbbb', commitId: 'b'.repeat(40), repo: 'demo/ui', date: '2021-06-02', author: 'Bob',
            text: 'Update campaign form validation\nFiles: src/campaign/Form.tsx',
            embedding: [0, 1, 0, 0],
            metadata: { title: 'Campaign validation', summary: 'Validate budget', riskLevel: 'MEDIUM', changeType: 'code' },
        },
        {
            id: 'aaaaaaaa', commitId: 'c'.repeat(40), repo: 'demo/api', date: '2021-06-03', author: 'Carol',
            text: 'Document authentication endpoint',
            embedding: [0, 0, 1, 0],
            metadata: { title: 'Auth docs', summary: 'Update docs', riskLevel: 'LOW', changeType: 'code' },
        },
    ]);

    const stats = await getVectorStats();
    assert(stats.totalCommits === 3, 'stores three commits');
    assert(stats.dimensions === 4, 'reports configured embedding dimensions');
    assert(stats.dateRange.from === '2021-06-01' && stats.dateRange.to === '2021-06-03', 'reports historical date anchor');

    const lexical = await searchLexical('AuthConfig.ts rollout', { repo: 'demo/ui', topK: 5 });
    assert(lexical[0]?.id === 'aaaaaaaa', 'FTS5 retrieves an exact code/path term');

    const fullShaLookup = await lookupByCommitIds(['a'.repeat(40)]);
    assert(fullShaLookup.length === 1 && fullShaLookup[0].commitId === 'a'.repeat(40), 'full SHA lookup remains exact when short IDs collide across repositories');

    const shortShaLookup = await lookupByCommitIds(['aaaaaaaa']);
    assert(shortShaLookup.length === 2, 'short SHA lookup returns matching commits across repositories');

    const filtered = await searchVectors([0, 1, 0, 0], {
        repo: 'demo/ui', dateFrom: '2021-06-02', dateTo: '2021-06-02', topK: 5, minScore: 0,
    });
    assert(filtered.length === 1 && filtered[0].id === 'bbbbbbbb', 'metadata is filtered before exact cosine ranking');
    assert(filtered[0]._retrievalMode === 'exact-filtered', 'reports exact filtered retrieval mode');

    const fused = fuseRankedResults([
        { results: [filtered[0]], weight: 1, channel: 'dense-primary' },
        { results: lexical, weight: 1, channel: 'lexical-fts5' },
    ], { k: 20 });
    assert(fused.length === 2, 'RRF preserves different commits across channels');

    const sameShortId = fuseRankedResults([
        { results: [{ id: 'aaaaaaaa', repo: 'demo/ui', score: 0.8 }], channel: 'dense-primary' },
        { results: [{ id: 'aaaaaaaa', repo: 'demo/api', score: 0.7 }], channel: 'dense-primary' },
    ]);
    assert(sameShortId.length === 2, 'RRF identity includes repository as well as short SHA');

    closeVectorStore();
    process.env.OPENAI_EMBEDDING_DIMENSIONS = '2';
    let rejectedStaleIndex = false;
    try {
        await getVectorStats();
    } catch (err) {
        rejectedStaleIndex = /contract mismatch/.test(err.message);
    }
    assert(rejectedStaleIndex, 'index contract rejects a model/dimension change without rebuild');
    process.env.OPENAI_EMBEDDING_DIMENSIONS = '4';

    console.log(`\n== Results: ${passed} passed ==`);
} finally {
    closeVectorStore();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
}
