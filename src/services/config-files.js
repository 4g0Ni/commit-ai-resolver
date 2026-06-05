/**
 * Config-file detection + minified-XML prettification helpers.
 *
 * Extracted from commit-summarizer.js into a standalone module so both
 * commit-summarizer.js and diff-builder.js can import them without creating a
 * circular dependency (commit-summarizer → diff-builder → commit-summarizer).
 */

/** XML config file patterns that may be minified. */
export const XML_CONFIG_PATTERNS = [
    /Web\.config$/i,
    /\.cscfg$/i,
    /\.csdef$/i,
    /Dynamic\.config$/i,
    /sharedfeatures\.config$/i,
    /\.config$/i,
];

/**
 * If a file is minified XML (any line > 10KB), split on "><" to get
 * one element per line so the diff is granular for LLM extraction.
 * @param {string|null} content
 * @param {string} path
 * @returns {string|null}
 */
export function prettifyMinifiedXml(content, path) {
    if (!content) return content;
    if (!XML_CONFIG_PATTERNS.some(p => p.test(path))) return content;
    // Check if any single line exceeds 10KB — indicates minified XML
    const lines = content.split('\n');
    const hasLongLine = lines.some(l => l.length > 10000);
    if (!hasLongLine) return content;
    // Split on >< and > < boundaries, preserving the brackets
    return content.replace(/>\s*</g, '>\n<');
}

/** Patterns for config/pilot files that should be prioritized in diff ordering. */
export const CONFIG_FILE_PATTERNS = [
    /\.cscfg$/i,
    /\.csdef$/i,
    /Web\.config$/i,
    /Dynamic\.config$/i,
    /DynamicConfigValues\.cs$/i,
    /appsettings.*\.json$/i,
    /sharedfeatures\.config$/i,
    /AllowedFeature\.cs$/i,
    /PermissionProvider\.cs$/i,
    /IPermissionProvider\.cs$/i,
    // NOTE: helm-*.yaml and values.yaml are NOT config files — they are k8s infrastructure
];

/**
 * Whether a path is a production config/pilot/flag file.
 * @param {string} path
 * @returns {boolean}
 */
export function isConfigFile(path) {
    return CONFIG_FILE_PATTERNS.some(p => p.test(path));
}
