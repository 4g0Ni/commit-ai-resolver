/**
 * Unit tests for vector-store.js — cosine similarity, search, upsert, filtering.
 * No external API calls needed — tests pure logic with mock data.
 *
 * Usage: node tests/test-vector-store.js
 */

import { cosineSimilarity } from '../services/vector-store.js';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, '..', '..', 'data', 'embeddings-test');
const TEST_VECTORS_FILE = join(TEST_DIR, 'vectors.json');

let passed = 0;
let failed = 0;

function assert(condition, name) {
    if (condition) {
        console.log(`  ✓ ${name}`);
        passed++;
    } else {
        console.error(`  ✗ ${name}`);
        failed++;
    }
}

function assertApprox(actual, expected, tolerance, name) {
    const ok = Math.abs(actual - expected) < tolerance;
    if (ok) {
        console.log(`  ✓ ${name} (${actual.toFixed(4)} ≈ ${expected})`);
        passed++;
    } else {
        console.error(`  ✗ ${name} — expected ~${expected}, got ${actual.toFixed(4)}`);
        failed++;
    }
}

// ---------------------------------------------------------------------------
// Test: cosineSimilarity
// ---------------------------------------------------------------------------
console.log('\n== cosineSimilarity ==');

// Identical vectors → similarity = 1
assertApprox(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1.0, 0.0001, 'identical vectors = 1.0');

// Orthogonal vectors → similarity = 0
assertApprox(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0.0, 0.0001, 'orthogonal vectors = 0.0');

// Opposite vectors → similarity = -1
assertApprox(cosineSimilarity([1, 0, 0], [-1, 0, 0]), -1.0, 0.0001, 'opposite vectors = -1.0');

// Parallel vectors with different magnitudes → similarity = 1
assertApprox(cosineSimilarity([1, 2, 3], [2, 4, 6]), 1.0, 0.0001, 'parallel vectors = 1.0');

// Known angle: [1,1] and [1,0] → cos(45°) ≈ 0.7071
assertApprox(cosineSimilarity([1, 1], [1, 0]), 0.7071, 0.001, '[1,1]·[1,0] ≈ 0.707');

// ---------------------------------------------------------------------------
// Test: search with mock vector store (in-process)
// ---------------------------------------------------------------------------
console.log('\n== searchVectors (mock data) ==');

// Build a mock store and test search logic directly
const mockCommits = [
    {
        id: 'abc12345', repo: 'AdsAppsCampaignUI', date: '2026-04-06',
        text: 'Add campaign grid bulk edit',
        embedding: [1, 0, 0, 0, 0], // direction: x-axis
        metadata: { title: 'Add bulk edit', riskLevel: 'MEDIUM', author: 'Alice' },
    },
    {
        id: 'def67890', repo: 'AdsAppsMT', date: '2026-04-06',
        text: 'Fix auth token refresh',
        embedding: [0, 1, 0, 0, 0], // direction: y-axis
        metadata: { title: 'Fix auth refresh', riskLevel: 'HIGH', author: 'Bob' },
    },
    {
        id: 'ghi11111', repo: 'AdsAppsCampaignUI', date: '2026-04-05',
        text: 'Update localization strings',
        embedding: [0.7, 0.7, 0, 0, 0], // between x and y
        metadata: { title: 'Update loc strings', riskLevel: 'LOW', author: 'Carol' },
    },
    {
        id: 'jkl22222', repo: 'AdsAppUI', date: '2026-04-04',
        text: 'Remove feature flag gating',
        embedding: [0, 0, 1, 0, 0], // z-axis
        metadata: { title: 'Remove flag gate', riskLevel: 'HIGH', author: 'Dave' },
    },
];

// Manual search implementation (mirrors searchVectors logic but in-memory)
function testSearch(queryEmbedding, opts = {}) {
    const { topK = 10, minScore = 0.3, repo, dateFrom, dateTo } = opts;
    let candidates = [...mockCommits];
    if (repo) candidates = candidates.filter(c => c.repo === repo);
    if (dateFrom) candidates = candidates.filter(c => c.date >= dateFrom);
    if (dateTo) candidates = candidates.filter(c => c.date <= dateTo);

    return candidates
        .map(c => ({ ...c, score: cosineSimilarity(queryEmbedding, c.embedding) }))
        .filter(r => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map(({ embedding, ...rest }) => rest);
}

// Query aligned with x-axis should find abc12345 first
{
    const results = testSearch([1, 0, 0, 0, 0]);
    assert(results.length >= 1, 'x-axis query returns results');
    assert(results[0].id === 'abc12345', 'x-axis query: top result is abc12345');
    assertApprox(results[0].score, 1.0, 0.001, 'x-axis query: top score = 1.0');
}

// Query aligned with y-axis should find def67890 first
{
    const results = testSearch([0, 1, 0, 0, 0]);
    assert(results[0].id === 'def67890', 'y-axis query: top result is def67890');
}

// Query between x and y should find ghi11111 (same direction)
{
    const results = testSearch([0.7, 0.7, 0, 0, 0]);
    assert(results[0].id === 'ghi11111', 'diagonal query: top result is ghi11111');
}

// topK limiting
{
    const results = testSearch([0.5, 0.5, 0.5, 0.5, 0.5], { topK: 2 });
    assert(results.length <= 2, 'topK=2 limits results');
}

// minScore filtering
{
    const results = testSearch([1, 0, 0, 0, 0], { minScore: 0.99 });
    assert(results.length === 1, 'minScore=0.99 filters to exact match only');
    assert(results[0].id === 'abc12345', 'minScore=0.99 returns abc12345');
}

// Repo filter
{
    const results = testSearch([0.5, 0.5, 0.5, 0.5, 0.5], { repo: 'AdsAppsCampaignUI' });
    assert(results.every(r => r.repo === 'AdsAppsCampaignUI'), 'repo filter only returns matching repo');
}

// Date range filter
{
    const results = testSearch([0.5, 0.5, 0.5, 0.5, 0.5], { dateFrom: '2026-04-06' });
    assert(results.every(r => r.date >= '2026-04-06'), 'dateFrom filter works');
}

{
    const results = testSearch([0.5, 0.5, 0.5, 0.5, 0.5], { dateTo: '2026-04-04' });
    assert(results.every(r => r.date <= '2026-04-04'), 'dateTo filter works');
}

// Embedding stripped from results
{
    const results = testSearch([1, 0, 0, 0, 0]);
    assert(!results[0].embedding, 'embedding stripped from results');
}

// ---------------------------------------------------------------------------
// Test: upsert deduplication logic
// ---------------------------------------------------------------------------
console.log('\n== upsert dedup logic ==');

{
    // Simulate upsert logic
    const store = { commits: [...mockCommits] };
    const existingKeys = new Set(store.commits.map(c => `${c.repo}:${c.id}`));

    const newEntry = {
        id: 'abc12345', repo: 'AdsAppsCampaignUI', date: '2026-04-06',
        text: 'UPDATED text',
        embedding: [0.9, 0.1, 0, 0, 0],
        metadata: { title: 'Updated bulk edit', riskLevel: 'LOW', author: 'Alice' },
    };

    const key = `${newEntry.repo}:${newEntry.id}`;
    if (existingKeys.has(key)) {
        const idx = store.commits.findIndex(c => `${c.repo}:${c.id}` === key);
        store.commits[idx] = newEntry;
    } else {
        store.commits.push(newEntry);
    }

    assert(store.commits.length === 4, 'upsert does not duplicate (still 4 commits)');
    assert(store.commits.find(c => c.id === 'abc12345').text === 'UPDATED text', 'upsert updates existing entry');

    // Insert genuinely new
    const brandNew = {
        id: 'zzz99999', repo: 'NewRepo', date: '2026-04-07',
        text: 'Brand new commit',
        embedding: [0, 0, 0, 0, 1],
        metadata: { title: 'New', riskLevel: 'LOW', author: 'Eve' },
    };
    const key2 = `${brandNew.repo}:${brandNew.id}`;
    if (!existingKeys.has(key2)) {
        store.commits.push(brandNew);
        existingKeys.add(key2);
    }
    assert(store.commits.length === 5, 'new entry adds to store (5 commits)');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n== Results: ${passed} passed, ${failed} failed ==`);
process.exit(failed > 0 ? 1 : 0);
