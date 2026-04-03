/**
 * Commit summarizer — Uses LLM to generate summaries and risk assessments for commits.
 */

import { llmHelper } from './llm-helper.js';
import { fetchCommitDiff } from './ado-git-client.js';

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

const COMMIT_SUMMARY_PROMPT = `You are a senior software engineer analyzing code changes in a Microsoft Advertising codebase.
Your job is to summarize each commit's changes for an on-call DRI investigating production incidents.

For each commit diff provided, produce a JSON response with these fields:
- "title": A concise one-line summary of what changed (max 120 chars)
- "summary": A detailed paragraph explaining what changed, why it likely changed, and what components are affected
- "riskLevel": One of "LOW", "MEDIUM", or "HIGH" based on the criteria below
- "affectedAreas": Array of affected areas/components (e.g. ["Campaign Grid", "Budget API", "Pilot Config"])
- "flags": Array of any pilot flags or feature flags mentioned in the diff
- "changeType": One of "code", "config", or "mixed". Use "config" if the commit ONLY changes dynamic configs, pilot flags, feature flags, experiment definitions, ramp percentages, or configuration files (e.g. files with names containing 'config', 'pilot', 'flag', 'experiment', 'feature-gate', 'dynamic-config', '.json' config files, or XML config files). Use "mixed" if it changes both code and config. Use "code" for pure code changes.
- "configChanges": Array of objects { "key": "config/flag name", "action": "added"|"modified"|"removed", "detail": "brief description" } — only populated when changeType is "config" or "mixed"

Risk level criteria:
- LOW: Documentation, tests, comments, lock file updates, version bumps, minor config
- MEDIUM: Business logic changes scoped to a single feature, new pilot-gated code, API parameter changes
- HIGH: Shared utility/infrastructure changes, authentication/authorization changes, database schema changes, pilot ramp changes affecting broad traffic, removal of feature gates, error handling changes in critical paths

Important rules:
- Be factual — only describe what you see in the diff, do not speculate
- If the diff is a lock file or auto-generated code, just say so briefly and mark as LOW risk
- Keep the summary concise but informative enough for incident investigation
- Focus on behavioral changes, not just file-level descriptions

Respond with valid JSON only, no markdown fencing.`;

/**
 * Summarize a single commit using LLM.
 *
 * @param {object} repoConfig - Repository config
 * @param {object} commit - Formatted commit object from fetchLatestCommits
 * @returns {Promise<object>} Commit with LLM summary attached
 */
async function summarizeCommit(repoConfig, commit) {
    try {
        const diffs = await fetchCommitDiff(repoConfig, commit.commitId);
        const diffText = diffs.join('\n---\n');

        // Truncate to avoid token limits (~100K chars ≈ ~25K tokens)
        const truncatedDiff = diffText.length > 100000
            ? diffText.substring(0, 100000) + '\n... (diff truncated)'
            : diffText;

        const userMessage = [
            `Repository: ${repoConfig.name}`,
            `Commit: ${commit.commitId}`,
            `Author: ${commit.author} <${commit.authorEmail}>`,
            `Date: ${commit.date}`,
            `Message: ${commit.message}`,
            '',
            '--- DIFF START ---',
            truncatedDiff,
            '--- DIFF END ---',
        ].join('\n');

        const response = await llmHelper(COMMIT_SUMMARY_PROMPT, [
            { role: 'user', content: userMessage },
        ]);

        let summary;
        try {
            summary = JSON.parse(response);
        } catch {
            // If LLM didn't return valid JSON, wrap the raw response
            summary = {
                title: commit.title,
                summary: response,
                riskLevel: 'MEDIUM',
                affectedAreas: [],
                flags: [],
                changeType: 'code',
                configChanges: [],
            };
        }

        return { ...commit, llmSummary: summary };
    } catch (err) {
        return {
            ...commit,
            llmSummary: {
                title: commit.title,
                summary: `Error generating summary: ${err.message}`,
                riskLevel: 'MEDIUM',
                affectedAreas: [],
                flags: [],
                changeType: 'code',
                configChanges: [],
            },
        };
    }
}

/**
 * Summarize an array of commits. Processes sequentially to respect rate limits.
 *
 * @param {object} repoConfig - Repository config
 * @param {Array} commits - Array of formatted commit objects
 * @param {function} onProgress - Optional callback(index, total, commit) for progress
 * @returns {Promise<Array>} Commits with llmSummary attached
 */
async function summarizeCommits(repoConfig, commits, onProgress) {
    const results = [];
    for (let i = 0; i < commits.length; i++) {
        if (onProgress) onProgress(i + 1, commits.length, commits[i]);
        const summarized = await summarizeCommit(repoConfig, commits[i]);
        results.push(summarized);
    }
    return results;
}

export { summarizeCommit, summarizeCommits, COMMIT_SUMMARY_PROMPT };
