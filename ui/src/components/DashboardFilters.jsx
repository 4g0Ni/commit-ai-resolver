/**
 * DashboardFilters — Toggle buttons for risk level, change type, and searchable author dropdown.
 * Filters commits within repos (unlike RepoFilter which filters entire repos).
 */
import { useState, useRef, useEffect } from 'react';

const RISK_LEVELS = ['HIGH', 'MEDIUM', 'LOW'];
const CHANGE_TYPES = ['code', 'config', 'mixed'];

function AuthorDropdown({ value, onChange, authors }) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const ref = useRef(null);
    const inputRef = useRef(null);

    // Close on outside click
    useEffect(() => {
        if (!open) return;
        const handle = (e) => {
            if (ref.current && !ref.current.contains(e.target)) setOpen(false);
        };
        document.addEventListener('mousedown', handle);
        return () => document.removeEventListener('mousedown', handle);
    }, [open]);

    // Focus input when opened
    useEffect(() => {
        if (open && inputRef.current) inputRef.current.focus();
    }, [open]);

    const filtered = search
        ? authors.filter(a => a.toLowerCase().includes(search.toLowerCase()))
        : authors;

    const select = (author) => {
        onChange(author);
        setOpen(false);
        setSearch('');
    };

    return (
        <div className="author-dropdown" ref={ref}>
            <button
                className={`author-dropdown-trigger ${value ? 'has-value' : ''}`}
                onClick={() => { setOpen(!open); setSearch(''); }}
            >
                {value || `All authors (${authors.length})`}
                <span className="author-dropdown-arrow">{open ? '\u25B2' : '\u25BC'}</span>
            </button>
            {open && (
                <div className="author-dropdown-menu">
                    <input
                        ref={inputRef}
                        className="author-dropdown-search"
                        type="text"
                        placeholder="Search authors..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                    />
                    <div className="author-dropdown-list">
                        <div
                            className={`author-dropdown-item ${!value ? 'selected' : ''}`}
                            onClick={() => select('')}
                        >
                            All authors ({authors.length})
                        </div>
                        {filtered.map(author => (
                            <div
                                key={author}
                                className={`author-dropdown-item ${value === author ? 'selected' : ''}`}
                                onClick={() => select(author)}
                            >
                                {author}
                            </div>
                        ))}
                        {filtered.length === 0 && (
                            <div className="author-dropdown-empty">No matches</div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function DashboardFilters({
    selectedRiskLevels,
    onRiskLevelsChange,
    selectedChangeTypes,
    onChangeTypesChange,
    authorSearch,
    onAuthorSearchChange,
    availableAuthors = [],
    onReset,
}) {
    const toggleRisk = (level) => {
        if (selectedRiskLevels.includes(level)) {
            if (selectedRiskLevels.length > 1) {
                onRiskLevelsChange(selectedRiskLevels.filter(r => r !== level));
            }
        } else {
            onRiskLevelsChange([...selectedRiskLevels, level]);
        }
    };

    const toggleChangeType = (type) => {
        if (selectedChangeTypes.includes(type)) {
            if (selectedChangeTypes.length > 1) {
                onChangeTypesChange(selectedChangeTypes.filter(t => t !== type));
            }
        } else {
            onChangeTypesChange([...selectedChangeTypes, type]);
        }
    };

    const hasActiveFilters = selectedRiskLevels.length < 3
        || selectedChangeTypes.length < 3
        || authorSearch;

    return (
        <div className="dashboard-filters">
            <div className="filter-group">
                <span className="filter-label">Risk:</span>
                {RISK_LEVELS.map(level => (
                    <button
                        key={level}
                        className={`filter-btn risk-${level.toLowerCase()} ${selectedRiskLevels.includes(level) ? 'active' : ''}`}
                        onClick={() => toggleRisk(level)}
                    >
                        {level}
                    </button>
                ))}
            </div>
            <div className="filter-separator" />
            <div className="filter-group">
                <span className="filter-label">Type:</span>
                {CHANGE_TYPES.map(type => (
                    <button
                        key={type}
                        className={`filter-btn type-${type} ${selectedChangeTypes.includes(type) ? 'active' : ''}`}
                        onClick={() => toggleChangeType(type)}
                    >
                        {type}
                    </button>
                ))}
            </div>
            <div className="filter-separator" />
            <div className="filter-group">
                <span className="filter-label">Author:</span>
                <AuthorDropdown
                    value={authorSearch}
                    onChange={onAuthorSearchChange}
                    authors={availableAuthors}
                />
            </div>
            {hasActiveFilters && (
                <>
                    <div className="filter-separator" />
                    <button className="filter-reset-btn" onClick={onReset}>
                        Reset
                    </button>
                </>
            )}
        </div>
    );
}

export default DashboardFilters;
