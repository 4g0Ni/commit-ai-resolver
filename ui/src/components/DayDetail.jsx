/**
 * DayDetail — Full commit detail view for a selected day.
 * Shows repo sections with commit lists.
 */

import CommitList from './CommitList';

function DayDetail({ data }) {
    const { date, summary, repositories } = data;
    const dayOfWeek = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' });

    return (
        <div className="day-detail">
            <div className="day-detail-header">
                <div className="day-detail-title">
                    <h2>{dayOfWeek}, {date}</h2>
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
            </div>
            <div className="day-detail-body">
                {Object.entries(repositories).map(([repoName, repoData]) => (
                    <div key={repoName} className="repo-section">
                        <div className="repo-name">
                            {repoName}
                            <span className="repo-stats">
                                {repoData.stats.total} commits
                                {repoData.stats.high > 0 && ` \u00B7 ${repoData.stats.high} HIGH`}
                                {repoData.stats.medium > 0 && ` \u00B7 ${repoData.stats.medium} MED`}
                            </span>
                        </div>
                        <CommitList commits={repoData.commits} />
                    </div>
                ))}
            </div>
        </div>
    );
}

export default DayDetail;
