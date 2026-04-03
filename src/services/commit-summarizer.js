/**
 * Commit summarizer — Uses LLM to generate summaries and risk assessments for commits.
 */

import { llmHelper } from './llm-helper.js';
import { fetchCommitDiff, fetchCommitChanges, fetchFileContent } from './ado-git-client.js';
import { classifyChanges, buildSkippedFilesSummary, MAX_FILES_FOR_DIFF, MAX_DIFF_SIZE } from './diff-filter.js';
import { createPatch } from 'diff';

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
 * Summarize a single commit using LLM, with diff filtering.
 *
 * 1. Fetch changed files list first (cheap API call)
 * 2. Classify files: needsDiff / autoSummary / ignored
 * 3. If all files are auto/ignored, produce summary without LLM
 * 4. Otherwise fetch diffs only for files that need it, send to LLM
 *
 * @param {object} repoConfig - Repository config
 * @param {object} commit - Formatted commit object from fetchLatestCommits
 * @returns {Promise<object>} Commit with LLM summary attached
 */
async function summarizeCommit(repoConfig, commit) {
    try {
        // Step 1: Get changed files list (cheap)
        const { changes } = await fetchCommitChanges(repoConfig, commit.commitId);

        // Step 2: Classify
        const { needsDiff, autoSummary, ignored } = classifyChanges(changes, repoConfig.name);
        const skippedNote = buildSkippedFilesSummary(autoSummary, ignored);

        // Step 3: If nothing needs LLM, auto-summarize
        if (needsDiff.length === 0) {
            const reasons = [...new Set(autoSummary.map(f => f.reason))];
            return {
                ...commit,
                llmSummary: {
                    title: `${reasons.join(', ')} (${autoSummary.length + ignored.length} files)`,
                    summary: `Auto-classified commit: ${reasons.join(', ')}. ${autoSummary.length} auto-summarized, ${ignored.length} ignored files.`,
                    riskLevel: 'LOW',
                    affectedAreas: [],
                    flags: [],
                    changeType: 'code',
                    configChanges: [],
                    _autoClassified: true,
                },
            };
        }

        // Step 4: If too many files, send just file names, not diffs
        let diffText;
        if (needsDiff.length > MAX_FILES_FOR_DIFF) {
            diffText = [
                `Commit touches ${changes.length} files (${needsDiff.length} code files, ${autoSummary.length} auto-skipped, ${ignored.length} ignored).`,
                'File list (diffs omitted due to size):',
                ...needsDiff.map(f => `  ${f.changeType}: ${f.path}`),
            ].join('\n');
        } else {
            // Fetch diffs only for files that need it
            const diffs = await fetchFilteredDiffs(repoConfig, commit.commitId, needsDiff);
            diffText = diffs.join('\n---\n');
        }

        // Append skipped files note
        if (skippedNote) {
            diffText += `\n\n--- SKIPPED FILES ---\n${skippedNote}`;
        }

        // Truncate
        if (diffText.length > MAX_DIFF_SIZE) {
            diffText = diffText.substring(0, MAX_DIFF_SIZE) + '\n... (diff truncated)';
        }

        const userMessage = [
            `Repository: ${repoConfig.name}`,
            `Commit: ${commit.commitId}`,
            `Author: ${commit.author} <${commit.authorEmail}>`,
            `Date: ${commit.date}`,
            `Message: ${commit.message}`,
            `Files changed: ${changes.length} total (${needsDiff.length} analyzed, ${autoSummary.length} auto-skipped, ${ignored.length} ignored)`,
            '',
            '--- DIFF START ---',
            diffText,
            '--- DIFF END ---',
        ].join('\n');

        const response = await llmHelper(COMMIT_SUMMARY_PROMPT, [
            { role: 'user', content: userMessage },
        ]);

        let summary;
        try {
            summary = JSON.parse(response);
        } catch {
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
                _error: true,
            },
        };
    }
}

/**
 * Fetch diffs only for specific files (not the full commit).
 * Reuses the same diff logic from ado-git-client but only for filtered files.
 */
async function fetchFilteredDiffs(repoConfig, commitId, filteredChanges) {
    // We need the parent to produce diffs
    const { fetchCommitById } = await import('./ado-git-client.js');
    const commitInfo = await fetchCommitById(repoConfig, commitId);
    const parentCommitId = commitInfo.parents?.[0];

    const diffs = await Promise.all(
        filteredChanges.map(async (change) => {
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

/**
 * Summarize an array of commits. Processes in parallel batches for speed.
 *
 * @param {object} repoConfig - Repository config
 * @param {Array} commits - Array of formatted commit objects
 * @param {function} onProgress - Optional callback(index, total, commit) for progress
 * @param {number} concurrency - Max parallel LLM calls (default 20)
 * @returns {Promise<Array>} Commits with llmSummary attached
 */
async function summarizeCommits(repoConfig, commits, onProgress, concurrency = 20) {
    const results = new Array(commits.length);
    let completed = 0;

    // Process in batches of `concurrency`
    for (let batchStart = 0; batchStart < commits.length; batchStart += concurrency) {
        const batch = commits.slice(batchStart, batchStart + concurrency);
        const batchPromises = batch.map((commit, idx) => {
            const globalIdx = batchStart + idx;
            return summarizeCommit(repoConfig, commit).then(result => {
                completed++;
                if (onProgress) onProgress(completed, commits.length, commit);
                results[globalIdx] = result;
            });
        });
        await Promise.all(batchPromises);
    }

    return results;
}

export { summarizeCommit, summarizeCommits, COMMIT_SUMMARY_PROMPT };
