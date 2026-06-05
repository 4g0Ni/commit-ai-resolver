/**
 * Smart diff builder — produces compact, faithful diffs for LLM summarization.
 *
 * Replaces the legacy "fetch whole file → minify → truncate at 200KB →
 * createPatch" approach, which silently lost the real change when a small edit
 * lived inside a very large file (e.g. DynamicConfigValues.cs @ 388KB).
 *
 * Strategy (per file):
 *   - Fetch RAW (untruncated) parent + current content.
 *   - Small file (<= SMALL_FILE_BYTES): emit a whole-file unified diff (full
 *     context — cheap because the file is small).
 *   - Large file: emit hunk diff with N lines of context, and prepend the
 *     nearest enclosing symbol signature to each hunk header (git-style).
 *
 * A per-commit byte budget is applied across files, with config/pilot files
 * ordered first so they survive truncation.
 */

import { structuredPatch, createPatch } from 'diff';
import { fetchRawFileContentBatch, fetchCommitById } from './ado-git-client.js';
import { isConfigFile, prettifyMinifiedXml } from './config-files.js';

export const DIFF_CONTEXT_LINES = 20;
export const SMALL_FILE_BYTES = 30 * 1024;
export const PER_COMMIT_DIFF_BUDGET = 200000;

/** Token that hints a line declares an enclosing symbol (C#/JS/TS/SQL-ish). */
const SYMBOL_RE = /\b(public|private|protected|internal|static|class|interface|struct|enum|namespace|void|async|function|def|const|let|var|CREATE\s+(PROCEDURE|TABLE|FUNCTION))\b/i;

/**
 * Find the nearest declaration line at or above `oldStart` (1-based) in the
 * parent file, to use as a hunk section header.
 * @returns {string|null}
 */
function enclosingSymbol(parentLines, oldStart) {
    const from = Math.min(oldStart - 2, parentLines.length - 1);
    for (let i = from; i >= 0 && i >= from - 400; i--) {
        const line = parentLines[i];
        if (line && line.trim().length > 0 && line.trim().length < 200 && SYMBOL_RE.test(line)) {
            return line.trim();
        }
    }
    return null;
}

/**
 * Build a unified diff for a single file using the adaptive strategy.
 * @returns {{ text: string, hunks: number, added: number, removed: number, mode: string }}
 */
export function buildFileDiff(path, parentContent, currentContent, opts = {}) {
    const context = opts.context ?? DIFF_CONTEXT_LINES;
    const smallBytes = opts.smallFileBytes ?? SMALL_FILE_BYTES;

    let parent = parentContent ?? '';
    let current = currentContent ?? '';
    // Make minified XML config diffs granular (one element per line).
    parent = prettifyMinifiedXml(parent, path) ?? parent;
    current = prettifyMinifiedXml(current, path) ?? current;

    const biggest = Math.max(parent.length, current.length);

    if (biggest <= smallBytes) {
        const patch = createPatch(path, parent, current, 'Parent', 'Current');
        const { added, removed } = countChanges(patch.split('\n'));
        return { text: patch, hunks: 1, added, removed, mode: 'whole-file' };
    }

    const sp = structuredPatch(path, path, parent, current, 'Parent', 'Current', { context });
    const parentLines = parent.split('\n');
    let text = '';
    let added = 0;
    let removed = 0;
    for (const h of sp.hunks) {
        const sym = enclosingSymbol(parentLines, h.oldStart);
        text += `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${sym ? ' ' + sym : ''}\n`;
        text += h.lines.join('\n') + '\n';
        for (const l of h.lines) {
            if (l.startsWith('+')) added++;
            else if (l.startsWith('-')) removed++;
        }
    }
    return { text, hunks: sp.hunks.length, added, removed, mode: `hunk(${context})+sym` };
}

function countChanges(lines) {
    let added = 0;
    let removed = 0;
    for (const l of lines) {
        if (/^\+/.test(l) && !/^\+\+\+/.test(l)) added++;
        else if (/^-/.test(l) && !/^---/.test(l)) removed++;
    }
    return { added, removed };
}

/**
 * Build smart diffs for a set of changed files in a commit.
 *
 * @param {object} repoConfig
 * @param {string} commitId
 * @param {Array<{path:string, changeType:string}>} filteredChanges
 * @param {object} opts - { context, smallFileBytes, budget }
 * @returns {Promise<{ diffs: string[], meta: object }>}
 */
export async function buildSmartDiff(repoConfig, commitId, filteredChanges, opts = {}) {
    const budget = opts.budget ?? PER_COMMIT_DIFF_BUDGET;

    // Config/pilot files first so they survive the per-commit budget.
    const ordered = [...filteredChanges].sort((a, b) => {
        return (isConfigFile(a.path) ? 0 : 1) - (isConfigFile(b.path) ? 0 : 1);
    });

    const commitInfo = await fetchCommitById(repoConfig, commitId);
    const parentCommitId = commitInfo.parents?.[0];

    const currentPaths = ordered.filter(c => c.changeType !== 'delete').map(c => c.path);
    const parentPaths = parentCommitId
        ? ordered.filter(c => c.changeType !== 'add').map(c => c.path)
        : [];

    const [currentContents, parentContents] = await Promise.all([
        currentPaths.length ? fetchRawFileContentBatch(repoConfig, currentPaths, commitId) : new Map(),
        parentPaths.length ? fetchRawFileContentBatch(repoConfig, parentPaths, parentCommitId) : new Map(),
    ]);

    const diffs = [];
    const perFile = [];
    let used = 0;
    let truncatedFiles = 0;

    for (const change of ordered) {
        const current = currentContents.get(change.path) ?? null;
        const parent = parentContents.get(change.path) ?? null;
        const cfgTag = isConfigFile(change.path) ? '[CONFIG FILE] ' : '';

        let block;
        if (change.changeType === 'add') {
            const body = (current ?? '').slice(0, budget);
            block = `${cfgTag}Added: ${change.path}\n${body}`;
            perFile.push({ path: change.path, mode: 'added-full', bytes: block.length, config: !!cfgTag });
        } else if (change.changeType === 'delete') {
            block = `${cfgTag}Deleted: ${change.path}`;
            perFile.push({ path: change.path, mode: 'deleted', bytes: block.length, config: !!cfgTag });
        } else if (parent != null && current != null) {
            const d = buildFileDiff(change.path, parent, current, opts);
            block = `${cfgTag}${change.path} Modified:\n${d.text}`;
            perFile.push({ path: change.path, mode: d.mode, bytes: block.length, added: d.added, removed: d.removed, hunks: d.hunks, config: !!cfgTag });
        } else {
            block = `${cfgTag}${change.changeType}: ${change.path}`;
            perFile.push({ path: change.path, mode: 'meta-only', bytes: block.length, config: !!cfgTag });
        }

        if (used + block.length > budget) {
            const remaining = Math.max(0, budget - used);
            if (remaining > 200) {
                diffs.push(block.slice(0, remaining) + '\n... (file diff truncated — over per-commit budget)');
            }
            truncatedFiles++;
            used = budget;
            continue;
        }
        diffs.push(block);
        used += block.length;
    }

    return {
        diffs,
        meta: { parentCommitId, totalBytes: used, truncatedFiles, perFile },
    };
}
