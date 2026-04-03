/**
 * DateRangePicker — Select a date range with presets.
 * Default: last 7 days ending today.
 */

function DateRangePicker({ fromDate, toDate, onChange }) {
    const today = new Date().toISOString().substring(0, 10);

    const presets = [
        { label: 'Last 7 days', days: 7 },
        { label: 'Last 14 days', days: 14 },
        { label: 'Last 30 days', days: 30 },
    ];

    const getPresetRange = (days) => {
        const to = today;
        const from = new Date();
        from.setDate(from.getDate() - days + 1);
        return { from: from.toISOString().substring(0, 10), to };
    };

    const activePreset = presets.find(p => {
        const r = getPresetRange(p.days);
        return r.from === fromDate && r.to === toDate;
    });

    return (
        <div className="date-range-picker">
            <div className="date-inputs">
                <label>
                    From
                    <input
                        type="date"
                        value={fromDate}
                        max={toDate}
                        onChange={e => onChange(e.target.value, toDate)}
                    />
                </label>
                <span className="date-separator">→</span>
                <label>
                    To
                    <input
                        type="date"
                        value={toDate}
                        min={fromDate}
                        max={today}
                        onChange={e => onChange(fromDate, e.target.value)}
                    />
                </label>
            </div>
            <div className="date-presets">
                {presets.map(p => (
                    <button
                        key={p.days}
                        className={`preset-btn ${activePreset?.days === p.days ? 'active' : ''}`}
                        onClick={() => {
                            const r = getPresetRange(p.days);
                            onChange(r.from, r.to);
                        }}
                    >
                        {p.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

export default DateRangePicker;
