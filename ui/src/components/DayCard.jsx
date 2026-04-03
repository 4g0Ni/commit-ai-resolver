import CommitList from './CommitList';

function DayCard({ data, expanded, onToggle }) {
    const { date, summary, repositories } = data;

    const dayOfWeek = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' });

    return (
        <div className="day-card">
            <div className="day-card-header" onClick={onToggle}>
                <div className="day-date">
                    <span className={`expand-icon ${expanded ? 'expanded' : ''}`}>&#9654;</span>
                    {dayOfWeek} {date}
                </div>
                <div className="day-stats">
                    <span className="stat-badge total">{summary.totalCommits} commits</span>
                    {summary.totalHigh > 0 && (
                        <span className="stat-badge high">{summary.totalHigh} HIGH</span>
                    )}
                    {summary.totalMedium > 0 && (
                        <span className="stat-badge medium">{summary.totalMedium} MED</span>
                    )}
                    {summary.totalLow > 0 && (
                        <span className="stat-badge low">{summary.totalLow} LOW</span>
                    )}
                </div>
            </div>
            {expanded && (
                <div className="day-card-body">
                    {Object.entries(repositories).map(([repoName, repoData]) => (
                        <div key={repoName} className="repo-section">
                            <div className="repo-name">
                                {repoName}
                                <span className="repo-stats">
                                    {repoData.stats.total} commits
                                    {repoData.stats.high > 0 && ` \u00B7 ${repoData.stats.high} HIGH`}
                                </span>
                            </div>
                            <CommitList commits={repoData.commits} />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

export default DayCard;
