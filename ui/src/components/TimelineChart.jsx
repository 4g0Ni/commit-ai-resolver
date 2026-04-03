/**
 * TimelineChart — Stacked bar chart showing commit counts per day by risk level.
 * Clicking a bar selects that day to show details below.
 */

function TimelineChart({ dates, dayData, selectedDate, onSelect }) {
    // Sort dates chronologically (oldest → newest, left → right)
    const sortedDates = [...dates].sort();

    const MAX_BAR_HEIGHT = 120; // px

    // Find max commits in any single day for scaling
    const maxCommits = sortedDates.reduce((max, date) => {
        const data = dayData[date];
        return data ? Math.max(max, data.summary.totalCommits) : max;
    }, 1);

    return (
        <div className="chart-container">
            <div className="chart-header">
                <h2 className="chart-title">Daily Changes</h2>
                <div className="chart-legend">
                    <span className="legend-item"><span className="legend-dot high"></span>High</span>
                    <span className="legend-item"><span className="legend-dot medium"></span>Medium</span>
                    <span className="legend-item"><span className="legend-dot low"></span>Low</span>
                </div>
            </div>
            <div className="chart-bars">
                {sortedDates.map(date => {
                    const data = dayData[date];
                    if (!data) return null;
                    const { totalCommits, totalHigh, totalMedium, totalLow } = data.summary;
                    const isSelected = date === selectedDate;
                    const barHeight = Math.max((totalCommits / maxCommits) * MAX_BAR_HEIGHT, 6);

                    // Pixel heights for each segment
                    const highH = totalCommits > 0 ? (totalHigh / totalCommits) * barHeight : 0;
                    const medH = totalCommits > 0 ? (totalMedium / totalCommits) * barHeight : 0;
                    const lowH = totalCommits > 0 ? (totalLow / totalCommits) * barHeight : 0;

                    const dayOfWeek = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' });
                    const shortDate = date.substring(5); // MM-DD

                    return (
                        <div
                            key={date}
                            className={`chart-bar-wrapper ${isSelected ? 'selected' : ''}`}
                            onClick={() => onSelect(date)}
                        >
                            <div className="chart-bar-count">{totalCommits}</div>
                            <div className="chart-bar" style={{ height: `${barHeight}px` }}>
                                {totalHigh > 0 && (
                                    <div className="bar-segment high" style={{ height: `${highH}px` }}
                                         title={`${totalHigh} HIGH`} />
                                )}
                                {totalMedium > 0 && (
                                    <div className="bar-segment medium" style={{ height: `${medH}px` }}
                                         title={`${totalMedium} MEDIUM`} />
                                )}
                                {totalLow > 0 && (
                                    <div className="bar-segment low" style={{ height: `${lowH}px` }}
                                         title={`${totalLow} LOW`} />
                                )}
                            </div>
                            <div className="chart-bar-label">
                                <span className="chart-day">{dayOfWeek}</span>
                                <span className="chart-date">{shortDate}</span>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export default TimelineChart;
