const AREA_RULES = [
    [/^(?:packages\/react-devtools|packages\/react-debug-tools|packages\/react-devtools-shared)/i, 'React DevTools'],
    [/^(?:packages\/react-server-dom|packages\/react-client|packages\/react-server|packages\/react-markup)/i, 'React Server Components / Flight'],
    [/^(?:packages\/react-dom|packages\/react-dom-bindings|src\/renderers\/dom|src\/eventPlugins)/i, 'React DOM'],
    [/^(?:packages\/react-reconciler|src\/renderers\/shared\/fiber|src\/reconciler)/i, 'Fiber / Reconciler'],
    [/^(?:packages\/react-native|packages\/react-native-renderer|src\/renderers\/native)/i, 'React Native Renderer'],
    [/^(?:packages\/scheduler|packages\/scheduler-)/i, 'Scheduler'],
    [/^(?:compiler\/|packages\/babel-plugin-react-compiler)/i, 'React Compiler'],
    [/^(?:packages\/react-test-renderer|packages\/react-noop-renderer)/i, 'Test Renderers'],
    [/^(?:packages\/react-art|src\/renderers\/art)/i, 'React ART'],
    [/^(?:packages\/shared|shared\/)/i, 'Shared React Infrastructure'],
    [/^(?:packages\/react-events|packages\/react-interactions)/i, 'React Events'],
    [/^(?:packages\/eslint-plugin-react-hooks)/i, 'React Hooks ESLint'],
    [/^(?:packages\/internal-test-utils)/i, 'Test Infrastructure'],
    [/^(?:packages\/react\b|src\/isomorphic|src\/core)/i, 'React Core'],
    [/^(?:shells\/)/i, 'React DevTools'],
    [/^(?:addons\/)/i, 'React Addons'],
    [/^(?:vendor\/)/i, 'Vendored Dependencies'],
    [/^(?:compiled(?:-rn)?\/|build\/|grunt\/)/i, 'Generated / Build Output'],
    [/^(?:fixtures\/)/i, 'Fixtures'],
    [/^(?:docs\/|README(?:\.|$)|CHANGELOG(?:\.|$)|MAINTAINERS(?:\.|$))/i, 'Documentation'],
    [/^(?:scripts\/|\.github\/|\.circleci\/|(?:grunt|gulp)file\.|\.[^/]+$|yarn\.lock$|package\.json$)/i, 'Build / Tooling'],
];

const TEST_PATH = /(?:^|\/)(?:__tests__|test|tests|fixtures)(?:\/|$)|(?:-test|\.test|\.spec)\.[^/]+$/i;
const NON_PRODUCTION_AREAS = new Set(['Build / Tooling', 'Generated / Build Output', 'Vendored Dependencies', 'Documentation', 'Fixtures', 'Test Infrastructure']);

function normalizedPath(path) {
    return String(path || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function fallbackArea(path) {
    const parts = normalizedPath(path).split('/').filter(Boolean);
    if (parts[0] === 'packages' && parts[1]) return parts[1];
    if (parts[0] === 'src') return 'React Core';
    return parts[0] || null;
}

function commitBody(fullMessage, subject, maxLength = 700) {
    const lines = String(fullMessage || '').replace(/\r/g, '').split('\n');
    if (lines[0]?.trim() === String(subject || '').trim()) lines.shift();
    const body = lines
        .filter(line => !/^\s*(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#\d+[.!]?\s*$/i.test(line))
        .filter(line => !/^\s*(?:co-authored-by|signed-off-by):/i.test(line))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (body.length < 30) return '';
    return body.length <= maxLength ? body : `${body.slice(0, maxLength).trim()}…`;
}

function declaredFileCount(commit) {
    if (Number.isInteger(commit.filesChangedCount)) return commit.filesChangedCount;
    const match = String(commit.summary?.summary || '').match(/\b(\d+)\s+files? changed\b/i);
    return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Derive stable React technical areas from changed paths.
 * Areas are ranked by path frequency, with product/runtime areas ahead of tooling.
 * @param {string[]} paths - Repo-relative changed paths
 * @param {object} [options]
 * @param {number} [options.max=4] - Maximum returned areas
 * @returns {string[]}
 */
export function deriveReactAffectedAreas(paths, options = {}) {
    const max = options.max || 4;
    const counts = new Map();
    for (const rawPath of paths || []) {
        const path = normalizedPath(rawPath);
        const area = AREA_RULES.find(([pattern]) => pattern.test(path))?.[1] || fallbackArea(path);
        if (area) counts.set(area, (counts.get(area) || 0) + 1);
    }
    return [...counts]
        .sort(([leftArea, leftCount], [rightArea, rightCount]) => {
            const productionDelta = Number(NON_PRODUCTION_AREAS.has(leftArea)) - Number(NON_PRODUCTION_AREAS.has(rightArea));
            return productionDelta || rightCount - leftCount || leftArea.localeCompare(rightArea);
        })
        .slice(0, max)
        .map(([area]) => area);
}

/**
 * Apply deterministic public-corpus metadata and summary enrichment to a commit.
 * @param {object} commit - Existing normalized daily commit
 * @param {object} gitMetadata - Full message and first-parent file changes
 * @returns {object} Backwards-compatible enriched commit
 */
export function enrichPublicCommit(commit, gitMetadata) {
    const fileChanges = Array.isArray(gitMetadata?.fileChanges) ? gitMetadata.fileChanges : [];
    const changedFiles = fileChanges.map(change => change.path).filter(Boolean);
    const affectedAreas = deriveReactAffectedAreas(changedFiles);
    const subject = String(commit.title || commit.message || '').split(/\r?\n/, 1)[0].trim();
    const body = commitBody(gitMetadata?.fullMessage, subject);
    const isTestOnly = changedFiles.length > 0 && changedFiles.every(path => TEST_PATH.test(normalizedPath(path)));
    const areasText = affectedAreas.length ? affectedAreas.join(', ') : 'an unclassified React area';
    const summaryText = body || `${subject}. Affects ${areasText} across ${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'}.`;
    const originalCount = declaredFileCount(commit);
    const riskLevel = isTestOnly || (affectedAreas.length > 0 && affectedAreas.every(area => NON_PRODUCTION_AREAS.has(area)))
        ? 'LOW'
        : (commit.summary?.riskLevel || 'MEDIUM');

    return {
        ...commit,
        fullMessage: gitMetadata.fullMessage || subject,
        changedFiles,
        filesChangedCount: changedFiles.length,
        fileChanges,
        summary: {
            ...(commit.summary || {}),
            title: subject,
            summary: summaryText,
            riskLevel,
            affectedAreas,
            affectedAreasSource: 'react-path-rules-v1',
            source: 'public-corpus-git-enriched-v1',
            testOnly: isTestOnly,
        },
        enrichment: {
            version: 1,
            source: gitMetadata.source || 'local-git',
            parentStrategy: gitMetadata.parentCount > 1 ? 'first-parent' : (gitMetadata.parentCount === 0 ? 'empty-tree' : 'single-parent'),
            sourceFilesChangedCount: originalCount,
            filesComplete: true,
            pathCountMatchesSource: originalCount === null ? null : originalCount === changedFiles.length,
        },
    };
}
