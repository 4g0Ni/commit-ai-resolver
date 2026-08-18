/**
 * Azure DevOps Git client for fetching commits from tracked repositories.
 * Authentication is explicit and optional; no interactive enterprise login is attempted.
 */

import { createPatch } from 'diff';
import { ADO_ORG, ADO_PROJECT, RELEASE_PIPELINE_DEFINITION_ID, RELEASE_LOG_TASKS } from '../config/repositories.js';

function getAuthorizationHeader() {
    if (process.env.ADO_PAT) {
        return `Basic ${Buffer.from(`:${process.env.ADO_PAT}`).toString('base64')}`;
    }
    if (process.env.ADO_BEARER_TOKEN) {
        return `Bearer ${process.env.ADO_BEARER_TOKEN}`;
    }
    throw new Error('ADO access is not configured. Set ADO_PAT or ADO_BEARER_TOKEN to enable live ADO requests.');
}

/**
 * Make an authenticated GET request to Azure DevOps REST API.
 */
async function adoGet(url) {
    const start = Date.now();
    const authorization = getAuthorizationHeader();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000); // 60s timeout
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            Authorization: authorization,
            'Content-Type': 'application/json',
        },
        signal: controller.signal,
    });
    clearTimeout(timer);
    const elapsed = Date.now() - start;
    if (elapsed > 5000) {
        // Extract API name from URL for readable logs
        const apiPath = url.replace(/.*_apis\//, '').split('?')[0];
        console.warn(`      ⏱ ADO slow (${(elapsed/1000).toFixed(1)}s): ${apiPath}`);
    }
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ADO API error ${response.status}: ${errorText}`);
    }
    return response.json();
}

/**
 * Make an authenticated GET request that returns plain text.
 * Used for build log endpoints which return text/plain.
 */
async function adoGetText(url) {
    const authorization = getAuthorizationHeader();
    const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: authorization },
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ADO API error ${response.status}: ${errorText}`);
    }
    return response.text();
}

/**
 * Fetch the latest N commits from a repository's default branch.
 *
 * @param {object} repoConfig - Repository config from repositories.js
 * @param {number} top - Number of commits to fetch (default: 10)
 * @returns {Promise<Array>} Array of formatted commit objects
 */
async function fetchLatestCommits(repoConfig, top = 10) {
    const branch = repoConfig.defaultBranch.replace('refs/heads/', '');
    const params = new URLSearchParams({
        'searchCriteria.itemVersion.version': branch,
        '$top': top,
        'api-version': '7.1',
    });
    const url = `https://dev.azure.com/${ADO_ORG}/${repoConfig.project}/_apis/git/repositories/${repoConfig.name}/commits?${params}`;
    const result = await adoGet(url);
    return (result.value || []).map(formatCommit);
}

// ---------------------------------------------------------------------------
// Release Tag APIs
// ---------------------------------------------------------------------------

/**
 * Fetch git refs (tags) matching a filter pattern.
 *
 * @param {object} repoConfig - Repository config
 * @param {string} filter - Tag prefix filter (e.g. 'tags/release/')
 * @param {number} top - Max results
 * @returns {Promise<Array>} Array of { name, objectId, peeledObjectId }
 */
async function fetchRefs(repoConfig, filter = 'tags/', top = 100) {
    const params = new URLSearchParams({
        filter,
        peelTags: 'true',
        '$top': top,
        'api-version': '7.1',
    });
    const url = `https://dev.azure.com/${ADO_ORG}/${repoConfig.project}/_apis/git/repositories/${repoConfig.name}/refs?${params}`;
    const result = await adoGet(url);
    return (result.value || []).map(ref => ({
        name: ref.name,                     // e.g. "refs/tags/release/2026.03.31"
        shortName: ref.name.replace('refs/tags/', ''),
        objectId: ref.objectId,
        peeledObjectId: ref.peeledObjectId, // actual commit SHA for annotated tags
        commitId: ref.peeledObjectId || ref.objectId, // resolved commit SHA
    }));
}

/**
 * Resolve release tags for a repo based on its tag strategy.
 *
 * - 'dateSorted': Tags like "Prefix.YYYYMMDD.NN". Sorted by date+sequence desc.
 * - 'rolling':    Named tags (e.g. MT_STAGING / MT_LKG). Uses repoConfig.releaseTags.
 * - 'versioned':  Tags like "sha-versioned.329". Sorted by version number desc.
 *
 * @param {object} repoConfig - Repository config
 * @returns {Promise<{ today: object|null, yesterday: object|null, allTags: Array }>}
 */
async function resolveReleaseTags(repoConfig) {
    const filter = repoConfig.tagPattern || 'tags/';
    const refs = await fetchRefs(repoConfig, filter, 200);

    if (repoConfig.tagStrategy === 'rolling' && repoConfig.releaseTags) {
        // Rolling tags: find specific named tags
        const { current, previous } = repoConfig.releaseTags;
        const todayTag = refs.find(r => r.shortName === current) || null;
        const yesterdayTag = refs.find(r => r.shortName === previous) || null;
        return { today: todayTag, yesterday: yesterdayTag, allTags: refs.slice(0, 10) };
    }

    if (repoConfig.tagStrategy === 'dateSorted') {
        // Date-sorted tags: "Prefix.YYYYMMDD.NN" — sort by date then sequence desc
        const withDate = refs.map(ref => {
            const match = ref.shortName.match(/(\d{8})\.(\d+)$/);
            return {
                ...ref,
                dateNum: match ? parseInt(match[1], 10) : 0,
                seqNum: match ? parseInt(match[2], 10) : 0,
            };
        });
        withDate.sort((a, b) => b.dateNum - a.dateNum || b.seqNum - a.seqNum);
        return {
            today: withDate[0] || null,
            yesterday: withDate[1] || null,
            allTags: withDate.slice(0, 10),
        };
    }

    // Versioned tags: sort by numeric suffix descending
    const withVersion = refs.map(ref => {
        const match = ref.shortName.match(/\.(\d+)$/);
        return { ...ref, versionNum: match ? parseInt(match[1], 10) : 0 };
    });
    withVersion.sort((a, b) => b.versionNum - a.versionNum);

    return {
        today: withVersion[0] || null,
        yesterday: withVersion[1] || null,
        allTags: withVersion.slice(0, 10),
    };
}

/**
 * Fetch all commits between two commit SHAs (tag-resolved or direct).
 * Uses the compare API to get commits reachable from targetCommit but not from baseCommit.
 *
 * @param {object} repoConfig - Repository config
 * @param {string} baseCommitId - Older commit SHA (exclusive)
 * @param {string} targetCommitId - Newer commit SHA (inclusive)
 * @returns {Promise<Array>} Array of formatted commit objects
 */
async function fetchCommitsBetweenTags(repoConfig, baseCommitId, targetCommitId) {
    const branch = repoConfig.defaultBranch.replace('refs/heads/', '');
    const params = new URLSearchParams({
        'searchCriteria.itemVersion.version': branch,
        'searchCriteria.compareVersion.versionType': 'commit',
        'searchCriteria.compareVersion.version': baseCommitId,
        'searchCriteria.itemVersion.versionType': 'commit',
        'searchCriteria.itemVersion.version': targetCommitId,
        'api-version': '7.1',
    });
    const url = `https://dev.azure.com/${ADO_ORG}/${repoConfig.project}/_apis/git/repositories/${repoConfig.name}/commits?${params}`;
    const result = await adoGet(url);
    return (result.value || []).map(formatCommit);
}

/**
 * High-level: fetch commits between the two most recent release tags for a repo.
 * Resolves tags to commit dates, then fetches commits in that date window.
 *
 * @param {object} repoConfig - Repository config
 * @returns {Promise<{ fromTag, toTag, commits }>}
 */
async function fetchCommitsBetweenReleaseTags(repoConfig) {
    const { today, yesterday } = await resolveReleaseTags(repoConfig);

    if (!today || !yesterday) {
        return {
            fromTag: yesterday?.shortName ?? null,
            toTag: today?.shortName ?? null,
            commits: [],
            error: 'Could not resolve two release tags. Found: ' +
                   `today=${today?.shortName ?? 'none'}, yesterday=${yesterday?.shortName ?? 'none'}`,
        };
    }

    // Use resolved commit SHA (handles both annotated and lightweight tags)
    const baseCommit = yesterday.commitId;
    const targetCommit = today.commitId;

    // Get commit dates to use date-range query (more reliable than compare API)
    const [baseInfo, targetInfo] = await Promise.all([
        fetchCommitById(repoConfig, baseCommit),
        fetchCommitById(repoConfig, targetCommit),
    ]);

    // Auto-swap if dates are inverted (e.g. LKG is newer than STAGING)
    let fromDate = new Date(baseInfo.date);
    let toDate = new Date(targetInfo.date);
    if (fromDate > toDate) {
        [fromDate, toDate] = [toDate, fromDate];
    }

    const commits = await fetchCommitsBetweenDates(repoConfig, fromDate, toDate);

    // Exclude the base commit itself (we want commits after the previous tag)
    const filtered = commits.filter(c => c.commitId !== baseCommit);

    return {
        fromTag: yesterday.shortName,
        toTag: today.shortName,
        fromCommit: baseCommit.substring(0, 8),
        toCommit: targetCommit.substring(0, 8),
        fromDate: baseInfo.date,
        toDate: targetInfo.date,
        commitCount: filtered.length,
        commits: filtered,
    };
}

/**
 * Fetch commits between two dates for a repository.
 *
 * @param {object} repoConfig - Repository config from repositories.js
 * @param {Date} fromDate - Start date (inclusive)
 * @param {Date} toDate - End date (inclusive)
 * @returns {Promise<Array>} Array of formatted commit objects
 */
async function fetchCommitsBetweenDates(repoConfig, fromDate, toDate) {
    const branch = repoConfig.defaultBranch.replace('refs/heads/', '');
    const params = new URLSearchParams({
        'searchCriteria.itemVersion.version': branch,
        'searchCriteria.fromDate': fromDate.toISOString(),
        'searchCriteria.toDate': toDate.toISOString(),
        'api-version': '7.1',
    });
    const url = `https://dev.azure.com/${ADO_ORG}/${repoConfig.project}/_apis/git/repositories/${repoConfig.name}/commits?${params}`;
    const result = await adoGet(url);
    return (result.value || []).map(formatCommit);
}

/**
 * Fetch a single commit's details by SHA.
 *
 * @param {object} repoConfig - Repository config
 * @param {string} commitId - The commit SHA
 * @returns {Promise<object>} Formatted commit object with parent info
 */
async function fetchCommitById(repoConfig, commitId) {
    const url = `https://dev.azure.com/${ADO_ORG}/${repoConfig.project}/_apis/git/repositories/${repoConfig.name}/commits/${commitId}?api-version=7.1`;
    const commit = await adoGet(url);
    return {
        ...formatCommit(commit),
        parents: commit.parents || [],
    };
}

/**
 * Fetch the list of changed files for a specific commit.
 *
 * @param {object} repoConfig - Repository config
 * @param {string} commitId - The commit SHA
 * @returns {Promise<object>} Commit changes metadata
 */
async function fetchCommitChanges(repoConfig, commitId) {
    const url = `https://dev.azure.com/${ADO_ORG}/${repoConfig.project}/_apis/git/repositories/${repoConfig.name}/commits/${commitId}/changes?api-version=7.1&$top=100`;
    const result = await adoGet(url);

    const blobChanges = (result.changes || []).filter(
        change => change.item && change.item.gitObjectType === 'blob'
    );

    return {
        commitId,
        changeCounts: result.changeCounts,
        changes: blobChanges.map(c => ({
            path: c.item.path,
            changeType: c.changeType,
        })),
    };
}

/**
 * Fetch file content at a specific commit version.
 *
 * @param {object} repoConfig - Repository config
 * @param {string} filePath - File path in the repo
 * @param {string} commitId - The commit SHA
 * @returns {Promise<string|null>} File content or null if not found
 */
async function fetchFileContent(repoConfig, filePath, commitId, opts = {}) {
    const authorization = getAuthorizationHeader();
    const params = new URLSearchParams({
        path: filePath,
        'versionDescriptor.version': commitId,
        'versionDescriptor.versionType': 'commit',
        'api-version': '7.1',
    });
    const url = `https://dev.azure.com/${ADO_ORG}/${repoConfig.project}/_apis/git/repositories/${repoConfig.name}/items?${params}`;

    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: authorization },
        signal: controller.signal,
    });
    clearTimeout(timer);
    const elapsed = Date.now() - start;
    if (elapsed > 5000) {
        console.warn(`      ⏱ ADO file slow (${(elapsed/1000).toFixed(1)}s): ${filePath}`);
    }

    if (!response.ok) return null;
    const content = await response.text();
    return opts.raw === true ? content : minifyContent(content, filePath);
}

/**
 * Fetch multiple file contents at a specific commit in a single API call.
 * Uses ADO's Items Batch API to avoid N individual requests.
 *
 * @param {object} repoConfig - Repository config
 * @param {string[]} filePaths - Array of file paths to fetch
 * @param {string} commitId - The commit SHA
 * @returns {Promise<Map<string, string|null>>} Map of filePath → content (or null)
 */
async function fetchFileContentBatch(repoConfig, filePaths, commitId, opts = {}) {
    if (filePaths.length === 0) return new Map();
    const raw = opts.raw === true;

    const authorization = getAuthorizationHeader();
    const url = `https://dev.azure.com/${ADO_ORG}/${repoConfig.project}/_apis/git/repositories/${repoConfig.name}/itemsbatch?api-version=7.1`;

    const body = {
        itemDescriptors: filePaths.map(path => ({
            path,
            version: commitId,
            versionType: 'commit',
            recursionLevel: 'none',
        })),
        includeContentMetadata: true,
    };

    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);

    let batchResult;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: authorization,
                'Content-Type': 'application/json',
            },
            signal: controller.signal,
        body: JSON.stringify(body),
        });
        clearTimeout(timer);

        if (!response.ok) {
            // Fallback to individual fetches if batch API fails
            console.warn(`      ⚠ Batch API failed (${response.status}), falling back to individual fetches`);
            return fetchFileContentIndividual(repoConfig, filePaths, commitId, opts);
        }
        batchResult = await response.json();
    } catch (err) {
        clearTimeout(timer);
        console.warn(`      ⚠ Batch API error: ${err.message}, falling back to individual fetches`);
        return fetchFileContentIndividual(repoConfig, filePaths, commitId, opts);
    }

    const elapsed = Date.now() - start;
    if (elapsed > 5000) {
        console.warn(`      ⏱ ADO batch slow (${(elapsed/1000).toFixed(1)}s): ${filePaths.length} files`);
    }

    // The batch API returns item metadata but not content directly.
    // We need to fetch content using the objectId (blob SHA) from the batch response.
    const results = new Map();
    const contentFetches = [];

    for (let i = 0; i < filePaths.length; i++) {
        const items = batchResult.value?.[i];
        const item = items?.[0]; // each descriptor returns an array of items
        if (!item || !item.objectId) {
            results.set(filePaths[i], null);
            continue;
        }

        // Fetch blob content by objectId — faster than by path+version
        contentFetches.push({ path: filePaths[i], objectId: item.objectId });
    }

    // Fetch all blob contents in parallel.
    // Kept low (8) to bound per-commit fan-out: current+parent batches run
    // concurrently, so a 50-file commit peaks at ~2×8 = 16 connections instead
    // of ~30, avoiding network saturation when many commits are in flight.
    const BATCH_CONCURRENCY = 8;
    for (let i = 0; i < contentFetches.length; i += BATCH_CONCURRENCY) {
        const batch = contentFetches.slice(i, i + BATCH_CONCURRENCY);
        await Promise.all(batch.map(async ({ path, objectId }) => {
            const blobUrl = `https://dev.azure.com/${ADO_ORG}/${repoConfig.project}/_apis/git/repositories/${repoConfig.name}/blobs/${objectId}?api-version=7.1&$format=text`;
            try {
                const blobResp = await fetch(blobUrl, {
                    headers: { Authorization: authorization },
                });
                if (blobResp.ok) {
                    const content = await blobResp.text();
                    results.set(path, raw ? content : minifyContent(content, path));
                } else {
                    results.set(path, null);
                }
            } catch {
                results.set(path, null);
            }
        }));
    }

    return results;
}

/**
 * Fallback: fetch file contents individually (used when batch API fails).
 */
async function fetchFileContentIndividual(repoConfig, filePaths, commitId, opts = {}) {
    const raw = opts.raw === true;
    const results = new Map();
    const CONCURRENCY = 8;
    for (let i = 0; i < filePaths.length; i += CONCURRENCY) {
        const batch = filePaths.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (path) => {
            const content = await fetchFileContent(repoConfig, path, commitId, { raw });
            results.set(path, content);
        }));
    }
    return results;
}

/**
 * Fetch RAW (untruncated, un-minified) file contents for a set of paths.
 * Used by the smart diff builder so hunk context and line numbers are faithful.
 */
async function fetchRawFileContentBatch(repoConfig, filePaths, commitId) {
    return fetchFileContentBatch(repoConfig, filePaths, commitId, { raw: true });
}

/**
 * Fetch full diff details for a commit — file changes with unified diffs.
 *
 * @param {object} repoConfig - Repository config
 * @param {string} commitId - The commit SHA
 * @returns {Promise<Array<string>>} Array of diff summaries per file
 */
async function fetchCommitDiff(repoConfig, commitId) {
    // Get commit info (need parent SHA)
    const commitUrl = `https://dev.azure.com/${ADO_ORG}/${repoConfig.project}/_apis/git/repositories/${repoConfig.name}/commits/${commitId}?api-version=7.1`;
    const commitInfo = await adoGet(commitUrl);
    const parentCommitId = commitInfo.parents?.[0];

    // Get changed files
    const { changes } = await fetchCommitChanges(repoConfig, commitId);

    // Get content + produce diffs for each changed file
    const diffs = await Promise.all(
        changes.map(async (change) => {
            let currentContent = null;
            let parentContent = null;

            if (change.changeType !== 'delete') {
                currentContent = await fetchFileContent(repoConfig, change.path, commitId);
            }
            if (change.changeType !== 'add' && parentCommitId) {
                parentContent = await fetchFileContent(repoConfig, change.path, parentCommitId);
            }

            if (change.changeType === 'edit' && parentContent && currentContent) {
                const patch = createPatch(change.path, parentContent, currentContent, 'Parent', 'Current');
                return `${change.path} Modified:\n${patch}`;
            } else if (change.changeType === 'add') {
                return `Added: ${change.path}\n${currentContent ?? ''}`;
            } else if (change.changeType === 'delete') {
                return `Deleted: ${change.path}`;
            }
            return `${change.changeType}: ${change.path}`;
        })
    );

    return diffs;
}

// ---------------------------------------------------------------------------
// Release Build APIs
// ---------------------------------------------------------------------------

/**
 * Find a release build by date from the configured release pipeline.
 *
 * @param {string} dateStr - Date in yyyyMMdd format (e.g. '20260407')
 * @returns {Promise<object|null>} Build object or null if not found
 */
async function fetchBuildByDate(dateStr) {
    const params = new URLSearchParams({
        'definitions': String(RELEASE_PIPELINE_DEFINITION_ID),
        'buildNumber': `*${dateStr}*`,
        '$top': '1',
        'api-version': '7.1',
    });
    const url = `https://dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_apis/build/builds?${params}`;
    const result = await adoGet(url);
    return result.value?.[0] ?? null;
}

/**
 * Get the timeline records for a build (tasks, phases, stages).
 *
 * @param {number} buildId - The build ID
 * @returns {Promise<Array>} Array of timeline record objects
 */
async function fetchBuildTimeline(buildId) {
    const url = `https://dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_apis/build/builds/${buildId}/timeline?api-version=7.1`;
    const result = await adoGet(url);
    return result.records || [];
}

/**
 * Fetch the plain-text content of a specific build log.
 *
 * @param {number} buildId - The build ID
 * @param {number} logId - The log ID from a timeline record's log.id
 * @returns {Promise<string>} Log text content
 */
async function fetchBuildLogText(buildId, logId) {
    const url = `https://dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_apis/build/builds/${buildId}/logs/${logId}?api-version=7.1`;
    return adoGetText(url);
}

/**
 * Parse structured fields from a release log task's output.
 *
 * @param {string} logText - Raw log text
 * @returns {object} Parsed fields { sourceCommit, runId, sourceBranch }
 */
function parseReleaseLogInfo(logText) {
    const extract = (pattern) => {
        const match = logText.match(pattern);
        return match?.[1]?.trim() ?? null;
    };
    return {
        sourceCommit: extract(/Source Commit:\s*(.+)/i),
        runId:        extract(/Run ID:\s*(.+)/i),
        sourceBranch: extract(/Source Branch:\s*(.+)/i),
    };
}

/**
 * High-level: find a release build for the given date and extract
 * source commit info for each configured log task.
 *
 * @param {string} dateStr - Date in yyyyMMdd format
 * @returns {Promise<object>} { build, logResults }
 */
async function fetchReleaseInfo(dateStr) {
    const build = await fetchBuildByDate(dateStr);
    if (!build) {
        return { build: null, error: `No release build found for date ${dateStr}` };
    }

    const records = await fetchBuildTimeline(build.id);

    const logResults = {};
    for (const [key, taskName] of Object.entries(RELEASE_LOG_TASKS)) {
        const record = records.find(r => r.name && r.name.includes(taskName));
        if (!record || !record.log?.id) {
            logResults[key] = { taskName, found: false, error: `Timeline record "${taskName}" not found` };
            continue;
        }

        const logText = await fetchBuildLogText(build.id, record.log.id);
        const parsed = parseReleaseLogInfo(logText);
        logResults[key] = { taskName, found: true, logId: record.log.id, ...parsed };
    }

    return {
        build: {
            id: build.id,
            buildNumber: build.buildNumber,
            status: build.status,
            result: build.result,
            startTime: build.startTime,
            finishTime: build.finishTime,
            url: build._links?.web?.href ?? null,
        },
        logResults,
    };
}

/**
 * List recent release builds from the last N days with their child build IDs.
 *
 * @param {number} days - Number of days to look back (default: 7)
 * @returns {Promise<Array>} Array of { build, logResults } objects
 */
async function fetchReleaseList(days = 7) {
    const minTime = new Date();
    minTime.setDate(minTime.getDate() - days);

    const params = new URLSearchParams({
        'definitions': String(RELEASE_PIPELINE_DEFINITION_ID),
        'minTime': minTime.toISOString(),
        'queryOrder': 'queueTimeDescending',
        '$top': '50',
        'api-version': '7.1',
    });
    const url = `https://dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_apis/build/builds?${params}`;
    const result = await adoGet(url);
    const builds = result.value || [];

    // For each build, fetch timeline and extract child build Run IDs
    const results = [];
    for (const build of builds) {
        const records = await fetchBuildTimeline(build.id);

        const logResults = {};
        for (const [key, taskName] of Object.entries(RELEASE_LOG_TASKS)) {
            const record = records.find(r => r.name && r.name.includes(taskName));
            if (!record || !record.log?.id) {
                logResults[key] = { taskName, found: false };
                continue;
            }

            const logText = await fetchBuildLogText(build.id, record.log.id);
            const parsed = parseReleaseLogInfo(logText);
            logResults[key] = { taskName, found: true, ...parsed };
        }

        results.push({
            build: {
                id: build.id,
                buildNumber: build.buildNumber,
                status: build.status,
                result: build.result,
                startTime: build.startTime,
                finishTime: build.finishTime,
                url: build._links?.web?.href ?? null,
            },
            logResults,
        });
    }

    return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minify file content to save tokens — strips comments, excess whitespace.
 */
function minifyContent(content, filePath) {
    if (!content) return null;

    const MAX_CONTENT_LENGTH = 200 * 1024;
    let minified = content.trim();

    // For XML config files, preserve structure by splitting on tag boundaries
    // so diffs are line-level granular instead of one massive blob
    const isXmlConfig = /\.(config|cscfg|csdef)$/i.test(filePath);
    if (isXmlConfig) {
        // Split dense XML into one element per line for granular diffs.
        // Don't truncate — the diff output from createPatch will be compact
        // even if the source file is large (only changed lines appear).
        return minified.replace(/>\s*</g, '>\n<');
    }

    // Strip single-line and multi-line comments
    minified = minified
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*[\r\n]/gm, '');

    // Collapse whitespace
    minified = minified
        .replace(/\s{2,}/g, ' ')
        .replace(/\s+\n/g, '\n')
        .replace(/\n{2,}/g, '\n');

    if (minified.length > MAX_CONTENT_LENGTH) {
        minified = minified.substring(0, MAX_CONTENT_LENGTH) +
            `\n... (truncated, original size: ${content.length} chars)`;
    }
    return minified;
}

/**
 * Format a raw ADO commit JSON into a clean object.
 */
function formatCommit(commit) {
    return {
        commitId: commit.commitId,
        shortId: commit.commitId?.substring(0, 8),
        author: commit.author?.name,
        authorEmail: commit.author?.email,
        date: commit.author?.date,
        message: commit.comment,
        title: commit.comment?.split('\n')[0],
        url: commit.remoteUrl,
    };
}

/**
 * Strip HTML tags from a string, preserving basic structure as plain text.
 */
function stripHtml(html) {
    if (!html) return null;
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?(p|div|li|tr|td|th|h[1-6])[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Extract image URLs from HTML content (e.g., ADO work item description).
 * @param {string} html - Raw HTML string
 * @returns {string[]} Array of unique image URLs
 */
function extractImageUrls(html) {
    if (!html) return [];
    const urls = [];
    const regex = /<img[^>]+src=["']([^"']+)["']/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
        const url = match[1];
        // Skip tiny inline images (tracking pixels, spacers) and data URIs
        if (!url.startsWith('data:') && !urls.includes(url)) {
            urls.push(url);
        }
    }
    return urls;
}

/**
 * Fetch an image from ADO with authentication and return as a base64 data URL.
 * @param {string} imageUrl - The image URL (must be under dev.azure.com or visualstudio.com)
 * @param {number} maxBytes - Maximum image size in bytes (default 2MB)
 * @returns {Promise<string|null>} base64 data URL, or null on failure
 */
async function fetchAdoImage(imageUrl, maxBytes = 2 * 1024 * 1024) {
    try {
        const authorization = getAuthorizationHeader();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        const response = await fetch(imageUrl, {
            method: 'GET',
            headers: { Authorization: authorization },
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!response.ok) return null;

        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > maxBytes) return null;

        const buf = await response.arrayBuffer();
        if (buf.byteLength > maxBytes) return null;

        // Normalize content type — API only accepts png, jpeg, webp, gif
        let contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();

        // Infer from URL extension if content-type is generic
        if (!contentType || contentType === 'application/octet-stream') {
            const ext = imageUrl.split('?')[0].split('.').pop()?.toLowerCase();
            const extMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
            contentType = extMap[ext] || 'image/png';
        }

        // Skip unsupported formats
        const supported = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
        if (!supported.includes(contentType)) return null;

        const base64 = Buffer.from(buf).toString('base64');
        return `data:${contentType};base64,${base64}`;
    } catch {
        return null;
    }
}

/**
 * Fetch an Azure DevOps work item by ID.
 *
 * @param {number|string} workItemId - Work item ID
 * @returns {Promise<object|null>} Normalized work item, or null if not found
 */
async function fetchWorkItem(workItemId) {
    const url = `https://dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_apis/wit/workitems/${workItemId}?api-version=7.1&$expand=all`;
    try {
        const data = await adoGet(url);
        const fields = data.fields || {};

        // Extract image URLs from raw HTML before stripping tags
        const descHtml = fields['System.Description'] || '';
        const reproHtml = fields['Microsoft.VSTS.TCM.ReproSteps'] || '';
        const descImageUrls = extractImageUrls(descHtml);
        const reproImageUrls = extractImageUrls(reproHtml);

        // Fetch images (cap at 5 total)
        const allImageEntries = [
            ...descImageUrls.map(u => ({ url: u, source: 'description' })),
            ...reproImageUrls.filter(u => !descImageUrls.includes(u)).map(u => ({ url: u, source: 'reproSteps' })),
        ].slice(0, 5);

        const images = [];
        for (const entry of allImageEntries) {
            const base64DataUrl = await fetchAdoImage(entry.url);
            if (base64DataUrl) {
                images.push({ url: entry.url, base64DataUrl, source: entry.source });
            }
        }
        if (images.length > 0) {
            console.log(`  Work item ${workItemId}: fetched ${images.length}/${allImageEntries.length} image(s)`);
        }

        return {
            id: data.id,
            url: data._links?.html?.href || `https://dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_workitems/edit/${data.id}`,
            title: fields['System.Title'] || '',
            description: stripHtml(fields['System.Description']),
            state: fields['System.State'] || '',
            type: fields['System.WorkItemType'] || '',
            createdDate: fields['System.CreatedDate'] || '',
            assignedTo: fields['System.AssignedTo']?.displayName || null,
            reproSteps: stripHtml(fields['Microsoft.VSTS.TCM.ReproSteps']),
            areaPath: fields['System.AreaPath'] || null,
            images,
        };
    } catch (err) {
        if (err.message?.includes('404')) return null;
        throw err;
    }
}

export {
    fetchLatestCommits,
    fetchRefs,
    resolveReleaseTags,
    fetchCommitsBetweenTags,
    fetchCommitsBetweenReleaseTags,
    fetchCommitById,
    fetchCommitsBetweenDates,
    fetchCommitChanges,
    fetchCommitDiff,
    fetchFileContent,
    fetchFileContentBatch,
    fetchRawFileContentBatch,
    minifyContent,
    fetchWorkItem,
    fetchReleaseInfo,
    fetchReleaseList,
};
