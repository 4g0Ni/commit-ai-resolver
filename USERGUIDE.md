# Commit AI Resolver — User Guide

## Overview

Commit AI Resolver fetches code commits from Azure DevOps repositories, uses an LLM (Azure OpenAI) to generate summaries and risk assessments, detects config/pilot flag changes, and presents everything in a React dashboard with LLM chat for incident investigation.

### Tracked Repositories

| Repository | Tag Strategy | Notes |
|---|---|---|
| AdsAppsCampaignUI | Date-sorted (`UnifiedUIDoubleRepoLKG.YYYYMMDD.NN`) | Campaign management UI |
| AdsAppsMT | Rolling named tags (`MT_STAGING` → `MT_LKG`) | Middle-tier services |
| AdsAppUI | Versioned (`sha-versioned.NNN`) | Ads Apps UI shell |

---

## Prerequisites

1. **Node.js** v18+
2. **Azure CLI** — logged in with `az login` (for ADO + Azure OpenAI auth)
3. **Install dependencies** (three package roots):
   ```bash
   cd src && npm install
   cd ../api && npm install
   cd ../ui && npm install
   ```

---

## Quick Start

### 1. Generate Daily Data

Fetches real commits from ADO, classifies/filters diffs, summarizes with LLM, and writes per-day JSON files to `data/daily/`.

```bash
cd src
node scripts/generate-sample-data.js --days 5
```

**Options:**
| Flag | Description |
|---|---|
| `--days N` | Number of weekdays to generate (default: 10) |
| `--force` | Regenerate all commits even if cached |

**Caching:** Previously summarized commits (by commitId) are loaded from existing JSON files and skipped. Error summaries are always re-attempted. Use `--force` to override.

**Parallelism:** LLM calls run 10 at a time per batch. Each day's JSON is written to disk after each repo completes, so partial results survive failures.

### 2. Generate Embeddings

Embeds all commit summaries into LanceDB for vector search. Required for the chat RAG pipeline.

```bash
cd src
node scripts/generate-embeddings.js
```

**Options:**
| Flag | Description |
|---|---|
| `--days N` | Only process last N days of data |
| `--force` | Re-embed all commits (needed after schema changes) |

Embeddings are stored in `data/lancedb/` (LanceDB embedded database). If you change the vector store schema, delete `data/lancedb/` and re-run with `--force`.

### 3. Start the Backend API

```bash
cd api
node server.js
```

Runs on `http://localhost:3001` with request logging (method, URL, status, duration):
| Endpoint | Description |
|---|---|
| `GET /api/days` | List available dates |
| `GET /api/days/:date` | Summary for a specific date |
| `GET /api/days?from=&to=` | Date range query |
| `POST /api/chat` | LLM chat with RAG vector search (body: `{ message, history }`) |
| `GET /api/vectors/stats` | Vector store stats (commit count, repos, date range) |

Chat requests log: query text, extracted filters, embedding time, search results count, LLM time, and token usage.

### 4. Start the Frontend

```bash
cd ui
npx vite --host
```

Runs on `http://localhost:5173` (or next available port).

---

## Vector Search & Smart Filters

The chat uses a **RAG pipeline**: embed your question → search LanceDB for matching commits → send only relevant commits to the LLM.

### Smart Query Filter Extraction

The API automatically extracts structured filters from natural language:

| Filter | What it detects | Examples |
|---|---|---|
| **Author** | First/last name matched against known commit authors | "what did Beina do", "show me Yi's changes" |
| **Repo** | Repository names and aliases | "CampaignUI changes", "what's new in appui" |
| **Date (explicit)** | ISO dates or "Month Day" format | "on March 30", "for 2026-04-02" |
| **Date (relative)** | Natural language time references | "today", "yesterday", "last 3 days", "this week" |

When any filter is active, the similarity threshold drops from 0.20 to 0.05, ensuring all matching commits are returned regardless of semantic relevance.

**Repo aliases:**
| Alias | Maps to |
|---|---|
| `campaignui`, `campaign ui`, `cmui` | AdsAppsCampaignUI |
| `adsappsmt`, `middle tier` | AdsAppsMT |
| `appui`, `ads app ui` | AdsAppUI |

---

## Testing

### Run E2E Tests

```bash
cd src
node tests/test-search-e2e.js
```

Requires LanceDB data (run `generate-embeddings.js` first) and API server on port 3001 for the full 13-suite test coverage:

| Suite | Tests | What it covers |
|---|---|---|
| 1. LanceDB health | 5 | DB connectivity, commit count, author fields |
| 2. Author filter | 3 | Returns ALL commits by a specific person |
| 3. Author case insensitivity | 3 | Lowercase, first-name-only matching |
| 4. Repo filter | 6 | Per-repo WHERE filtering |
| 5. Date range filter | 4 | Single day, multi-day ranges |
| 6. Combined filters | 2 | Author + repo together |
| 7. Semantic relevance | 10 | Domain queries (flags, risk, bugs, grid) |
| 8. Score ordering | 3 | Descending scores, valid range |
| 9. minScore threshold | 3 | Threshold filtering behavior |
| 10. Result shape | 12 | All fields present and typed correctly |
| 11. Edge cases | 4 | Unrelated queries, non-existent filters |
| 12. Chat API E2E | 6 | Full roundtrip chat queries |
| 13. API endpoints | 5 | GET/POST endpoints, 404 handling |

### Other Test Suites

```bash
# Unit tests for vector store (cosine similarity, dedup logic)
node tests/test-vector-store.js

# Integration tests with real embeddings
node tests/test-vector-search-integration.js
```

---

## Dashboard UI

The React dashboard has three main areas:

### Layout
```
┌──────────────────────────────────────────────────────────┐
│ Header — Commit AI Resolver                              │
├──────────────────────────────────────┬───────────────────┤
│ Toolbar (date range picker + repo    │                   │
│   filter)                            │                   │
│──────────────────────────────────────│   Chat Panel      │
│ Timeline Chart (stacked bar chart)   │   (LLM chat       │
│──────────────────────────────────────│    with markdown)  │
│ Metrics  │ Day Detail                │                   │
│ Sidebar  │ (commit list per repo     │                   │
│ (counts) │  with risk indicators)    │                   │
└──────────┴───────────────────────────┴───────────────────┘
```

### Features

- **Date Range Picker** — Select from/to dates with preset buttons (7/14/30 days)
- **Repo Filter** — Toggle which repos are visible (AdsAppsCampaignUI, AdsAppsMT, AdsAppUI)
- **Timeline Chart** — Stacked bar chart colored by risk level (red/yellow/green), with weekend markers. Click a bar to view that day's details.
- **Metrics Sidebar** — Vertical cards: Total Commits, Avg/Day, High/Medium/Low Risk, Config Changes, per-repo counts
- **Day Detail** — Commit list grouped by repo, each commit showing:
  - Risk indicator (🔴/🟡/🟢)
  - Change type badge (⚙️ Config / ⚙️ Mixed) for config changes
  - Commit SHA (linked to ADO), author, time
  - LLM-generated title and summary
  - Config changes list (key, action, detail)
  - Affected areas and feature flag tags
- **Chat Panel** — Ask questions about changes, investigate incidents. Responses rendered as markdown.

---

## Diff Filter System

Before sending diffs to the LLM, each commit's changed files are classified:

| Category | Action | Examples |
|---|---|---|
| **Ignored** | Completely skipped | `.snap`, `.png`, `.woff2`, `.Designer.cs` |
| **Auto-summarized** | LOW risk without LLM | `pnpm-lock.yaml`, `.min.js`, `.resx`, `.xlf`, `/dist/`, `.map` |
| **Needs diff** | Full diff sent to LLM | Everything else |

**Per-repo rules** in `src/services/diff-filter.js`:
- **CampaignUI:** `/loc/` dirs, `.resjson` files, generated string constants
- **MT:** `Generated` paths, `.dgml` files
- **AdsAppUI:** `/loc/` dirs, `.resjson` files

Commits with >50 files get file-list-only summary (no diff content). Max diff size: 200K chars.

To customize, edit `repoFilters` in `src/services/diff-filter.js`.

---

## LLM Configuration

| Setting | Location | Current Value |
|---|---|---|
| Azure OpenAI endpoint | `src/services/llm-helper.js` | `yizha-maz2xf24-swedencentral.openai.azure.com` |
| Model deployment | `src/services/llm-helper.js` | `gpt-5.4` |
| API version | `src/services/llm-helper.js` | `2025-04-01-preview` |
| Max completion tokens | `src/services/llm-helper.js` | `128000` |
| Retry attempts | `src/services/llm-helper.js` | `3` (exponential backoff) |
| Concurrency | `src/services/commit-summarizer.js` | `10` parallel LLM calls |
| ADO org | `src/config/repositories.js` | `msasg` |
| ADO project | `src/config/repositories.js` | `Bing_Ads` |

---

## Risk Level Criteria

| Level | Criteria |
|---|---|
| 🟢 LOW | Docs, tests, comments, lock files, version bumps, minor config |
| 🟡 MEDIUM | Business logic scoped to one feature, new pilot-gated code, API param changes |
| 🔴 HIGH | Shared infra, auth changes, DB schema, pilot ramp changes, removal of feature gates |

---

## Change Type Detection

Each commit is classified as one of:
| Type | Meaning |
|---|---|
| `code` | Pure code changes |
| `config` | Only config/pilot/flag/experiment changes |
| `mixed` | Both code and config changes |

Config changes include pilot flags, feature gates, experiment definitions, ramp percentages, dynamic config files (JSON/XML config files, files with names containing `config`, `pilot`, `flag`, `experiment`).

---

## Project Structure

```
commit-ai-resolver/
├── src/                              # Core backend / CLI
│   ├── index.js                      # CLI entry point
│   ├── config/
│   │   └── repositories.js           # Repo definitions and tag strategies
│   ├── scripts/
│   │   ├── generate-sample-data.js   # Generate daily summaries (cached, parallel)
│   │   ├── generate-embeddings.js    # Embed commit summaries into LanceDB
│   │   └── extend-sample-data.js     # Generate synthetic historical data
│   ├── services/
│   │   ├── ado-git-client.js         # Azure DevOps REST API client
│   │   ├── llm-helper.js             # Azure OpenAI client (retry, auth)
│   │   ├── commit-summarizer.js      # LLM summarization with diff filtering
│   │   ├── diff-filter.js            # File classification & skip rules
│   │   ├── vector-store.js           # LanceDB vector database (search, upsert, stats)
│   │   └── embedding-client.js       # Azure OpenAI text-embedding-3-large client
│   ├── tests/
│   │   ├── test-search-e2e.js        # E2E tests (74 tests, 13 suites)
│   │   ├── test-vector-store.js      # Unit tests for vector store
│   │   └── test-vector-search-integration.js  # Integration tests
│   └── package.json
├── api/                              # Express backend API
│   ├── server.js                     # REST endpoints + LLM chat + smart filters
│   └── package.json
├── ui/                               # React dashboard (Vite 5)
│   ├── src/
│   │   ├── App.jsx                   # Main layout (timeline + chat)
│   │   ├── App.css                   # Dark theme styles
│   │   ├── api.js                    # API client helpers
│   │   └── components/
│   │       ├── Timeline.jsx          # Orchestrator (toolbar + chart + detail)
│   │       ├── TimelineChart.jsx     # Stacked bar chart with weekend markers
│   │       ├── DayDetail.jsx         # Per-day commit detail view
│   │       ├── CommitList.jsx        # Commit cards with risk/config badges
│   │       ├── MetricsBoard.jsx      # Vertical metrics sidebar
│   │       ├── DateRangePicker.jsx   # Date range with presets
│   │       ├── RepoFilter.jsx        # Repository toggle filter
│   │       └── ChatBox.jsx           # LLM chat with markdown rendering
│   └── package.json
├── data/
│   ├── daily/                        # Generated daily JSON files
│   │   ├── index.json                # Dates index
│   │   └── YYYY-MM-DD.json          # Per-day commit summaries
│   ├── lancedb/                      # LanceDB vector database (auto-generated)
│   └── diffs/                        # LLM input diffs (for inspection)
├── README.md                         # Product specification
└── USERGUIDE.md                      # This file
```

---

## Adding a New Repository

Edit `src/config/repositories.js`:

```js
NewRepo: {
    name: 'NewRepo',
    project: ADO_PROJECT,
    defaultBranch: 'refs/heads/master',
    tagStrategy: 'dateSorted',     // or 'rolling' or 'versioned'
    tagPattern: 'tags/MyPrefix.',
    // For rolling strategy only:
    // releaseTags: { current: 'TAG_CURRENT', previous: 'TAG_PREVIOUS' },
},
```

Then add repo-specific filter rules in `src/services/diff-filter.js`:

```js
repoFilters.NewRepo = {
    autoSummary: [
        { pattern: /\/generated\//i, reason: 'auto-generated code' },
    ],
    ignore: [],
};
```

**Tag strategies:**
- `dateSorted` — Tags like `Prefix.YYYYMMDD.NN`, sorted by date+sequence
- `rolling` — Fixed names updated in-place (e.g. `MT_STAGING`, `MT_LKG`)
- `versioned` — Tags like `sha-versioned.329`, sorted by version number

---

## Authentication

All API calls use `DefaultAzureCredential` from `@azure/identity`:
- **Local dev:** Your `az login` session
- **Deployed:** Managed Identity

No PAT tokens needed.

---

## CLI Usage (Advanced)

From `src/`:

```bash
# Fetch commits between release tags
node index.js

# Specific repos
node index.js --repos AdsAppsCampaignUI,AdsAppsMT

# List release tags
node index.js --tags

# Latest N commits
node index.js --latest 20 --repos AdsAppsCampaignUI

# Summarize with LLM
node index.js --summarize --repos AdsAppsCampaignUI
```
