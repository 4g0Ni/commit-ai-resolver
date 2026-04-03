import { useState, useMemo } from 'react';
import DateRangePicker from './DateRangePicker';
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

function Timeline({ dates, dayData }) {
    const defaultRange = getDefaultRange();
    const [fromDate, setFromDate] = useState(defaultRange.from);
    const [toDate, setToDate] = useState(defaultRange.to);

    // Filter dates to selected range
    const filteredDates = useMemo(() => {
        return dates.filter(d => d >= fromDate && d <= toDate).sort();
    }, [dates, fromDate, toDate]);

    // Default selection: today or most recent in range
    const sortedFiltered = [...filteredDates].sort().reverse();
    const [selectedDate, setSelectedDate] = useState(sortedFiltered[0] || null);

    // If selected date falls outside range, reset
    const effectiveSelected = filteredDates.includes(selectedDate) ? selectedDate : sortedFiltered[0] || null;

    const selectedData = effectiveSelected ? dayData[effectiveSelected] : null;

    const handleRangeChange = (from, to) => {
        setFromDate(from);
        setToDate(to);
    };

    return (
        <div className="timeline">
            <DateRangePicker
                fromDate={fromDate}
                toDate={toDate}
                onChange={handleRangeChange}
            />
            <MetricsBoard dates={filteredDates} dayData={dayData} />
            <TimelineChart
                dates={filteredDates}
                dayData={dayData}
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
