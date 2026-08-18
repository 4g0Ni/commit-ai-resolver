# Commit AI Resolver — User Guide

## Overview

Commit AI Resolver reads commit data, uses an optional OpenAI-compatible LLM to generate summaries and risk assessments, detects config/pilot flag changes, and presents everything in a React dashboard with LLM chat for incident investigation.

### Tracked Repositories

| Repository | Tag Strategy | Notes |
|---|---|---|
| AdsAppsCampaignUI | Date-sorted (`UnifiedUIDoubleRepoLKG.YYYYMMDD.NN`) | Campaign management UI |
| AdsAppsMT | Rolling named tags (`MT_STAGING` → `MT_LKG`) | Middle-tier services |
| AdsAppUI | Versioned (`sha-versioned.NNN`) | Ads Apps UI shell |
| AnB | Versioned (`tags/`) | Ads & Billing platform |
| AdsAppsDB | Versioned (`tags/`) | Database / data layer |

---

## Local Access And Credentials

The dashboard, REST API, and MCP endpoint do not require user authentication. The browser does not acquire or send an ID token, and the backend does not validate JWTs or contact a Microsoft identity endpoint.

The server binds to `127.0.0.1` by default. This is intentional: an auth-free instance can expose commit summaries, chat history, and feedback data, so do not bind it to a public interface unless you add an access-control layer in front of it.

External integrations are optional and stay server-side:

| Configuration | Used for | Sent to |
|---|---|---|
| `OPENAI_API_KEY` | Chat, summarization, and embeddings | The configured OpenAI-compatible API only |
| `OPENAI_BASE_URL` | Self-hosted/OpenAI-compatible provider | The configured provider |
| `ADO_PAT` or `ADO_BEARER_TOKEN` | Live commit, work-item, and diff retrieval | Azure DevOps only |

No external credential is needed to browse existing files under `data/daily/` or inspect local metrics. Query and feedback history is stored locally in `data/feedback.db`.

---

## Connecting from MCP clients

The dashboard exposes the same commit data as an MCP server so you can query it directly from **GitHub Copilot CLI** (primary), Claude Desktop, Claude Code, or VS Code. The easiest way to connect is the **Connect MCP** button in the dashboard header.

### One-click setup (recommended)

1. Click **Connect MCP** in the dashboard header.
2. Click **Download setup-commit-resolver.ps1** in the modal.
3. In PowerShell, run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\setup-commit-resolver.ps1
   ```
   This wires the MCP server into GitHub Copilot CLI, Claude Desktop, Claude Code, and VS Code, and drops the `commit-resolver` skill into both `~/.copilot/skills` (Copilot CLI) and `~/.claude/skills` (Claude — transitional).
4. Restart your MCP client (quit and reopen Copilot CLI / Claude Desktop / Code / VS Code). In Copilot CLI you can also run `/skills reload`.
5. Invoke the skill — e.g. ask *"what changed in CMUI yesterday?"*. The local MCP endpoint connects directly without a sign-in flow.

### Direct download

If you don't have access to the dashboard, the same script is served at:
```
http://127.0.0.1:4399/install/setup-commit-resolver.ps1
```
The downloaded script is fully standalone — it pulls the skill files from the server on the fly, so you don't need to clone the repo.

### What the installer touches

The installer wires the MCP server into every supported client config it can find:
- `%USERPROFILE%\.copilot\mcp-config.json` (GitHub Copilot CLI — primary; respects `$COPILOT_HOME`)
- `%APPDATA%\Claude\claude_desktop_config.json` (Claude Desktop)
- `%USERPROFILE%\.claude\mcp.json` (Claude Code CLI — global)
- `%USERPROFILE%\.claude.json` under `projects.*.mcpServers` (Claude Code CLI per-project overrides — needed because per-project entries shadow the global config when working inside that directory)
- `%APPDATA%\Code\User\mcp.json` (and the Insiders variant if present)

It also drops the skill at `%USERPROFILE%\.copilot\skills\commit-resolver\` (Copilot CLI) and `%USERPROFILE%\.claude\skills\commit-resolver\` (Claude — transitional). Every modified file is backed up under `%USERPROFILE%\.commit-resolver-setup-state\` so `-Uninstall` can restore it.

### Access Model

The MCP endpoint is anonymous and local-only by default. It does not expose OAuth discovery, registration, authorize, or token proxy endpoints.

### Uninstall

```powershell
.\setup-commit-resolver.ps1 -Uninstall
```

This restores all backed-up MCP client configs and removes the skill bundle.

---

## Prerequisites

1. **Node.js** v20+
2. **Install dependencies** (three package roots):
   ```bash
   cd src && npm install
   cd ../api && npm install
   cd ../ui && npm install
   ```
3. **Optional AI:** set `OPENAI_API_KEY`, or set `OPENAI_BASE_URL` for a compatible local provider.
4. **Optional live ADO access:** set `ADO_PAT` or `ADO_BEARER_TOKEN`. This is not needed for existing local data.

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
| `--from DATE` | Start date YYYY-MM-DD (use with `--to` for a specific range) |
| `--to DATE` | End date YYYY-MM-DD |
| `--force` | Regenerate all commits even if cached |

**Examples:**
```bash
# Last 5 days
node scripts/generate-sample-data.js --days 5

# Force regenerate a specific date range
node scripts/generate-sample-data.js --from 2026-03-25 --to 2026-03-31 --force

# Just one day
node scripts/generate-sample-data.js --from 2026-04-01 --to 2026-04-01 --force
```

**Caching:** Previously summarized commits (by commitId) are loaded from existing JSON files and skipped. Error summaries are always re-attempted. Use `--force` to override.

**Parallelism:** LLM calls run 10 at a time per batch. Each day's JSON is written to disk after each repo completes, so partial results survive failures.

### 2. Generate Embeddings

Embeds all commit summaries into the local SQLite vector store. Required for the chat RAG pipeline.

```bash
cd src
node scripts/generate-embeddings.js
```

**Options:**
| Flag | Description |
|---|---|
| `--days N` | Only process last N days of data |
| `--from DATE` | Start date YYYY-MM-DD (inclusive) |
| `--to DATE` | End date YYYY-MM-DD (inclusive) |
| `--force` | Re-embed all commits (needed after schema changes) |

**Examples:**
```bash
# Incremental (only new commits)
node scripts/generate-embeddings.js

# Re-embed a specific date range
node scripts/generate-embeddings.js --from 2026-04-01 --to 2026-04-03 --force

# Force re-embed everything
node scripts/generate-embeddings.js --force
```

Embeddings are stored in `data/vectors.db` using `sqlite-vec`. If you change the vector schema, remove that database and re-run with `--force`.

### 3. Start the Backend API

```bash
cd api
node server.js
```

Runs on `http://127.0.0.1:4399` with request logging (method, URL, status, duration):
| Endpoint | Description |
|---|---|
| `GET /api/days` | List available dates |
| `GET /api/days/:date` | Summary for a specific date |
| `GET /api/days?from=&to=` | Date range query |
| `POST /api/chat` | LLM chat with RAG vector search (body: `{ message, history }`). Supports ADO work item URLs — automatically fetches bug context, extracts screenshots, and runs multi-query search. |
| `POST /api/investigate` | Deep diff investigation for suspect commits |
| `GET /api/metrics/usage` | Usage metrics dashboard (DAU/WAU/MAU, query volume, confidence, latency, feedback rates, retention) |
| `GET /api/vectors/stats` | Vector store stats (commit count, repos, date range) |

Chat requests log: query text, extracted filters, embedding time, search results count, LLM time, and token usage.

### 4. Start the Frontend

```bash
cd ui
npx vite --host
```

Runs on `http://localhost:5173` (or next available port).

---

## Vector Search & Agentic Search Pipeline

The chat uses an **agentic multi-step RAG pipeline** that iteratively refines queries for better results. Instead of a single-pass search, the system coordinates 3 LLM-based agents in a loop (max 3 iterations):

### Pipeline Flow

```
User Query (or ADO work item URL)
    │
    ├── (if URL) Fetch work item + extract screenshots
    │
    ├── Agent 1: Intent Extractor (+ self-validation)
    │       ↓
    ├── Multi-Query RAG Search (up to 3 queries + RRF fusion)
    │       ↓
    ├── Agent 2: Answer Synthesizer (+ bug screenshots)
    │       ↓
    └── Agent 3: Answer Evaluator
                │                          │
         (PASS/PARTIAL)              (RETRY → refine
          → return answer              query, loop back)
```

### Agent Roles

| Agent | Purpose | Output |
|---|---|---|
| **Intent Extractor** | Extracts structured filters (author, repo, dates, risk level, change type, search query, secondary search query) + confidence score + keywords. Self-validates quality (GOOD / ASK_USER). | JSON with filters + `confidence` 0–1 + `verdict` |
| **Answer Synthesizer** | Analyzes RAG results, ranks suspect commits, generates answer with commit links. Supports multimodal input (bug screenshots). | Markdown answer + confidence + coverage |
| **Answer Evaluator** | Rates answer quality and grounding. Decides: return to user (PASS/PARTIAL) or retry with different query (RETRY). | `PASS` / `RETRY` / `PARTIAL` |

### Clarification Flow

If your query is too vague (e.g., "something broke"), the system asks a follow-up question instead of guessing:

```
You: "something broke"
System: "🤔 Need more details — What broke, and roughly when did it start?
         If you know the affected feature/repo and whether it was an error,
         crash, UI issue, or regression, include that too."
You: "the campaign editor page is crashing since yesterday"
→ Pipeline resumes with enriched context
```

### Iteration Behavior

| Iteration | Strategy |
|---|---|
| 1 | Full pipeline with initial extraction + multi-query RRF search |
| 2 | Refine query with evaluator feedback (add keywords, adjust dates) |
| 3 | Best-effort return with disclaimer if needed |

The pipeline exits early when the Answer Evaluator scores quality ≥ 0.65 with ≥ 3 results (typically on iteration 1 for clear queries).

### API Response Format

The `POST /api/chat` response now includes agentic metadata:

```json
{
  "reply": "Based on the commits from March 27–29...",
  "type": "answer",           // "answer" or "clarification"
  "searchMethod": "agentic",  // "agentic", "fallback-full", or "full"
  "iterations": 1,            // Number of pipeline iterations used
  "confidence": 0.91,         // Answer confidence 0–1
  "suggestedActions": ["Check commit abc123", ...],
  "resultCount": 30,
  "suspects": [...],          // Top suspect commits for deep investigation
  "workItem": {               // Present when a work item URL was used
    "id": 10552393,
    "title": "The grid is missing for Products.",
    "url": "...",
    "type": "Bug",
    "state": "Active",
    "createdDate": "2026-04-07T..."
  }
}
```

For clarifications:
```json
{
  "reply": "Could you clarify which page or feature is affected?",
  "type": "clarification",
  "searchMethod": "agentic",
  "iterations": 1,
  "question": "Could you clarify which page or feature is affected?"
}
```

### LLM-Based Query Understanding

The Intent Extractor agent extracts:
- **author** — person name if asking about a specific person
- **repo** — exact repo name (recognizes aliases like "campaignui", "cmui", "appui", "uiserver", "anb", "ccdb", "ccmt", "client center db", "client center mt", "cmdb", "campaign db", "db", "adsappsdb")
- **dateFrom / dateTo** — date range (resolves "yesterday", "last week", "March 30", etc.)
- **searchQuery** — a rewritten query optimized for embedding search (filter terms stripped)
- **secondarySearchQuery** — a second, different semantic query for work item searches (different angle on the bug)
- **riskLevel** — filter by risk level (HIGH, MEDIUM, LOW) when explicitly requested
- **changeType** — filter by change type (code, config, mixed) when explicitly requested
- **keywords** — fallback keywords for text matching
- **confidence** — self-assessed extraction quality (0–1)
- **verdict** — self-validation: `GOOD` (proceed) or `ASK_USER` (request clarification)
- **ambiguities** — parts of the query that are unclear

The rewritten `searchQuery` is embedded for vector similarity, while extracted filters become SQL WHERE clauses in the SQLite metadata table. When any filter is active, the similarity threshold drops to 0.05 (or 0.01 for author queries) to return all matching commits.

**Multi-query search:** For work item queries, up to 3 separate searches are run (primary, secondary, bug title) and merged via Reciprocal Rank Fusion (RRF). The bug title gets a 5x weight because its natural language often has better semantic overlap with fix commits.

### Fallback Behavior

The pipeline gracefully degrades:
1. **Vector store + agentic** → Full 4-agent pipeline with iterative refinement
2. **Vector store + no results** → Falls back to full context stuffing
3. **No vector store** → Single-pass full context stuffing (original behavior)

---

## Testing

### Run E2E Tests

```bash
cd src
node tests/test-search-e2e.js
```

Requires `data/vectors.db` (run `generate-embeddings.js` first) and the API server on port 4399 for the full test coverage:

| Suite | Tests | What it covers |
|---|---|---|
| 1. Vector DB health | 5 | DB connectivity, commit count, author fields |
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
│ Header — Commit AI Resolver    [Metrics] [Feedback] 🌙   │
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
- **Repo Filter** — Toggle which repos are visible (AdsAppsCampaignUI, AdsAppsMT, AdsAppUI, AnB, AdsAppsDB)
- **Timeline Chart** — Stacked bar chart colored by risk level (red/yellow/green), with weekend markers. Click a bar to view that day's details.
- **Metrics Sidebar** — Vertical cards: Total Commits, Avg/Day, High/Medium/Low Risk, Config Changes, per-repo counts
- **Day Detail** — Commit list grouped by repo, each commit showing:
  - Risk indicator (🔴/🟡/🟢)
  - Change type badge (⚙️ Config / ⚙️ Mixed) for config changes
  - Commit SHA (linked to ADO), author, time
  - LLM-generated title and summary
  - Config changes list (key, action, detail)
  - Affected areas and feature flag tags
- **Chat Panel** — Ask questions about changes, investigate incidents. Responses rendered as markdown. **Resizable** — drag the left edge to adjust width (min 360px, max 1200px, default 560px). Width is persisted across page refreshes.
- **Theme Toggle** — Switch between dark and light themes (persisted in localStorage)
- **Metrics Dashboard** — Click "Metrics" in the header to open a usage dashboard showing: total/daily/weekly/monthly query counts, DAU/WAU/MAU, daily active users chart, confidence distribution, search method breakdown, feedback rates (positive/negative), latency percentiles (P50/P95), user engagement (retention rate, avg queries/user), and adoption summary (DAU/MAU ratio)
- **Feedback Panel** — Click "Feedback" in the header to view and submit thumbs-up/down feedback on chat responses

---

## Diff Filter System

Before sending diffs to the LLM, each commit's changed files are classified:

| Category | Action | Examples |
|---|---|---|
| **Ignored** | Completely skipped | `.snap`, `.png`, `.woff2`, `.Designer.cs` |
| **Auto-summarized** | LOW risk without LLM | `pnpm-lock.yaml`, `.min.js`, `.resx`, `.xlf`, `/dist/`, `.map` |
| **Needs diff** | Full diff sent to LLM | Everything else |

**Per-repo rules** in `src/services/diff-filter.js`:
- **CampaignUI:** `/loc/` dirs, `.resjson` files, generated string constants, `.cscfg`/`.csdef`/`Web.config` (deploy config only — pilots live in AdsAppUI)
- **MT:** `Generated` paths, `.dgml` files, `Datamart/`, `adf-prod/trigger/`, `agent/` (AI workflow), `.script` (SCOPE/Lens)
- **AdsAppUI:** `/loc/` dirs, `.resjson` files, `.cshtml` (Razor views)

Commits with >50 files get file-list-only summary (no diff content). Max diff size: 200K chars.

To customize, edit `repoFilters` in `src/services/diff-filter.js`.

---

## LLM Configuration

| Setting | Environment variable | Default |
|---|---|---|
| API key | `OPENAI_API_KEY` | unset (AI disabled) |
| Compatible endpoint | `OPENAI_BASE_URL` | OpenAI API |
| Quality model | `OPENAI_MODEL` | `gpt-4.1` |
| Fast model | `OPENAI_FAST_MODEL` | `gpt-4.1-mini` |
| Embedding model | `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-large` |
| Retry attempts | Code default | `3` with exponential backoff |
| Concurrency | Code default | `10` parallel summary calls |

---

### Get release build info by date

```bash
node index.js --releaseInfo 20260407
```

Looks up the release pipeline build (MAP WebUI Daily Shipping) matching the given date, retrieves the build timeline, and extracts source commit SHAs from the log tasks for AdsAppsCampaignUI and AdsAppUI.

Example output:

```
============================================================
Release Info for: 20260407
============================================================

  Build ID:     66926764
  Build Number: #Prod-20260407..1
  Status:       completed / succeeded
  Started:      2026-04-07T08:00:00Z
  Finished:     2026-04-07T09:30:00Z
  URL:          https://msasg.visualstudio.com/Bing_Ads/_build/results?buildId=66926764

  ----------------------------------------
  AdsAppsCampaignUI (Log AdsAppsCampaignUI):
    Source Commit:  abc1234def5678...
    Run ID:        66915346
    Source Branch:  refs/heads/master

  ----------------------------------------
  AdsAppUI (Log AdsAppUI_Release_WebUI):
    Source Commit:  9262bcae8749c6cc...
    Run ID:        66915346
    Source Branch:  refs/heads/master
```

### List recent release builds

```bash
node index.js --releaseList
```

Lists all release builds from the last 7 days in a table showing the release name, build ID, status, and the child build IDs for AdsAppsCampaignUI and AdsAppUI.

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

Config changes include pilot flags, feature gates, experiment definitions, ramp percentages, and dynamic config files (`Dynamic.config`, `DynamicConfig*.json`, `sharedfeatures.config`, `appsettings*.json`).

**Not classified as config:** Kubernetes/Helm infrastructure changes, agent/AI workflow files, Dependabot dependency bumps, build/deploy scripts, AKS packaging artifacts. Config keys use short flag names (e.g., `EnablePMaxLite`) not XPath paths.

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
│   │   ├── generate-embeddings.js    # Embed commit summaries into sqlite-vec
│   │   └── extend-sample-data.js     # Generate synthetic historical data
│   ├── services/
│   │   ├── ado-git-client.js         # Azure DevOps REST API client (commits, diffs, work items, image extraction)
│   │   ├── llm-helper.js             # OpenAI-compatible client and retry logic
│   │   ├── commit-summarizer.js      # LLM summarization with diff filtering
│   │   ├── diff-filter.js            # File classification & skip rules
│   │   ├── vector-store.js           # SQLite/sqlite-vec database (search, upsert, stats)
│   │   ├── embedding-client.js       # OpenAI-compatible embedding client
│   │   └── workitem-detector.js      # ADO work item URL detection
│   ├── tests/
│   │   ├── test-search-e2e.js        # E2E tests (74 tests, 13 suites)
│   │   ├── test-vector-store.js      # Unit tests for vector store
│   │   ├── test-vector-store.js       # Vector-store unit tests
│   │   └── test-vector-search-integration.js  # Integration tests
│   └── package.json
├── scripts/                          # CLI utilities
│   └── reset-and-refresh.js          # Reset data + backfill commits + rebuild embeddings
├── api/                              # Express backend API
│   ├── server.js                     # REST endpoints + agentic chat pipeline
│   ├── db.js                         # SQLite telemetry DB (queries, feedback, usage metrics)
│   ├── agents/                       # Agentic search pipeline agents
│   │   ├── orchestrator.js           # Agent loop coordinator (max 3 iterations, multi-query RRF)
│   │   ├── intent-extractor.js       # Agent 1: Extract filters + confidence + self-validation
│   │   ├── extraction-analyzer.js    # (Legacy — functionality merged into intent-extractor)
│   │   ├── answer-synthesizer.js     # Agent 2: Generate ranked answer with commit links (multimodal)
│   │   └── answer-evaluator.js       # Agent 3: Rate answer quality, decide pass/retry
│   └── package.json
├── ui/                               # React dashboard (Vite 5)
│   ├── src/
│   │   ├── App.jsx                   # Main layout (timeline + chat)
│   │   ├── App.css                   # Dark/light theme styles
│   │   ├── index.css                 # CSS custom properties (theme variables)
│   │   ├── api.js                    # API client helpers
│   │   └── components/
│   │       ├── Timeline.jsx          # Orchestrator (toolbar + chart + detail)
│   │       ├── TimelineChart.jsx     # Stacked bar chart with weekend markers
│   │       ├── DayDetail.jsx         # Per-day commit detail view
│   │       ├── CommitList.jsx        # Commit cards with risk/config badges
│   │       ├── MetricsBoard.jsx      # Vertical metrics sidebar
│   │       ├── DateRangePicker.jsx   # Date range with presets
│   │       ├── RepoFilter.jsx        # Repository toggle filter
│   │       ├── ChatBox.jsx           # LLM chat with markdown rendering
│   │       ├── FeedbackPanel.jsx     # User feedback overlay (thumbs up/down)
│   │       └── UsageMetrics.jsx      # Usage metrics dashboard (DAU/MAU, latency, feedback rates)
│   └── package.json
├── deploy/
│   ├── prepare-api.ps1               # Package API + UI + scripts into zip
│   └── setup-commit-resolver.ps1      # Configure local MCP clients
├── data/
│   ├── daily/                        # Generated daily JSON files
│   │   ├── index.json                # Dates index
│   │   └── YYYY-MM-DD.json          # Per-day commit summaries
│   ├── vectors.db                    # SQLite/sqlite-vec database (auto-generated)
│   └── diffs/                        # LLM input diffs (for inspection)
├── README.md                         # Product specification
├── USERGUIDE.md                      # This file
└── package.json                      # Root package.json (ESM: "type": "module")
```

---

## Deployment

This auth-free variant is intended for local use and binds to `127.0.0.1`. Do not expose it directly to the internet: the REST API, feedback history, and MCP tools have no user access control.

The scripts under `deploy/` are retained only as legacy project history. They target the former Azure environment and require separate Azure credentials; they are not part of the supported local startup path.

---

## Data Management (Reset / Refresh / Rebuild)

### Local CLI

```bash
# Reset all data + backfill 90 days of commits
node scripts/reset-and-refresh.js

# Backfill missing commits only (preserves existing summaries)
node scripts/reset-and-refresh.js --refresh-only --days 90

# Only reset data (no backfill)
node scripts/reset-and-refresh.js --reset-only

# Rebuild vector embeddings from existing daily JSON (no ADO fetch)
node scripts/reset-and-refresh.js --rebuild-embeddings

# Custom backfill window
node scripts/reset-and-refresh.js --days 60
```

### What Gets Cleared (Reset)

| Data | Location | Description |
|---|---|---|
| Daily JSON | `data/daily/*.json` | Commit summaries per day |
| Vector DB | `data/vectors.db` | Vector embeddings and commit metadata for RAG search |
| SQLite DB | `data/feedback.db` | Chat queries, feedback, usage metrics |
| Checkpoint | `data/refresh-checkpoint.json` | Last successful refresh timestamp per repo |
| Diffs cache | `data/diffs/` | Cached commit diffs |

### Refresh-Only Mode

Fetches commits day-by-day and performs **commit-level deduplication** — existing summaries and embeddings are preserved. Only new commits (not yet in daily JSON) are fetched from ADO, summarized by LLM, and embedded. Safe to run repeatedly.

### Rebuild Embeddings

Regenerates the SQLite vector store from existing daily JSON files without re-fetching from ADO. Use this after:
- Vector-store corruption
- Accidentally deleting `data/vectors.db`
- Changing the embedding schema

### Remote Server Management

Remote Azure management is not part of the auth-free local workflow. Use the local CLI commands above against a local `DATA_DIR`.

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

## External Integrations

The application has no end-user login. Optional provider credentials are read from environment variables by the server and never sent to the browser.

- `OPENAI_API_KEY` or `OPENAI_BASE_URL` enables AI and embedding calls.
- `ADO_PAT` or `ADO_BEARER_TOKEN` enables live Azure DevOps calls.
- `ENABLE_SCHEDULED_REFRESH=1` explicitly enables background refresh; it is off by default.
- Without these values, the dashboard and local-data APIs still start normally.

---

## CLI Usage (Advanced)

| Setting | Location | Current Value |
|---|---|---|
| OpenAI-compatible endpoint | `OPENAI_BASE_URL` | OpenAI API when unset |
| Quality model | `OPENAI_MODEL` | `gpt-4.1` |
| Fast model | `OPENAI_FAST_MODEL` | `gpt-4.1-mini` |
| ADO org | `config/repositories.js` | `msasg` |
| ADO project | `config/repositories.js` | `Bing_Ads` |
| Release pipeline ID | `config/repositories.js` | `66277` |
| Release log tasks | `config/repositories.js` | `Log AdsAppsCampaignUI`, `Log AdsAppUI_Release_WebUI` |
From `src/`:

```bash
# Fetch commits between release tags
node index.js

# Specific repos
node index.js --repos AdsAppsCampaignUI,AdsAppsMT,AnB

# List release tags
node index.js --tags

# Latest N commits
node index.js --latest 20 --repos AdsAppsCampaignUI

# Summarize with LLM
node index.js --summarize --repos AdsAppsCampaignUI
```
