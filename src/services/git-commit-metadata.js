import { spawnSync } from 'node:child_process';

const DEFAULT_BATCH_SIZE = 200;
const MAX_GIT_OUTPUT = 256 * 1024 * 1024;

function chunks(items, size) {
    const output = [];
    for (let index = 0; index < items.length; index += size) {
        output.push(items.slice(index, index + size));
    }
    return output;
}

function runGit(gitDir, args, { input } = {}) {
    const result = spawnSync('git', ['-C', gitDir, ...args], {
        input,
        encoding: 'utf8',
        maxBuffer: MAX_GIT_OUTPUT,
        windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout || '').trim()}`);
    }
    return result.stdout;
}

function parseMessages(output, result) {
    for (const segment of output.split('\x1e')) {
        if (!segment) continue;
        const fields = segment.split('\0');
        const commitId = fields[0]?.trim().toLowerCase();
        if (!commitId) continue;
        const parents = String(fields[1] || '').trim().split(/\s+/).filter(Boolean);
        const fullMessage = String(fields[2] || '').trim();
        result.set(commitId, {
            commitId,
            fullMessage,
            parentCount: parents.length,
            fileChanges: [],
            source: 'local-git',
            extractorVersion: 3,
        });
    }
}

function parseFileChanges(output, result) {
    for (const segment of output.split('\x1e')) {
        if (!segment) continue;
        const fields = segment.split('\0');
        const commitId = fields[0]?.trim().toLowerCase();
        const metadata = result.get(commitId);
        if (!metadata) continue;

        const fileChanges = [];
        let index = 1;
        while (index < fields.length) {
            const status = String(fields[index] || '').replace(/^\s+/, '');
            if (!status) {
                index++;
                continue;
            }
            const code = status[0];
            if (code === 'R' || code === 'C') {
                const previousPath = fields[index + 1];
                const path = fields[index + 2];
                if (path) fileChanges.push({ path, previousPath, status: code === 'R' ? 'renamed' : 'copied' });
                index += 3;
                continue;
            }
            const path = fields[index + 1];
            if (path) {
                const names = { A: 'added', D: 'removed', M: 'modified', T: 'type-changed', U: 'unmerged' };
                fileChanges.push({ path, status: names[code] || 'modified' });
            }
            index += 2;
        }
        metadata.fileChanges = fileChanges;
    }
}

/**
 * Verify that a path is a usable Git repository (bare repositories are supported).
 * @param {string} gitDir - Worktree or bare repository path
 */
export function verifyGitRepository(gitDir) {
    runGit(gitDir, ['rev-parse', '--git-dir']);
}

/**
 * Check which corpus SHAs are present in a local Git object store without reading diffs.
 * @param {string} gitDir - Worktree or bare repository path
 * @param {string[]} commitIds - Full commit SHAs
 * @returns {{available: string[], missing: string[]}}
 */
export function checkGitCommitAvailability(gitDir, commitIds) {
    verifyGitRepository(gitDir);
    const requested = [...new Set(commitIds.map(value => String(value).toLowerCase()))];
    const reachable = new Set(runGit(gitDir, ['rev-list', '--all'])
        .split(/\r?\n/)
        .map(value => value.trim().toLowerCase())
        .filter(Boolean));
    return {
        available: requested.filter(commitId => reachable.has(commitId)),
        missing: requested.filter(commitId => !reachable.has(commitId)),
    };
}

function fetchBatch(gitDir, remote, commitIds) {
    if (!commitIds.length) return { fetched: [], failed: [] };
    try {
        runGit(gitDir, [
            'fetch', '--no-tags', remote,
            ...commitIds.map(commitId => `${commitId}:refs/enrichment/${commitId}`),
        ]);
        return { fetched: commitIds, failed: [] };
    } catch {
        if (commitIds.length === 1) return { fetched: [], failed: commitIds };
        const middle = Math.ceil(commitIds.length / 2);
        const left = fetchBatch(gitDir, remote, commitIds.slice(0, middle));
        const right = fetchBatch(gitDir, remote, commitIds.slice(middle));
        return { fetched: [...left.fetched, ...right.fetched], failed: [...left.failed, ...right.failed] };
    }
}

/**
 * Fetch corpus SHAs that are no longer reachable from advertised branches or tags.
 * Successful objects are anchored under refs/enrichment so later runs remain offline.
 * @param {string} gitDir - Worktree or bare repository path
 * @param {string[]} commitIds - Full commit SHAs
 * @param {object} [options]
 * @param {string} [options.remote='origin'] - Git remote name
 * @param {number} [options.batchSize=25] - Ref specs per fetch
 * @returns {{fetched: string[], failed: string[]}}
 */
export function fetchMissingGitCommits(gitDir, commitIds, options = {}) {
    verifyGitRepository(gitDir);
    const remote = options.remote || 'origin';
    const batchSize = options.batchSize || 25;
    const fetched = [];
    const failed = [];
    for (const batch of chunks([...new Set(commitIds.map(value => String(value).toLowerCase()))], batchSize)) {
        const result = fetchBatch(gitDir, remote, batch);
        fetched.push(...result.fetched);
        failed.push(...result.failed);
    }
    return { fetched, failed };
}

/**
 * Read full messages and first-parent changed-file metadata for many commits.
 * Uses batched Git commands so a full public corpus does not spawn a process per SHA.
 * Missing or unreachable SHAs are returned separately for an optional targeted fetch.
 *
 * @param {string} gitDir - Worktree or bare repository path
 * @param {string[]} commitIds - Full commit SHAs
 * @param {object} [options]
 * @param {number} [options.batchSize=200] - Maximum SHAs per Git invocation
 * @returns {{metadata: Map<string, object>, missing: string[]}}
 */
export function readGitCommitMetadata(gitDir, commitIds, options = {}) {
    verifyGitRepository(gitDir);
    const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
    const requested = [...new Set(commitIds.map(value => String(value).toLowerCase()))];
    const metadata = new Map();
    const availability = checkGitCommitAvailability(gitDir, requested);

    for (const available of chunks(availability.available, batchSize)) {
        const messageOutput = runGit(gitDir, [
            'show', '-s', '--no-show-signature', '--format=%x1e%H%x00%P%x00%B%x00', ...available,
        ]);
        parseMessages(messageOutput, metadata);

        const diffOutput = runGit(gitDir, [
            'diff-tree', '--stdin', '--root', '--diff-merges=first-parent', '-r',
            '-M', '--name-status', '-z', '--pretty=format:%x1e%H%x00',
        ], { input: `${available.join('\n')}\n` });
        parseFileChanges(diffOutput, metadata);
    }

    return {
        metadata,
        missing: requested.filter(commitId => !metadata.has(commitId)),
    };
}
