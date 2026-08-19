/** Canonical document template for both batch and incremental commit indexing. */

import { compactPathTokens, cleanCommitSubject } from './commit-paths.js';

/**
 * Build semantic text without date/author fields, which belong in metadata filters.
 * Keep repository/component/path terms because they carry domain and lexical meaning.
 */
function buildSearchableCommitText(commit, repoName) {
    const summary = commit.summary || commit.llmSummary;
    const parts = [
        `Repository: ${repoName}`,
        `Title: ${summary.title}`,
        `Summary: ${summary.summary}`,
    ];
    if (summary.affectedAreas?.length) parts.push(`Areas: ${summary.affectedAreas.join(', ')}`);
    if (summary.flags?.length) parts.push(`Flags: ${summary.flags.join(', ')}`);
    if (summary.changeType && summary.changeType !== 'code') parts.push(`Type: ${summary.changeType}`);
    if (summary.configChanges?.length) {
        const configs = summary.configChanges.map(change => {
            let description = `${change.action} ${change.key}: ${change.detail}`;
            if (change.from || change.to) description += ` (${change.from || '?'} -> ${change.to || '?'})`;
            return description;
        }).join('; ');
        parts.push(`Config: ${configs}`);
    }
    const subject = cleanCommitSubject(commit.message);
    if (subject && subject !== summary.title) parts.push(`Commit message: ${subject}`);
    const pathTokens = compactPathTokens(commit.changedFiles);
    if (pathTokens.length) parts.push(`Files: ${pathTokens.join(', ')}`);
    return parts.join('\n');
}

export { buildSearchableCommitText };
