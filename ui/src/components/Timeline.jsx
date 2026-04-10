import { useState, useMemo, useEffect } from 'react';
import { fetchReleases } from '../api';
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

/** Extract YYYY-MM-DD from a build number like "#Prod-20260407..1". */
function extractDateFromBuildNumber(buildNumber) {
    const m = buildNumber?.match(/(\d{4})(\d{2})(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
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

    // --- Release mode state ---
    const [releaseMode, setReleaseMode] = useState(false);
    const [releases, setReleases] = useState([]);
    const [releasesLoading, setReleasesLoading] = useState(false);
    const [fromRelease, setFromRelease] = useState(null);
    const [toRelease, setToRelease] = useState(null);

    // Fetch releases lazily when release mode is first toggled on
    useEffect(() => {
        if (releaseMode && releases.length === 0 && !releasesLoading) {
            setReleasesLoading(true);
            fetchReleases()
                .then(setReleases)
                .catch(err => console.error('Failed to load releases:', err))
                .finally(() => setReleasesLoading(false));
        }
    }, [releaseMode]);

    const handleReleaseModeChange = (on) => {
        setReleaseMode(on);
        if (!on) {
            const d = getDefaultRange();
            setFromDate(d.from);
            setToDate(d.to);
            setFromRelease(null);
            setToRelease(null);
        }
    };

    const handleReleaseChange = (from, to) => {
        setFromRelease(from);
        setToRelease(to);
        if (from && to) {
            const fd = extractDateFromBuildNumber(from.build.buildNumber);
            const td = extractDateFromBuildNumber(to.build.buildNumber);
            if (fd && td) {
                setFromDate(fd <= td ? fd : td);
                setToDate(fd <= td ? td : fd);
            }
        }
    };

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
                    releaseMode={releaseMode}
                    onReleaseModeChange={handleReleaseModeChange}
                    releases={releases}
                    releasesLoading={releasesLoading}
                    fromRelease={fromRelease}
                    toRelease={toRelease}
                    onReleaseChange={handleReleaseChange}
                />
                <RepoFilter
                    allRepos={allRepos}
                    selectedRepos={selectedRepos}
                    onChange={setSelectedRepos}
                />
            </div>
            <TimelineChart
                dates={filteredDates}
                dayData={filteredDayData}
                selectedDate={effectiveSelected}
                onSelect={setSelectedDate}
            />
            <div className="timeline-body">
                <MetricsBoard dates={filteredDates} dayData={filteredDayData} />
                <div className="timeline-detail">
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
            </div>
        </div>
    );
}

export default Timeline;
