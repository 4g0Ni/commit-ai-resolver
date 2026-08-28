import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readGitCommitMetadata } from '../services/git-commit-metadata.js';
import { deriveReactAffectedAreas, enrichPublicCommit } from '../services/public-commit-enrichment.js';

const areas = deriveReactAffectedAreas([
    'packages/react-dom-bindings/src/client/ReactDOMInput.js',
    'packages/react-dom/src/__tests__/ReactDOMInput-test.js',
    'packages/react-reconciler/src/ReactFiber.js',
    'compiler/packages/babel-plugin-react-compiler/src/index.ts',
    'scripts/release/publish.js',
]);
assert.deepEqual(areas, ['React DOM', 'Fiber / Reconciler', 'React Compiler', 'Build / Tooling']);

const enriched = enrichPublicCommit({
    commitId: 'a'.repeat(40),
    title: 'Fix controlled input reset',
    message: 'Fix controlled input reset',
    summary: {
        title: 'Fix controlled input reset',
        summary: 'Fix controlled input reset. 2 files changed, +0/-0.',
        riskLevel: 'MEDIUM',
        changeType: 'code',
    },
}, {
    source: 'local-git',
    parentCount: 1,
    fullMessage: 'Fix controlled input reset\n\nRemove the obsolete blur-only special case and keep defaultValue synchronized.',
    fileChanges: [
        { path: 'packages/react-dom-bindings/src/client/ReactDOMInput.js', status: 'modified' },
        { path: 'packages/react-dom/src/__tests__/ReactDOMInput-test.js', status: 'modified' },
    ],
});
assert.deepEqual(enriched.changedFiles, [
    'packages/react-dom-bindings/src/client/ReactDOMInput.js',
    'packages/react-dom/src/__tests__/ReactDOMInput-test.js',
]);
assert.deepEqual(enriched.summary.affectedAreas, ['React DOM']);
assert.match(enriched.summary.summary, /obsolete blur-only special case/);
assert.equal(enriched.enrichment.pathCountMatchesSource, true);

const repo = await mkdtemp(join(tmpdir(), 'commit-enrichment-'));
execFileSync('git', ['init', '-q'], { cwd: repo });
execFileSync('git', ['config', 'user.name', 'Eval Test'], { cwd: repo });
execFileSync('git', ['config', 'user.email', 'eval@example.test'], { cwd: repo });
const baseBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const sourceDir = join(repo, 'packages', 'react-dom', 'src');
await mkdir(sourceDir, { recursive: true });
await writeFile(join(sourceDir, 'input.js'), 'export const value = 1;\n');
execFileSync('git', ['add', '.'], { cwd: repo });
execFileSync('git', ['commit', '-q', '-m', 'Initial input support'], { cwd: repo });
const first = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
await writeFile(join(sourceDir, 'input.js'), 'export const value = 2;\n');
execFileSync('git', ['add', '.'], { cwd: repo });
execFileSync('git', ['commit', '-q', '-m', 'Update input support', '-m', 'Keep the controlled value synchronized.'], { cwd: repo });
const second = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
execFileSync('git', ['mv', 'packages/react-dom/src/input.js', 'packages/react-dom/src/controlled-input.js'], { cwd: repo });
execFileSync('git', ['commit', '-q', '-m', 'Rename controlled input module'], { cwd: repo });
const third = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: repo });
const reconcilerDir = join(repo, 'packages', 'react-reconciler', 'src');
await mkdir(reconcilerDir, { recursive: true });
await writeFile(join(reconcilerDir, 'ReactFiber.js'), 'export const fiber = true;\n');
execFileSync('git', ['add', '.'], { cwd: repo });
execFileSync('git', ['commit', '-q', '-m', 'Add Fiber support'], { cwd: repo });
execFileSync('git', ['checkout', '-q', baseBranch], { cwd: repo });
await writeFile(join(repo, 'README.md'), 'Commit enrichment fixture.\n');
execFileSync('git', ['add', '.'], { cwd: repo });
execFileSync('git', ['commit', '-q', '-m', 'Document fixture'], { cwd: repo });
execFileSync('git', ['merge', '-q', '--no-ff', '-m', 'Merge Fiber support', 'feature'], { cwd: repo });
const merge = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

const result = readGitCommitMetadata(repo, [first, second, third, merge, 'f'.repeat(40)]);
assert.equal(result.metadata.size, 4);
assert.deepEqual(result.missing, ['f'.repeat(40)]);
assert.equal(result.metadata.get(first).parentCount, 0);
assert.equal(result.metadata.get(second).parentCount, 1);
assert.match(result.metadata.get(second).fullMessage, /controlled value synchronized/);
assert.deepEqual(result.metadata.get(second).fileChanges, [
    { path: 'packages/react-dom/src/input.js', status: 'modified' },
]);
assert.deepEqual(result.metadata.get(third).fileChanges, [
    {
        path: 'packages/react-dom/src/controlled-input.js',
        previousPath: 'packages/react-dom/src/input.js',
        status: 'renamed',
    },
]);
assert.equal(result.metadata.get(merge).parentCount, 2);
assert.deepEqual(result.metadata.get(merge).fileChanges, [
    { path: 'packages/react-reconciler/src/ReactFiber.js', status: 'added' },
]);

console.log('public commit enrichment: PASS');
