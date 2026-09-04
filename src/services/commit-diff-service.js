const DEFAULT_MAX_DIFF_CHARS = 10_000;
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const GITHUB_REPO_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/iu;

function countDiffFiles(diff) {
    return (String(diff || '').match(/^diff --git /gmu) || []).length;
}

function capDiff(fullDiff, maxDiffChars) {
    const truncated = fullDiff.length > maxDiffChars;
    return {
        diff: truncated ? `${fullDiff.slice(0, maxDiffChars)}\n... (diff truncated)` : fullDiff,
        originalChars: fullDiff.length,
        truncated,
    };
}

/**
 * Create a validated commit-diff service for agent tools.
 *
 * @param {object} dependencies
 * @param {Function} dependencies.fetchCommitDiff
 * @param {object} dependencies.repositories
 * @param {boolean} dependencies.available
 * @param {number} dependencies.maxDiffChars
 * @param {boolean} dependencies.allowPublicGitHub
 * @param {Function} dependencies.fetchImpl
 */
export function createCommitDiffService({
    fetchCommitDiff,
    repositories,
    available = true,
    maxDiffChars = DEFAULT_MAX_DIFF_CHARS,
    allowPublicGitHub = true,
    fetchImpl = globalThis.fetch,
}) {
    const safeLimit = Math.max(1_000, Math.min(30_000, Number(maxDiffChars) || DEFAULT_MAX_DIFF_CHARS));

    function canFetch(repo) {
        if (allowPublicGitHub && GITHUB_REPO_PATTERN.test(String(repo || ''))) return true;
        return Boolean(available && repositories?.[repo]);
    }

    async function getGitHubDiff(repo, commitId) {
        if (typeof fetchImpl !== 'function') throw new Error('fetch is not available for public GitHub diffs');
        const url = `https://api.github.com/repos/${repo}/commits/${commitId}`;
        const response = await fetchImpl(url, {
            headers: {
                Accept: 'application/vnd.github.diff',
                'User-Agent': 'commit-ai-resolver',
                'X-GitHub-Api-Version': '2022-11-28',
                ...(process.env.GITHUB_TOKEN
                    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
                    : {}),
            },
            signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`GitHub diff request failed with HTTP ${response.status}`);
        const fullDiff = await response.text();
        return {
            available: true,
            repo,
            commitId,
            provider: 'github',
            files: countDiffFiles(fullDiff),
            ...capDiff(fullDiff, safeLimit),
            error: null,
        };
    }

    /** Fetch and cap a commit diff after repository validation. */
    async function getCommitDiff({ repo, commitId }) {
        if (!/^[0-9a-f]{7,40}$/iu.test(String(commitId || ''))) {
            throw new Error('commitId must be a 7-40 character hexadecimal SHA');
        }
        if (allowPublicGitHub && GITHUB_REPO_PATTERN.test(String(repo || ''))) {
            return getGitHubDiff(repo, commitId);
        }
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

        const diffs = await fetchCommitDiff(repository, commitId);
        const fullDiff = Array.isArray(diffs) ? diffs.join('\n\n') : String(diffs || '');
        return {
            available: true,
            repo,
            commitId,
            provider: 'azure-devops',
            files: Array.isArray(diffs) ? diffs.length : null,
            ...capDiff(fullDiff, safeLimit),
            error: null,
        };
    }

    return {
        available: Boolean(available || allowPublicGitHub),
        canFetch,
        getCommitDiff,
    };
}
