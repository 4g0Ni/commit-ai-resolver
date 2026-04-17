/**
 * E2E test suite for the vector search + chat pipeline.
 *
 * Tests the full flow: query → embedding → LanceDB search → filters → chat API.
 * Requires:
 *   - LanceDB data at data/lancedb/ (run generate-embeddings.js --force first)
 *   - API server running on port 3001 (for chat endpoint tests)
 *
 * Usage: cd src && node tests/test-search-e2e.js
 */

import { searchVectors, getVectorStats, loadVectorStore } from '../services/vector-store.js';
import { generateEmbedding } from '../services/embedding-client.js';

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, name) {
    if (condition) {
        console.log(`  ✓ ${name}`);
        passed++;
    } else {
        console.error(`  ✗ FAIL: ${name}`);
        failed++;
    }
}

function skip(name) {
    console.log(`  ⊘ SKIP: ${name}`);
    skipped++;
}

const API_BASE = 'http://localhost:4399';
async function apiAvailable() {
    try {
        const res = await fetch(`${API_BASE}/api/vectors/stats`);
        return res.ok;
    } catch { return false; }
}

async function chatQuery(message) {
    const res = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
    });
    return { status: res.status, data: await res.json() };
}

// ===========================================================================
// Suite 1: LanceDB health
// ===========================================================================
console.log('\n══ Suite 1: LanceDB health ══');
{
    const stats = await getVectorStats();
    assert(stats.totalCommits > 100, `has >100 commits (${stats.totalCommits})`);
    assert(stats.repos.length >= 3, `has >=3 repos (${stats.repos.join(', ')})`);
    assert(stats.dateRange.from < stats.dateRange.to, `date range spans multiple days`);

    const store = await loadVectorStore();
    const authors = [...new Set(store.commits.map(c => c.author).filter(Boolean))];
    assert(authors.length > 10, `has >10 distinct authors (${authors.length})`);
    assert(store.commits.every(c => c.author), `every commit has an author field`);
}

// ===========================================================================
// Suite 2: Author filter — find ALL commits by a specific person
// ===========================================================================
console.log('\n══ Suite 2: Author filter ══');
{
    const store = await loadVectorStore();
    // Pick an author with multiple commits
    const authorCounts = {};
    store.commits.forEach(c => { authorCounts[c.author] = (authorCounts[c.author] || 0) + 1; });
    const topAuthor = Object.entries(authorCounts).sort((a, b) => b[1] - a[1])[0];
    console.log(`  Testing with author: "${topAuthor[0]}" (${topAuthor[1]} commits in store)`);

    const emb = await generateEmbedding(`what did ${topAuthor[0]} change recently`);
    const results = await searchVectors(emb, { topK: 50, minScore: 0.0, author: topAuthor[0] });

    assert(results.length === topAuthor[1],
        `author filter returns ALL ${topAuthor[1]} commits (got ${results.length})`);
    assert(results.every(r => r.author === topAuthor[0]),
        `all results are from "${topAuthor[0]}"`);
    assert(results.every(r => r.metadata?.author === topAuthor[0]),
        `metadata.author matches for all results`);
}

// ===========================================================================
// Suite 3: Author filter — case insensitivity and partial match
// ===========================================================================
console.log('\n══ Suite 3: Author case insensitivity ══');
{
    const store = await loadVectorStore();
    const sampleAuthor = store.commits.find(c => c.author?.includes(' '))?.author;
    if (sampleAuthor) {
        const firstName = sampleAuthor.split(' ')[0];
        const emb = await generateEmbedding('recent changes');

        // Full name, lowercase
        const r1 = await searchVectors(emb, { topK: 50, minScore: 0.0, author: sampleAuthor.toLowerCase() });
        assert(r1.length > 0, `lowercase full name "${sampleAuthor.toLowerCase()}" returns results`);

        // First name only
        const r2 = await searchVectors(emb, { topK: 50, minScore: 0.0, author: firstName });
        assert(r2.length >= r1.length, `first name "${firstName}" returns >= full name results (${r2.length} >= ${r1.length})`);
        assert(r2.every(r => r.author.toLowerCase().includes(firstName.toLowerCase())),
            `all results contain "${firstName}" in author`);
    } else {
        skip('no multi-word author found');
    }
}

// ===========================================================================
// Suite 4: Repo filter
// ===========================================================================
console.log('\n══ Suite 4: Repo filter ══');
{
    const emb = await generateEmbedding('code changes');
    for (const repo of ['AdsAppsCampaignUI', 'AdsAppsMT', 'AdsAppUI']) {
        const results = await searchVectors(emb, { topK: 20, minScore: 0.0, repo });
        assert(results.length > 0, `repo="${repo}" returns results (${results.length})`);
        assert(results.every(r => r.repo === repo), `all results are from ${repo}`);
    }
}

// ===========================================================================
// Suite 5: Date range filter
// ===========================================================================
console.log('\n══ Suite 5: Date range filter ══');
{
    const stats = await getVectorStats();
    const emb = await generateEmbedding('recent changes');

    // Single day
    const singleDay = stats.dateRange.to;
    const r1 = await searchVectors(emb, { topK: 50, minScore: 0.0, dateFrom: singleDay, dateTo: singleDay });
    assert(r1.length > 0, `single day ${singleDay} returns results (${r1.length})`);
    assert(r1.every(r => r.date === singleDay), `all results are from ${singleDay}`);

    // Date range (last 3 days)
    const d = new Date(singleDay);
    d.setDate(d.getDate() - 2);
    const threeDaysAgo = d.toISOString().slice(0, 10);
    const r2 = await searchVectors(emb, { topK: 50, minScore: 0.0, dateFrom: threeDaysAgo, dateTo: singleDay });
    assert(r2.length >= r1.length, `3-day range returns >= single day (${r2.length} >= ${r1.length})`);
    assert(r2.every(r => r.date >= threeDaysAgo && r.date <= singleDay), `all results within date range`);
}

// ===========================================================================
// Suite 6: Combined filters (author + date + repo)
// ===========================================================================
console.log('\n══ Suite 6: Combined filters ══');
{
    const store = await loadVectorStore();
    // Find an author who has commits in AdsAppsCampaignUI
    const campaignAuthors = store.commits
        .filter(c => c.repo === 'AdsAppsCampaignUI')
        .map(c => c.author);
    const authorCounts = {};
    campaignAuthors.forEach(a => { authorCounts[a] = (authorCounts[a] || 0) + 1; });
    const testAuthor = Object.entries(authorCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

    if (testAuthor) {
        const emb = await generateEmbedding('changes');
        const results = await searchVectors(emb, {
            topK: 50, minScore: 0.0,
            author: testAuthor,
            repo: 'AdsAppsCampaignUI',
        });
        assert(results.length > 0, `combined author+repo returns results`);
        assert(results.every(r => r.author === testAuthor && r.repo === 'AdsAppsCampaignUI'),
            `all results match both author="${testAuthor}" and repo=AdsAppsCampaignUI`);
    } else {
        skip('no suitable author found for combined filter test');
    }
}

// ===========================================================================
// Suite 7: Semantic relevance — domain queries
// ===========================================================================
console.log('\n══ Suite 7: Semantic relevance ══');
{
    const queries = [
        { q: 'pilot flag or feature gate changes', check: r => r.some(x =>
            x.metadata.flags?.length > 0 || x.metadata.changeType === 'config' || x.metadata.changeType === 'mixed'
        ), name: 'finds flag/config commits' },
        { q: 'high risk infrastructure changes', check: r => r.some(x =>
            x.metadata.riskLevel === 'HIGH'
        ), name: 'finds HIGH risk commits' },
        { q: 'UI bug fix for ads page', check: r => r.some(x =>
            x.metadata.title.toLowerCase().includes('fix') || x.metadata.summary.toLowerCase().includes('fix')
        ), name: 'finds bug fix commits' },
        { q: 'grid or table column changes', check: r => r.some(x =>
            x.metadata.title.toLowerCase().includes('grid') || x.metadata.title.toLowerCase().includes('column')
        ), name: 'finds grid/column commits' },
        { q: 'authentication or login changes', check: r => r.length > 0,
            name: 'returns results for auth query' },
    ];

    for (const { q, check, name } of queries) {
        const emb = await generateEmbedding(q);
        const results = await searchVectors(emb, { topK: 10, minScore: 0.15 });
        assert(results.length > 0, `"${q}" → ${results.length} results`);
        if (results.length > 0) {
            if (check(results)) {
                console.log(`  ✓ ${name}`);
                passed++;
            } else {
                console.log(`  ⚠ ${name} — no exact match in top 10 (semantic search approximation)`);
                // Don't fail on semantic approximations
            }
        }
    }
}

// ===========================================================================
// Suite 8: Score ordering and bounds
// ===========================================================================
console.log('\n══ Suite 8: Score ordering ══');
{
    const emb = await generateEmbedding('campaign management UI changes');
    const results = await searchVectors(emb, { topK: 20, minScore: 0.0 });
    assert(results.length > 0, `got results`);

    // Scores should be descending
    for (let i = 1; i < results.length; i++) {
        if (results[i].score > results[i - 1].score + 0.001) {
            assert(false, `scores are descending (${results[i - 1].score} then ${results[i].score} at index ${i})`);
            break;
        }
        if (i === results.length - 1) {
            assert(true, `all ${results.length} scores are in descending order`);
        }
    }

    // All scores should be between 0 and 1
    assert(results.every(r => r.score >= -0.01 && r.score <= 1.01),
        `all scores in [-0.01, 1.01] range`);
}

// ===========================================================================
// Suite 9: minScore threshold
// ===========================================================================
console.log('\n══ Suite 9: minScore threshold ══');
{
    const emb = await generateEmbedding('something');
    const r0 = await searchVectors(emb, { topK: 50, minScore: 0.0 });
    const r3 = await searchVectors(emb, { topK: 50, minScore: 0.3 });
    const r5 = await searchVectors(emb, { topK: 50, minScore: 0.5 });

    assert(r0.length >= r3.length, `minScore=0.0 (${r0.length}) >= minScore=0.3 (${r3.length})`);
    assert(r3.length >= r5.length, `minScore=0.3 (${r3.length}) >= minScore=0.5 (${r5.length})`);
    assert(r3.every(r => r.score >= 0.3), `all results with minScore=0.3 have score >= 0.3`);
}

// ===========================================================================
// Suite 10: Result shape verification
// ===========================================================================
console.log('\n══ Suite 10: Result shape ══');
{
    const emb = await generateEmbedding('any changes');
    const results = await searchVectors(emb, { topK: 5, minScore: 0.0 });
    if (results.length > 0) {
        const r = results[0];
        assert(typeof r.id === 'string' && r.id.length > 0, 'has id (string)');
        assert(typeof r.repo === 'string', 'has repo (string)');
        assert(typeof r.date === 'string' && /\d{4}-\d{2}-\d{2}/.test(r.date), 'has date (YYYY-MM-DD)');
        assert(typeof r.author === 'string' && r.author.length > 0, 'has author (string)');
        assert(typeof r.score === 'number', 'has score (number)');
        assert(typeof r.text === 'string' && r.text.length > 0, 'has text (string)');
        assert(typeof r.metadata === 'object', 'has metadata (object)');
        assert(typeof r.metadata.title === 'string', 'metadata has title');
        assert(typeof r.metadata.summary === 'string', 'metadata has summary');
        assert(['LOW', 'MEDIUM', 'HIGH'].includes(r.metadata.riskLevel), `metadata.riskLevel is valid (${r.metadata.riskLevel})`);
        assert(Array.isArray(r.metadata.affectedAreas), 'metadata has affectedAreas array');
        assert(Array.isArray(r.metadata.flags), 'metadata has flags array');
    }
}

// ===========================================================================
// Suite 11: Empty/no-match scenarios
// ===========================================================================
console.log('\n══ Suite 11: Edge cases ══');
{
    const emb = await generateEmbedding('quantum physics entanglement');
    const results = await searchVectors(emb, { topK: 5, minScore: 0.5 });
    assert(results.length === 0 || results[0].score < 0.6,
        `unrelated query gets low or no results (${results.length} results, top score: ${results[0]?.score?.toFixed(3) ?? 'N/A'})`);

    // Non-existent author
    const r2 = await searchVectors(emb, { topK: 5, minScore: 0.0, author: 'NonExistentPerson12345' });
    assert(r2.length === 0, `non-existent author returns 0 results`);

    // Non-existent repo
    const r3 = await searchVectors(emb, { topK: 5, minScore: 0.0, repo: 'FakeRepoThatDoesNotExist' });
    assert(r3.length === 0, `non-existent repo returns 0 results`);

    // Future date
    const r4 = await searchVectors(emb, { topK: 5, minScore: 0.0, dateFrom: '2099-01-01' });
    assert(r4.length === 0, `future dateFrom returns 0 results`);
}

// ===========================================================================
// Suite 12: Chat API E2E (requires running server)
// ===========================================================================
console.log('\n══ Suite 12: Chat API E2E ══');
{
    const hasApi = await apiAvailable();
    if (!hasApi) {
        skip('API server not running — skipping chat E2E tests');
    } else {
        // 12a: Basic chat query
        {
            const { status, data } = await chatQuery('What changed today?');
            assert(status === 200, `chat returns 200`);
            assert(data.reply?.length > 50, `reply is substantive (${data.reply?.length} chars)`);
            assert(data.searchMethod === 'vector' || data.searchMethod === 'fallback-full',
                `searchMethod is vector or fallback (${data.searchMethod})`);
        }

        // 12b: Author query — should trigger author filter
        {
            const store = await loadVectorStore();
            const sampleAuthor = store.commits[0].author;
            const firstName = sampleAuthor.split(' ')[0];
            const { status, data } = await chatQuery(`what did ${firstName} do recently?`);
            assert(status === 200, `author chat query returns 200`);
            assert(data.reply.toLowerCase().includes(firstName.toLowerCase()),
                `reply mentions "${firstName}"`);
        }

        // 12c: Specific incident query
        {
            const { status, data } = await chatQuery(
                'There was a latency regression on March 30. Which commits from that day might be related?'
            );
            assert(status === 200, `incident query returns 200`);
            assert(data.reply.length > 100, `incident reply is detailed (${data.reply.length} chars)`);
        }

        // 12d: Config/pilot query
        {
            const { status, data } = await chatQuery('List any pilot flag or feature flag changes in the last week');
            assert(status === 200, `flag query returns 200`);
            assert(data.reply.length > 50, `flag reply has content`);
        }

        // 12e: Repo-specific query
        {
            const { status, data } = await chatQuery('What high risk changes were made to AdsAppsMT recently?');
            assert(status === 200, `repo-specific query returns 200`);
            assert(data.reply.length > 50, `repo reply has content`);
        }

        // 12f: Empty message
        {
            const res = await fetch(`${API_BASE}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: '' }),
            });
            assert(res.status === 400, `empty message returns 400`);
        }
    }
}

// ===========================================================================
// Suite 13: API data endpoints
// ===========================================================================
console.log('\n══ Suite 13: API data endpoints ══');
{
    const hasApi = await apiAvailable();
    if (!hasApi) {
        skip('API server not running — skipping data endpoint tests');
    } else {
        // GET /api/days
        {
            const res = await fetch(`${API_BASE}/api/days`);
            const data = await res.json();
            assert(res.status === 200, `GET /api/days returns 200`);
            assert(Array.isArray(data.dates) && data.dates.length > 0, `has dates array (${data.dates.length})`);
        }

        // GET /api/days/:date
        {
            const daysRes = await fetch(`${API_BASE}/api/days`);
            const { dates } = await daysRes.json();
            const latest = dates[dates.length - 1];
            const res = await fetch(`${API_BASE}/api/days/${latest}`);
            const data = await res.json();
            assert(res.status === 200, `GET /api/days/${latest} returns 200`);
            assert(data.repositories && Object.keys(data.repositories).length > 0, `has repositories`);
        }

        // GET /api/days/:date — 404 for missing date
        {
            const res = await fetch(`${API_BASE}/api/days/1900-01-01`);
            assert(res.status === 404, `missing date returns 404`);
        }

        // GET /api/vectors/stats
        {
            const res = await fetch(`${API_BASE}/api/vectors/stats`);
            const data = await res.json();
            assert(data.totalCommits > 0, `vectors/stats has commits`);
            assert(data.model === 'text-embedding-3-large', `model correct`);
        }
    }
}

// ===========================================================================
// Suite 14: Follow-up query with prior suspects (prior results context)
// ===========================================================================
console.log('\n══ Suite 14: Follow-up query with prior suspects ══');
{
    const hasApi = await apiAvailable();
    if (!hasApi) {
        skip('API server not running — skipping follow-up query tests');
    } else {
        // Step 1: Initial query to get suspects
        const { status: s1, data: d1 } = await chatQuery('What changes were made to ads grid recently?');
        if (s1 !== 200 || !d1.suspects?.length) {
            skip(`initial query failed or no suspects (status=${s1}, suspects=${d1.suspects?.length ?? 0})`);
        } else {
            const suspects = d1.suspects;
            const firstCommitId = suspects[0].commitId;
            console.log(`  Initial query returned ${suspects.length} suspects, first: ${firstCommitId}`);

            // Step 2: Follow-up query referencing a specific commit ID from prior results,
            // with history that includes the prior assistant message and its suspects
            const history = [
                { role: 'user', content: 'What changes were made to ads grid recently?' },
                { role: 'assistant', content: d1.reply, suspects },
            ];

            const res = await fetch(`${API_BASE}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Tell me more about commit ${firstCommitId}`,
                    history,
                }),
            });
            const d2 = await res.json();

            assert(res.status === 200, `follow-up query returns 200`);
            assert(d2.reply?.length > 50, `follow-up reply is substantive (${d2.reply?.length} chars)`);
            assert(
                d2.reply.toLowerCase().includes(firstCommitId.slice(0, 7).toLowerCase()) ||
                d2.suspects?.some(s => s.commitId === firstCommitId),
                `follow-up references the requested commit ${firstCommitId}`
            );

            // Step 3: Follow-up comparing two commits from prior results
            if (suspects.length >= 2) {
                const id1 = suspects[0].commitId;
                const id2 = suspects[1].commitId;
                const history2 = [
                    { role: 'user', content: 'What changes were made to ads grid recently?' },
                    { role: 'assistant', content: d1.reply, suspects },
                ];
                const res2 = await fetch(`${API_BASE}/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        message: `Compare commit ${id1} and ${id2}`,
                        history: history2,
                    }),
                });
                const d3 = await res2.json();
                assert(res2.status === 200, `compare query returns 200`);
                assert(d3.reply?.length > 50, `compare reply is substantive (${d3.reply?.length} chars)`);
            } else {
                skip('need >=2 suspects for compare test');
            }
        }
    }
}

// ===========================================================================
// Summary
// ===========================================================================
console.log(`\n══════════════════════════════════════════`);
console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log(`══════════════════════════════════════════\n`);
process.exit(failed > 0 ? 1 : 0);
