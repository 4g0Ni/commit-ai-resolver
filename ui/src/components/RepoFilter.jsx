/**
 * RepoFilter — Toggle which repositories are visible in the dashboard.
 */

function RepoFilter({ allRepos, selectedRepos, onChange }) {
    const toggle = (repo) => {
        if (selectedRepos.includes(repo)) {
            // Don't allow deselecting all
            if (selectedRepos.length > 1) {
                onChange(selectedRepos.filter(r => r !== repo));
            }
        } else {
            onChange([...selectedRepos, repo]);
        }
    };

    const selectAll = () => onChange([...allRepos]);

    return (
        <div className="repo-filter">
            <span className="repo-filter-label">Repos:</span>
            {allRepos.map(repo => (
                <button
                    key={repo}
                    className={`repo-filter-btn ${selectedRepos.includes(repo) ? 'active' : ''}`}
                    onClick={() => toggle(repo)}
                    title={selectedRepos.includes(repo) ? `Hide ${repo}` : `Show ${repo}`}
                >
                    {repo.replace('AdsApps', '').replace('AdsApp', '')}
                </button>
            ))}
            {selectedRepos.length < allRepos.length && (
                <button className="repo-filter-btn all" onClick={selectAll}>All</button>
            )}
        </div>
    );
}

export default RepoFilter;
