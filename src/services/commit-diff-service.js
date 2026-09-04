const DEFAULT_MAX_DIFF_CHARS = 10_000;

/**
 * Create a validated commit-diff service for agent tools.
 *
 * @param {object} dependencies
 * @param {Function} dependencies.fetchCommitDiff
 * @param {object} dependencies.repositories
 * @param {boolean} dependencies.available
 * @param {number} dependencies.maxDiffChars
 */
export function createCommitDiffService({
    fetchCommitDiff,
    repositories,
    available = true,
    maxDiffChars = DEFAULT_MAX_DIFF_CHARS,
}) {
    const safeLimit = Math.max(1_000, Math.min(30_000, Number(maxDiffChars) || DEFAULT_MAX_DIFF_CHARS));

    /** Fetch and cap a commit diff after repository validation. */
    async function getCommitDiff({ repo, commitId }) {
        if (!available) {
            return {
                available: false,
                repo,
                commitId,
                files: 0,
                diff: '',
                truncated: false,
                error: 'Live ADO access is not configured.',
            };
        }
        if (typeof fetchCommitDiff !== 'function') throw new Error('fetchCommitDiff is not configured');

        const repository = repositories?.[repo];
        if (!repository) throw new Error(`Unknown repository: ${repo}`);
        if (!/^[0-9a-f]{7,40}$/iu.test(String(commitId || ''))) {
            throw new Error('commitId must be a 7-40 character hexadecimal SHA');
        }

        const diffs = await fetchCommitDiff(repository, commitId);
        const fullDiff = Array.isArray(diffs) ? diffs.join('\n\n') : String(diffs || '');
        const truncated = fullDiff.length > safeLimit;
        return {
            available: true,
            repo,
            commitId,
            files: Array.isArray(diffs) ? diffs.length : null,
            diff: truncated ? `${fullDiff.slice(0, safeLimit)}\n... (diff truncated)` : fullDiff,
            originalChars: fullDiff.length,
            truncated,
            error: null,
        };
    }

    return { available: Boolean(available), getCommitDiff };
}

