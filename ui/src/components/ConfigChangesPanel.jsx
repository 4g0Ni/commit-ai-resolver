/**
 * ConfigChangesPanel — Dedicated view for config/pilot flag changes.
 * Shows only commits with changeType config/mixed or non-empty configChanges,
 * with a table of key/action/from/to/environments per commit.
 * Groups identical key+action+from+to rows, showing environments as tags.
 */

const ACTION_COLORS = { added: 'added', modified: 'modified', removed: 'removed' };

/**
 * Extract an environment name from a config change's detail text.
 * Looks for common patterns like "in XYZ environment" or known env names.
 */
function extractEnvFromDetail(detail) {
    if (!detail) return null;
    // Match "in <Env> environment" or "from <Env> environment"
    const envMatch = detail.match(/(?:in|from)\s+(?:the\s+)?([A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+)*?)\s+environment/i);
    if (envMatch) return envMatch[1].trim();
    // Match known env patterns: EastUS SI, WestUS Prod, Local, INT, PROD-TIP, etc.
    const knownEnv = detail.match(/\b((?:EastUS|WestUS|CentralUS|NorthEurope|WestEurope)\s+(?:SI|Prod|TIP)|Local|INT|PROD-TIP|PROD|BingAdsService\w+-(?:Prod|SI)-\w+|CampaignWeb\s+Web\.config|UICore\s+\w+)/i);
    if (knownEnv) return knownEnv[1].trim();
    return null;
}

/**
 * Filter out no-op changes where from === to (false positives from LLM).
 */
function isRealChange(cfg) {
    if (cfg.action === 'modified' && cfg.from && cfg.to && cfg.from === cfg.to) return false;
    return true;
}

/**
 * Group config changes to reduce row duplication.
 *
 * 1. Exact match: same key+action+from+to → single row with env tags.
 * 2. Key+action match with varying values → single row, value shows
 *    per-env breakdown in a compact list when envs are extractable.
 *
 * Returns grouped entries with `envs`, `details`, and optionally
 * `perEnvValues` (when from/to differ across environments).
 */
function groupConfigChanges(changes) {
    // Phase 0 — filter out no-op changes where from === to (false positives)
    const meaningful = changes.filter(isRealChange);

    // Phase 1 — exact grouping (key+action+from+to)
    const exactGroups = new Map();
    for (const cfg of meaningful) {
        const key = cfg.key || cfg.name || '';
        const groupKey = `${key}||${cfg.action}||${cfg.from || ''}||${cfg.to || ''}`;
        if (!exactGroups.has(groupKey)) {
            exactGroups.set(groupKey, {
                key,
                action: cfg.action,
                from: cfg.from,
                to: cfg.to,
                envs: [],
                details: [],
            });
        }
        const g = exactGroups.get(groupKey);
        const env = extractEnvFromDetail(cfg.detail);
        if (env && !g.envs.includes(env)) g.envs.push(env);
        if (cfg.detail) g.details.push(cfg.detail);
    }
    const phase1 = Array.from(exactGroups.values());

    // Phase 2 — merge rows that share key+action but differ in from/to
    const keyActionGroups = new Map();
    for (const g of phase1) {
        const mergeKey = `${g.key}||${g.action}`;
        if (!keyActionGroups.has(mergeKey)) {
            keyActionGroups.set(mergeKey, []);
        }
        keyActionGroups.get(mergeKey).push(g);
    }

    const result = [];
    for (const [, items] of keyActionGroups) {
        if (items.length <= 1) {
            // No merging needed
            result.push(items[0]);
            continue;
        }
        // Multiple rows for same key+action — merge into one with per-env values
        const allEnvs = [];
        const allDetails = [];
        const perEnvValues = [];
        for (const item of items) {
            for (const env of item.envs) {
                if (!allEnvs.includes(env)) allEnvs.push(env);
            }
            allDetails.push(...item.details);
            // Build per-env value entries
            if (item.envs.length > 0) {
                perEnvValues.push({
                    envs: item.envs,
                    from: item.from,
                    to: item.to,
                });
            } else {
                perEnvValues.push({
                    envs: [],
                    from: item.from,
                    to: item.to,
                    detail: item.details[0] || '',
                });
            }
        }
        result.push({
            key: items[0].key,
            action: items[0].action,
            from: null,  // varies
            to: null,     // varies
            envs: allEnvs,
            details: allDetails,
            perEnvValues,
        });
    }
    return result;
}

function ConfigChangesPanel({ repositories }) {
    // Extract config commits from all repos
    const repoConfigs = [];
    let totalChanges = 0;
    let totalCommits = 0;

    for (const [repoName, repoData] of Object.entries(repositories)) {
        const configCommits = (repoData.commits || []).filter(c => {
            const ct = c.summary?.changeType;
            return ct === 'config' || ct === 'mixed' || c.summary?.configChanges?.length > 0;
        });
        if (configCommits.length > 0) {
            repoConfigs.push({ repoName, commits: configCommits });
            totalCommits += configCommits.length;
            for (const c of configCommits) {
                totalChanges += (c.summary?.configChanges || []).filter(isRealChange).length;
            }
        }
    }

    if (repoConfigs.length === 0) {
        return (
            <div className="config-panel">
                <div className="config-empty">
                    No config or pilot flag changes today
                </div>
            </div>
        );
    }

    return (
        <div className="config-panel">
            <div className="config-panel-summary">
                {totalChanges} config change{totalChanges !== 1 ? 's' : ''} across {totalCommits} commit{totalCommits !== 1 ? 's' : ''}
            </div>
            {repoConfigs.map(({ repoName, commits }) => (
                <div key={repoName} className="repo-section">
                    <div className="repo-name">
                        {repoName}
                        <span className="repo-stats">
                            {commits.length} config commit{commits.length !== 1 ? 's' : ''}
                        </span>
                    </div>
                    {commits.map(commit => {
                        const s = commit.summary;
                        const changes = s.configChanges || [];
                        const grouped = groupConfigChanges(changes);
                        return (
                            <div key={commit.commitId} className="config-commit-card">
                                <div className="config-commit-header">
                                    <span className={`change-type-badge ${s.changeType || 'config'}`}>
                                        {s.changeType === 'mixed' ? '\u2699\uFE0F Mixed' : '\u2699\uFE0F Config'}
                                    </span>
                                    {commit.url ? (
                                        <a className="commit-sha" href={commit.url} target="_blank" rel="noopener noreferrer">
                                            {commit.shortId}
                                        </a>
                                    ) : (
                                        <span className="commit-sha">{commit.shortId}</span>
                                    )}
                                    <span className="config-commit-title">{s.title}</span>
                                    <span className="config-commit-author">{commit.author}</span>
                                </div>
                                {grouped.length > 0 ? (
                                    <table className="config-table">
                                        <colgroup>
                                            <col style={{ width: '20%' }} />
                                            <col style={{ width: '10%' }} />
                                            <col style={{ width: '35%' }} />
                                            <col style={{ width: '35%' }} />
                                        </colgroup>
                                        <thead>
                                            <tr>
                                                <th>Key</th>
                                                <th>Action</th>
                                                <th>Value Change</th>
                                                <th>Environments</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {grouped.map((g, i) => (
                                                <tr key={i}>
                                                    <td className="config-key-cell">{g.key}</td>
                                                    <td>
                                                        <span className={`config-action-badge ${ACTION_COLORS[g.action] || ''}`}>
                                                            {g.action}
                                                        </span>
                                                    </td>
                                                    <td className="config-from-to">
                                                        {g.perEnvValues ? (
                                                            <div className="config-per-env-values">
                                                                {g.perEnvValues.map((pev, k) => (
                                                                    <div key={k} className="config-per-env-row">
                                                                        <span className="config-per-env-label">
                                                                            {pev.envs.length > 0
                                                                                ? pev.envs.join(', ')
                                                                                : pev.detail || 'other'}
                                                                        </span>
                                                                        <span className="config-per-env-change">
                                                                            {g.action === 'removed' ? (
                                                                                <><span className="config-from">{pev.from || '—'}</span> &rarr; <span className="config-na">&mdash;</span></>
                                                                            ) : g.action === 'added' ? (
                                                                                <><span className="config-na">&mdash;</span> &rarr; <span className="config-to">{pev.to || '—'}</span></>
                                                                            ) : (
                                                                                <><span className="config-from">{pev.from || '?'}</span> &rarr; <span className="config-to">{pev.to || '?'}</span></>
                                                                            )}
                                                                        </span>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        ) : g.action === 'added' ? (
                                                            <><span className="config-na">&mdash;</span> &rarr; <span className="config-to">{g.to || '?'}</span></>
                                                        ) : g.action === 'removed' ? (
                                                            <><span className="config-from">{g.from || '?'}</span> &rarr; <span className="config-na">&mdash;</span></>
                                                        ) : (
                                                            <><span className="config-from">{g.from || '?'}</span> &rarr; <span className="config-to">{g.to || '?'}</span></>
                                                        )}
                                                    </td>
                                                    <td className="config-env-cell">
                                                        {g.envs.length > 0 ? (
                                                            <div className="config-env-tags">
                                                                {g.envs.map((env, j) => (
                                                                    <span key={j} className="config-env-tag">{env}</span>
                                                                ))}
                                                            </div>
                                                        ) : (
                                                            <span className="config-detail-cell">
                                                                {g.details[0] || ''}
                                                            </span>
                                                        )}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                ) : (
                                    <div className="config-no-details">
                                        Config-type commit (no structured changes extracted)
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            ))}
        </div>
    );
}

export default ConfigChangesPanel;
