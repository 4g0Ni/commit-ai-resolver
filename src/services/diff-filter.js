/**
 * Diff filter — Decides which files in a commit need LLM summarization
 * and which can be auto-summarized without sending diffs.
 *
 * Supports:
 *   - General skip patterns (lock files, auto-gen, binary assets)
 *   - Per-repo custom rules via repoFilters
 *   - File-count threshold (massive auto-merge commits)
 */

// ---------------------------------------------------------------------------
// Skip patterns — files matching these never need LLM diff analysis
// ---------------------------------------------------------------------------

/** Files to completely skip (not even mention in summary). */
const IGNORE_PATTERNS = [
    /\.snap$/i,                        // Jest snapshots
    /\.Designer\.cs$/i,                // VS auto-generated designer files
    /\.(png|jpg|jpeg|gif|ico|svg|woff2?|ttf|eot)$/i,  // binary assets
];

/** Files to auto-summarize as LOW risk without sending diff to LLM. */
const AUTO_SUMMARY_PATTERNS = [
    // Lock files
    { pattern: /package-lock\.json$/i, reason: 'lock file update' },
    { pattern: /pnpm-lock\.yaml$/i, reason: 'lock file update' },
    { pattern: /yarn\.lock$/i, reason: 'lock file update' },
    { pattern: /\.lock$/i, reason: 'lock file update' },
    // Auto-generated code
    { pattern: /\.generated\.\w+$/i, reason: 'auto-generated file' },
    { pattern: /\.g\.cs$/i, reason: 'auto-generated C# file' },
    // Build artifacts
    { pattern: /\.min\.(js|css)$/i, reason: 'minified bundle' },
    { pattern: /dist\//i, reason: 'build output' },
    { pattern: /\.map$/i, reason: 'source map' },
    // Localization / resources
    { pattern: /\.resx$/i, reason: 'resource file update' },
    { pattern: /\.xlf$/i, reason: 'translation file update' },
    { pattern: /\.lcl$/i, reason: 'localization file update' },
    // Project / build config files
    { pattern: /\.csproj$/i, reason: 'C# project file' },
    // NOTE: .csdef and Web.config are NOT auto-skipped — they contain
    // production-affecting pilot/config settings in AdsAppUI.
    { pattern: /Directory\.(Build|Packages)\.props$/i, reason: 'MSBuild props file' },
    { pattern: /\.gitignore$/i, reason: '.gitignore update' },
    { pattern: /TestFilter.*\.json$/i, reason: 'test filter config' },
    { pattern: /\.xsd$/i, reason: 'XML schema definition' },
    // NOTE: appsettings*.json, DynamicConfig*, sharedfeatures.config, .cscfg
    // are NOT auto-skipped — they contain production-affecting config/pilot values
    // and must go through LLM for structured configChanges extraction.
    // --- Audit-driven additions (2026-05-15): AI / developer tooling ---
    { pattern: /\.skill\.md$/i, reason: 'AI skill definition' },
    { pattern: /\.prompt\.md$/i, reason: 'AI prompt definition' },
    { pattern: /\.agent\.md$/i, reason: 'AI agent definition' },
    { pattern: /CLAUDE\.md$/i, reason: 'Claude Code project instructions' },
    { pattern: /\.cursorrules$/i, reason: 'Cursor AI rules' },
    { pattern: /\.github\/copilot/i, reason: 'GitHub Copilot config' },
    { pattern: /\/\.claude\//i, reason: 'Claude tooling directory' },
    // --- Audit-driven additions: design docs (17/17 ceremony in audit) ---
    { pattern: /\.design-docs\//i, reason: 'design documentation' },
    { pattern: /knowledge-docs\//i, reason: 'knowledge docs' },
    { pattern: /knowledge\.md$/i, reason: 'AI reference doc' },
    // --- Audit-driven additions: project setup pinning ---
    { pattern: /global\.json$/i, reason: '.NET SDK pin' },
    { pattern: /\.editorconfig$/i, reason: 'editor config' },
    { pattern: /nuget\.config$/i, reason: 'NuGet feed config' },
    { pattern: /\.npmrc$/i, reason: 'npm registry config' },
    // --- Audit-driven additions: test runner config (NOT test files themselves) ---
    { pattern: /jest\.config\.[jt]s$/i, reason: 'Jest runner config' },
    { pattern: /karma\.conf\.[jt]s$/i, reason: 'Karma runner config' },
    { pattern: /\.istanbul\.yml$/i, reason: 'coverage config' },
    // --- Audit-driven additions: package.json metadata (1 real / 11 ceremony in audit) ---
    // Note: 1 false-skip rate accepted — version/dep bumps dominate this file type.
    { pattern: /\bpackage\.json$/i, reason: 'package metadata / dependency bump' },
];

// ---------------------------------------------------------------------------
// Per-repo filters — custom rules for specific repositories
// ---------------------------------------------------------------------------

const repoFilters = {
    AdsAppsCampaignUI: {
        autoSummary: [
            { pattern: /\/loc\//i, reason: 'localization strings' },
            { pattern: /\.resjson$/i, reason: 'resource JSON strings' },
            { pattern: /strings\.\w+\.ts$/i, reason: 'generated string constants' },
            { pattern: /\/cloud-test\/TestDefinitions\//i, reason: 'test definitions' },
            { pattern: /\/build\/yaml\//i, reason: 'build pipeline config' },
            { pattern: /\/pipeline-variable-groups/i, reason: 'pipeline variables' },
            { pattern: /imagediff\.ci\.json$/i, reason: 'CI image diff config' },
            // Pilot/config controls for CampaignUI live in AdsAppUI server-side,
            // so .cscfg/.csdef/Web.config/.config files here are build/deploy config only.
            { pattern: /\.cscfg$/i, reason: 'deploy config (pilots in AdsAppUI)' },
            { pattern: /\.csdef$/i, reason: 'service definition (pilots in AdsAppUI)' },
            { pattern: /Web\.config$/i, reason: 'web config (pilots in AdsAppUI)' },
        ],
        ignore: [],
    },
    AdsAppsMT: {
        autoSummary: [
            { pattern: /Generated/i, reason: 'auto-generated code' },
            { pattern: /\.dgml$/i, reason: 'dependency graph diagram' },
            { pattern: /\/Datamart\//i, reason: 'datamart auto-generated' },
            { pattern: /\/adf-prod\/trigger\//i, reason: 'ADF pipeline trigger' },
            { pattern: /\.script$/i, reason: 'SCOPE/Lens script' },
            { pattern: /\/agent\//i, reason: 'agent/AI workflow config' },
            // NOTE: Dynamic.config, *Dynamic.config NOT auto-skipped —
            // they control feature flags in production.
        ],
        ignore: [],
    },
    AdsAppsDB: {
        autoSummary: [
            // NOTE (2026-05-15 audit): blanket /\.sql$/i rule was too broad —
            // 42 SQL files flagged as "real" production schema/proc/seed changes.
            // Only auto-skip clearly generated or build-artifact SQL paths.
            { pattern: /\/Migrations\//i, reason: 'database migration' },
            { pattern: /\/dacpac\//i, reason: 'DACPAC build artifact' },
            { pattern: /Generated/i, reason: 'auto-generated code' },
            // Removed: /\.sql$/i — covered real schema/proc edits
            // Removed: /StoredProcedures/i — covered real procedure body edits
        ],
        ignore: [],
    },
    AnB: {
        autoSummary: [
            { pattern: /Generated/i, reason: 'auto-generated code' },
            { pattern: /\/loc\//i, reason: 'localization strings' },
            { pattern: /\.resjson$/i, reason: 'resource JSON strings' },
            { pattern: /\/build\//i, reason: 'build pipeline config' },
        ],
        ignore: [],
    },
    AdsAppUI: {
        autoSummary: [
            { pattern: /\/loc\//i, reason: 'localization strings' },
            { pattern: /\.resjson$/i, reason: 'resource JSON strings' },
            // NOTE (2026-05-15 audit): blanket /\.cshtml$/i rule dropped —
            // 7 Razor views surfaced with real pilot-token / logic-density signals.
            // .cshtml views in AdsAppUI carry pilot gating, so let them flow to LLM.
            // NOTE: .cscfg, .csdef, Web.config, appsettings*.json, sharedfeatures.config,
            // AllowedFeature.cs, PermissionProvider.cs are NOT auto-skipped —
            // they are the primary pilot/config control files for AdsAppUI.
        ],
        ignore: [],
    },
};

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** If a commit has more than this many files, skip diff and just summarize from filenames. */
const MAX_FILES_FOR_DIFF = 50;

/** Max total diff size (chars) to send to LLM. Beyond this, truncate. */
const MAX_DIFF_SIZE = 200000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify changed files in a commit into categories.
 *
 * @param {Array<{path: string, changeType: string}>} changes - File changes from ADO
 * @param {string} repoName - Repository name for repo-specific rules
 * @returns {{ needsDiff: Array, autoSummary: Array, ignored: Array }}
 */
function classifyChanges(changes, repoName) {
    const custom = repoFilters[repoName] || { autoSummary: [], ignore: [] };
    const allAutoPatterns = [...AUTO_SUMMARY_PATTERNS, ...custom.autoSummary];
    const allIgnorePatterns = [...IGNORE_PATTERNS, ...custom.ignore];

    const needsDiff = [];
    const autoSummary = [];
    const ignored = [];

    for (const change of changes) {
        const path = change.path;

        // Check ignore first
        if (allIgnorePatterns.some(p => (p instanceof RegExp ? p : p.pattern).test(path))) {
            ignored.push(change);
            continue;
        }

        // Check auto-summary
        const autoMatch = allAutoPatterns.find(rule => rule.pattern.test(path));
        if (autoMatch) {
            autoSummary.push({ ...change, reason: autoMatch.reason });
            continue;
        }

        needsDiff.push(change);
    }

    return { needsDiff, autoSummary, ignored };
}

/**
 * Build a file-list-only summary for commits with too many files or auto-summary files.
 *
 * @param {Array} autoSummaryFiles - Files that were auto-classified
 * @param {Array} ignoredFiles - Files that were ignored
 * @returns {string} Human-readable summary of skipped files
 */
function buildSkippedFilesSummary(autoSummaryFiles, ignoredFiles) {
    const parts = [];
    if (autoSummaryFiles.length > 0) {
        const grouped = {};
        for (const f of autoSummaryFiles) {
            const reason = f.reason || 'auto-skipped';
            if (!grouped[reason]) grouped[reason] = [];
            grouped[reason].push(f.path);
        }
        for (const [reason, files] of Object.entries(grouped)) {
            parts.push(`${files.length} file(s) skipped (${reason}): ${files.slice(0, 3).join(', ')}${files.length > 3 ? '...' : ''}`);
        }
    }
    if (ignoredFiles.length > 0) {
        parts.push(`${ignoredFiles.length} file(s) ignored (binary/snapshot)`);
    }
    return parts.join('\n');
}

/**
 * Check if a commit should skip LLM entirely (all files are auto/ignored).
 */
function shouldSkipLLM(changes, repoName) {
    const { needsDiff } = classifyChanges(changes, repoName);
    return needsDiff.length === 0;
}

export {
    classifyChanges,
    buildSkippedFilesSummary,
    shouldSkipLLM,
    MAX_FILES_FOR_DIFF,
    MAX_DIFF_SIZE,
    repoFilters,
};
