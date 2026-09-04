import { strict as assert } from 'node:assert';
import { createCommitDiffService } from '../services/commit-diff-service.js';

const publicService = createCommitDiffService({
    available: false,
    repositories: {},
    maxDiffChars: 1_000,
    async fetchImpl(url, options) {
        assert.equal(
            url,
            'https://api.github.com/repos/facebook/react/commits/c3555f0ca2648380ccd3d6af23479610e72f6bf1',
        );
        assert.equal(options.headers['User-Agent'], 'commit-ai-resolver');
        assert.equal(options.headers.Accept, 'application/vnd.github.diff');
        return {
            ok: true,
            status: 200,
            async text() {
                return 'diff --git a/a.js b/a.js\n-old\n+new\n';
            },
        };
    },
});

assert.equal(publicService.available, true);
assert.equal(publicService.canFetch('facebook/react'), true);
assert.equal(publicService.canFetch('AdsAppUI'), false);
const publicDiff = await publicService.getCommitDiff({
    repo: 'facebook/react',
    commitId: 'c3555f0ca2648380ccd3d6af23479610e72f6bf1',
});
assert.equal(publicDiff.provider, 'github');
assert.equal(publicDiff.files, 1);
assert.match(publicDiff.diff, /\+new/u);

const adoService = createCommitDiffService({
    available: true,
    allowPublicGitHub: false,
    repositories: { AdsAppUI: { id: 'repo-id' } },
    async fetchCommitDiff(repository, commitId) {
        assert.equal(repository.id, 'repo-id');
        assert.equal(commitId, 'abc1234');
        return ['diff --git a/Auth.js b/Auth.js\n+guard'];
    },
});
const adoDiff = await adoService.getCommitDiff({ repo: 'AdsAppUI', commitId: 'abc1234' });
assert.equal(adoDiff.provider, 'azure-devops');
assert.equal(adoDiff.files, 1);

await assert.rejects(
    () => publicService.getCommitDiff({ repo: 'facebook/react', commitId: 'not-a-sha' }),
    /commitId must be/u,
);

console.log('commit diff service: PASS');
