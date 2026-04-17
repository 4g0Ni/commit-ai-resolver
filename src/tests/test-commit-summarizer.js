/**
 * Unit tests for commit-summarizer.js — pure logic functions.
 * Tests isConfigFile, prettifyMinifiedXml, CONFIG_FILE_PATTERNS,
 * COMMIT_SUMMARY_PROMPT structure, and pattern correctness.
 *
 * Usage: node tests/test-commit-summarizer.js
 */

import {
    isConfigFile,
    prettifyMinifiedXml,
    CONFIG_FILE_PATTERNS,
    COMMIT_SUMMARY_PROMPT,
} from '../services/commit-summarizer.js';

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

// ---------------------------------------------------------------------------
// Suite 1: isConfigFile — positive matches
// ---------------------------------------------------------------------------
console.log('\n== isConfigFile — positive matches ==');

const configFiles = [
    ['ServiceConfiguration.Cloud.cscfg', '.cscfg'],
    ['ServiceDefinition.csdef', '.csdef'],
    ['Web.config', 'Web.config'],
    ['Implementation/Dynamic.config', 'Dynamic.config'],
    ['Source/DynamicConfigValues.cs', 'DynamicConfigValues.cs'],
    ['appsettings.json', 'appsettings.json'],
    ['appsettings.Production.json', 'appsettings.*.json'],
    ['sharedfeatures.config', 'sharedfeatures.config'],
    ['AllowedFeature.cs', 'AllowedFeature.cs'],
    ['PermissionProvider.cs', 'PermissionProvider.cs'],
    ['IPermissionProvider.cs', 'IPermissionProvider.cs'],
];

for (const [path, desc] of configFiles) {
    assert(isConfigFile(path) === true, `${path} is config (${desc})`);
}

// ---------------------------------------------------------------------------
// Suite 2: isConfigFile — negative matches
// ---------------------------------------------------------------------------
console.log('\n== isConfigFile — negative matches ==');

const notConfigFiles = [
    'helm-campaign.yaml',
    'values.yaml',
    'src/components/Grid.tsx',
    'README.md',
    'package.json',
    'styles.css',
    'SomeService.cs',
    'agent/workflow.json',
    'Dockerfile',
];

for (const path of notConfigFiles) {
    assert(isConfigFile(path) === false, `${path} is NOT config`);
}

// ---------------------------------------------------------------------------
// Suite 3: prettifyMinifiedXml — non-XML paths unchanged
// ---------------------------------------------------------------------------
console.log('\n== prettifyMinifiedXml — non-XML paths ==');

{
    assert(prettifyMinifiedXml(null, 'Web.config') === null, 'null content → null');
    assert(prettifyMinifiedXml('', 'Web.config') === '', 'empty content → empty');
    assert(prettifyMinifiedXml('<root/>', 'src/app.ts') === '<root/>', 'non-XML path → unchanged');
    assert(prettifyMinifiedXml('<root/>', 'styles.css') === '<root/>', 'CSS path → unchanged');
}

// ---------------------------------------------------------------------------
// Suite 4: prettifyMinifiedXml — short lines unchanged
// ---------------------------------------------------------------------------
console.log('\n== prettifyMinifiedXml — short lines ==');

{
    const shortXml = '<configuration>\n  <appSettings>\n    <add key="foo" value="bar"/>\n  </appSettings>\n</configuration>';
    assert(
        prettifyMinifiedXml(shortXml, 'Web.config') === shortXml,
        'short XML lines → unchanged'
    );
}

// ---------------------------------------------------------------------------
// Suite 5: prettifyMinifiedXml — minified XML split
// ---------------------------------------------------------------------------
console.log('\n== prettifyMinifiedXml — minified XML ==');

{
    // Create a minified line > 10KB
    const longValue = 'x'.repeat(11000);
    const minified = `<root><item value="${longValue}"/><other/></root>`;
    const result = prettifyMinifiedXml(minified, 'Dynamic.config');
    assert(result.includes('\n'), 'minified XML → contains newlines');
    assert(result.split('\n').length > 1, 'minified XML → split into multiple lines');
    // Each ><  boundary should become >\n<
    assert(result.includes('>\n<'), 'splits on >< boundary');
}

{
    // .cscfg also matches
    const longValue = 'y'.repeat(11000);
    const minified = `<ServiceConfiguration><Role name="${longValue}"/><Setting/></ServiceConfiguration>`;
    const result = prettifyMinifiedXml(minified, 'ServiceConfiguration.Cloud.cscfg');
    assert(result.includes('>\n<'), '.cscfg minified → split');
}

{
    // sharedfeatures.config matches
    const longValue = 'z'.repeat(11000);
    const minified = `<features><flag name="${longValue}"/><flag/></features>`;
    const result = prettifyMinifiedXml(minified, 'sharedfeatures.config');
    assert(result.includes('>\n<'), 'sharedfeatures.config minified → split');
}

// ---------------------------------------------------------------------------
// Suite 6: CONFIG_FILE_PATTERNS — structure
// ---------------------------------------------------------------------------
console.log('\n== CONFIG_FILE_PATTERNS — structure ==');

{
    assert(Array.isArray(CONFIG_FILE_PATTERNS), 'CONFIG_FILE_PATTERNS is array');
    assert(CONFIG_FILE_PATTERNS.length >= 10, `has ${CONFIG_FILE_PATTERNS.length} patterns (>= 10)`);
    assert(CONFIG_FILE_PATTERNS.every(p => p instanceof RegExp), 'all entries are RegExp');

    // Verify key patterns exist by testing against known config files
    assert(CONFIG_FILE_PATTERNS.some(p => p.test('Dynamic.config')), 'includes Dynamic.config pattern');
    assert(CONFIG_FILE_PATTERNS.some(p => p.test('appsettings.json')), 'includes appsettings pattern');

    // Verify exclusions
    assert(!CONFIG_FILE_PATTERNS.some(p => p.test('helm-campaign.yaml')), 'excludes helm-*.yaml');
    assert(!CONFIG_FILE_PATTERNS.some(p => p.test('values.yaml')), 'excludes values.yaml');
}

// ---------------------------------------------------------------------------
// Suite 7: COMMIT_SUMMARY_PROMPT — key sections present
// ---------------------------------------------------------------------------
console.log('\n== COMMIT_SUMMARY_PROMPT — key sections ==');

{
    assert(typeof COMMIT_SUMMARY_PROMPT === 'string', 'COMMIT_SUMMARY_PROMPT is string');
    assert(COMMIT_SUMMARY_PROMPT.length > 500, `prompt is substantial (${COMMIT_SUMMARY_PROMPT.length} chars)`);

    // JSON output schema
    assert(COMMIT_SUMMARY_PROMPT.includes('changeType'), 'prompt mentions changeType');
    assert(COMMIT_SUMMARY_PROMPT.includes('configChanges'), 'prompt mentions configChanges');
    assert(COMMIT_SUMMARY_PROMPT.includes('riskLevel'), 'prompt mentions riskLevel');
    assert(COMMIT_SUMMARY_PROMPT.includes('breakingChange'), 'prompt mentions breakingChange');

    // Risk level criteria
    assert(COMMIT_SUMMARY_PROMPT.includes('HIGH') && COMMIT_SUMMARY_PROMPT.includes('MEDIUM') && COMMIT_SUMMARY_PROMPT.includes('LOW'), 'prompt has risk level criteria');

    // Config detection rules
    assert(COMMIT_SUMMARY_PROMPT.includes('NOT a config change') || COMMIT_SUMMARY_PROMPT.includes('not config') || COMMIT_SUMMARY_PROMPT.includes('NOT classify'), 'prompt has config exclusion rules');

    // Repo-specific rules
    assert(COMMIT_SUMMARY_PROMPT.includes('AdsAppsMT'), 'prompt has MT-specific rules');
    assert(COMMIT_SUMMARY_PROMPT.includes('AdsAppUI'), 'prompt has AdsAppUI rules');
    assert(COMMIT_SUMMARY_PROMPT.includes('AdsAppsCampaignUI') || COMMIT_SUMMARY_PROMPT.includes('CampaignUI'), 'prompt has CampaignUI rules');
}

// ---------------------------------------------------------------------------
// Suite 8: Diff truncation logic (test the pattern)
// ---------------------------------------------------------------------------
console.log('\n== Diff truncation logic ==');

{
    const MAX_DIFF_SIZE = 200000;

    // Under limit — unchanged
    const short = 'a'.repeat(100);
    let result = short;
    if (result.length > MAX_DIFF_SIZE) {
        result = result.substring(0, MAX_DIFF_SIZE) + '\n... (diff truncated)';
    }
    assert(result === short, 'under limit → unchanged');
    assert(!result.includes('truncated'), 'under limit → no truncation marker');

    // Over limit — truncated
    const long = 'b'.repeat(250000);
    let result2 = long;
    if (result2.length > MAX_DIFF_SIZE) {
        result2 = result2.substring(0, MAX_DIFF_SIZE) + '\n... (diff truncated)';
    }
    assert(result2.length === MAX_DIFF_SIZE + '\n... (diff truncated)'.length, 'over limit → truncated to MAX + marker');
    assert(result2.endsWith('\n... (diff truncated)'), 'over limit → ends with truncation marker');

    // Exactly at limit — unchanged
    const exact = 'c'.repeat(MAX_DIFF_SIZE);
    let result3 = exact;
    if (result3.length > MAX_DIFF_SIZE) {
        result3 = result3.substring(0, MAX_DIFF_SIZE) + '\n... (diff truncated)';
    }
    assert(result3 === exact, 'exactly at limit → unchanged');
}

// ---------------------------------------------------------------------------
// Suite 9: JSON parse fallback logic (test the pattern)
// ---------------------------------------------------------------------------
console.log('\n== JSON parse fallback ==');

{
    // Valid JSON
    const validResponse = '{"title":"test","summary":"test summary","riskLevel":"LOW","changeType":"code"}';
    let summary;
    try { summary = JSON.parse(validResponse); } catch { summary = null; }
    assert(summary !== null && summary.title === 'test', 'valid JSON → parsed correctly');
    assert(summary.riskLevel === 'LOW', 'valid JSON → riskLevel preserved');

    // Invalid JSON → fallback
    const invalidResponse = 'This is not JSON, just a text summary.';
    let summary2;
    try {
        summary2 = JSON.parse(invalidResponse);
    } catch {
        summary2 = {
            title: 'Fallback Title',
            summary: invalidResponse,
            riskLevel: 'MEDIUM',
            affectedAreas: [],
            flags: [],
            changeType: 'code',
            configChanges: [],
            breakingChange: false,
        };
    }
    assert(summary2.summary === invalidResponse, 'invalid JSON → raw response as summary');
    assert(summary2.riskLevel === 'MEDIUM', 'invalid JSON → defaults to MEDIUM');
    assert(summary2.changeType === 'code', 'invalid JSON → defaults to code');
    assert(summary2.configChanges.length === 0, 'invalid JSON → empty configChanges');

    // Empty string
    let summary3;
    try {
        summary3 = JSON.parse('');
    } catch {
        summary3 = { summary: '', riskLevel: 'MEDIUM', changeType: 'code', configChanges: [] };
    }
    assert(summary3.riskLevel === 'MEDIUM', 'empty string → fallback MEDIUM');

    // Partial JSON (truncated response)
    const partial = '{"title":"test","summary":"trunca';
    let summary4;
    try {
        summary4 = JSON.parse(partial);
    } catch {
        summary4 = { summary: partial, riskLevel: 'MEDIUM', changeType: 'code', configChanges: [] };
    }
    assert(summary4.summary === partial, 'partial JSON → raw response preserved');
}

// ---------------------------------------------------------------------------
// Suite 10: Config-first sort ordering (test the pattern)
// ---------------------------------------------------------------------------
console.log('\n== Config-first sort ordering ==');

{
    const files = [
        { path: 'src/app.ts' },
        { path: 'Web.config' },
        { path: 'README.md' },
        { path: 'Dynamic.config' },
        { path: 'src/service.cs' },
    ];

    const sorted = [...files].sort((a, b) => {
        const aConfig = isConfigFile(a.path) ? 0 : 1;
        const bConfig = isConfigFile(b.path) ? 0 : 1;
        return aConfig - bConfig;
    });

    assert(isConfigFile(sorted[0].path), 'first item is config file');
    assert(isConfigFile(sorted[1].path), 'second item is config file');
    assert(!isConfigFile(sorted[2].path), 'third item is NOT config file');
    assert(sorted.length === files.length, 'sort preserves all items');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
console.log('='.repeat(40));
process.exit(failed > 0 ? 1 : 0);
