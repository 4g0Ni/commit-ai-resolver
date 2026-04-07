/**
 * MetricsBoard — Summary metrics for the selected date range.
 */

function MetricsBoard({ dates, dayData }) {
    // Aggregate across all visible dates
    let totalCommits = 0, totalHigh = 0, totalMedium = 0, totalLow = 0, totalConfigChanges = 0;
    const repoTotals = {};

    for (const date of dates) {
        const data = dayData[date];
        if (!data) continue;
        totalCommits += data.summary.totalCommits;
        totalHigh += data.summary.totalHigh;
        totalMedium += data.summary.totalMedium;
        totalLow += data.summary.totalLow;
        totalConfigChanges += data.summary.totalConfigChanges || 0;

        for (const [name, repo] of Object.entries(data.repositories)) {
            if (!repoTotals[name]) repoTotals[name] = { commits: 0, high: 0 };
            repoTotals[name].commits += repo.stats.total;
            repoTotals[name].high += repo.stats.high;
        }
    }

    const avgPerDay = dates.length > 0 ? Math.round(totalCommits / dates.length) : 0;

    return (
        <div className="metrics-board">
            <div className="metric-card">
                <div className="metric-value">{totalCommits}</div>
                <div className="metric-label">Total Commits</div>
            </div>
            <div className="metric-card">
                <div className="metric-value">{avgPerDay}</div>
                <div className="metric-label">Avg / Day</div>
            </div>
            <div className="metric-card high">
                <div className="metric-value">{totalHigh}</div>
                <div className="metric-label">High Risk</div>
            </div>
            <div className="metric-card medium">
                <div className="metric-value">{totalMedium}</div>
                <div className="metric-label">Medium Risk</div>
            </div>
            <div className="metric-card low">
                <div className="metric-value">{totalLow}</div>
                <div className="metric-label">Low Risk</div>
            </div>
            {totalConfigChanges > 0 && (
                <div className="metric-card config">
                    <div className="metric-value">{totalConfigChanges}</div>
                    <div className="metric-label">Config Changes</div>
                </div>
            )}
            {Object.entries(repoTotals).map(([name, stats]) => (
                <div key={name} className="metric-card repo">
                    <div className="metric-value">{stats.commits}</div>
                    <div className="metric-label">{name.replace('AdsApps', '')}</div>
                    {stats.high > 0 && <div className="metric-sub">{stats.high} high</div>}
                </div>
            ))}
        </div>
    );
}

export default MetricsBoard;
