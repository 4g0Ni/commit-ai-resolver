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
    fetchCommitsBetweenDates,
    fetchCommitChanges,
    fetchCommitDiff,
    fetchFileContent,
    minifyContent,
};
