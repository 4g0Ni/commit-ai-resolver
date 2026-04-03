import { useState } from 'react';
import TimelineChart from './TimelineChart';
import DayDetail from './DayDetail';

function Timeline({ dates, dayData }) {
    // Default to the most recent date
    const sortedDates = [...dates].sort().reverse();
    const [selectedDate, setSelectedDate] = useState(sortedDates[0] || null);

    const selectedData = selectedDate ? dayData[selectedDate] : null;

    return (
        <div className="timeline">
            <TimelineChart
                dates={dates}
                dayData={dayData}
                selectedDate={selectedDate}
                onSelect={setSelectedDate}
            />
            {selectedData ? (
                <DayDetail data={selectedData} />
            ) : (
                <div className="no-selection">Select a day from the chart above to view details</div>
            )}
        </div>
    );
}

export default Timeline;
