/**
 * MCP (Model Context Protocol) server for Commit AI Resolver.
 *
 * Exposes commit search, lookup, and daily summary tools over Streamable HTTP
 * so external agents can query commit data as part of their investigation pipelines.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { logQuery } from './db.js';

/** Display name → internal repo name mapping (case-insensitive lookup built at runtime). */
const REPO_ALIASES = {
    cmui: 'AdsAppsCampaignUI',
    campaignui: 'AdsAppsCampaignUI',
    adsappscampaignui: 'AdsAppsCampaignUI',
    mt: 'AdsAppsMT',
    'middle-tier': 'AdsAppsMT',
    adsappsmt: 'AdsAppsMT',
    appui: 'AdsAppUI',
    uiserver: 'AdsAppUI',
    shell: 'AdsAppUI',
    adsappui: 'AdsAppUI',
    anb: 'AnB',
    ccdb: 'AnB',
    ccmt: 'AnB',
    cmdb: 'AdsAppsDB',
    'campaign-db': 'AdsAppsDB',
    adsappsdb: 'AdsAppsDB',
};

const VALID_REPOS = ['AdsAppsCampaignUI', 'AdsAppsMT', 'AdsAppUI', 'AnB', 'AdsAppsDB'];

/** Resolve a repo input (name or alias) to the canonical repo name. */
function resolveRepo(input) {
    if (!input) return undefined;
    if (VALID_REPOS.includes(input)) return input;
    return REPO_ALIASES[input.toLowerCase()] || undefined;
}

/**
 * Create and configure an MCP server with commit search tools.
 * @param {object} deps - Service dependencies from the API server
 * @param {function} deps.embedQuery - (text) => Promise<number[]>
 * @param {function} deps.searchVectors - (embedding, opts) => Promise<results[]>
 * @param {function} deps.lookupByCommitIds - (shortIds) => Promise<results[]>
 * @param {function} deps.getVectorStats - () => Promise<stats>
 * @param {function} deps.listAvailableDates - () => Promise<string[]>
 * @param {function} deps.loadDayData - (date) => Promise<dayData>
 * @param {function} deps.fetchCommitChanges - (repoConfig, commitId) => Promise<{changes}>
 * @param {function} deps.fetchFilteredDiffs - (repoConfig, commitId, changes) => Promise<string[]>
 * @param {function} deps.classifyChanges - (changes, repoName) => {needsDiff, autoSummary, ignored}
 * @param {object}   deps.REPOSITORIES - repo config map keyed by canonical repo name
 */
export function createMcpServer(deps) {
    const server = new McpServer({
        name: 'commit-ai-resolver',
        version: '1.0.0',
    });

    // Wrap a tool handler with usage logging into chat_queries (source='mcp').
    // queryExtractor: optional (args) => string for search-like tools; null otherwise.
    function logged(toolName, handler, queryExtractor = null) {
        return async (args) => {
            const t0 = Date.now();
            let isError = false;
            try {
                const result = await handler(args);
                if (result?.isError) isError = true;
                return result;
            } catch (err) {
                isError = true;
                throw err;
            } finally {
                try {
                    logQuery({
                        id: randomUUID(),
                        query: queryExtractor ? queryExtractor(args) : null,
                        response: isError ? null : 'ok',
                        confidence: isError ? -1 : null,
                        iterations: null,
                        searchMethod: null,
                        resultCount: null,
                        iterationLog: [],
                        workItemId: null,
                        workItemTitle: null,
                        elapsedMs: Date.now() - t0,
                        userId: deps.userEmail || null,
                        source: 'mcp',
                        toolName,
                    });
                } catch (dbErr) {
                    console.error(`[MCP] Failed to log ${toolName} call:`, dbErr.message);
                }
            }
        };
    }

    // --- Tool: search_commits ---
    server.registerTool(
        'search_commits',
        {
            title: 'Search Commits',
            description: 'Semantic search over commit summaries across Microsoft Advertising repositories. ' +
                'Returns ranked results with commit details, risk level, and relevance score. ' +
                'Use natural language queries like "config flag changes in campaign UI" or "high risk authentication changes".',
            inputSchema: z.object({
                query: z.string().describe('Natural language search query describing what commits to find'),
                repo: z.string().optional().describe(
                    'Repository filter. Accepts canonical names (AdsAppsCampaignUI, AdsAppsMT, AdsAppUI, AnB, AdsAppsDB) ' +
                    'or aliases (CMUI, MT, UIServer, AnB, CMDB, campaignui, middle-tier, appui, shell, campaign-db)'
                ),
                author: z.string().optional().describe('Filter by commit author name'),
                dateFrom: z.string().optional().describe('Start date filter (YYYY-MM-DD)'),
                dateTo: z.string().optional().describe('End date filter (YYYY-MM-DD)'),
                riskLevel: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional().describe(
                    'Filter by risk level. HIGH = breaking changes, large refactors, auth/security changes. ' +
                    'MEDIUM = moderate feature changes. LOW = minor fixes, typos, config tweaks.'
                ),
                changeType: z.enum(['config', 'code', 'mixed']).optional().describe(
                    'Filter by change type. config = configuration/feature flag changes. ' +
                    'code = source code changes. mixed = both config and code changes.'
                ),
                topK: z.number().optional().describe('Maximum number of results to return (default 10, max 50)'),
            }),
        },
        logged('search_commits', async ({ query, repo, author, dateFrom, dateTo, riskLevel, changeType, topK }) => {
            try {
                const resolvedRepo = resolveRepo(repo);
                if (repo && !resolvedRepo) {
                    return {
                        content: [{
                            type: 'text',
                            text: `Unknown repository "${repo}". Valid repos: ${VALID_REPOS.join(', ')}. ` +
                                `Aliases: CMUI, MT, UIServer, AnB, CMDB.`,
                        }],
                        isError: true,
                    };
                }

                const k = Math.min(topK || 10, 50);
                const embedding = await deps.embedQuery(query);
                const results = await deps.searchVectors(embedding, {
                    topK: k,
                    repo: resolvedRepo,
                    author,
                    dateFrom,
                    dateTo,
                    riskLevel,
                    changeType,
                });

                if (results.length === 0) {
                    return {
                        content: [{ type: 'text', text: 'No commits found matching the query and filters.' }],
                    };
                }

                const formatted = results.map((r, i) => ({
                    rank: i + 1,
                    score: Math.round(r.score * 1000) / 1000,
                    commitId: r.commitId,
                    shortId: r.id,
                    repo: r.repo,
                    date: r.date,
                    author: r.author,
                    title: r.metadata?.title,
                    summary: r.metadata?.summary,
                    riskLevel: r.metadata?.riskLevel,
                    changeType: r.metadata?.changeType,
                    affectedAreas: r.metadata?.affectedAreas,
                    flags: r.metadata?.flags,
                    breakingChange: r.metadata?.breakingChange,
                    url: r.metadata?.url,
                }));

                return {
                    content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }],
                };
            } catch (err) {
                return {
                    content: [{ type: 'text', text: `Search failed: ${err.message}` }],
                    isError: true,
                };
            }
        }, (args) => args.query)
    );

    // --- Tool: get_commit ---
    server.registerTool(
        'get_commit',
        {
            title: 'Get Commit by ID',
            description: 'Look up one or more commits by their short commit ID (7-8 character hex SHA). ' +
                'Returns full commit details including summary, risk level, and affected areas.',
            inputSchema: z.object({
                commitIds: z.array(z.string()).describe('Array of short commit IDs (e.g. ["519cdc3f", "a1b2c3d4"])'),
            }),
        },
        logged('get_commit', async ({ commitIds }) => {
            try {
                const results = await deps.lookupByCommitIds(commitIds);
                if (results.length === 0) {
                    return {
                        content: [{ type: 'text', text: `No commits found for IDs: ${commitIds.join(', ')}` }],
                    };
                }

                const formatted = results.map(r => ({
                    commitId: r.commitId,
                    shortId: r.id,
                    repo: r.repo,
                    date: r.date,
                    author: r.author,
                    title: r.metadata?.title,
                    summary: r.metadata?.summary,
                    riskLevel: r.metadata?.riskLevel,
                    changeType: r.metadata?.changeType,
                    affectedAreas: r.metadata?.affectedAreas,
                    flags: r.metadata?.flags,
                    breakingChange: r.metadata?.breakingChange,
                    url: r.metadata?.url,
                }));

                return {
                    content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }],
                };
            } catch (err) {
                return {
                    content: [{ type: 'text', text: `Lookup failed: ${err.message}` }],
                    isError: true,
                };
            }
        })
    );

    // --- Tool: get_daily_summary ---
    server.registerTool(
        'get_daily_summary',
        {
            title: 'Get Daily Summary',
            description: 'Get the commit summary for a specific date. Returns all commits grouped by repository ' +
                'with stats (total, high/medium/low risk counts, config changes, breaking changes).',
            inputSchema: z.object({
                date: z.string().describe('Date to get summary for (YYYY-MM-DD)'),
                repo: z.string().optional().describe(
                    'Optional repository filter. Accepts canonical names or aliases (CMUI, MT, UIServer, AnB, CMDB).'
                ),
            }),
        },
        logged('get_daily_summary', async ({ date, repo }) => {
            try {
                const data = await deps.loadDayData(date);
                const resolvedRepo = resolveRepo(repo);

                if (repo && !resolvedRepo) {
                    return {
                        content: [{
                            type: 'text',
                            text: `Unknown repository "${repo}". Valid repos: ${VALID_REPOS.join(', ')}.`,
                        }],
                        isError: true,
                    };
                }

                // Filter to specific repo if requested
                let repositories = data.repositories;
                if (resolvedRepo) {
                    repositories = {};
                    if (data.repositories[resolvedRepo]) {
                        repositories[resolvedRepo] = data.repositories[resolvedRepo];
                    }
                }

                const summary = {
                    date: data.date,
                    repositories: Object.fromEntries(
                        Object.entries(repositories).map(([name, repo]) => [
                            name,
                            {
                                stats: repo.stats,
                                commits: repo.commits.map(c => ({
                                    shortId: c.shortId,
                                    commitId: c.commitId,
                                    author: c.author,
                                    date: c.date,
                                    title: c.summary?.title || c.title,
                                    summary: c.summary?.summary,
                                    riskLevel: c.summary?.riskLevel,
                                    changeType: c.summary?.changeType,
                                    affectedAreas: c.summary?.affectedAreas,
                                    flags: c.summary?.flags,
                                    breakingChange: c.summary?.breakingChange,
                                    url: c.url,
                                })),
                            },
                        ])
                    ),
                };

                return {
                    content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
                };
            } catch (err) {
                if (err.code === 'ENOENT') {
                    return {
                        content: [{ type: 'text', text: `No data available for date: ${date}` }],
                    };
                }
                return {
                    content: [{ type: 'text', text: `Failed to load summary: ${err.message}` }],
                    isError: true,
                };
            }
        })
    );

    // --- Tool: list_available_dates ---
    server.registerTool(
        'list_available_dates',
        {
            title: 'List Available Dates',
            description: 'List all dates that have commit summary data available. ' +
                'Optionally filter by date range.',
            inputSchema: z.object({
                from: z.string().optional().describe('Start date filter (YYYY-MM-DD)'),
                to: z.string().optional().describe('End date filter (YYYY-MM-DD)'),
            }),
        },
        logged('list_available_dates', async ({ from, to }) => {
            try {
                let dates = await deps.listAvailableDates();
                if (from) dates = dates.filter(d => d >= from);
                if (to) dates = dates.filter(d => d <= to);

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ count: dates.length, dates }, null, 2),
                    }],
                };
            } catch (err) {
                return {
                    content: [{ type: 'text', text: `Failed to list dates: ${err.message}` }],
                    isError: true,
                };
            }
        })
    );

    // --- Tool: get_commit_diff ---
    server.registerTool(
        'get_commit_diff',
        {
            title: 'Get Commit Diff',
            description: 'Fetch the file-level diff for a single commit. Returns the patch text for code files, ' +
                'with noise files (lock files, generated code, localization, build artifacts) filtered out. ' +
                'Use this when you need to see what actually changed beyond the LLM summary.',
            inputSchema: z.object({
                commitId: z.string().describe('Full or short commit SHA'),
                repo: z.string().describe(
                    'Repository name or alias (required — SHAs are not unique across repos). ' +
                    'Canonical: AdsAppsCampaignUI, AdsAppsMT, AdsAppUI, AnB, AdsAppsDB. ' +
                    'Aliases: CMUI, MT, UIServer, AnB, CMDB.'
                ),
                maxFiles: z.number().optional().describe('Max files to include diffs for (default 20, max 50)'),
                includePatch: z.boolean().optional().describe(
                    'When true (default), return full patch text. When false, return only file paths + change types.'
                ),
            }),
        },
        logged('get_commit_diff', async ({ commitId, repo, maxFiles, includePatch }) => {
            try {
                const resolvedRepo = resolveRepo(repo);
                if (!resolvedRepo) {
                    return {
                        content: [{
                            type: 'text',
                            text: `Unknown repository "${repo}". Valid repos: ${VALID_REPOS.join(', ')}.`,
                        }],
                        isError: true,
                    };
                }
                const repoConfig = deps.REPOSITORIES[resolvedRepo];
                const cap = Math.min(maxFiles || 20, 50);
                const wantPatch = includePatch !== false;

                const { changes } = await deps.fetchCommitChanges(repoConfig, commitId);
                const { needsDiff, autoSummary, ignored } = deps.classifyChanges(changes, resolvedRepo);

                const fileList = needsDiff.slice(0, cap).map(c => ({
                    path: c.path,
                    changeType: c.changeType,
                }));

                const result = {
                    commitId,
                    repo: resolvedRepo,
                    totalFiles: changes.length,
                    analyzableFiles: needsDiff.length,
                    autoSkipped: autoSummary.length,
                    ignored: ignored.length,
                    truncated: needsDiff.length > cap,
                    files: fileList,
                };

                if (wantPatch && needsDiff.length > 0) {
                    const subset = needsDiff.slice(0, cap);
                    const diffs = await deps.fetchFilteredDiffs(repoConfig, commitId, subset);
                    result.patches = diffs;
                }

                return {
                    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                };
            } catch (err) {
                return {
                    content: [{ type: 'text', text: `Failed to fetch diff: ${err.message}` }],
                    isError: true,
                };
            }
        })
    );

    // --- Tool: list_commits_by_filter ---
    server.registerTool(
        'list_commits_by_filter',
        {
            title: 'List Commits by Filter',
            description: 'List commits matching metadata filters (repo, date range, change type) without a search query. ' +
                'Use when you want all commits in a window rather than the most semantically relevant ones.',
            inputSchema: z.object({
                repo: z.string().optional().describe(
                    'Repository filter. Canonical names or aliases (CMUI, MT, UIServer, AnB, CMDB).'
                ),
                dateFrom: z.string().optional().describe('Start date (YYYY-MM-DD, inclusive)'),
                dateTo: z.string().optional().describe('End date (YYYY-MM-DD, inclusive)'),
                changeType: z.enum(['config', 'code', 'mixed']).optional().describe(
                    'Filter by change type. config = configuration/feature flag changes. ' +
                    'code = source code changes. mixed = both.'
                ),
                limit: z.number().optional().describe('Max commits to return (default 50, max 200)'),
            }),
        },
        logged('list_commits_by_filter', async ({ repo, dateFrom, dateTo, changeType, limit }) => {
            try {
                const resolvedRepo = resolveRepo(repo);
                if (repo && !resolvedRepo) {
                    return {
                        content: [{
                            type: 'text',
                            text: `Unknown repository "${repo}". Valid repos: ${VALID_REPOS.join(', ')}.`,
                        }],
                        isError: true,
                    };
                }
                const cap = Math.min(limit || 50, 200);

                let dates = await deps.listAvailableDates();
                if (dateFrom) dates = dates.filter(d => d >= dateFrom);
                if (dateTo) dates = dates.filter(d => d <= dateTo);
                dates.sort((a, b) => b.localeCompare(a)); // newest first

                const collected = [];
                for (const date of dates) {
                    if (collected.length >= cap) break;
                    let dayData;
                    try {
                        dayData = await deps.loadDayData(date);
                    } catch (err) {
                        if (err.code === 'ENOENT') continue;
                        throw err;
                    }
                    const repoEntries = resolvedRepo
                        ? (dayData.repositories[resolvedRepo] ? [[resolvedRepo, dayData.repositories[resolvedRepo]]] : [])
                        : Object.entries(dayData.repositories);

                    for (const [repoName, repoData] of repoEntries) {
                        for (const c of repoData.commits) {
                            const ct = c.summary?.changeType;
                            if (changeType && ct !== changeType) continue;
                            collected.push({
                                shortId: c.shortId,
                                commitId: c.commitId,
                                repo: repoName,
                                date: c.date,
                                author: c.author,
                                title: c.summary?.title || c.title,
                                summary: c.summary?.summary,
                                riskLevel: c.summary?.riskLevel,
                                changeType: ct,
                                affectedAreas: c.summary?.affectedAreas,
                                flags: c.summary?.flags,
                                breakingChange: c.summary?.breakingChange,
                                url: c.url,
                            });
                            if (collected.length >= cap) break;
                        }
                        if (collected.length >= cap) break;
                    }
                }

                if (collected.length === 0) {
                    return { content: [{ type: 'text', text: 'No commits found matching the filters.' }] };
                }

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ count: collected.length, commits: collected }, null, 2),
                    }],
                };
            } catch (err) {
                return {
                    content: [{ type: 'text', text: `List failed: ${err.message}` }],
                    isError: true,
                };
            }
        })
    );

    // --- Resource: commit://stats ---
    server.registerResource(
        'vector-stats',
        'commit://stats',
        {
            title: 'Vector Store Stats',
            description: 'Statistics about the commit vector store: total indexed commits, tracked repos, date range.',
            mimeType: 'application/json',
        },
        async () => {
            const stats = await deps.getVectorStats();
            return {
                contents: [{
                    uri: 'commit://stats',
                    text: JSON.stringify(stats, null, 2),
                }],
            };
        }
    );

    return server;
}
