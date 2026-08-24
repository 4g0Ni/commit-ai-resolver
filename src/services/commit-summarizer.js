/**
 * Commit summarizer — Uses LLM to generate summaries and risk assessments for commits.
 */

import { llmHelper } from './llm-helper.js';
import { fetchCommitChanges } from './ado-git-client.js';
import { classifyChanges, buildSkippedFilesSummary, MAX_FILES_FOR_DIFF, MAX_DIFF_SIZE } from './diff-filter.js';
import { isConfigFile, prettifyMinifiedXml, CONFIG_FILE_PATTERNS } from './config-files.js';
import { buildSmartDiff } from './diff-builder.js';
import { detectSharedInfra } from './commit-paths.js';
import { selectDomainKnowledge } from './domain-knowledge.js';
import {
    COMMIT_SUMMARY_PROMPT,
    COMMIT_SUMMARY_PROMPT_VERSION,
    buildCommitSummarySystemPrompt,
} from '../prompts/commit-summary-prompt.js';
import {
    applyPromptVariant,
    reportPromptOutcome,
    selectPromptVariant,
} from '../prompts/prompt-registry.js';
import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const RISK_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 };

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIFFS_DIR = join(process.env.DATA_DIR || join(__dirname, '..', '..', 'data'), 'diffs');

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
        const changedFiles = changes.map(f => f.path);

        // Step 3: If nothing needs LLM, auto-summarize
        if (needsDiff.length === 0) {
            const reasons = [...new Set(autoSummary.map(f => f.reason))];
            // Use commit message for context instead of generic "lock file update (2 files)"
            const commitMsg = commit.message.replace(/^Merged PR \d+:\s*/i, '').trim();
            const autoTitle = commitMsg.length > 10 && commitMsg.length <= 80
                ? commitMsg
                : `${reasons.join(', ')} (${autoSummary.length + ignored.length} files)`;
            const filePaths = autoSummary.map(f => f.path).slice(0, 5).join(', ');
            return {
                ...commit,
                changedFiles,
                llmSummary: {
                    title: autoTitle,
                    summary: `Auto-classified: ${reasons.join(', ')}. ${autoSummary.length} file(s) updated: ${filePaths}${autoSummary.length > 5 ? '...' : ''}.`,
                    riskLevel: 'LOW',
                    affectedAreas: reasons.length <= 3 ? reasons : reasons.slice(0, 3),
                    flags: [],
                    changeType: repoConfig.name === 'AdsAppsCampaignUI' ? 'code'
                        : reasons.some(r => r.includes('config')) ? 'config' : 'code',
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
        const domainContext = selectDomainKnowledge(repoConfig.name, {
            changedFiles,
            commitMessage: commit.message,
        });
        const prompt = selectPromptVariant('commit-summary', commit.commitId);
        const systemPrompt = applyPromptVariant(buildCommitSummarySystemPrompt({
            repoName: repoConfig.name,
            domainContext,
        }), prompt);
        await saveLlmInput(repoConfig.name, commit.commitId, systemPrompt, userMessage);

        const tLlm = Date.now();
        const response = await llmHelper(systemPrompt, [
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
            reportPromptOutcome('commit-summary', prompt.variant, { failed: false });
        } catch {
            reportPromptOutcome('commit-summary', prompt.variant, { failed: true });
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
        summary._promptVersion = prompt.version;
        summary._promptVariant = prompt.variant;

        // Fix 2: Shared-infrastructure escalation. The PR message states INTENT,
        // but the changed-file list states BLAST RADIUS. When a commit edits
        // shared infra (e.g. grid-shared filter bar) the LLM often scopes the
        // summary to the page named in the PR; deterministically bump risk to
        // HIGH and inject a blast-radius area so it is searchable/visible.
        const sharedInfra = detectSharedInfra(changedFiles);
        if (sharedInfra.isShared) {
            const currentRank = RISK_RANK[summary.riskLevel] ?? 1;
            if (currentRank < RISK_RANK.HIGH) {
                summary.riskLevel = 'HIGH';
                summary._riskEscalated = 'shared-infra';
            }
            const areas = Array.isArray(summary.affectedAreas) ? summary.affectedAreas : [];
            if (!areas.includes(sharedInfra.area)) {
                summary.affectedAreas = [sharedInfra.area, ...areas].slice(0, 4);
            }
        }

        return { ...commit, changedFiles, llmSummary: summary };
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
 * Build per-file diffs for the given changed files using the smart-diff
 * builder (raw, untruncated content → adaptive whole-file or hunk+symbol
 * diff with a per-commit byte budget; config files prioritized & tagged).
 *
 * Replaces the legacy "fetch whole minified file → createPatch → truncate at
 * MAX_DIFF_SIZE" approach, which silently lost the real change when a small
 * edit lived inside a very large file (e.g. DynamicConfigValues.cs @ 388KB).
 *
 * Signature preserved (repoConfig, commitId, filteredChanges) => string[] so
 * existing callers (summarizeCommit, api/server.js, api/mcp.js) are unchanged.
 *
 * @returns {Promise<string[]>}
 */
async function fetchFilteredDiffs(repoConfig, commitId, filteredChanges) {
    const { diffs } = await buildSmartDiff(repoConfig, commitId, filteredChanges, {
        budget: MAX_DIFF_SIZE,
    });
    return diffs;
}

/**
 * Summarize an array of commits. Processes in parallel batches for speed.
 *
 * @param {object} repoConfig - Repository config
 * @param {Array} commits - Array of formatted commit objects
 * @param {function} onProgress - Optional callback(index, total, commit) for progress
 * @param {number} concurrency - Max parallel commits processed at once (default 6).
 *   Each commit fans out to ~30 parallel ADO blob fetches, so keep this low to
 *   avoid saturating the network (25 × ~30 ≈ 750 concurrent connections).
 * @returns {Promise<Array>} Commits with llmSummary attached
 */
async function summarizeCommits(repoConfig, commits, onProgress, concurrency = 6) {
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

export {
    summarizeCommit,
    summarizeCommits,
    fetchFilteredDiffs,
    COMMIT_SUMMARY_PROMPT,
    COMMIT_SUMMARY_PROMPT_VERSION,
    isConfigFile,
    prettifyMinifiedXml,
    CONFIG_FILE_PATTERNS,
};
