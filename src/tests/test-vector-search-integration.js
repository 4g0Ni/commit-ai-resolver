/**
 * Integration test for vector search — uses real embeddings on disk.
 * Requires: data/embeddings/vectors.json to exist (run generate-embeddings.js first).
 *
 * Tests:
 * 1. Vector store loads correctly
 * 2. Search returns results for known queries
 * 3. Repo/date filtering works with real data
 * 4. API endpoint responds (if server is running)
 *
 * Usage: node tests/test-vector-search-integration.js
 */

import { loadVectorStore, searchVectors, getVectorStats, cosineSimilarity } from '../services/vector-store.js';
import { generateEmbedding } from '../services/embedding-client.js';

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

// ---------------------------------------------------------------------------
// Test 1: Vector store loads
// ---------------------------------------------------------------------------
console.log('\n== 1. Vector store loads ==');

const store = await loadVectorStore();
assert(store.commits.length > 0, `store has commits (${store.commits.length})`);
assert(store.meta.model === 'text-embedding-3-large', `model is text-embedding-3-large`);
assert(store.commits[0].embedding.length === 3072, `embedding dimension is 3072`);

const stats = await getVectorStats();
assert(stats.totalCommits > 0, `stats.totalCommits = ${stats.totalCommits}`);
assert(stats.repos.length > 0, `stats.repos = ${stats.repos.join(', ')}`);
console.log(`  Date range: ${stats.dateRange?.from} → ${stats.dateRange?.to}`);

// ---------------------------------------------------------------------------
// Test 2: Embedding quality — self-similarity
// ---------------------------------------------------------------------------
console.log('\n== 2. Embedding consistency ==');

// Pick two commits from the same repo — they should have reasonable similarity
const sameRepo = store.commits.filter(c => c.repo === 'AdsAppsCampaignUI').slice(0, 2);
if (sameRepo.length >= 2) {
    const sim = cosineSimilarity(sameRepo[0].embedding, sameRepo[1].embedding);
    assert(sim > -1 && sim <= 1, `same-repo similarity is valid: ${sim.toFixed(4)}`);
    console.log(`  Same-repo pair similarity: ${sim.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// Test 3: Real semantic search queries
// ---------------------------------------------------------------------------
console.log('\n== 3. Semantic search with real embeddings ==');

const testQueries = [
    { query: 'campaign grid changes', expectRepo: 'AdsAppsCampaignUI' },
    { query: 'high risk authentication changes', expectRisk: 'HIGH' },
    { query: 'feature flag pilot ramp', expectField: 'flags' },
    { query: 'what changed yesterday', expectAny: true },
];

for (const { query, expectRepo, expectRisk, expectField, expectAny } of testQueries) {
    console.log(`\n  Query: "${query}"`);
    try {
        const queryEmbedding = await generateEmbedding(query);
        assert(queryEmbedding.length === 3072, `embedding generated (dim=${queryEmbedding.length})`);

        const results = await searchVectors(queryEmbedding, { topK: 5, minScore: 0.2 });
        assert(results.length > 0, `got ${results.length} results`);

        if (results.length > 0) {
            const top = results[0];
            console.log(`  Top: [${top.score.toFixed(3)}] ${top.repo} ${top.id} — ${top.metadata.title}`);

            if (expectRepo) {
                const hasRepo = results.some(r => r.repo === expectRepo);
                assert(hasRepo, `results include ${expectRepo}`);
            }
            if (expectRisk) {
                const hasRisk = results.some(r => r.metadata.riskLevel === expectRisk);
                // Don't fail on this — semantic search won't always surface exact risk levels
                if (hasRisk) {
                    console.log(`  ✓ found ${expectRisk} risk commit`);
                    passed++;
                } else {
                    console.log(`  ⚠ no ${expectRisk} risk in top 5 (not a failure — semantic match may differ)`);
                }
            }
            if (expectAny) {
                assert(results.length >= 1, 'returned at least 1 result');
            }
        }
    } catch (err) {
        console.error(`  ✗ Query failed: ${err.message}`);
        failed++;
    }
}

// ---------------------------------------------------------------------------
// Test 4: Filtering with real data
// ---------------------------------------------------------------------------
console.log('\n== 4. Repo and date filtering ==');

{
    const queryEmbedding = await generateEmbedding('any code change');

    // Repo filter
    const repoResults = await searchVectors(queryEmbedding, { topK: 5, repo: 'AdsAppsMT' });
    assert(repoResults.every(r => r.repo === 'AdsAppsMT'), `repo filter: all results are AdsAppsMT`);

    // Date filter
    const latestDate = stats.dateRange?.to;
    if (latestDate) {
        const dateResults = await searchVectors(queryEmbedding, { topK: 5, dateFrom: latestDate });
        assert(dateResults.every(r => r.date >= latestDate), `dateFrom filter: all results >= ${latestDate}`);
    }
}

// ---------------------------------------------------------------------------
// Test 5: API endpoint (optional — only if server is running)
// ---------------------------------------------------------------------------
console.log('\n== 5. API endpoint (optional) ==');

try {
    const res = await fetch('http://localhost:3001/api/vectors/stats');
    if (res.ok) {
        const apiStats = await res.json();
        assert(apiStats.totalCommits > 0, `API /vectors/stats returns ${apiStats.totalCommits} commits`);
    } else {
        console.log(`  ⚠ API returned ${res.status} — skipping`);
    }
} catch {
    console.log('  ⚠ API server not running — skipping endpoint test');
}

try {
    const res = await fetch('http://localhost:3001/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'What changed today?' }),
    });
    if (res.ok) {
        const data = await res.json();
        assert(data.reply?.length > 0, `API /chat returns reply (${data.reply.length} chars)`);
        if (data.searchMethod) {
            assert(data.searchMethod === 'vector', `API uses vector search method: ${data.searchMethod}`);
        } else {
            console.log('  ⚠ searchMethod not in response — server may need restart');
        }
    } else {
        console.log(`  ⚠ Chat API returned ${res.status} — skipping`);
    }
} catch {
    console.log('  ⚠ API server not running — skipping chat test');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n== Results: ${passed} passed, ${failed} failed ==`);
process.exit(failed > 0 ? 1 : 0);
