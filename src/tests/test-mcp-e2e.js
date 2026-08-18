/**
 * E2E test suite for the MCP Streamable HTTP endpoint.
 *
 * Tests the full MCP flow: initialize → tools/list → tool calls → resources.
 * Requires:
 *   - API server running on port 4399
 *   - vector data at data/vectors.db
 *
 * Usage:
 *   node api/server.js &
 *   node src/tests/test-mcp-e2e.js
 */

const API_BASE = 'http://localhost:4399';

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

/** Send a JSON-RPC request to the MCP endpoint and parse the SSE response. */
async function mcpRequest(body, sessionId) {
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;

    const res = await fetch(`${API_BASE}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });

    const responseSessionId = res.headers.get('mcp-session-id');
    const contentType = res.headers.get('content-type');

    if (contentType?.includes('text/event-stream')) {
        // Parse SSE response
        const text = await res.text();
        const dataLines = text.split('\n')
            .filter(l => l.startsWith('data: '))
            .map(l => JSON.parse(l.slice(6)));
        return { status: res.status, data: dataLines[0], sessionId: responseSessionId };
    }

    return { status: res.status, data: await res.json(), sessionId: responseSessionId };
}

async function mcpAvailable() {
    try {
        const res = await fetch(`${API_BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        return res.status !== 404;
    } catch { return false; }
}

// ===========================================================================
// Check server availability
// ===========================================================================
const available = await mcpAvailable();
if (!available) {
    console.error('\n✗ MCP endpoint not available. Start the server first:');
    console.error('  node api/server.js');
    process.exit(1);
}

// ===========================================================================
// Suite 1: MCP Initialize
// ===========================================================================
console.log('\n══ Suite 1: MCP Initialize ══');

let sessionId;
{
    const { status, data, sessionId: sid } = await mcpRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test-runner', version: '1.0' },
        },
    });

    assert(status === 200, `initialize returns 200 (got ${status})`);
    assert(data?.result?.serverInfo?.name === 'commit-ai-resolver', `server name is commit-ai-resolver`);
    assert(data?.result?.capabilities?.tools, `server advertises tools capability`);
    assert(data?.result?.capabilities?.resources, `server advertises resources capability`);
    assert(sid, `response includes mcp-session-id header`);
    sessionId = sid;
}

// ===========================================================================
// Suite 2: Tools List
// ===========================================================================
console.log('\n══ Suite 2: Tools List ══');
{
    const { data } = await mcpRequest({
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
    }, sessionId);

    const tools = data?.result?.tools || [];
    const toolNames = tools.map(t => t.name);

    assert(tools.length === 4, `has 4 tools (got ${tools.length})`);
    assert(toolNames.includes('search_commits'), `has search_commits tool`);
    assert(toolNames.includes('get_commit'), `has get_commit tool`);
    assert(toolNames.includes('get_daily_summary'), `has get_daily_summary tool`);
    assert(toolNames.includes('list_available_dates'), `has list_available_dates tool`);

    // Verify search_commits schema has enums
    const searchTool = tools.find(t => t.name === 'search_commits');
    const schema = searchTool?.inputSchema;
    assert(schema?.required?.includes('query'), `search_commits requires query param`);
    assert(schema?.properties?.riskLevel?.enum?.length === 3, `riskLevel has 3 enum values`);
    assert(schema?.properties?.changeType?.enum?.length === 3, `changeType has 3 enum values`);
    assert(schema?.properties?.repo?.description?.includes('CMUI'), `repo description includes CMUI alias`);
}

// ===========================================================================
// Suite 3: list_available_dates
// ===========================================================================
console.log('\n══ Suite 3: list_available_dates ══');
{
    const { data } = await mcpRequest({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'list_available_dates', arguments: {} },
    }, sessionId);

    const content = data?.result?.content?.[0]?.text;
    assert(content, `returns content`);
    const parsed = JSON.parse(content);
    assert(parsed.count > 0, `has ${parsed.count} dates available`);
    assert(parsed.dates.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d)), `all dates match YYYY-MM-DD format`);

    // Test with date range filter
    const { data: rangeData } = await mcpRequest({
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'list_available_dates', arguments: { from: '2026-04-01', to: '2026-04-10' } },
    }, sessionId);

    const rangeContent = JSON.parse(rangeData?.result?.content?.[0]?.text);
    assert(rangeContent.count <= parsed.count, `date range filter reduces results`);
    assert(rangeContent.dates.every(d => d >= '2026-04-01' && d <= '2026-04-10'), `all dates within range`);
}

// ===========================================================================
// Suite 4: search_commits
// ===========================================================================
console.log('\n══ Suite 4: search_commits ══');
{
    // Basic search
    const { data } = await mcpRequest({
        jsonrpc: '2.0', id: 5, method: 'tools/call',
        params: { name: 'search_commits', arguments: { query: 'config flag changes', topK: 3 } },
    }, sessionId);

    const content = data?.result?.content?.[0]?.text;
    assert(content, `returns content for basic search`);
    const results = JSON.parse(content);
    assert(Array.isArray(results), `results is an array`);
    assert(results.length <= 3, `respects topK=3 (got ${results.length})`);
    assert(results.length > 0, `returns at least 1 result`);

    if (results.length > 0) {
        const r = results[0];
        assert(r.rank === 1, `first result has rank 1`);
        assert(typeof r.score === 'number' && r.score > 0, `has numeric score`);
        assert(r.commitId, `has commitId`);
        assert(r.shortId, `has shortId`);
        assert(r.repo, `has repo`);
        assert(r.author, `has author`);
        assert(r.title, `has title`);
        assert(r.summary, `has summary`);
        assert(['HIGH', 'MEDIUM', 'LOW'].includes(r.riskLevel), `has valid riskLevel`);
        assert(r.url, `has url`);
    }

    // Search with repo alias
    const { data: aliasData } = await mcpRequest({
        jsonrpc: '2.0', id: 6, method: 'tools/call',
        params: { name: 'search_commits', arguments: { query: 'changes', repo: 'CMUI', topK: 5 } },
    }, sessionId);

    const aliasResults = JSON.parse(aliasData?.result?.content?.[0]?.text);
    assert(Array.isArray(aliasResults), `alias search returns array`);
    if (aliasResults.length > 0) {
        assert(aliasResults.every(r => r.repo === 'AdsAppsCampaignUI'), `CMUI alias resolves to AdsAppsCampaignUI`);
    }

    // Search with invalid repo
    const { data: badRepoData } = await mcpRequest({
        jsonrpc: '2.0', id: 7, method: 'tools/call',
        params: { name: 'search_commits', arguments: { query: 'test', repo: 'NonExistentRepo' } },
    }, sessionId);

    assert(badRepoData?.result?.isError === true, `invalid repo returns isError`);
    assert(badRepoData?.result?.content?.[0]?.text?.includes('Unknown repository'), `error mentions unknown repo`);

    // Search with riskLevel filter
    const { data: riskData } = await mcpRequest({
        jsonrpc: '2.0', id: 8, method: 'tools/call',
        params: { name: 'search_commits', arguments: { query: 'breaking changes', riskLevel: 'HIGH', topK: 5 } },
    }, sessionId);

    const riskResults = JSON.parse(riskData?.result?.content?.[0]?.text || '[]');
    if (riskResults.length > 0) {
        assert(riskResults.every(r => r.riskLevel === 'HIGH'), `riskLevel filter returns only HIGH commits`);
    } else {
        skip('riskLevel filter — no HIGH results to verify');
    }
}

// ===========================================================================
// Suite 5: get_commit
// ===========================================================================
console.log('\n══ Suite 5: get_commit ══');
{
    // First get a commit ID from search
    const { data: searchData } = await mcpRequest({
        jsonrpc: '2.0', id: 9, method: 'tools/call',
        params: { name: 'search_commits', arguments: { query: 'any change', topK: 1 } },
    }, sessionId);

    const searchResults = JSON.parse(searchData?.result?.content?.[0]?.text || '[]');
    if (searchResults.length > 0) {
        const shortId = searchResults[0].shortId;

        const { data } = await mcpRequest({
            jsonrpc: '2.0', id: 10, method: 'tools/call',
            params: { name: 'get_commit', arguments: { commitIds: [shortId] } },
        }, sessionId);

        const commits = JSON.parse(data?.result?.content?.[0]?.text || '[]');
        assert(commits.length === 1, `returns 1 commit for known ID`);
        assert(commits[0].shortId === shortId, `returned commit matches requested ID`);
    } else {
        skip('get_commit — no search results to use as input');
    }

    // Test with unknown ID
    const { data: unknownData } = await mcpRequest({
        jsonrpc: '2.0', id: 11, method: 'tools/call',
        params: { name: 'get_commit', arguments: { commitIds: ['00000000'] } },
    }, sessionId);

    const unknownText = unknownData?.result?.content?.[0]?.text || '';
    assert(unknownText.includes('No commits found'), `unknown ID returns "No commits found"`);
}

// ===========================================================================
// Suite 6: get_daily_summary
// ===========================================================================
console.log('\n══ Suite 6: get_daily_summary ══');
{
    // Get a valid date first
    const { data: datesData } = await mcpRequest({
        jsonrpc: '2.0', id: 12, method: 'tools/call',
        params: { name: 'list_available_dates', arguments: {} },
    }, sessionId);
    const dates = JSON.parse(datesData?.result?.content?.[0]?.text).dates;
    const testDate = dates[dates.length - 1]; // most recent

    const { data } = await mcpRequest({
        jsonrpc: '2.0', id: 13, method: 'tools/call',
        params: { name: 'get_daily_summary', arguments: { date: testDate } },
    }, sessionId);

    const summary = JSON.parse(data?.result?.content?.[0]?.text);
    assert(summary.date === testDate, `summary date matches ${testDate}`);
    assert(Object.keys(summary.repositories).length > 0, `has at least 1 repository`);

    const firstRepo = Object.values(summary.repositories)[0];
    assert(firstRepo.stats, `repo has stats`);
    assert(Array.isArray(firstRepo.commits), `repo has commits array`);
    if (firstRepo.commits.length > 0) {
        const c = firstRepo.commits[0];
        assert(c.shortId, `commit has shortId`);
        assert(c.author, `commit has author`);
        assert(c.title, `commit has title`);
    }

    // Test with repo filter alias
    const { data: filteredData } = await mcpRequest({
        jsonrpc: '2.0', id: 14, method: 'tools/call',
        params: { name: 'get_daily_summary', arguments: { date: testDate, repo: 'MT' } },
    }, sessionId);

    const filtered = JSON.parse(filteredData?.result?.content?.[0]?.text);
    const filteredRepos = Object.keys(filtered.repositories);
    assert(filteredRepos.length <= 1, `repo filter limits to 1 repo (got ${filteredRepos.length})`);
    if (filteredRepos.length === 1) {
        assert(filteredRepos[0] === 'AdsAppsMT', `MT alias resolves to AdsAppsMT`);
    }

    // Test with invalid date
    const { data: noData } = await mcpRequest({
        jsonrpc: '2.0', id: 15, method: 'tools/call',
        params: { name: 'get_daily_summary', arguments: { date: '1999-01-01' } },
    }, sessionId);

    const noDataText = noData?.result?.content?.[0]?.text || '';
    assert(noDataText.includes('No data available'), `invalid date returns "No data available"`);
}

// ===========================================================================
// Suite 7: Resources
// ===========================================================================
console.log('\n══ Suite 7: Resources ══');
{
    // List resources
    const { data: listData } = await mcpRequest({
        jsonrpc: '2.0', id: 16, method: 'resources/list', params: {},
    }, sessionId);

    const resources = listData?.result?.resources || [];
    assert(resources.length >= 1, `has at least 1 resource`);
    const statsResource = resources.find(r => r.uri === 'commit://stats');
    assert(statsResource, `has commit://stats resource`);

    // Read resource
    const { data: readData } = await mcpRequest({
        jsonrpc: '2.0', id: 17, method: 'resources/read',
        params: { uri: 'commit://stats' },
    }, sessionId);

    const contents = readData?.result?.contents?.[0];
    assert(contents?.uri === 'commit://stats', `resource URI matches`);
    const stats = JSON.parse(contents?.text || '{}');
    assert(stats.totalCommits > 0, `stats has totalCommits (${stats.totalCommits})`);
    assert(Array.isArray(stats.repos), `stats has repos array`);
}

// ===========================================================================
// Suite 8: Session management
// ===========================================================================
console.log('\n══ Suite 8: Session management ══');
{
    // Request without session ID (not initialize) should fail
    const { status: noSidStatus, data: noSidData } = await mcpRequest({
        jsonrpc: '2.0', id: 18, method: 'tools/list', params: {},
    });

    assert(noSidData?.error?.code === -32000, `request without session ID returns error -32000`);

    // Request with unknown session ID should fail
    const { status: badSidStatus, data: badSidData } = await mcpRequest({
        jsonrpc: '2.0', id: 19, method: 'tools/list', params: {},
    }, 'non-existent-session-id');

    assert(badSidData?.error?.code === -32001 || badSidStatus === 404, `unknown session returns 404 or error -32001`);
}

// ===========================================================================
// Suite 9: Anonymous local access
// ===========================================================================
console.log('\n══ Suite 9: Anonymous local access ══');
{
    const probeRes = await fetch(`${API_BASE}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        body: '{}',
    });
    assert(probeRes.status !== 401 && probeRes.status !== 403,
        `MCP does not require credentials (got ${probeRes.status})`);

    const daysRes = await fetch(`${API_BASE}/api/days`);
    assert(daysRes.status === 200, `API accepts anonymous requests (got ${daysRes.status})`);

    const prmRes = await fetch(`${API_BASE}/.well-known/oauth-protected-resource`);
    assert(prmRes.status === 404, `OAuth discovery endpoint was removed (got ${prmRes.status})`);

    const registerRes = await fetch(`${API_BASE}/oauth/register`, { method: 'POST' });
    assert(registerRes.status === 404, `OAuth registration endpoint was removed (got ${registerRes.status})`);
}


console.log('\n══════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log('══════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
