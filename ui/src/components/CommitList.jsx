const RISK_ICON = { HIGH: '\uD83D\uDD34', MEDIUM: '\uD83D\uDFE1', LOW: '\uD83D\uDFE2' };
const CHANGE_TYPE_LABEL = { config: '\u2699\uFE0F Config', mixed: '\u2699\uFE0F Mixed', code: null };

function CommitList({ commits }) {
    return (
        <div className="commit-list">
            {commits.map(commit => {
                const s = commit.summary;
                const changeType = s.changeType || 'code';
                return (
                    <div key={commit.commitId} className={`commit-item risk-${s.riskLevel}`}>
                        <div className="commit-header">
                            <span className="risk-icon">{RISK_ICON[s.riskLevel] || '\u26AA'}</span>
                            {CHANGE_TYPE_LABEL[changeType] && (
                                <span className={`change-type-badge ${changeType}`}>
                                    {CHANGE_TYPE_LABEL[changeType]}
                                </span>
                            )}
                            {commit.url ? (
                                <a
                                    className="commit-sha"
                                    href={commit.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    {commit.shortId}
                                </a>
                            ) : (
                                <span className="commit-sha">{commit.shortId}</span>
                            )}
                            <span className="commit-title">{s.title}</span>
                        </div>
                        <div className="commit-meta">
                            {commit.author} &middot; {new Date(commit.date).toLocaleTimeString()}
                        </div>
                        <div className="commit-summary">{s.summary}</div>
                        {s.configChanges?.length > 0 && (
                            <div className="config-changes">
                                {s.configChanges.map((cfg, i) => (
                                    <div key={i} className="config-change-item">
                                        <span className="config-key">{cfg.key || cfg.name}</span>
                                        <span className="config-action">{cfg.action}</span>
                                        {cfg.detail && <span className="config-detail">{cfg.detail}</span>}
                                    </div>
                                ))}
                            </div>
                        )}
                        {(s.affectedAreas?.length > 0 || s.flags?.length > 0) && (
                            <div className="commit-tags">
                                {s.affectedAreas?.map(area => (
                                    <span key={area} className="area-tag">{area}</span>
                                ))}
                                {s.flags?.map(flag => (
                                    <span key={flag} className="flag-tag">{flag}</span>
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

export default CommitList;
