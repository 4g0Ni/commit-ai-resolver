# Commit AI Resolver — Product Specification

## 1. Overview

**Commit AI Resolver** is an LLM-powered daily change tracking and regression diagnosis system. It automatically collects, summarizes, and indexes daily code changes and configuration diffs across multiple repositories, then exposes a React dashboard with an interactive LLM chat interface that enables engineers to quickly correlate production incidents with recent deployments.

### Implementation Status

| Component | Status | Notes |
|---|---|---|
| ADO Git integration (commits, diffs, tags) | ✅ Done | 3 tag strategies supported |
| LLM commit summarization | ✅ Done | GPT-5.4, 10x parallel, retry, diff filtering |
| Config/pilot change detection | ✅ Done | changeType + configChanges fields |
| React dashboard | ✅ Done | Dark/light theme, chart, filters, metrics, usage dashboard |
| LLM chat interface | ✅ Done | Markdown rendering, context-aware |
| Vector search (RAG) | ✅ Done | LanceDB embedded vector DB, text-embedding-3-large, LLM-based query intent extraction, multi-query RRF fusion |
| Work item integration | ✅ Done | Paste ADO work item URL → fetch bug → extract screenshots → anchor search dates |
| Daily data generation (cached) | ✅ Done | Incremental, skip cached commits, --from/--to date range |
| Azure deployment | ✅ Done | Single App Service (API + UI), Managed Identity, Oryx build |
| C2C Cosmos DB pilot tracker | 🚫 Removed (low ROI) | DB-level pilot ramp tracking — descoped |
| Queryable storage | ✅ Done | Daily JSON files + LanceDB vector store (filtered queries via vector store SQL pre-filters on author/repo/date) |

### Repositories in Scope

| Repository | Domain | Tag Strategy | Status |
|---|---|---|---|
| AdsAppsCampaignUI | Campaign management UI | Date-sorted | ✅ Active |
| AdsAppsMT | Middle-tier services | Rolling | ✅ Active |
| AdsAppUI | Ads Apps UI shell | Versioned | ✅ Active |
| AnB | Ads & Billing platform | Versioned | ✅ Active |
| AdsAppsDB | Database / data layer | Versioned | ✅ Active |

---

## 2. Goals

1. **Automated daily change reports** — Generate a per-day summary of every code commit and config change across all tracked repositories.
2. **Pilot flag & dynamic config tracking** — Detect additions, modifications, and removals of feature flags and dynamic configs that could alter production or SI behavior.
3. **LLM-powered root cause analysis** — Allow engineers to describe an incident (latency regression, page crash, error spike) and have the model correlate it against recent changes to suggest probable causes.
4. **Reduce MTTR** — Shorten the time DRI on-call and performance investigators spend manually reviewing commits and config diffs.

---

## 3. Data Collection — Two Pillars

### 3.1 Pillar 1: Pilot Flags & Dynamic Config Changes

#### What to Track

- **Feature pilot flags** — Any flag added, removed, or whose ramp percentage / ring changed.
- **Dynamic configs** — Key-value configuration entries that control runtime behavior in both UI and MT layers.

#### Current Implementation (Code-Level Detection)

Each commit diff is analyzed by the LLM to detect config changes. The summarizer classifies every commit as:
- `code` — Pure code changes
- `config` — Only changes to pilot flags, feature gates, experiment definitions, ramp percentages, or configuration files
- `mixed` — Both code and config changes

For `config` and `mixed` commits, a `configChanges` array captures each flag/config key with its action (added/modified/removed) and a brief description. Config keys use **short flag names** (e.g., `NewGoogleLoginGSI`) rather than XPath paths.

**What IS a config change:**
- Pilot flag additions, removals, or ramp percentage changes
- Feature gate / experiment definition changes
- `Dynamic.config`, `DynamicConfig*.json`, `sharedfeatures.config`, `appsettings*.json` value changes
- `.cscfg` / `.csdef` / `Web.config` pilot/flight settings (AdsAppUI only)

**What is NOT a config change:**
- Kubernetes / Helm infrastructure (`helm-*.yaml`, `values.yaml`, AKS packaging)
- Agent / AI workflow files (`agent/*.json`, `agent/*.md`)
- Dependabot dependency version bumps
- Build/deploy scripts and CI pipeline config

#### Diff Filtering (Noise Reduction)

Before sending diffs to the LLM, files are classified by `src/services/diff-filter.js`:

| Category | Action | Examples |
|---|---|---|
| **Ignored** | Dropped entirely | `.snap`, `.png`, `.woff2`, `.Designer.cs` |
| **Auto-summarized** | LOW risk, no LLM call | Lock files, `.min.js`, `.resx`, `.xlf`, `/dist/`, `.map` |
| **Needs diff** | Full diff sent to LLM | Everything else |

Per-repo custom rules exist for CampaignUI (localization, deploy config), MT (generated code, agent/AI workflows, Datamart, SCOPE scripts), and AdsAppUI (localization, Razor views). Commits with >50 files get file-list-only summaries.

#### Planned: C2C Cosmos DB Pilot Ramp Tracker

- Read pilot ramp data from the C2C campaign database replicated to Cosmos DB.
- For each pilot ID, capture:
  - Number of **customer-level** pilot changes (added / removed / modified)
  - Number of **account-level** pilot changes
  - Current ramp **percentage** and delta from previous snapshot
  - Pilot ID and display name
  - Snapshot timestamp
- Compare today's Cosmos snapshot against yesterday's to detect:
  - New pilots ramped up (0% → N%)
  - Pilots ramped to 100% (full rollout)
  - Pilots ramped down or killed (N% → 0%)
  - Incremental ramp changes (e.g., 10% → 50%)
- This source captures **runtime pilot changes that happen outside of code deployments** — e.g., a pilot ramped via the experimentation portal without any PR.

#### Why It Matters

Flag flips and config changes can alter production behavior **without any code deployment**. They are a frequent root cause of latency regressions and unexpected errors. The C2C/Cosmos source is especially critical because DB-level pilot ramps (customer/account granularity) are invisible in code diffs — they can silently change behavior for a large percentage of traffic.

---

### 3.2 Pillar 2: Code Commit Changes per Release

#### Current Implementation

All commits merged to `master` are fetched per-day via the ADO REST API v7.1 `fetchCommitsBetweenDates` endpoint.

#### Per-Commit Processing Pipeline

For each commit, the system:

1. **Fetches the changed files list** (cheap ADO API call) via `fetchCommitChanges`.
2. **Classifies files** using `diff-filter.js` — ignored / auto-summarized / needs-diff.
3. **Skips LLM entirely** for commits where all files are auto-classifiable (instant LOW risk).
4. **Fetches diffs only for relevant files** — skips lock files, assets, generated code.
5. **LLM summarization** (10x parallel, 3 retries with exponential backoff) — produces:
   - Concise title (one line)
   - Detailed summary paragraph
   - Risk assessment: `LOW` / `MEDIUM` / `HIGH`
   - Change type: `code` / `config` / `mixed`
   - Config changes array (key, action, detail)
   - Affected areas and feature flags
6. **Captures metadata:** SHA, author, date, message, URL
7. **Caches results** — existing commit summaries in JSON files are reused unless `--force` is specified

---

## 4. Daily Report

Daily reports are stored as JSON files in `data/daily/YYYY-MM-DD.json`, generated by `src/scripts/generate-sample-data.js`.

### JSON Structure

```json
{
  "date": "2026-04-02",
  "repositories": {
    "AdsAppsCampaignUI": {
      "repo": "AdsAppsCampaignUI",
      "commits": [
        {
          "commitId": "...",
          "shortId": "8c4b796e",
          "author": "...",
          "date": "...",
          "url": "...",
          "summary": {
            "title": "...",
            "summary": "...",
            "riskLevel": "MEDIUM",
            "affectedAreas": ["Scope Bar", "Campaign Dropdown"],
            "flags": ["IsRenameHotelToLodgingEnabled"],
            "changeType": "code",
            "configChanges": []
          }
        }
      ],
      "stats": { "total": 65, "high": 2, "medium": 35, "low": 28, "configChanges": 5 }
    },
    "AdsAppsMT": { "..." : "..." },
    "AdsAppUI": { "..." : "..." },
    "AnB": { "..." : "..." },
    "AdsAppsDB": { "..." : "..." }
  },
  "summary": {
    "totalCommits": 98,
    "totalHigh": 8,
    "totalMedium": 56,
    "totalLow": 34,
    "totalConfigChanges": 30,
    "reposIncluded": ["AdsAppsCampaignUI", "AdsAppsMT", "AdsAppUI", "AnB", "AdsAppsDB"]
  }
}
```

### Dashboard Visualization

The React dashboard renders daily reports as:

- **Stacked bar chart** — One bar per day, segments colored by risk level, clickable
- **Vertical metrics sidebar** — Aggregate counts with color-coded borders
- **Commit detail view** — Per-repo sections with full commit cards, config badges, and flag tags
- **Date range picker** — Filter to 7/14/30 day windows
- **Repo filter** — Toggle individual repos on/off
- **Usage metrics dashboard** — Query volume, DAU/WAU/MAU, confidence distribution, feedback rates, latency percentiles, retention, and adoption metrics

---

## 5. Use Cases

### 5.1 Use Case 1: Latency Regression Investigation

**Persona:** Performance engineer / DRI

**Scenario:** A page's load latency has spiked from 3 s to 14 s starting ~4 days ago.

**Workflow:**

1. User opens the LLM chat interface.
2. User provides:
   - Affected page / scenario name
   - Time period of regression (e.g., "started around March 27")
   - Metric details (e.g., P50 latency went from 3 s → 14 s)
3. The system:
   - Looks up daily reports for the stated period **plus a 2-day buffer** (releases can take up to 2 days to reach production).
   - Filters for changes related to the affected page — by file path, component name, flag name.
   - Ranks candidate changes by relevance and risk level.
4. LLM returns:
   - A ranked list of suspect changes (commits and/or flag flips) with links.
   - For each suspect: why it might be related (code path overlap, timing match, risk level).
   - Suggested next steps (revert flag, cherry-pick revert, deeper profiling).

### 5.2 Use Case 2: DRI On-Call — Beta Prod Error / Page Crash

**Persona:** DRI on-call engineer

**Scenario:** A manual tester reports a page crash or error on beta-prod (newly shipped code not yet flipped to full production).

**Workflow:**

1. User opens the LLM chat interface.
2. User provides:
   - Error message or crash signature
   - Page / feature area affected
   - Beta-prod ring and approximate time observed
3. The system:
   - Identifies today's (or most recent) release and its included commits.
   - Searches commit summaries for changes touching the affected area.
   - Cross-references any recent pilot flag changes that may have enabled new code paths.
4. LLM returns:
   - Most likely root-cause commit(s) with PR links.
   - Assessment of cherry-pick urgency (is this blocking? what's the blast radius?).
   - Steps to validate (e.g., "disable flag X in SI and reproduce").

### 5.3 Use Case 3: Daily Change Review (Proactive)

**Persona:** Team lead / engineering manager

**Scenario:** Quick daily standup preparation — understand what shipped yesterday.

**Workflow:**

1. User asks: "What shipped yesterday across all repos?"
2. System returns the daily report summary with high-risk items highlighted.

### 5.4 Use Case 4: Incident Postmortem Support

**Persona:** Incident response team

**Scenario:** Building a timeline for a postmortem — need to identify exactly which change caused an outage and when it reached production.

**Workflow:**

1. User provides the incident time window.
2. System returns a chronological timeline of all deployments and config changes within that window, annotated with LLM analysis of relevance.

---

## 6. System Architecture — Work Breakdown

> **Parent Task:** [10544035 — Commit AI Resolver](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544035)

### 6.1 Data Collection Layer

| Work Item | Description | ADO |
|---|---|---|
| Git integration | Connect to each repo's Azure DevOps API. Fetch commits between release tags. Reference: [DRIAgent ADO handlers](https://msasg.visualstudio.com/Bing_Ads/_git/B2BCrawler/pullrequest/5444356?path=/projects/DRIAgent/src/app/ado-handlers.js&_a=files) | [10544142](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544142) |
| Release tag resolver | For each repo, determine today's release tag and yesterday's release tag. Map commits to release windows. | [10544144](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544144) |
| Diff fetcher | Retrieve full diffs per commit. Apply noise filters (lock files, proxy files, configurable globs). | [10544145](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544145) |
| Flag/config differ | Identify flag and dynamic config definition files per repo. Compute structured diffs (added / changed / removed). | [10544146](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544146) |
| C2C Cosmos DB pilot ramp tracker | Read pilot ramp data from C2C campaign database replicated to Cosmos DB. Compare daily snapshots to detect ramp changes. | [10544147](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544147) |

### 6.2 Data Processing Pipeline

| Work Item | Description | ADO |
|---|---|---|
| LLM summarization | For each commit diff (post-filtering), call the LLM to produce title, summary, and risk tag. | [10544150](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544150) |
| Flag change annotator | For each flag/config diff, produce a human-readable change description and impact assessment. | [10544151](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544151) |
| Deduplication | Handle merge commits, revert-then-re-merge, and cherry-picks without double-counting. | [10544152](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544152) |
| Noise filter engine | Configurable rules to skip or condense known-noisy files (lock files, generated code, etc.). | [10544153](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544153) |
| Batching & rate limiting | Manage LLM API token budgets. Batch small diffs, chunk large ones. | [10544154](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544154) |

### 6.3 Data Storage & Ingestion

#### Storage Strategy: Queryable DB (recommended) vs. JSON Files

| Approach | Pros | Cons |
|---|---|---|
| **JSON files (Blob Storage)** | Simple to generate; easy to version/diff; no DB setup | No real-time filtering; must load entire day to query one repo; poor for cross-day queries |
| **DB tables (Azure SQL / CosmosDB)** | Real-time filtered queries (by repo, change type, date range, author, risk level); supports the chat RAG layer efficiently; scales with indexes | Requires schema design and DB ops |
| **Hybrid: DB + JSON archive** | DB for live queries; JSON snapshots for backup, sharing, and LLM context hydration | Two write targets to maintain |

**Recommendation:** Use a **queryable DB as the primary store** with optional JSON export per day for archival / sharing. The core use cases (e.g., "show me only pilot config changes from AdsAppsCampaignUI this week") require filtered queries that flat files cannot support efficiently.

#### Proposed DB Tables

| Table | Key Columns | Purpose |
|---|---|---|
| `daily_commits` | `date`, `repo`, `commit_sha`, `pr_id`, `author`, `title`, `summary`, `risk_level`, `files_changed`, `pr_link`, `merge_timestamp` | Code commit summaries |
| `pilot_flag_changes` | `date`, `repo`, `flag_key`, `old_value`, `new_value`, `source` (code / cosmos), `commit_sha`, `pr_link`, `author` | Code-level flag diffs |
| `pilot_ramp_changes` | `date`, `pilot_id`, `pilot_name`, `customer_count_delta`, `account_count_delta`, `old_percentage`, `new_percentage`, `snapshot_timestamp` | C2C/Cosmos DB-level pilot ramp changes |
| `dynamic_config_changes` | `date`, `repo`, `config_key`, `old_value`, `new_value`, `commit_sha`, `pr_link`, `author` | Dynamic config diffs |
| `daily_reports` | `date`, `repo`, `report_json`, `summary_md` | Full assembled report per repo-day (for LLM context hydration and export) |

#### Query Examples

```sql
-- Pilot config changes from AdsAppsCampaignUI only
SELECT * FROM pilot_flag_changes
WHERE repo = 'AdsAppsCampaignUI' AND date = '2026-03-30';

-- All high-risk commits across repos for a date range
SELECT * FROM daily_commits
WHERE risk_level = 'HIGH' AND date BETWEEN '2026-03-25' AND '2026-03-31';

-- Pilot ramps that changed by more than 10% (DB-level)
SELECT * FROM pilot_ramp_changes
WHERE ABS(new_percentage - old_percentage) > 10 AND date = '2026-03-30';
```

#### Work Items

| Work Item | Description | ADO |
|---|---|---|
| DB schema design | Define tables, indexes (date + repo composite), and column types. | [10544158](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544158) |
| Storage provisioning | Set up Azure SQL or CosmosDB with appropriate throughput and retention policy. | [10544159](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544159) |
| Ingestion pipeline | Orchestrate: collect → process → write to DB. Scheduled daily (e.g., Azure Functions timer trigger or ADO pipeline). | [10544160](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544160) |
| JSON export (optional) | Nightly job to export each day's data as a JSON snapshot to Blob Storage for archival. | [10544162](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544162) |
| Backfill tooling | Ability to re-run historical dates to rebuild DB rows after schema changes or LLM prompt improvements. | [10544163](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544163) |
| Query API | REST or GraphQL API layer on top of the DB to serve the dashboard and chat RAG layer. | [10544165](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544165) |

### 6.4 Data Visualization

| Work Item | Description | ADO |
|---|---|---|
| Date chart / timeline UI | Calendar or timeline view showing daily change counts, risk indicators, and drill-down. | [10544188](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544188) |
| Daily report detail view | Rendered Markdown or HTML page per day with full commit summaries and flag diffs. | [10544194](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544194) |
| Filtering & search | Filter by repo, author, risk level, date range, keyword. | [10544198](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544198) |
| Dashboard metrics | Aggregate views: commits/day trend, flag change frequency, high-risk change heatmap. Usage metrics dashboard with DAU/WAU/MAU, feedback rates, latency percentiles, retention, and adoption metrics. | [10544202](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544202) |

### 6.5 LLM Chat Integration

| Work Item | Description | ADO |
|---|---|---|
| Chat interface | Web-based chat UI for engineers to describe incidents and ask questions. Supports pasting ADO work item URLs for automatic bug context fetching. | [10544301](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544301) |
| Retrieval layer (RAG) | Given a user query, retrieve relevant daily report segments by date range, repo, page/component keywords. Apply the 2-day release buffer automatically. Multi-query RRF fusion for work item searches. | [10544206](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544206) |
| Prompt engineering | System prompts that instruct the model to correlate user-described symptoms with retrieved change data and produce ranked suspect lists with links. | [10544208](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544208) |
| Context window management | Handle large report windows (multiple days × multiple repos) within token limits — summarize or paginate as needed. | [10544209](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544209) |
| Response formatting | Structured output: ranked suspects, links, risk assessment, suggested next steps. | [10544210](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544210) |

### 6.6 Vector Search & Embedding (RAG)

#### Architecture

The chat interface uses a **Retrieval-Augmented Generation (RAG)** pipeline to avoid stuffing all commit summaries into the LLM context window. Instead, the user's query is embedded and matched against pre-computed commit embeddings via cosine similarity.

```
User Query
    │
    ├──── LLM Intent Extraction ──┐
    │     (extract author, repo,  │
    │      date range, rewritten  │
    │      search query + secondary│
    │      query via LLM)          │
    ▼                             ▼
┌─────────────────┐     ┌───────────────────┐
│  Embed Queries   │────▶│  LanceDB Search   │
│  (text-embed-   │     │  (cosine + WHERE  │
│   3-large)      │     │   pre-filters)    │
└─────────────────┘     └───────────────────┘
                                │
            Up to 3 parallel searches:
            1. Primary query (weight 1)
            2. Secondary query (weight 1)
            3. Bug title verbatim (weight 5)
                                │
                                ▼
                        ┌───────────────────┐
                        │  RRF Fusion       │
                        │  Merge & re-rank  │
                        └───────────────────┘
                                │
                                ▼
                        ┌───────────────────┐
                        │  Build Context    │
                        │  (top 30-50       │
                        │   commits)        │
                        └───────────────────┘
                                │
                                ▼
                        ┌───────────────────┐
                        │  LLM Chat         │
                        │  (GPT-5.4)        │
                        │  + bug screenshots│
                        │  (multimodal)     │
                        └───────────────────┘
```

#### LLM-Based Query Intent Extraction

The chat API uses a lightweight LLM pre-processing call to extract structured filters from natural language queries. This replaces the previous regex-based approach which was fragile (e.g., "changes" falsely matching author "Chang").

The LLM extracts a JSON object with:
- `author` — person name if the query is about a specific person's commits
- `repo` — exact repo name if mentioned (recognizes aliases like "campaignui", "cmui", "uiserver", "anb", "ccdb", "ccmt", "client center db", "client center mt", "cmdb", "campaign db", "db", "adsappsdb")
- `dateFrom` / `dateTo` — date range if time is mentioned (resolves relative dates like "last week", "yesterday")
- `searchQuery` — a rewritten version optimized for embedding similarity search (stripped of filter terms)
- `secondarySearchQuery` — a second, different semantic query focusing on fix mechanisms (only for work item queries). Uses different terms than the primary query to bridge the semantic gap between bug descriptions and fix commits.
- `riskLevel` — filter by risk level (HIGH, MEDIUM, LOW) when explicitly requested
- `changeType` — filter by change type (code, config, mixed) when explicitly requested
- `keywords` — fallback keywords for text matching (3-6 terms)
- `confidence` — self-assessed extraction quality (0-1)
- `verdict` — self-validation result: `GOOD` (proceed) or `ASK_USER` (request clarification). Replaces the separate Extraction Analyzer agent.

When any filter is active, `minScore` is lowered to 0.05 so filtering dominates over semantic ranking. Author queries use `minScore` 0.01 for maximum recall.

**Secondary queries bypass metadata filters** (riskLevel, changeType) via `broadSearchOpts` to cast a wider net and avoid filtering out relevant commits with different metadata classifications.

#### Components

| Component | File | Description |
|---|---|---|
| Embedding client | `src/services/embedding-client.js` | Azure OpenAI `text-embedding-3-large` client (3072 dimensions), uses `DefaultAzureCredential`, same endpoint as the LLM |
| Vector store | `src/services/vector-store.js` | LanceDB embedded vector DB (`data/lancedb/`). Cosine similarity search with SQL pre-filtering on author, repo, and date columns. Post-filters on riskLevel and changeType metadata. Pre-filter limit scales up for filtered queries (`topK * 5` or 200) |
| Work item detector | `src/services/workitem-detector.js` | Detects ADO work item IDs from URL patterns in user messages |
| ADO Git client | `src/services/ado-git-client.js` | Azure DevOps REST API client. Fetches commits, diffs, and work items. Extracts and fetches images from work item HTML fields (Description, ReproSteps) |
| Embedding generator | `src/scripts/generate-embeddings.js` | Reads daily JSON files, builds searchable text per commit, generates embeddings in batches of 16, upserts into vector store. Incremental (skips already-embedded commits) |
| Chat API (RAG) | `api/server.js` | LLM intent extraction → embeds optimized search query → multi-query LanceDB search with RRF fusion → sends relevant commits + bug screenshots as LLM context. Falls back to full-context if no vector store. Embedding LRU cache (100 entries) |

#### Embedding Model

- **Model:** `text-embedding-3-large` (3072 dimensions)
- **API version:** `2023-05-15`
- **Endpoint:** Same Azure OpenAI resource as the LLM
- **Auth:** `DefaultAzureCredential` (Azure AD token)

#### Text Representation per Commit

Each commit is embedded as a concatenation of:
- Date and repository name
- LLM-generated title and summary
- Risk level and author
- Affected areas, feature flags, config changes

#### Usage

```bash
# Generate embeddings for all daily data (incremental)
cd src && node scripts/generate-embeddings.js

# Re-embed last 7 days
node scripts/generate-embeddings.js --days 7

# Re-embed a specific date range
node scripts/generate-embeddings.js --from 2026-03-25 --to 2026-03-31 --force

# Force re-embed everything
node scripts/generate-embeddings.js --force
```

#### Fallback Behavior

The chat API gracefully degrades:
1. **Vector store available + results found** → RAG path (top-20 semantically relevant commits)
2. **Vector store available but no results** → Falls back to full context stuffing
3. **No vector store** → Full context stuffing (original behavior)

---

## 7. Pipeline Flow

```
┌─────────────┐     ┌──────────────┐     ┌────────────────┐
│  Scheduled   │────▶│  Data        │────▶│  LLM           │
│  Trigger     │     │  Collection  │     │  Summarization  │
│  (daily)     │     │  (Git + ADO) │     │  Pipeline       │
└─────────────┘     └──────────────┘     └────────────────┘
                                                 │
                                                 ▼
                    ┌──────────────┐     ┌────────────────┐
                    │  Storage     │◀────│  Report        │
                    │  (DB/Blob)   │     │  Assembly      │
                    └──────────────┘     └────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
     ┌──────────────┐ ┌─────────┐ ┌──────────┐
     │  Date Chart  │ │  Chat   │ │  API     │
     │  Dashboard   │ │  (RAG)  │ │  Access  │
     └──────────────┘ └─────────┘ └──────────┘
```

---

## 8. Key Design Decisions to Make

| Decision | Options to Evaluate |
|---|---|
| LLM provider | Azure OpenAI (GPT-4o) / GitHub Models / self-hosted |
| Storage | CosmosDB / Azure SQL / Blob Storage + Search index |
| Orchestration | Azure Functions (timer) / ADO Pipeline / GitHub Actions |
| Chat framework | Copilot SDK / custom RAG app / Teams bot |
| Visualization | Custom React app / Power BI / Grafana |
| Release tag strategy | Git tags / ADO release definitions / build numbers per repo |
| Noise filter config | Repo-level `.commitairc` file / central config |
| Auth & access control | ~~Entra ID / existing internal auth~~ | ✅ Done — Microsoft Entra ID via MSAL |

---

## 9. Non-Functional Requirements

- **Latency:** Daily pipeline must complete within 30 minutes for all repos.
- **Freshness:** Reports available by 9 AM local time for previous day's changes.
- **Accuracy:** LLM summaries must be grounded in actual diff content — no hallucinated changes.
- **Scalability:** Support adding new repositories without pipeline changes (config-driven).
- **Cost:** Optimize LLM token usage — filter noise before sending to LLM, cache repeated patterns.
- **Reliability:** Pipeline failures should alert and auto-retry. Partial failures (one repo down) should not block others.

---

## 10. Success Metrics

| Metric | Target |
|---|---|
| Mean time to identify suspect commit (via chat) | < 5 minutes (vs. 30–60 min manual) |
| Daily report coverage | 100% of commits across all 5 repos |
| False positive rate in suspect ranking | < 30% of top-3 suggestions |
| DRI adoption | 80% of on-call incidents use the tool within 3 months |
| Pipeline reliability | > 99% daily completion rate |
| User engagement (DAU/MAU ratio) | Tracked via usage metrics dashboard (user identity from Entra ID) |
| Feedback positive rate | Tracked via usage metrics dashboard |
| User retention rate | Tracked via usage metrics dashboard |

---

## 11. Agentic Search Flow (Multi-Step Query Pipeline)

### 11.1 Motivation

The current search flow uses an agentic loop with multi-query search: extract intent → multi-query embed → vector search with RRF fusion → LLM answer → evaluate → retry if needed. This handles:

- Vague or ambiguous queries ("something broke last week") — asks for clarification
- Work item URL input — fetches bug context, anchors dates, runs 3 parallel searches
- Intent extraction with self-validation — no separate analyzer agent needed
- Answer quality evaluation with iterative refinement

### 11.2 Architecture Overview

```
                          ┌─────────────────────────────────┐
                          │         User Query               │
                          │   (or ADO work item URL)          │
                          └────────────┬────────────────────┘
                                       │
                            (if URL detected, fetch work item
                             + extract screenshots from HTML)
                                       │
                          ┌────────────▼────────────────────┐
                          │   Agent 1: Intent Extractor      │
                          │   (extract filters + search      │
                          │    query + secondary query        │
                          │    + self-validation)             │
                          └──────┬───────────┬──────────────┘
                                 │           │
                        ┌────────▼──┐   ┌────▼──────────────┐
                        │  GOOD     │   │  ASK_USER          │
                        │           │   │  → return           │
                        │           │   │  clarification      │
                        │           │   │  question to user   │
                        └────┬──────┘   └───────────────────┘
                             │
                          ┌──▼──────────────────────────────┐
                          │   Multi-Query RAG Search          │
                          │   1. Primary query (weight 1)     │
                          │   2. Secondary query (weight 1)   │
                          │   3. Bug title search (weight 5)  │
                          │   → Reciprocal Rank Fusion (RRF)  │
                          └────────────┬────────────────────┘
                                       │
                          ┌────────────▼────────────────────┐
                          │   Agent 2: Answer Synthesizer    │
                          │   (analyze results, rank          │
                          │    suspects, generate answer      │
                          │    with commit links + ratings)    │
                          │   (multimodal: bug screenshots)   │
                          └────────────┬────────────────────┘
                                       │
                          ┌────────────▼────────────────────┐
                          │   Agent 3: Answer Evaluator      │
                          │   (rate confidence, check         │
                          │    grounding, validate links)     │
                          └──────┬───────────┬──────────────┘
                                 │           │
                        ┌────────▼──┐   ┌────▼──────────────┐
                        │  PASS     │   │  RETRY             │
                        │  → return │   │  → refine query    │
                        │  to user  │   │    (add keywords,  │
                        │           │   │     broaden dates)  │
                        └───────────┘   └───────┬───────────┘
                                                │ (loop back to
                                                │  Intent Extractor
                                                │  with feedback)
                                                │
                                        max 3 iterations
```

### 11.3 Agent Definitions

#### Agent 1: Intent Extractor (with Self-Validation)

**Input:** Raw user query + conversation history + (optional) feedback from Evaluator on previous attempt + (optional) work item context.

**Output:** Structured JSON:
```json
{
  "author": "Beina Zhang" | null,
  "repo": "AdsAppsCampaignUI" | null,
  "dateFrom": "2026-03-25" | null,
  "dateTo": "2026-03-31" | null,
  "searchQuery": "store page crash error in campaign editor",
  "secondarySearchQuery": "grid template rendering no-data view filter reset",
  "riskLevel": "HIGH" | null,
  "changeType": "config" | null,
  "keywords": ["crash", "store page", "campaign editor"],
  "confidence": 0.85,
  "ambiguities": [],
  "verdict": "GOOD" | "ASK_USER",
  "clarificationQuestion": null
}
```

**Key capabilities:**
- Adds `secondarySearchQuery` for work item queries — uses different terms from the primary query to bridge the semantic gap between bug descriptions and fix commits
- Self-validates extraction quality via `verdict` field — replaces the separate Extraction Analyzer agent (saves one LLM round-trip, ~8-12s)
- Adds `riskLevel` and `changeType` fields for structured filtering
- Accepts feedback from the Evaluator to reformulate on retry
- When a work item is provided, crafts highly targeted queries from bug title, description, and repro steps

#### Agent 2: Answer Synthesizer

**Input:** RAG search results (top-K commits with metadata) + original query + extracted intent + (optional) bug screenshots as multimodal content.

**Output:**
```json
{
  "answer": "Based on the commits from March 27–29, the most likely cause...",
  "confidence": 0.78,
  "suggestedActions": ["revert flag X", "check perf traces for commit abc123"],
  "searchCoverage": "partial",
  "suspectCount": 5
}
```

**Responsibilities:**
- Rank suspect commits by relevance to the user's query
- Include direct commit links (ADO URLs) for each suspect
- Assess confidence based on how well the results match the query
- Flag when search coverage is insufficient (too few results, poor similarity scores)
- **Multimodal:** When bug screenshots are available, pass them as image content blocks alongside the text query so the LLM can correlate visual symptoms with code changes
- Confidence is clamped against objective metrics — if ≤2 results with avg score < 0.3, confidence is capped at 0.5

#### Agent 3: Answer Evaluator

**Input:** The Answer Synthesizer's output + original query + search metadata (result count, score distribution).

**Output:**
```json
{
  "verdict": "PASS" | "RETRY" | "PARTIAL",
  "qualityScore": 0.82,
  "issues": [],
  "retryStrategy": {
    "action": "broaden_search" | "add_keywords" | "expand_dates" | "try_different_repo",
    "newKeywords": ["performance", "latency", "P50"],
    "expandedDateFrom": "2026-03-20",
    "reasoning": "Initial search only found 3 results with low scores..."
  }
}
```

**Evaluation criteria:**
- **Grounding check:** Are all cited commits actually present in the search results? (prevent hallucination)
- **Relevance score:** Average relevance of cited suspects (threshold: > 0.5)
- **Answer completeness:** Does the answer address all aspects of the user's query?
- **Confidence threshold:** Fast-path PASS when confidence ≥ 0.65 with ≥ 3 results
- **Result coverage:** If search returned < 5 results or all scores < 0.3, recommend broadening
- **Date expansion:** When retrying, can suggest expanded date ranges applied to next iteration's RAG search

### 11.4 Iteration Loop

The agentic flow runs in a loop with a **maximum of 3 iterations** per user query:

```
Iteration 1: Extract (+ self-validate) → Multi-Query Search → Synthesize → Evaluate
Iteration 2: (if eval = RETRY) Refine query → Search → Synthesize → Evaluate
Iteration 3: (if eval = RETRY) Broaden filters → Search → Synthesize → Evaluate
             Force return best answer so far
```

**Iteration budget tracking:**

| Iteration | Focus | Typical Action |
|---|---|---|
| 1 | Initial attempt | Full pipeline with extracted intent, multi-query RRF |
| 2 | Query refinement | Add keywords from result analysis, adjust date range, apply evaluator date overrides |
| 3 | Best-effort | Return highest-confidence answer accumulated across iterations, with disclaimer if confidence is still low |

**Early exit conditions:**
- Answer Evaluator returns `PASS` (qualityScore ≥ 0.65 with ≥ 3 results) → return immediately
- Intent Extractor returns `ASK_USER` → pause loop, send clarification question to user, resume on user response
- Answer Evaluator returns `PARTIAL` → return answer with "results may be incomplete" disclaimer
- All 3 iterations exhausted → return best answer with confidence disclaimer

### 11.5 Clarification Protocol (ASK_USER)

When the Intent Extractor's self-validation determines the query is too ambiguous to proceed:

1. The pipeline pauses and returns a **clarification question** to the user via the chat interface
2. The UI renders this as a system message (distinct from a final answer)
3. The user responds with additional context
4. The pipeline resumes from the Intent Extractor with the original query + user's clarification appended
5. This counts as one iteration of the loop

**Example:**
```
User: "something is broken"
System: "Could you clarify: Which page or feature is affected? When did you first notice the issue? Are you seeing errors, crashes, or performance degradation?"
User: "the campaign editor page is crashing since yesterday"
→ Pipeline resumes with enriched context
```

### 11.6 Message Queue / Agent Coordination

The agents are **not** a traditional message queue system. They are implemented as **sequential LLM calls within a single request handler**, coordinated by an orchestrator function. This keeps the architecture simple and avoids the complexity of distributed message brokers.

```javascript
// Pseudocode for the orchestrator
async function agenticSearch(userQuery, history, workItemContext, maxIterations = 3) {
    let bestAnswer = null;
    let context = { query: userQuery, history, feedback: null, workItemContext };

    // If work item provided, anchor dates to bug creation
    if (workItemContext?.createdDate) {
        context.dateOverrides = { dateFrom: bugDate - 2days, dateTo: bugDate };
    }

    for (let i = 0; i < maxIterations; i++) {
        // Agent 1: Extract intent (with self-validation)
        const intent = await intentExtractor(context);

        if (intent.verdict === 'ASK_USER') {
            return { type: 'clarification', question: intent.clarificationQuestion };
        }

        // Multi-query RAG search with RRF fusion
        const primaryResults = await ragSearch(intent.searchQuery, searchOpts);
        const allLists = [{ results: primaryResults, weight: 1 }];

        if (intent.secondarySearchQuery) {
            const secondaryResults = await ragSearch(intent.secondarySearchQuery, broadSearchOpts);
            allLists.push({ results: secondaryResults, weight: 1 });
        }
        if (workItemContext?.title) {
            const titleResults = await ragSearch(workItemContext.title, broadSearchOpts);
            allLists.push({ results: titleResults, weight: 5 });
        }

        const results = fuseResults(allLists); // Reciprocal Rank Fusion

        // Agent 2: Synthesize answer (with bug screenshots if available)
        const answer = await answerSynthesizer(results, intent, context);

        // Agent 3: Evaluate answer
        const evaluation = await answerEvaluator(answer, context, results);

        if (evaluation.qualityScore > (bestAnswer?.qualityScore || 0)) {
            bestAnswer = { ...answer, qualityScore: evaluation.qualityScore };
        }

        if (evaluation.verdict === 'PASS') {
            return { type: 'answer', ...bestAnswer };
        }

        // Apply evaluator feedback (date expansion, new keywords) for next iteration
        context.feedback = evaluation.retryStrategy;
        if (evaluation.retryStrategy.expandedDateFrom) {
            context.dateOverrides = { dateFrom: evaluation.retryStrategy.expandedDateFrom };
        }
    }

    // Max iterations reached — return best effort
    return { type: 'answer', ...bestAnswer, disclaimer: 'Low confidence — results may be incomplete.' };
}
```

**Why not a message queue?**
- The entire flow is **request-scoped** — it starts and ends within a single HTTP request
- Latency is critical (user is waiting) — adding broker overhead is counterproductive
- The agents share state (accumulated context, previous results) which is trivial with in-process calls but complex with a queue
- If async processing is needed in the future (e.g., background deep analysis), a job queue can be added alongside without replacing the synchronous orchestrator

### 11.7 Latency Budget

Each iteration adds LLM calls. Target latencies per agent:

| Agent | Target Latency | LLM Calls |
|---|---|---|
| Intent Extractor (+ self-validation) | 500ms | 1 (lightweight, low temperature) |
| RAG Search (multi-query + RRF) | 300-500ms | 0 (embedding + LanceDB, up to 3 searches) |
| Answer Synthesizer | 2000ms | 1 (full analysis, higher token output, optional multimodal) |
| Answer Evaluator | 500ms | 1 (lightweight evaluation) |

**Per-iteration budget:** ~3.3 seconds (down from ~3.8s with separate Analyzer)
**Worst case (3 iterations):** ~10 seconds
**Typical case (1 iteration):** ~3-4 seconds + network latency
**Observed average:** ~34 seconds (dominated by LLM API latency, not local compute)

To stay within acceptable chat response times:
- Use `gpt-5.4` (fast) for lightweight agents (Extractor, Evaluator)
- Reserve higher token budgets only for the Synthesizer (2048 max tokens, 10 results)
- Embedding LRU cache (100 entries) avoids re-embedding repeated queries
- Stream the final answer to the UI (show partial response while generating)
- Show iteration progress in the UI ("Refining search... attempt 2/3")

### 11.8 Work Items

| Work Item | Description | Status |
|---|---|---|
| Agent orchestrator | Iteration loop with agent coordination, budget tracking, and early exit logic | ✅ Done |
| Intent Extractor v2 | Confidence scoring, keywords, ambiguity detection, self-validation, secondary search query, work item context | ✅ Done |
| ~~Extraction Analyzer agent~~ | ~~Evaluate intent extraction quality~~ | Eliminated — merged into Intent Extractor as self-validation |
| Answer Synthesizer agent | Ranks suspects, generates structured answers with commit links, confidence, and multimodal support | ✅ Done |
| Answer Evaluator agent | Evaluates answer quality, grounding, confidence; decides pass/retry/partial | ✅ Done |
| Work item integration | Detect ADO URLs, fetch bug context, extract images, anchor search dates | ✅ Done |
| Multi-query RRF search | Primary + secondary + title queries with Reciprocal Rank Fusion | ✅ Done |
| Bug screenshot support | Extract images from work item HTML, fetch with auth, pass as multimodal content | ✅ Done |
| Clarification UI | Chat UI support for system clarification questions (distinct from answers) | ✅ Done |
| Iteration progress UI | Show iteration count in the chat interface | ✅ Done — UI shows "Search refined N time(s)" in the response metadata |
| Streaming support | Stream the final answer to the UI for perceived latency improvement | ✅ Done — SSE (`event: status` / `token` / `complete`) end-to-end |

---

## 12. Deployment

### Architecture

The application is deployed as a single Azure App Service (Linux, Node 20 LTS, B1 tier) that serves both the Express API and the React UI as static files from the same origin.

```
User → Azure App Service (commit-ai-resolver-win.azurewebsites.net)
         ├── /api/*    → Express API routes
         ├── /mcp      → MCP endpoint
         └── /*        → React UI (static files from ui/dist/)
```

### Azure Resources

| Resource | Type | Details |
|---|---|---|
| `commit-ai-resolver-rg` | Resource Group | West US 2 |
| `commit-ai-resolver` | App Service | Linux B1, Node 20 LTS |
| `commit-ai-resolver-plan` | App Service Plan | Linux B1 |
| System-assigned MI | Managed Identity | Azure OpenAI access (Cognitive Services OpenAI User) |
| User-assigned MI | Managed Identity | Azure DevOps access (added as ADO org user) |

### Deployment Scripts

All scripts are in the `deploy/` directory:

| Script | Purpose |
|---|---|
| `deploy.ps1` | Full provisioning + deployment (creates resources, assigns RBAC, builds UI, packages, deploys) |
| `prepare-api.ps1` | Packages API + UI + scripts into a zip for deployment (used by deploy.ps1) |
| `reset-remote.ps1` | Interactive remote data management via Kudu API (refresh, reset, rebuild embeddings) |

### Quick Deploy (Code Only)

```powershell
# Skip provisioning, just rebuild and redeploy
.\deploy\deploy.ps1 -SkipProvision

# Skip both provisioning and build (redeploy existing package)
.\deploy\deploy.ps1 -SkipProvision -SkipBuild
```

### Full Deploy (First Time)

```powershell
.\deploy\deploy.ps1 `
    -ResourceGroup "commit-ai-resolver-rg" `
    -AppName "commit-ai-resolver" `
    -Location "westus2" `
    -AriaIngestionToken "<token>"
```

### How It Works

1. **`prepare-api.ps1`** copies `api/`, `src/services/`, `src/config/`, `scripts/`, and `ui/dist/` into a staging directory, generates a `startup.sh` script, and creates a zip with forward-slash paths (Linux-compatible)
2. **`deploy.ps1`** deploys the zip via `az webapp deployment source config-zip`, which triggers **Oryx build** on the server — Oryx runs `npm install`, compresses `node_modules` to `tar.gz`, and sets up extraction on startup
3. On container startup, Oryx extracts `node_modules.tar.gz` to `/node_modules`, then runs `startup.sh`
4. **`startup.sh`** creates symlinks for persistent data (`/home/data` → `/home/site/data`) and shared source (`/home/site/wwwroot/src` → `/home/site/src`), then starts `node server.js`

### Data Persistence

- **Daily JSON files and LanceDB** are stored at `/home/data/` (persistent across redeployments)
- Data is uploaded separately via the Kudu ZIP API, not included in the deployment package
- `startup.sh` symlinks `/home/site/data → /home/data` so relative paths (`../data/`) resolve correctly

### Data Management (Reset / Refresh / Rebuild)

The system provides tools to manage data on both local and deployed environments.

#### CLI Script (`scripts/reset-and-refresh.js`)

```bash
# Reset all data + backfill 90 days
node scripts/reset-and-refresh.js

# Reset + backfill custom window
node scripts/reset-and-refresh.js --days 60

# Only reset (no backfill)
node scripts/reset-and-refresh.js --reset-only

# Backfill missing commits only (skip existing, preserve data)
node scripts/reset-and-refresh.js --refresh-only --days 90

# Rebuild vector embeddings from existing daily JSON (no ADO fetch)
node scripts/reset-and-refresh.js --rebuild-embeddings
```

**What gets cleared (reset):**
- Daily JSON files (`data/daily/*.json`)
- LanceDB vector store (`data/lancedb/`)
- SQLite database (`data/feedback.db` — chat queries, feedback)
- Refresh checkpoint (`data/refresh-checkpoint.json`)
- Diffs cache (`data/diffs/`)

**Refresh-only mode** fetches commits day-by-day and performs commit-level deduplication — existing summaries are preserved, only new commits are fetched and summarized.

**Rebuild-embeddings mode** reads all existing daily JSON files and regenerates vector embeddings without re-fetching from ADO. Useful after lancedb corruption or deletion.

#### Remote Data Management (`deploy/reset-remote.ps1`)

Interactive PowerShell menu for managing data on the deployed Azure App Service:

```powershell
# Interactive menu
.\deploy\reset-remote.ps1

# Non-interactive
.\deploy\reset-remote.ps1 -Mode refresh-only -Days 90
.\deploy\reset-remote.ps1 -Mode rebuild-embeddings
.\deploy\reset-remote.ps1 -Mode reset-and-refresh -Days 90
```

| Option | Description |
|---|---|
| 1) Refresh only | Backfill missing commits (preserves existing data) |
| 2) Reset partial | Clear daily JSON + checkpoint only (preserves vector DB, feedback) |
| 3) Reset ALL | Clear everything (daily JSON, vector DB, feedback, metrics, diffs, checkpoint) |
| 4) Reset ALL + Refresh | Clear everything and backfill commits |
| 5) Rebuild embeddings | Regenerate vector DB from existing daily JSON |

The script uses Azure AD bearer tokens for Kudu API authentication. For reset operations that delete SQLite files, the App Service is stopped first to release file locks.

Alternatively, SSH into the server and run the script directly:

```bash
az webapp ssh --name commit-ai-resolver --resource-group commit-ai-resolver-rg
cd /home/site/wwwroot && node scripts/reset-and-refresh.js --refresh-only --days 90
```

### App Settings

| Setting | Value | Purpose |
|---|---|---|
| `PORT` | `4399` | Express server port |
| `AZURE_CLIENT_ID` | `<MI client ID>` | User-assigned Managed Identity for ADO access |
| `ARIA_INGESTION_TOKEN` | `<token>` | 1DS telemetry ingestion |
| `ARIA_PROJECT_ID` | (optional) | 1DS project ID |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `true` | Enables Oryx build |
| `WEBSITES_CONTAINER_START_TIME_LIMIT` | `300` | Container startup timeout (seconds) |

### Authentication Setup

After deployment, register the production redirect URI in the Azure AD app registration:
- Platform: **Single-page application**
- URI: `https://commit-ai-resolver-win.azurewebsites.net`

#### MCP tools

The `/mcp` endpoint exposes the following tools to connected agents:

| Tool | Purpose |
|---|---|
| `search_commits` | Semantic vector search over commit summaries. Filters: repo, author, date range, riskLevel, changeType. |
| `get_commit` | Look up one or more commits by short SHA. |
| `get_daily_summary` | Return all commits for a date, grouped by repo, with risk/breaking/config stats. |
| `list_available_dates` | List dates that have data, optionally bounded by from/to. |
| `list_commits_by_filter` | List commits by metadata only (repo, date range, changeType) — no query string required. Use when you want all commits in a window rather than the most relevant ones. |
| `get_commit_diff` | Fetch file-level diffs for a single commit. Applies the noise filter (lock files, generated code, localization, build artifacts) before returning. `includePatch:false` returns just the file list cheaply. |

Resource: `commit://stats` — vector store stats (total indexed commits, tracked repos, date range).

#### MCP OAuth (one-time app reg config)

> **For end users:** the easiest way to connect a client is the **Connect MCP** button in the dashboard header, which serves a one-shot installer (`/install/setup-commit-resolver.ps1`). See [USERGUIDE.md → Connecting from MCP clients](USERGUIDE.md#connecting-from-mcp-clients). The rest of this section covers the one-time tenant setup behind it.

The `/mcp` endpoint is an OAuth 2.1 protected resource (per MCP auth spec 2025-06-18). Because Entra ID does not implement RFC 7591 dynamic client registration — which the Claude Code / VS Code MCP SDKs require — the server runs a thin **DCR shim** at `/oauth/register` and proxies `/oauth/authorize` and `/oauth/token` to Entra. Tokens are still issued and signed by Entra; the server only mediates the OAuth handshake and validates the resulting access tokens via JWKS.

Discovery docs served by the API:
- `/.well-known/oauth-protected-resource` (RFC 9728) — points clients at our auth server metadata.
- `/.well-known/oauth-authorization-server` (RFC 8414) — advertises our pass-through endpoints + the DCR shim.

Manual app-registration setup on `bc4d2d3c-b205-42f4-90f6-8bac756fd7f5` (one-time):

1. **Application ID URI** set to `api://bc4d2d3c-b205-42f4-90f6-8bac756fd7f5` (Expose an API → Set).
2. **A scope** named `mcp.access` exposed under that URI (Expose an API → Add a scope). Admin + user consent both fine.
3. **Loopback redirect** under the **Mobile and desktop applications** platform: add `http://localhost` (no port, no path). Entra treats it as a wildcard for any loopback port, which the MCP SDK uses for its PKCE callback. **Important:** do *not* also list the loopback URI under the Single-page application platform — Entra picks SPA on collision and blocks server-side token redemption (`AADSTS9002327`). Keep SPA for the UI's redirect URIs only (e.g. `http://localhost:5173`, the deployed Azure URLs).

To verify the wiring without a client:
```bash
curl https://commit-ai-resolver-win.azurewebsites.net/.well-known/oauth-authorization-server
# → registration_endpoint, authorization_endpoint, token_endpoint all under our domain

curl -i -X POST https://commit-ai-resolver-win.azurewebsites.net/mcp \
  -H 'Content-Type: application/json' -d '{}'
# → HTTP/1.1 401 with WWW-Authenticate: Bearer ... resource_metadata="..."
```

For local development, run `node api/server.js --no-auth` to bypass the gate entirely.

### ADO Access via Managed Identity

The user-assigned Managed Identity must be added as a user in the Azure DevOps organization:
1. Go to ADO Organization Settings → Users
2. Add the MI's service principal (Object ID) as a user
3. Grant appropriate project access for commit fetching

### Uploading Data

Data files are uploaded separately to persistent storage via the Kudu ZIP API:

```powershell
$token = az account get-access-token --query accessToken -o tsv
Compress-Archive -Path data\* -DestinationPath data.zip
curl -X PUT "https://commit-ai-resolver.scm.azurewebsites.net/api/zip/data/" `
    -H "Authorization: Bearer $token" `
    -H "Content-Type: application/zip" `
    --data-binary "@data.zip"
```

---

## 13. Open Questions

Still open:

1. **Runtime config / experimentation service** — Which platform drives runtime pilot ramps that happen outside code deployments? Needed to scope the C2C Cosmos DB pilot tracker (§3.1, §6.1).
2. **LLM QPS / 429 handling** — We use our own Azure OpenAI deployments (no $ ceiling), but daily summarization occasionally hits 429s under the 25-concurrent-call setting. Open: tune concurrency, add backoff, or request higher TPM quota.

### Resolved

| # | Question | Resolution |
|---|---|---|
| 1 | Release tag structure | Per-repo, 3 strategies codified in `src/config/repositories.js`: `dateSorted` (CampaignUI), `rolling` (MT: STAGING ↔ LKG), `versioned` (AppUI/AnB/DB) |
| 2 | Pilot flag locations | Code-side enumerated in §3.1 (`Dynamic.config`, `DynamicConfigValues.cs`, `sharedfeatures.config`, `appsettings*.json`, `.cscfg`/`.csdef`/`Web.config`). Runtime ramps deferred to C2C tracker |
| 4 | Chat surface | Standalone React app + MCP endpoint (DCR shim for Claude Code / VS Code clients). No Teams bot |
| 5 | Access control | Entra ID JWT on `/api/*`, MCP via OAuth 2.1 `mcp.access` scope. All tenant users see all repos (no team scoping) |
| 6 | Telemetry integration | Aria / 1DS → Kusto tables `commitairesolver_tracing` and `commitairesolver_errors`. Usage metrics in local SQLite, exposed via `/api/metrics/usage` |

