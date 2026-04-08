/**
 * Commit summarizer — Uses LLM to generate summaries and risk assessments for commits.
 */

import { llmHelper } from './llm-helper.js';
import { fetchCommitDiff, fetchCommitChanges, fetchFileContent, fetchFileContentBatch } from './ado-git-client.js';
import { classifyChanges, buildSkippedFilesSummary, MAX_FILES_FOR_DIFF, MAX_DIFF_SIZE } from './diff-filter.js';
import { createPatch } from 'diff';
import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIFFS_DIR = join(__dirname, '..', '..', 'data', 'diffs');

/** Save the full LLM input for a commit to disk for inspection. */
async function saveLlmInput(repoName, commitId, systemPrompt, userMessage) {
    try {
        const repoDir = join(DIFFS_DIR, repoName);
        await mkdir(repoDir, { recursive: true });
        const content = `=== SYSTEM PROMPT ===\n${systemPrompt}\n\n=== USER MESSAGE ===\n${userMessage}`;
        await writeFile(join(repoDir, `${commitId.substring(0, 8)}.txt`), content);
    } catch { /* non-critical, don't fail summarization */ }
}

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

const COMMIT_SUMMARY_PROMPT = `You are a senior software engineer analyzing code changes in a Microsoft Advertising codebase.
Your job is to summarize each commit's changes for an on-call DRI investigating production incidents.

For each commit diff provided, produce a JSON response with EXACTLY these fields:

{
  "title": "Concise one-line summary, max 80 chars. Be specific about WHAT changed, not just where.",
  "summary": "2-3 sentences max. Focus on behavioral impact: what changed, what it affects, and any risk. Skip obvious context.",
  "riskLevel": "LOW | MEDIUM | HIGH",
  "affectedAreas": ["Max 3-4 areas. Use the most specific component name, not generic paths."],
  "flags": ["Only ACTUAL flag/pilot names found literally in the diff. Never guess or invent flag names."],
  "changeType": "code | config | mixed",
  "configChanges": [{"key": "flag name", "action": "added|modified|removed", "detail": "brief description"}],
  "breakingChange": false
}

FIELD RULES:
- "title": Max 80 chars. Start with a verb. Bad: "Updates to campaign grid component". Good: "Add bulk edit drawer to campaign grid".
- "summary": Max 3 sentences. Focus on WHAT behavior changed and WHO is affected. Skip listing files.
- "riskLevel": See criteria below. When in doubt between MEDIUM and LOW, prefer LOW. When in doubt between MEDIUM and HIGH, prefer MEDIUM.
- "affectedAreas": Max 4 items. Use feature names (e.g. "Campaign Grid", "Budget API"), not file paths.
- "flags": ONLY include flag/pilot names that appear LITERALLY as string constants in the diff. If no flags exist, use empty array []. NEVER output "TBD", "unknown", or guessed names.
- "changeType": "config" = ONLY config/pilot/flag files changed. "mixed" = both code + config. "code" = everything else.
- "configChanges": Only when changeType is "config" or "mixed". Each entry must reference a real key name from the diff.
- "breakingChange": true if the commit removes public APIs, changes function signatures used by other packages, alters DB schemas, removes feature gates without replacement, or changes shared contracts/interfaces. false otherwise.

RISK LEVEL CRITERIA:
- LOW: Tests only, documentation, comments, localization strings, version bumps, dependency updates, build/CI config, adding new code behind a feature flag (not yet enabled)
- MEDIUM: Business logic in a single feature, new API parameters, UI behavior changes scoped to one page, pilot ramp changes < 50%
- HIGH: Shared utility/infrastructure changes, auth/authz changes, DB schema, pilot ramp ≥ 50% or to 100%, removal of feature gates, error handling in critical paths, breaking contract changes

IMPORTANT:
- Be factual — ONLY describe what you see in the diff
- If the diff is a lock file or auto-generated code, say so briefly and mark LOW
- Do NOT speculate about intent or future plans
- Do NOT invent flag names that don't appear in the code

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
    const t0 = Date.now();
    try {
        // Step 1: Get changed files list (cheap)
        const t1 = Date.now();
        const { changes } = await fetchCommitChanges(repoConfig, commit.commitId);
        const changesMs = Date.now() - t1;

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
                    breakingChange: false,
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
            const tDiff = Date.now();
            const diffs = await fetchFilteredDiffs(repoConfig, commit.commitId, needsDiff);
            const diffMs = Date.now() - tDiff;
            if (diffMs > 5000) {
                console.warn(`      ⏱ ${commit.shortId} diff fetch (${(diffMs/1000).toFixed(1)}s) ${needsDiff.length} files`);
            }
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

        // Save LLM input for inspection
        await saveLlmInput(repoConfig.name, commit.commitId, COMMIT_SUMMARY_PROMPT, userMessage);

        const tLlm = Date.now();
        const response = await llmHelper(COMMIT_SUMMARY_PROMPT, [
            { role: 'user', content: userMessage },
        ]);
        const llmMs = Date.now() - tLlm;
        const totalMs = Date.now() - t0;
        if (totalMs > 15000) {
            console.warn(`      ⏱ ${commit.shortId} total=${(totalMs/1000).toFixed(1)}s changes=${changesMs}ms diff=${diffText.length > 0 ? (tLlm - t0 - changesMs) + 'ms' : 'skip'} llm=${(llmMs/1000).toFixed(1)}s`);
        }

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
                breakingChange: false,
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
                breakingChange: false,
                _error: true,
            },
        };
    }
}

/**
 * Fetch diffs only for specific files (not the full commit).
 * Uses batch API to fetch all file contents in 2 calls instead of 2N.
 */
async function fetchFilteredDiffs(repoConfig, commitId, filteredChanges) {
    // We need the parent to produce diffs
    const { fetchCommitById } = await import('./ado-git-client.js');
    const commitInfo = await fetchCommitById(repoConfig, commitId);
    const parentCommitId = commitInfo.parents?.[0];

    // Collect paths needed for current and parent versions
    const currentPaths = filteredChanges
        .filter(c => c.changeType !== 'delete')
        .map(c => c.path);
    const parentPaths = parentCommitId
        ? filteredChanges.filter(c => c.changeType !== 'add').map(c => c.path)
        : [];

    // Batch fetch: 2 API calls instead of 2N individual calls
    const [currentContents, parentContents] = await Promise.all([
        currentPaths.length > 0
            ? fetchFileContentBatch(repoConfig, currentPaths, commitId)
            : new Map(),
        parentPaths.length > 0
            ? fetchFileContentBatch(repoConfig, parentPaths, parentCommitId)
            : new Map(),
    ]);

    // Build diffs from fetched contents
    const diffs = filteredChanges.map(change => {
        const currentContent = currentContents.get(change.path) ?? null;
        const parentContent = parentContents.get(change.path) ?? null;

        if (change.changeType === 'edit' && parentContent && currentContent) {
            const patch = createPatch(change.path, parentContent, currentContent, 'Parent', 'Current');
            return `${change.path} Modified:\n${patch}`;
        } else if (change.changeType === 'add') {
            return `Added: ${change.path}\n${currentContent ?? ''}`;
        } else if (change.changeType === 'delete') {
            return `Deleted: ${change.path}`;
        }
        return `${change.changeType}: ${change.path}`;
    });

    return diffs;
}

/**
 * Summarize an array of commits. Processes in parallel batches for speed.
 *
 * @param {object} repoConfig - Repository config
 * @param {Array} commits - Array of formatted commit objects
 * @param {function} onProgress - Optional callback(index, total, commit) for progress
 * @param {number} concurrency - Max parallel LLM calls (default 25)
 * @returns {Promise<Array>} Commits with llmSummary attached
 */
async function summarizeCommits(repoConfig, commits, onProgress, concurrency = 25) {
    const results = new Array(commits.length);
    let completed = 0;
    const PER_COMMIT_TIMEOUT = 180000; // 3 minutes max per commit

    // Process in batches of `concurrency`
    for (let batchStart = 0; batchStart < commits.length; batchStart += concurrency) {
        const batch = commits.slice(batchStart, batchStart + concurrency);
        const batchPromises = batch.map((commit, idx) => {
            const globalIdx = batchStart + idx;
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Commit ${commit.shortId} timed out after ${PER_COMMIT_TIMEOUT / 1000}s`)), PER_COMMIT_TIMEOUT)
            );
            return Promise.race([summarizeCommit(repoConfig, commit), timeoutPromise])
                .catch(err => ({
                    ...commit,
                    llmSummary: {
                        title: commit.title,
                        summary: `Timed out: ${err.message}`,
                        riskLevel: 'MEDIUM',
                        affectedAreas: [],
                        flags: [],
                        changeType: 'code',
                        configChanges: [],
                        breakingChange: false,
                        _error: true,
                    },
                }))
                .then(result => {
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
