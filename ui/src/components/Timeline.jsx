import { useState, useMemo } from 'react';
import DateRangePicker from './DateRangePicker';
import RepoFilter from './RepoFilter';
import MetricsBoard from './MetricsBoard';
import TimelineChart from './TimelineChart';
import DayDetail from './DayDetail';

function getDefaultRange() {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 6); // 7 days including today
    return {
        from: from.toISOString().substring(0, 10),
        to: to.toISOString().substring(0, 10),
    };
}

/** Collect all unique repo names from all day data. */
function getAllRepos(dayData) {
    const repos = new Set();
    for (const data of Object.values(dayData)) {
        if (data?.repositories) {
            for (const name of Object.keys(data.repositories)) repos.add(name);
        }
    }
    return [...repos].sort();
}

/** Filter a single day's data to only include selected repos + recalculate summary. */
function filterDayByRepos(data, selectedRepos) {
    if (!data) return data;
    const filtered = {};
    let totalCommits = 0, totalHigh = 0, totalMedium = 0, totalLow = 0, totalConfigChanges = 0;
    for (const [name, repo] of Object.entries(data.repositories)) {
        if (!selectedRepos.includes(name)) continue;
        filtered[name] = repo;
        totalCommits += repo.stats.total;
        totalHigh += repo.stats.high;
        totalMedium += repo.stats.medium;
        totalLow += repo.stats.low;
        totalConfigChanges += repo.stats.configChanges || 0;
    }
    return {
        ...data,
        repositories: filtered,
        summary: { ...data.summary, totalCommits, totalHigh, totalMedium, totalLow, totalConfigChanges },
    };
}

function Timeline({ dates, dayData }) {
    const defaultRange = getDefaultRange();
    const [fromDate, setFromDate] = useState(defaultRange.from);
    const [toDate, setToDate] = useState(defaultRange.to);

    const allRepos = useMemo(() => getAllRepos(dayData), [dayData]);
    const [selectedRepos, setSelectedRepos] = useState(allRepos);

    // Filter dates to selected range
    const filteredDates = useMemo(() => {
        return dates.filter(d => d >= fromDate && d <= toDate).sort();
    }, [dates, fromDate, toDate]);

    // Build repo-filtered dayData
    const filteredDayData = useMemo(() => {
        const out = {};
        for (const date of filteredDates) {
            out[date] = filterDayByRepos(dayData[date], selectedRepos);
        }
        return out;
    }, [filteredDates, dayData, selectedRepos]);

    // Default selection: today or most recent in range
    const sortedFiltered = [...filteredDates].sort().reverse();
    const [selectedDate, setSelectedDate] = useState(sortedFiltered[0] || null);

    // If selected date falls outside range, reset
    const effectiveSelected = filteredDates.includes(selectedDate) ? selectedDate : sortedFiltered[0] || null;

    const selectedData = effectiveSelected ? filteredDayData[effectiveSelected] : null;

    const handleRangeChange = (from, to) => {
        setFromDate(from);
        setToDate(to);
    };

    return (
        <div className="timeline">
            <div className="timeline-toolbar">
                <DateRangePicker
                    fromDate={fromDate}
                    toDate={toDate}
                    onChange={handleRangeChange}
                />
                <RepoFilter
                    allRepos={allRepos}
                    selectedRepos={selectedRepos}
                    onChange={setSelectedRepos}
                />
            </div>
            <MetricsBoard dates={filteredDates} dayData={filteredDayData} />
            <TimelineChart
                dates={filteredDates}
                dayData={filteredDayData}
                selectedDate={effectiveSelected}
                onSelect={setSelectedDate}
            />
            {selectedData ? (
                <DayDetail data={selectedData} />
            ) : (
                <div className="no-selection">
                    {filteredDates.length === 0
                        ? 'No data available for the selected date range'
                        : 'Select a day from the chart above to view details'}
                </div>
            )}
        </div>
    );
}

export default Timeline;
