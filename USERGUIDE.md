# Commit AI Resolver — User Guide

## Overview

Commit AI Resolver fetches code commits from Azure DevOps repositories, uses an LLM (Azure OpenAI) to generate summaries and risk assessments, detects config/pilot flag changes, and presents everything in a React dashboard with LLM chat for incident investigation.

### Tracked Repositories

| Repository | Tag Strategy | Notes |
|---|---|---|
| AdsAppsCampaignUI | Date-sorted (`UnifiedUIDoubleRepoLKG.YYYYMMDD.NN`) | Campaign management UI |
| AdsAppsMT | Rolling named tags (`MT_STAGING` → `MT_LKG`) | Middle-tier services |
| AdsAppUI | Versioned (`sha-versioned.NNN`) | Ads Apps UI shell |
| AnB | Versioned (`tags/`) | Ads & Billing platform |
| AdsAppsDB | Versioned (`tags/`) | Database / data layer |

---

## Authentication

All API endpoints require authentication via **Microsoft Entra ID (Azure AD)**. Users sign in with their Microsoft corporate account.

### How It Works

1. Frontend uses `@azure/msal-browser` with redirect flow — user is redirected to Microsoft login, then back to the app
2. After sign-in, an **ID token** (JWT) is sent with every API request as a `Bearer` token
3. Backend validates the JWT signature against Microsoft's JWKS endpoint, checks audience (client ID) and issuer (tenant)
4. User identity (`preferred_username` / email) is extracted from the token and used for DAU/MAU tracking

### Session Persistence

MSAL caches tokens in `localStorage` with `storeAuthStateInCookie: true`, so users stay signed in across browser refreshes and tabs. No server-side session management needed.

### Azure App Registration

| Setting | Value |
|---|---|
| Client ID | `bc4d2d3c-b205-42f4-90f6-8bac756fd7f5` |
| Tenant ID | `72f988bf-86f1-41af-91ab-2d7cd011db47` |
| Platform | Single-page application |
| Redirect URI | `http://localhost:5173` (dev) |

**Important:** The redirect URI must be registered under the **Single-page application** platform type in the Azure portal (not "Web"), otherwise MSAL will get a `AADSTS9002326` cross-origin error.

### Config Files

- `ui/src/authConfig.js` — MSAL configuration (client ID, authority, cache settings, login scopes)
- `api/server.js` — JWT validation middleware (`authMiddleware`)

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

Embeds all commit summaries into LanceDB for vector search. Required for the chat RAG pipeline.

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

The rewritten `searchQuery` is embedded for vector similarity, while extracted filters become SQL WHERE clauses in LanceDB. When any filter is active, the similarity threshold drops to 0.05 (or 0.01 for author queries) to return all matching commits.

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
│   │   ├── generate-embeddings.js    # Embed commit summaries into LanceDB
│   │   └── extend-sample-data.js     # Generate synthetic historical data
│   ├── services/
│   │   ├── ado-git-client.js         # Azure DevOps REST API client (commits, diffs, work items, image extraction)
│   │   ├── llm-helper.js             # Azure OpenAI client (retry, auth)
│   │   ├── commit-summarizer.js      # LLM summarization with diff filtering
│   │   ├── diff-filter.js            # File classification & skip rules
│   │   ├── vector-store.js           # LanceDB vector database (search, upsert, stats)
│   │   ├── embedding-client.js       # Azure OpenAI text-embedding-3-large client
│   │   └── workitem-detector.js      # ADO work item URL detection
│   ├── tests/
│   │   ├── test-search-e2e.js        # E2E tests (74 tests, 13 suites)
│   │   ├── test-vector-store.js      # Unit tests for vector store
│   │   └── test-vector-search-integration.js  # Integration tests
│   └── package.json
├── api/                              # Express backend API
│   ├── server.js                     # REST endpoints + agentic chat pipeline
│   ├── db.js                         # SQLite telemetry DB (queries, feedback, usage metrics)
│   ├── agents/                       # Agentic search pipeline agents
│   │   ├── orchestrator.js           # Agent loop coordinator (max 3 iterations, multi-query RRF)
│   │   ├── intent-extractor.js       # Agent 1: Extract filters + confidence + self-validation
│   │   ├── extraction-analyzer.js    # (Legacy — functionality merged into intent-extractor)
│   │   ├── answer-synthesizer.js     # Agent 2: Generate ranked answer with commit links (multimodal)
│   │   └── answer-evaluator.js       # Agent 3: Rate answer quality, decide pass/retry
│   ├── telemetry/                    # Aria / 1DS telemetry
│   │   ├── aria-client.js            # 1DS SDK initialization
│   │   └── column-whitelist.js       # Event filtering (commitairesolver_tracing / commitairesolver_errors)
│   └── package.json
├── ui/                               # React dashboard (Vite 5)
│   ├── src/
│   │   ├── App.jsx                   # Main layout (timeline + chat + auth guard)
│   │   ├── App.css                   # Dark/light theme styles
│   │   ├── authConfig.js             # MSAL configuration (client ID, authority, instance)
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

## Deployment to Azure

The application deploys to a single Azure App Service that serves both the API and UI.

**Live URL:** https://commit-ai-resolver.azurewebsites.net

### Prerequisites

- **Azure CLI** — logged in with `az login`
- **Node.js** v18+
- UI built (`cd ui && npm run build`)

### Deploy Commands

```powershell
# Full deploy (first time — provisions resources + deploys)
.\deploy\deploy.ps1

# Redeploy code only (resources already exist)
.\deploy\deploy.ps1 -SkipProvision

# Redeploy without rebuilding (use existing package)
.\deploy\deploy.ps1 -SkipProvision -SkipBuild
```

### What Gets Deployed

The `deploy/prepare-api.ps1` script packages:
- `api/` — Express server, agents, telemetry
- `src/services/` and `src/config/` — business logic (symlinked from `/home/site/src`)
- `ui/dist/` — built React app (served as static files)
- `startup.sh` — container startup script (creates symlinks, starts server)

**Not included in the package:**
- `data/` — uploaded separately to `/home/data` via Kudu ZIP API (persists across redeployments)
- `node_modules/` — installed on the server by Oryx build

### Upload Data Files

Daily JSON files and the LanceDB vector store must be uploaded separately:

```powershell
$token = az account get-access-token --query accessToken -o tsv
Compress-Archive -Path data\* -DestinationPath data.zip
curl -X PUT "https://commit-ai-resolver.scm.azurewebsites.net/api/zip/data/" `
    -H "Authorization: Bearer $token" `
    -H "Content-Type: application/zip" `
    --data-binary "@data.zip"
```

### App Settings

Configure via Azure portal or CLI:

```powershell
az webapp config appsettings set --name commit-ai-resolver --resource-group commit-ai-resolver-rg --settings `
    "PORT=4399" `
    "AZURE_CLIENT_ID=<user-assigned-MI-client-id>" `
    "ARIA_INGESTION_TOKEN=<token>" `
    "SCM_DO_BUILD_DURING_DEPLOYMENT=true" `
    "WEBSITES_CONTAINER_START_TIME_LIMIT=300"
```

### Post-Deployment Checklist

1. Register `https://commit-ai-resolver.azurewebsites.net` as a redirect URI in the Azure AD app registration (Single-page application platform)
2. Add the user-assigned Managed Identity as a user in the ADO organization (for commit fetching)
3. Verify: `curl https://commit-ai-resolver.azurewebsites.net/` returns 200
4. Verify: navigate to the URL in a browser and sign in

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| 503 after deploy | Oryx build not triggered | Use `az webapp deployment source config-zip` (not `az webapp deploy --type zip`) |
| `Cannot find package 'dotenv'` | node_modules missing | Redeploy with `SCM_DO_BUILD_DURING_DEPLOYMENT=true` |
| `Cannot find module '../src/...'` | Symlink missing | Check `startup.sh` creates `ln -sfn "$DEPLOY_DIR/src" /home/site/src` |
| rsync path errors with backslashes | Windows zip tool | `prepare-api.ps1` uses .NET ZipFile with forward-slash normalization |
| ADO 401 errors in logs | MI not registered in ADO | Add MI service principal as user in ADO org settings |
| MSAL redirect error | Redirect URI not registered | Add production URL to Azure AD app registration |

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

All API calls use `DefaultAzureCredential` from `@azure/identity` for Azure OpenAI and ADO access:
- **Local dev:** Your `az login` session
- **Deployed:** Managed Identity

No PAT tokens needed.

**User authentication** uses Microsoft Entra ID via MSAL:
- Frontend: `@azure/msal-browser` + `@azure/msal-react` (redirect flow, localStorage cache)
- Backend: JWT validation middleware using `jsonwebtoken` + `jwks-rsa`
- All `/api` routes require a valid Bearer token (ID token from Microsoft)
- User email from the token is stored as `user_id` in SQLite for usage metrics

---

## CLI Usage (Advanced)

| Setting | Location | Current Value |
|---|---|---|
| Azure OpenAI endpoint | `services/llm-helper.js` | `chezh-m7lorxce-eastus2.openai.azure.com` |
| Model deployment | `services/llm-helper.js` | `gpt-4.1` |
| API version | `services/llm-helper.js` | `2025-01-01-preview` |
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
