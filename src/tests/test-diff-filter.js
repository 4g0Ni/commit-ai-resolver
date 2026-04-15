/**
 * Unit tests for diff-filter.js — classifyChanges, shouldSkipLLM,
 * buildSkippedFilesSummary, and exported constants.
 *
 * Usage: node tests/test-diff-filter.js
 */

import {
    classifyChanges,
    buildSkippedFilesSummary,
    shouldSkipLLM,
    MAX_FILES_FOR_DIFF,
    MAX_DIFF_SIZE,
    repoFilters,
} from '../services/diff-filter.js';

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

function file(path) {
    return { path, changeType: 'edit' };
}

// ---------------------------------------------------------------------------
// Suite 1: Empty input
// ---------------------------------------------------------------------------
console.log('\n== classifyChanges — empty input ==');

{
    const r = classifyChanges([], 'AdsAppsMT');
    assert(r.needsDiff.length === 0, 'empty array → no needsDiff');
    assert(r.autoSummary.length === 0, 'empty array → no autoSummary');
    assert(r.ignored.length === 0, 'empty array → no ignored');
}

{
    const r = classifyChanges([file('src/index.ts')], 'UnknownRepo');
    assert(r.needsDiff.length === 1, 'unknown repo → file goes to needsDiff');
    assert(r.autoSummary.length === 0, 'unknown repo → no repo-specific auto-summary');
}

// ---------------------------------------------------------------------------
// Suite 2: IGNORE patterns
// ---------------------------------------------------------------------------
console.log('\n== classifyChanges — IGNORE patterns ==');

{
    const files = [
        file('src/__snapshots__/Component.test.snap'),
        file('Form.Designer.cs'),
        file('logo.png'),
        file('icon.JPG'),
        file('photo.jpeg'),
        file('animation.gif'),
        file('favicon.ico'),
        file('diagram.svg'),
        file('font.woff2'),
        file('font.woff'),
        file('font.ttf'),
        file('font.eot'),
    ];
    const r = classifyChanges(files, 'AdsAppsMT');
    assert(r.ignored.length === files.length, `all ${files.length} files ignored`);
    assert(r.needsDiff.length === 0, 'none need diff');
    assert(r.autoSummary.length === 0, 'none auto-summarized');
}

{
    // Case insensitive
    const r = classifyChanges([file('Test.SNAP'), file('form.DESIGNER.CS')], 'AdsAppsMT');
    assert(r.ignored.length === 2, 'case insensitive ignore patterns');
}

// ---------------------------------------------------------------------------
// Suite 3: AUTO_SUMMARY global patterns
// ---------------------------------------------------------------------------
console.log('\n== classifyChanges — AUTO_SUMMARY global patterns ==');

{
    const cases = [
        ['package-lock.json', 'lock file update'],
        ['pnpm-lock.yaml', 'lock file update'],
        ['yarn.lock', 'lock file update'],
        ['Cargo.lock', 'lock file update'],
        ['src/Component.generated.ts', 'auto-generated file'],
        ['Models.g.cs', 'auto-generated C# file'],
        ['bundle.min.js', 'minified bundle'],
        ['styles.min.css', 'minified bundle'],
        ['dist/app.js', 'build output'],
        ['src/app.js.map', 'source map'],
        ['Resources.resx', 'resource file update'],
        ['strings.xlf', 'translation file update'],
        ['locale.lcl', 'localization file update'],
        ['Project.csproj', 'C# project file'],
        ['Directory.Build.props', 'MSBuild props file'],
        ['Directory.Packages.props', 'MSBuild props file'],
        ['.gitignore', '.gitignore update'],
        ['TestFilter.json', 'test filter config'],
        ['TestFilterSomeModule.json', 'test filter config'],
        ['schema.xsd', 'XML schema definition'],
    ];

    for (const [path, expectedReason] of cases) {
        const r = classifyChanges([file(path)], 'UnknownRepo');
        assert(
            r.autoSummary.length === 1 && r.autoSummary[0].reason === expectedReason,
            `${path} → autoSummary (${expectedReason})`
        );
    }
}

// ---------------------------------------------------------------------------
// Suite 4: Per-repo — AdsAppsCampaignUI
// ---------------------------------------------------------------------------
console.log('\n== classifyChanges — per-repo CampaignUI ==');

{
    const cases = [
        ['/src/loc/en-us/strings.json', 'localization strings'],
        ['strings.resjson', 'resource JSON strings'],
        ['strings.campaign.ts', 'generated string constants'],
        ['/cloud-test/TestDefinitions/smoke.xml', 'test definitions'],
        ['/build/yaml/ci-pipeline.yaml', 'build pipeline config'],
        ['/pipeline-variable-groups/prod.json', 'pipeline variables'],
        ['imagediff.ci.json', 'CI image diff config'],
        ['ServiceConfiguration.Cloud.cscfg', 'deploy config (pilots in AdsAppUI)'],
        ['ServiceDefinition.csdef', 'service definition (pilots in AdsAppUI)'],
        ['Web.config', 'web config (pilots in AdsAppUI)'],
    ];

    for (const [path, expectedReason] of cases) {
        const r = classifyChanges([file(path)], 'AdsAppsCampaignUI');
        assert(
            r.autoSummary.length === 1 && r.autoSummary[0].reason === expectedReason,
            `CampaignUI: ${path} → autoSummary (${expectedReason})`
        );
    }
}

// ---------------------------------------------------------------------------
// Suite 5: Per-repo — AdsAppsMT
// ---------------------------------------------------------------------------
console.log('\n== classifyChanges — per-repo AdsAppsMT ==');

{
    const cases = [
        ['Generated/ApiModels.cs', 'auto-generated code'],
        ['diagram.dgml', 'dependency graph diagram'],
        ['/Datamart/tables/fact_clicks.sql', 'datamart auto-generated'],
        ['/adf-prod/trigger/daily-trigger.json', 'ADF pipeline trigger'],
        ['query.script', 'SCOPE/Lens script'],
        ['/agent/workflow.json', 'agent/AI workflow config'],
        ['/agent/instructions.md', 'agent/AI workflow config'],
    ];

    for (const [path, expectedReason] of cases) {
        const r = classifyChanges([file(path)], 'AdsAppsMT');
        assert(
            r.autoSummary.length === 1 && r.autoSummary[0].reason === expectedReason,
            `MT: ${path} → autoSummary (${expectedReason})`
        );
    }
}

// ---------------------------------------------------------------------------
// Suite 6: Per-repo — AdsAppUI
// ---------------------------------------------------------------------------
console.log('\n== classifyChanges — per-repo AdsAppUI ==');

{
    const cases = [
        ['/loc/en-us/strings.json', 'localization strings'],
        ['strings.resjson', 'resource JSON strings'],
        ['Views/Home/Index.cshtml', 'Razor view template'],
    ];

    for (const [path, expectedReason] of cases) {
        const r = classifyChanges([file(path)], 'AdsAppUI');
        assert(
            r.autoSummary.length === 1 && r.autoSummary[0].reason === expectedReason,
            `AdsAppUI: ${path} → autoSummary (${expectedReason})`
        );
    }

    // .cscfg and Web.config should NOT be auto-skipped for AdsAppUI (real config files)
    for (const path of ['ServiceConfiguration.Cloud.cscfg', 'Web.config']) {
        const r = classifyChanges([file(path)], 'AdsAppUI');
        assert(
            r.needsDiff.length === 1,
            `AdsAppUI: ${path} → needsDiff (not auto-skipped)`
        );
    }
}

// ---------------------------------------------------------------------------
// Suite 7: Priority — ignore beats auto-summary
// ---------------------------------------------------------------------------
console.log('\n== classifyChanges — priority ==');

{
    // .snap matches both ignore and could match generated — should be ignored
    const r1 = classifyChanges([file('Component.generated.snap')], 'AdsAppsMT');
    assert(r1.ignored.length === 1, '.generated.snap → ignored (not auto-summary)');
    assert(r1.autoSummary.length === 0, '.generated.snap → not in autoSummary');

    // .png in Generated/ folder — ignore wins
    const r2 = classifyChanges([file('Generated/icon.png')], 'AdsAppsMT');
    assert(r2.ignored.length === 1, 'Generated/icon.png → ignored (binary wins)');
}

// ---------------------------------------------------------------------------
// Suite 8: Files that match nothing → needsDiff
// ---------------------------------------------------------------------------
console.log('\n== classifyChanges — needsDiff fallthrough ==');

{
    const needsDiffFiles = [
        ['src/components/Grid.tsx', 'AdsAppsMT'],
        ['src/services/api.cs', 'AdsAppUI'],
        ['README.md', 'AdsAppsMT'],
        // Dynamic.config is NOT auto-skipped for MT (it's a real config file for LLM)
        ['Implementation/Dynamic.config', 'AdsAppsMT'],
        // appsettings.json is NOT auto-skipped (needs LLM for configChanges extraction)
        ['appsettings.Production.json', 'AdsAppUI'],
    ];

    for (const [path, repo] of needsDiffFiles) {
        const r = classifyChanges([file(path)], repo);
        assert(r.needsDiff.length === 1, `${repo}: ${path} → needsDiff`);
    }
}

// ---------------------------------------------------------------------------
// Suite 9: shouldSkipLLM
// ---------------------------------------------------------------------------
console.log('\n== shouldSkipLLM ==');

{
    // All auto/ignored → true
    assert(
        shouldSkipLLM([file('package-lock.json'), file('logo.png')], 'AdsAppsMT') === true,
        'all auto/ignored → skip LLM'
    );

    // At least one needs diff → false
    assert(
        shouldSkipLLM([file('package-lock.json'), file('src/app.ts')], 'AdsAppsMT') === false,
        'one needsDiff → do not skip LLM'
    );

    // Empty → true
    assert(
        shouldSkipLLM([], 'AdsAppsMT') === true,
        'empty changes → skip LLM'
    );
}

// ---------------------------------------------------------------------------
// Suite 10: buildSkippedFilesSummary
// ---------------------------------------------------------------------------
console.log('\n== buildSkippedFilesSummary ==');

{
    // Groups by reason
    const auto = [
        { path: 'a.lock', reason: 'lock file update' },
        { path: 'b.lock', reason: 'lock file update' },
        { path: 'c.resx', reason: 'resource file update' },
    ];
    const result = buildSkippedFilesSummary(auto, []);
    assert(result.includes('2 file(s) skipped (lock file update)'), 'groups lock files');
    assert(result.includes('1 file(s) skipped (resource file update)'), 'groups resx files');
}

{
    // Truncates at 3 files
    const auto = [
        { path: 'a.lock', reason: 'lock' },
        { path: 'b.lock', reason: 'lock' },
        { path: 'c.lock', reason: 'lock' },
        { path: 'd.lock', reason: 'lock' },
    ];
    const result = buildSkippedFilesSummary(auto, []);
    assert(result.includes('...'), '4+ files shows ...');
    assert(result.includes('4 file(s) skipped (lock)'), 'shows count of 4');
}

{
    // Ignored files section
    const result = buildSkippedFilesSummary([], [file('a.png'), file('b.snap')]);
    assert(result.includes('2 file(s) ignored (binary/snapshot)'), 'shows ignored count');
}

{
    // Empty inputs
    const result = buildSkippedFilesSummary([], []);
    assert(result === '', 'empty inputs → empty string');
}

// ---------------------------------------------------------------------------
// Suite 11: Exported constants
// ---------------------------------------------------------------------------
console.log('\n== Exported constants ==');

assert(MAX_FILES_FOR_DIFF === 50, 'MAX_FILES_FOR_DIFF === 50');
assert(MAX_DIFF_SIZE === 200000, 'MAX_DIFF_SIZE === 200000');
assert('AdsAppsCampaignUI' in repoFilters, 'repoFilters has AdsAppsCampaignUI');
assert('AdsAppsMT' in repoFilters, 'repoFilters has AdsAppsMT');
assert('AdsAppUI' in repoFilters, 'repoFilters has AdsAppUI');
assert(Array.isArray(repoFilters.AdsAppsMT.autoSummary), 'MT autoSummary is array');
assert(Array.isArray(repoFilters.AdsAppsMT.ignore), 'MT ignore is array');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
console.log('='.repeat(40));
process.exit(failed > 0 ? 1 : 0);
