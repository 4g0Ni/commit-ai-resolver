/**
 * Unit tests for commit-paths.js — compact path tokens, shared-infra
 * detection, and commit-subject cleaning.
 *
 * Usage: node tests/test-commit-paths.js
 */

import {
    isSharedInfraPath,
    compactPathToken,
    compactPathTokens,
    detectSharedInfra,
    cleanCommitSubject,
} from '../services/commit-paths.js';

let passed = 0;
let failed = 0;

function assert(condition, name) {
    if (condition) {
        console.log(`  ✓ ${name}`);
        passed++;
    } else {
        console.error(`  ✗ ${name}`);
        failed++;
    }
}

// Real file list from bc6b9cd2 (the mis-scoped "content page" commit).
const BC6_PATHS = [
    '/private/component-react-fluent-v2/packages/grid-shared/src/contexts/grid-page-config.ts',
    '/private/component-react-fluent-v2/packages/grid-shared/src/filters/filter-action-bar.tsx',
    '/private/component-react-fluent-v2/packages/grid-shared/src/filters/fluent-filter-bar.tsx',
    '/private/shared-client-react/packages/app-layout-container/src/layout-configs.ts',
    '/private/shared-client-react/packages/app-layout-container/src/types.ts',
    '/private/ui-next/packages/fluent-content-targeting-page/src/bulk-edit/components/add-content-target-drawer.tsx',
    '/private/ui-next/packages/ui-next/src/components/app-content.jsx',
];

console.log('\n== isSharedInfraPath ==');
assert(isSharedInfraPath(BC6_PATHS[1]) === true, 'grid-shared filter-action-bar → shared');
assert(isSharedInfraPath(BC6_PATHS[3]) === true, 'app-layout-container layout-configs → shared');
assert(isSharedInfraPath(BC6_PATHS[5]) === false, 'fluent-content-targeting-page drawer → NOT shared');
assert(isSharedInfraPath('') === false, 'empty path → not shared');

console.log('\n== compactPathToken ==');
assert(compactPathToken(BC6_PATHS[1]) === 'grid-shared/filter-action-bar.tsx', 'package/basename token');
assert(compactPathToken('a/b/c.ts') === 'b/c.ts', 'fallback to last two segments');
assert(compactPathToken('file.ts') === 'file.ts', 'single segment → basename');

console.log('\n== compactPathTokens (ordering + cap) ==');
const tokens = compactPathTokens(BC6_PATHS, { max: 4 });
assert(tokens[0].startsWith('grid-shared/'), 'shared-infra paths sorted first');
assert(tokens[tokens.length - 1] === '+3 more files', 'cap appends "+N more files"');
assert(tokens.length === 5, 'capped to max + truncation marker');
assert(compactPathTokens([]).length === 0, 'empty input → empty array');

const dupes = compactPathTokens(['x/packages/p/src/a.ts', 'y/packages/p/src/a.ts']);
assert(dupes.length === 1, 'duplicate tokens de-duplicated');

const big = compactPathTokens(Array.from({ length: 50 }, (_, i) => `/x/packages/p/src/f${i}.ts`));
assert(big.length === 16, 'large commit capped to 15 + marker');
assert(big[15] === '+35 more files', 'large commit truncation count correct');

console.log('\n== detectSharedInfra ==');
const shared = detectSharedInfra(BC6_PATHS);
assert(shared.isShared === true, 'detects shared infra in mixed commit');
assert(shared.area === 'Shared Fluent grid filter bar (all grid pages)', 'filter-bar area label');
assert(shared.matched.length === 5, 'matched all 5 shared paths');

const notShared = detectSharedInfra([BC6_PATHS[5], BC6_PATHS[6]]);
assert(notShared.isShared === false, 'page-only commit → not shared');
assert(notShared.area === null, 'no area when not shared');

const genericShared = detectSharedInfra(['/repo/src/utils/helper.ts']);
assert(genericShared.isShared === true, 'src/utils → shared');
assert(genericShared.area === 'Shared infrastructure (multiple consumers)', 'generic shared area label');

console.log('\n== cleanCommitSubject ==');
assert(
    cleanCommitSubject('Merged PR 6824215: ADO-10842864: polish content page filter bar')
        === 'ADO-10842864: polish content page filter bar',
    'strips "Merged PR <id>:" prefix',
);
assert(cleanCommitSubject('line one\nline two') === 'line one', 'keeps only first line');
assert(cleanCommitSubject('') === '', 'empty message → empty string');
const long = cleanCommitSubject('x'.repeat(300), 50);
assert(long.length === 51 && long.endsWith('…'), 'truncates long subject with ellipsis');

console.log('\n========================================');
console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
console.log('========================================');
process.exit(failed > 0 ? 1 : 0);
