const RISK_ICON = { HIGH: '\uD83D\uDD34', MEDIUM: '\uD83D\uDFE1', LOW: '\uD83D\uDFE2' };

function CommitList({ commits }) {
    return (
        <div className="commit-list">
            {commits.map(commit => {
                const s = commit.summary;
                return (
                    <div key={commit.commitId} className={`commit-item risk-${s.riskLevel}`}>
                        <div className="commit-header">
                            <span className="risk-icon">{RISK_ICON[s.riskLevel] || '\u26AA'}</span>
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
