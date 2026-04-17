# Plan: Dashboard Filters + Chat Voting + SQLite Telemetry

## Context

The dashboard only has repo and date range filters — no way to filter by risk level, change type, or author. Chat responses have no feedback mechanism, and all pipeline traces are console-only with no persistence. This plan adds three features: (1) toolbar filters, (2) thumbs up/down voting, (3) SQLite telemetry DB to close the feedback loop.

---

## Phase 1: SQLite Telemetry DB (backend foundation)

### 1a. Install `better-sqlite3` in `api/`

```bash
cd api && npm install better-sqlite3
```

### 1b. Create `api/db.js` — schema + helpers

Tables:
- **`chat_queries`**: `id` (UUID PK), `query`, `response`, `confidence`, `iterations`, `search_method`, `result_count`, `iteration_log` (JSON), `work_item_id`, `work_item_title`, `created_at`
- **`chat_feedback`**: `id` (auto PK), `query_id` (FK → chat_queries), `vote` ('up'/'down'), `comment`, `voted_at`

Exports: `logQuery()`, `recordFeedback()`, `getFeedbackStats()`

DB path: `data/feedback.db`, WAL mode, foreign keys ON.

### 1c. Modify `api/server.js`

- Import `{ randomUUID }` from `crypto` and helpers from `./db.js`
- In `POST /api/chat`: generate `queryId`, call `logQuery()` after pipeline completes, include `queryId` in response JSON
- Add `POST /api/feedback` — validates `queryId` + `vote`, calls `recordFeedback()`. If FK fails (old queryId from localStorage), insert a stub `chat_queries` row from client-sent metadata, then retry.
- Add `GET /api/feedback/stats` — returns `{ total_queries, avg_confidence, thumbs_up, thumbs_down }`

### 1d. Add `data/feedback.db` to `.gitignore`

---

## Phase 2: Dashboard Filters (UI)

### 2a. Create `ui/src/components/DashboardFilters.jsx`

Three filter groups in one bar, following `RepoFilter.jsx` toggle-button pattern:

- **Risk Level**: HIGH / MEDIUM / LOW toggle buttons (multi-select, colored with `--risk-high/medium/low`)
- **Change Type**: code / config / mixed toggle buttons (multi-select)
- **Author**: text input with debounce (300ms), placeholder "Filter author..."
- Separators between groups (`filter-separator`)

Props: `selectedRiskLevels`, `onRiskLevelsChange`, `selectedChangeTypes`, `onChangeTypesChange`, `authorSearch`, `onAuthorSearchChange`

### 2b. Add `filterDayByCommitFilters()` in `Timeline.jsx`

New function that filters **commits within repos** (unlike `filterDayByRepos` which filters entire repos):

```javascript
function filterDayByCommitFilters(data, { riskLevels, changeTypes, authorSearch }) {
    // For each repo: filter commits by riskLevel, changeType, author substring
    // Recalculate repo.stats and data.summary from remaining commits
    // Keep repos even if 0 commits (for chart consistency)
}
```

### 2c. Wire into `Timeline.jsx`

- Add state: `selectedRiskLevels`, `selectedChangeTypes`, `authorSearch`
- Chain in `filteredDayData` useMemo: `filterDayByRepos` → `filterDayByCommitFilters`
- Render `<DashboardFilters />` in `.timeline-toolbar` after `<RepoFilter />`

### 2d. Add CSS to `ui/src/App.css`

- `.dashboard-filters` — flex row, same style as `.repo-filter`
- `.filter-group` — flex, gap, align-items center
- `.filter-btn.risk-high.active` etc. — risk-colored active states using rgba backgrounds
- `.author-search-input` — styled like date inputs
- `.filter-separator` — vertical line between groups

**No changes needed** to TimelineChart, MetricsBoard, DayDetail, or CommitList — they already consume `filteredDayData` and render whatever they receive.

---

## Phase 3: Thumbs Up/Down Voting (UI + API)

### 3a. Add `submitFeedback()` to `ui/src/api.js`

```javascript
export async function submitFeedback(queryId, vote, comment, metadata) { ... }
```

Posts to `POST /api/feedback` with queryId, vote, comment, and message metadata as fallback context.

### 3b. Create `ui/src/components/VoteFeedback.jsx`

Renders below each assistant message (not clarifications or investigations-in-progress):

- Two icon buttons: 👍 👎 (opacity 0.4 default, 1.0 when selected, 0.2 when other selected)
- On thumbs-down click: slide in a text input "What went wrong?" with Submit button
- On vote: call parent `onVote(vote, comment)`, fire-and-forget API call

### 3c. Modify `ChatBox.jsx`

- When creating assistant messages after API response, add `queryId` (from API response) and `metadata` snapshot
- Add `handleVote(messageIndex, vote, comment)` — updates message in state, calls `submitFeedback()`
- Render `<VoteFeedback />` after each assistant message (not clarification, not investigation)
- Vote state persists via existing localStorage `chat-history` mechanism

### 3d. Add CSS to `ui/src/App.css`

- `.vote-feedback` — flex row, border-top separator, small margin
- `.vote-btn` — no background, emoji, hover scale effect
- `.vote-btn.selected` / `.vote-btn.dimmed` — opacity states
- `.vote-comment` — slide-in input + submit button

---

## Files to Create/Modify

| File | Action | Feature |
|------|--------|---------|
| `api/db.js` | CREATE | Phase 1 — SQLite schema + helpers |
| `api/server.js` | EDIT | Phase 1+3 — queryId, logQuery, feedback endpoints |
| `api/package.json` | EDIT | Phase 1 — add better-sqlite3 |
| `.gitignore` | EDIT | Phase 1 — exclude data/feedback.db |
| `ui/src/components/DashboardFilters.jsx` | CREATE | Phase 2 — filter controls |
| `ui/src/components/Timeline.jsx` | EDIT | Phase 2 — filter state + pipeline |
| `ui/src/components/VoteFeedback.jsx` | CREATE | Phase 3 — voting UI |
| `ui/src/components/ChatBox.jsx` | EDIT | Phase 3 — vote integration |
| `ui/src/api.js` | EDIT | Phase 3 — submitFeedback helper |
| `ui/src/App.css` | EDIT | Phase 2+3 — styles |

---

## Verification

1. **Filters**: Start UI, select a day with mixed commits. Toggle HIGH off → HIGH commits disappear from chart, metrics, and detail. Type an author name → only their commits shown. Toggle "config" only → only config/mixed commits.
2. **Voting**: Send a chat query. Thumbs up → button highlights, API logged. Thumbs down → comment input appears, submit → both stored. Refresh page → vote state persists from localStorage.
3. **Telemetry**: After a few queries + votes, run `sqlite3 data/feedback.db "SELECT * FROM chat_queries"` and `"SELECT * FROM chat_feedback"` to verify data.
4. **Stats**: `GET /api/feedback/stats` returns correct counts.
