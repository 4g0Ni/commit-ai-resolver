/**
 * DateRangePicker — Select a date range with presets, or switch to Release Mode
 * to pick from/to release builds instead.
 */

function DateRangePicker({
    fromDate, toDate, onChange,
    releaseMode, onReleaseModeChange,
    releases, releasesLoading,
    fromRelease, toRelease, onReleaseChange,
}) {
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

    const fromIdx = fromRelease ? releases.indexOf(fromRelease) : '';
    const toIdx = toRelease ? releases.indexOf(toRelease) : '';

    return (
        <div className="date-range-picker">
            {releaseMode ? (
                <div className="release-inputs">
                    {releasesLoading ? (
                        <span className="release-loading">Loading releases...</span>
                    ) : (
                        <>
                            <label>
                                From
                                <select
                                    value={fromIdx === '' ? '' : fromIdx}
                                    onChange={e => {
                                        const idx = parseInt(e.target.value, 10);
                                        onReleaseChange(
                                            isNaN(idx) ? null : releases[idx],
                                            toRelease
                                        );
                                    }}
                                >
                                    <option value="">Select release...</option>
                                    {releases.map((r, i) => (
                                        <option key={r.build.id} value={i}>
                                            {r.build.buildNumber}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <span className="date-separator">→</span>
                            <label>
                                To
                                <select
                                    value={toIdx === '' ? '' : toIdx}
                                    onChange={e => {
                                        const idx = parseInt(e.target.value, 10);
                                        onReleaseChange(
                                            fromRelease,
                                            isNaN(idx) ? null : releases[idx]
                                        );
                                    }}
                                >
                                    <option value="">Select release...</option>
                                    {releases.map((r, i) => (
                                        <option key={r.build.id} value={i}>
                                            {r.build.buildNumber}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        </>
                    )}
                </div>
            ) : (
                <>
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
                </>
            )}
        </div>
    );
}

export default DateRangePicker;
