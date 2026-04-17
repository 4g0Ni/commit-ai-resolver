import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { fetchReleases, fetchDayRange } from '../api';
import DateRangePicker from './DateRangePicker';
import RepoFilter from './RepoFilter';
import DashboardFilters from './DashboardFilters';
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

/** Filter commits within repos by risk level, change type, and author — recalculate stats. */
function filterDayByCommitFilters(data, { riskLevels, changeTypes, authorSearch }) {
    if (!data) return data;
    const filtered = {};
    let totalCommits = 0, totalHigh = 0, totalMedium = 0, totalLow = 0, totalConfigChanges = 0;

    for (const [name, repo] of Object.entries(data.repositories)) {
        const commits = repo.commits.filter(c => {
            const s = c.summary;
            if (!riskLevels.includes(s.riskLevel)) return false;
            const ct = s.changeType || 'code';
            if (!changeTypes.includes(ct)) return false;
            if (authorSearch && c.author !== authorSearch) return false;
            return true;
        });
        const high = commits.filter(c => c.summary.riskLevel === 'HIGH').length;
        const medium = commits.filter(c => c.summary.riskLevel === 'MEDIUM').length;
        const low = commits.filter(c => c.summary.riskLevel === 'LOW').length;
        const config = commits.filter(c => (c.summary.changeType || 'code') !== 'code').length;
        filtered[name] = {
            ...repo,
            commits,
            stats: { total: commits.length, high, medium, low, configChanges: config },
        };
        totalCommits += commits.length;
        totalHigh += high;
        totalMedium += medium;
        totalLow += low;
        totalConfigChanges += config;
    }

    return {
        ...data,
        repositories: filtered,
        summary: { ...data.summary, totalCommits, totalHigh, totalMedium, totalLow, totalConfigChanges },
    };
}

function Timeline({ dates }) {
    const defaultRange = getDefaultRange();
    const [fromDate, setFromDate] = useState(defaultRange.from);
    const [toDate, setToDate] = useState(defaultRange.to);

    // Day data loaded on demand per date range, with cache
    const [dayData, setDayData] = useState({});
    const [dataLoading, setDataLoading] = useState(false);
    const loadedRangeRef = useRef(null);

    // Load day data when date range changes
    const loadRangeData = useCallback(async (from, to) => {
        const rangeKey = `${from}:${to}`;
        if (loadedRangeRef.current === rangeKey) return;
        loadedRangeRef.current = rangeKey;
        setDataLoading(true);
        try {
            const results = await fetchDayRange(from, to);
            const dataMap = {};
            for (const day of results) {
                if (day?.date) dataMap[day.date] = day;
            }
            setDayData(prev => ({ ...prev, ...dataMap }));
        } catch (err) {
            console.error('Failed to load range data:', err);
        } finally {
            setDataLoading(false);
        }
    }, []);

    useEffect(() => {
        loadRangeData(fromDate, toDate);
    }, [fromDate, toDate, loadRangeData]);

    const allRepos = useMemo(() => getAllRepos(dayData), [dayData]);
    const [selectedRepos, setSelectedRepos] = useState([]);
    const [selectedRiskLevels, setSelectedRiskLevels] = useState(['HIGH', 'MEDIUM', 'LOW']);
    const [selectedChangeTypes, setSelectedChangeTypes] = useState(['code', 'config', 'mixed']);
    const [authorSearch, setAuthorSearch] = useState('');

    // Sync selectedRepos when allRepos changes (new repos appear after data loads)
    useEffect(() => {
        if (allRepos.length > 0 && selectedRepos.length === 0) {
            setSelectedRepos(allRepos);
        }
    }, [allRepos]);

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

    // Pre-author filtered data: apply repo, risk, and type filters (used to compute available authors)
    const preAuthorData = useMemo(() => {
        const out = {};
        for (const date of filteredDates) {
            const repoFiltered = filterDayByRepos(dayData[date], selectedRepos);
            out[date] = filterDayByCommitFilters(repoFiltered, {
                riskLevels: selectedRiskLevels,
                changeTypes: selectedChangeTypes,
                authorSearch: '',
            });
        }
        return out;
    }, [filteredDates, dayData, selectedRepos, selectedRiskLevels, selectedChangeTypes]);

    // Collect unique authors from pre-author-filtered data
    const availableAuthors = useMemo(() => {
        const authors = new Set();
        for (const data of Object.values(preAuthorData)) {
            if (!data?.repositories) continue;
            for (const repo of Object.values(data.repositories)) {
                for (const c of repo.commits) authors.add(c.author);
            }
        }
        return [...authors].sort();
    }, [preAuthorData]);

    // Build fully filtered dayData (including author filter)
    const filteredDayData = useMemo(() => {
        if (!authorSearch) return preAuthorData;
        const out = {};
        for (const date of filteredDates) {
            out[date] = filterDayByCommitFilters(preAuthorData[date], {
                riskLevels: selectedRiskLevels,
                changeTypes: selectedChangeTypes,
                authorSearch,
            });
        }
        return out;
    }, [preAuthorData, filteredDates, selectedRiskLevels, selectedChangeTypes, authorSearch]);

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

    const handleResetFilters = () => {
        setSelectedRiskLevels(['HIGH', 'MEDIUM', 'LOW']);
        setSelectedChangeTypes(['code', 'config', 'mixed']);
        setAuthorSearch('');
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
                <DashboardFilters
                    selectedRiskLevels={selectedRiskLevels}
                    onRiskLevelsChange={setSelectedRiskLevels}
                    selectedChangeTypes={selectedChangeTypes}
                    onChangeTypesChange={setSelectedChangeTypes}
                    authorSearch={authorSearch}
                    onAuthorSearchChange={setAuthorSearch}
                    availableAuthors={availableAuthors}
                    onReset={handleResetFilters}
                />
            </div>
            <TimelineChart
                dates={filteredDates}
                dayData={filteredDayData}
                selectedDate={effectiveSelected}
                onSelect={setSelectedDate}
            />
            <div className="timeline-body">
                {dataLoading && <div className="loading">Loading commits...</div>}
                <MetricsBoard dates={filteredDates} dayData={filteredDayData} />
                <div className="timeline-detail">
                    {selectedData ? (
                        <DayDetail data={selectedData} />
                    ) : (
                        <div className="no-selection">
                            {dataLoading
                                ? 'Loading...'
                                : filteredDates.length === 0
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
