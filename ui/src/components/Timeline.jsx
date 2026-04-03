import { useState } from 'react';
import DayCard from './DayCard';

const RISK_ICON = { HIGH: '\uD83D\uDD34', MEDIUM: '\uD83D\uDFE1', LOW: '\uD83D\uDFE2' };

function Timeline({ dates, dayData }) {
    const [expanded, setExpanded] = useState({});

    const toggle = (date) => {
        setExpanded(prev => ({ ...prev, [date]: !prev[date] }));
    };

    // Sort dates newest first
    const sortedDates = [...dates].sort().reverse();

    return (
        <div className="timeline">
            <h2 style={{ marginBottom: 8, fontSize: 16, color: 'var(--text-secondary)' }}>
                {sortedDates.length} days of change data
            </h2>
            {sortedDates.map(date => {
                const data = dayData[date];
                if (!data) return null;
                return (
                    <DayCard
                        key={date}
                        data={data}
                        expanded={!!expanded[date]}
                        onToggle={() => toggle(date)}
                    />
                );
            })}
        </div>
    );
}

export default Timeline;
