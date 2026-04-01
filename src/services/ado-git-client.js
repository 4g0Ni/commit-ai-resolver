/**
 * Azure DevOps Git client for fetching commits from tracked repositories.
 * Uses DefaultAzureCredential + direct REST API calls (fetch).
 *
 * Reference: https://msasg.visualstudio.com/Bing_Ads/_git/B2BCrawler/pullrequest/5444356?path=/projects/DRIAgent/src/app/ado-handlers.js&_a=files
 */

import { DefaultAzureCredential } from '@azure/identity';
import { createPatch } from 'diff';
import { ADO_ORG, ADO_PROJECT } from '../config/repositories.js';

const ADO_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';

/**
 * Get a Bearer token for Azure DevOps REST APIs.
 * Uses DefaultAzureCredential which supports:
 *   - Az CLI login (local dev)
 *   - Managed Identity (deployed)
 */
async function getCredentialToken() {
    const credential = new DefaultAzureCredential();
    const tokenResponse = await credential.getToken(ADO_SCOPE);
    return tokenResponse.token;
}

/**
 * Make an authenticated GET request to Azure DevOps REST API.
 */
async function adoGet(url) {
    const token = await getCredentialToken();
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ADO API error ${response.status}: ${errorText}`);
    }
    return response.json();
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
async function fetchFileContent(repoConfig, filePath, commitId) {
    const token = await getCredentialToken();
    const params = new URLSearchParams({
        path: filePath,
        'versionDescriptor.version': commitId,
        'versionDescriptor.versionType': 'commit',
        'api-version': '7.1',
    });
    const url = `https://dev.azure.com/${ADO_ORG}/${repoConfig.project}/_apis/git/repositories/${repoConfig.name}/items?${params}`;

    const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) return null;
    const content = await response.text();
    return minifyContent(content, filePath);
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minify file content to save tokens — strips comments, excess whitespace.
 */
function minifyContent(content, filePath) {
    if (!content) return null;

    const MAX_CONTENT_LENGTH = 200 * 1024;
    let minified = content.trim();

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
    minifyContent,
};
