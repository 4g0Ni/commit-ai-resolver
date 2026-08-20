/**
 * Commit path utilities — shared helpers for turning a commit's changed-file
 * list into compact, searchable tokens and for detecting shared-infrastructure
 * changes whose blast radius extends beyond the page named in the PR message.
 *
 * Used by:
 *  - commit-summarizer.js — shared-infra risk escalation (Fix 2)
 *  - scheduled-refresh.js / generate-embedding.py — embed-text enrichment (Fix 1)
 */

/**
 * Paths that indicate a change to shared infrastructure consumed by many
 * pages/packages. A regression in these files is rarely scoped to the feature
 * named in the PR title, so we treat them as higher blast radius.
 */
const SHARED_INFRA_PATTERNS = [
    /\/grid-shared\//i,
    /\/shared-client-react\//i,
    /\/app-layout-container\//i,
    /\/shared-components?\//i,
    /\/packages\/[^/]*shared[^/]*\//i,
    /\/packages\/[^/]*common[^/]*\//i,
    /\/src\/(shared|common|contexts?|hooks|utils)\//i,
    /[-/](filter-action-bar|filter-bar|action-bar)\.[jt]sx?$/i,
    /[-/][a-z0-9]+-context\.[jt]sx?$/i,
    /[-/]layout-configs?\.[jt]sx?$/i,
];

/**
 * @param {string} path - Repo-relative file path
 * @returns {boolean} True if the path looks like shared infrastructure
 */
export function isSharedInfraPath(path) {
    if (!path) return false;
    return SHARED_INFRA_PATTERNS.some(re => re.test(path));
}

/**
 * Collapse a full path into a compact `package/filename` token for embedding.
 * Prefers the package name from a `/packages/<pkg>/` segment; otherwise falls
 * back to the last two path segments.
 *
 * @param {string} path - Repo-relative file path
 * @returns {string} Compact token (e.g. "grid-shared/filter-action-bar.tsx")
 */
export function compactPathToken(path) {
    if (!path) return '';
    const clean = path.replace(/^\/+/, '');
    const segments = clean.split('/').filter(Boolean);
    const base = segments[segments.length - 1] || clean;

    const pkgIdx = segments.lastIndexOf('packages');
    if (pkgIdx !== -1 && segments[pkgIdx + 1]) {
        return `${segments[pkgIdx + 1]}/${base}`;
    }
    if (segments.length >= 2) {
        return `${segments[segments.length - 2]}/${base}`;
    }
    return base;
}

/**
 * Build a bounded, de-duplicated list of compact path tokens for embedding.
 * Shared-infrastructure paths are listed first so they survive the cap, and
 * the result is truncated with a "+N more" marker to keep embed text small
 * even for very large commits.
 *
 * @param {string[]} paths - Changed file paths
 * @param {object} [opts]
 * @param {number} [opts.max=15] - Max tokens before truncation
 * @returns {string[]} Ordered, capped token list (may end with "+N more files")
 */
export function compactPathTokens(paths, opts = {}) {
    const max = opts.max ?? 15;
    if (!Array.isArray(paths) || paths.length === 0) return [];

    const shared = [];
    const rest = [];
    for (const p of paths) {
        (isSharedInfraPath(p) ? shared : rest).push(p);
    }

    const seen = new Set();
    const ordered = [];
    for (const p of [...shared, ...rest]) {
        const token = compactPathToken(p);
        if (token && !seen.has(token)) {
            seen.add(token);
            ordered.push(token);
        }
    }

    if (ordered.length <= max) return ordered;
    const kept = ordered.slice(0, max);
    kept.push(`+${ordered.length - max} more files`);
    return kept;
}

/**
 * Detect whether a commit touches shared infrastructure and, if so, describe
 * the affected surface for an injected affectedArea.
 *
 * @param {string[]} paths - Changed file paths
 * @returns {{ isShared: boolean, matched: string[], area: string|null }}
 */
export function detectSharedInfra(paths) {
    if (!Array.isArray(paths) || paths.length === 0) {
        return { isShared: false, matched: [], area: null };
    }
    const matched = paths.filter(isSharedInfraPath);
    if (matched.length === 0) {
        return { isShared: false, matched: [], area: null };
    }

    const isFilterBar = matched.some(p => /(filter-action-bar|filter-bar|action-bar)/i.test(p));
    const isGridShared = matched.some(p => /\/grid-shared\//i.test(p));
    let area;
    if (isFilterBar || isGridShared) {
        area = 'Shared Fluent grid filter bar (all grid pages)';
    } else {
        area = 'Shared infrastructure (multiple consumers)';
    }
    return { isShared: true, matched, area };
}

/**
 * Clean a commit/PR message down to a short subject line for embedding.
 * Strips the "Merged PR <id>:" prefix, collapses whitespace, and truncates.
 *
 * @param {string} message - Raw commit message
 * @param {number} [maxLen=200] - Max characters
 * @returns {string} Cleaned subject (may be empty)
 */
export function cleanCommitSubject(message, maxLen = 200) {
    if (!message) return '';
    const firstLine = message.split('\n')[0] || '';
    const stripped = firstLine.replace(/^Merged PR \d+:\s*/i, '').trim();
    if (stripped.length <= maxLen) return stripped;
    return `${stripped.slice(0, maxLen).trim()}…`;
}
