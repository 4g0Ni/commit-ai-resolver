# Commit AI Resolver — Product Specification

## 1. Overview

**Commit AI Resolver** is an LLM-powered daily change tracking and regression diagnosis system. It automatically collects, summarizes, and indexes daily code changes and configuration diffs across multiple repositories, then exposes a React dashboard with an interactive LLM chat interface that enables engineers to quickly correlate production incidents with recent deployments.

### Implementation Status

| Component | Status | Notes |
|---|---|---|
| ADO Git integration (commits, diffs, tags) | ✅ Done | 3 tag strategies supported |
| LLM commit summarization | ✅ Done | GPT-5.4, 10x parallel, retry, diff filtering |
| Config/pilot change detection | ✅ Done | changeType + configChanges fields |
| React dashboard | ✅ Done | Dark theme, chart, filters, metrics |
| LLM chat interface | ✅ Done | Markdown rendering, context-aware |
| Daily data generation (cached) | ✅ Done | Incremental, skip cached commits |
| C2C Cosmos DB pilot tracker | ❌ Planned | DB-level pilot ramp tracking |
| Queryable DB storage | ❌ Planned | Currently JSON files |

### Repositories in Scope

| Repository | Domain | Tag Strategy | Status |
|---|---|---|---|
| AdsAppsCampaignUI | Campaign management UI | Date-sorted | ✅ Active |
| AdsAppsMT | Middle-tier services | Rolling | ✅ Active |
| AdsAppUI | Ads Apps UI shell | Versioned | ✅ Active |
| AdsAppsDB | Database / data layer | Versioned | Commented out |
| AnB | Ads & Billing platform | Versioned | Commented out |

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

For `config` and `mixed` commits, a `configChanges` array captures each flag/config key with its action (added/modified/removed) and a brief description.

**Detection is based on:**
- File names containing `config`, `pilot`, `flag`, `experiment`, `feature-gate`, `dynamic-config`
- JSON/XML config files
- The LLM prompt instructs the model to identify these patterns in diffs

#### Diff Filtering (Noise Reduction)

Before sending diffs to the LLM, files are classified by `src/services/diff-filter.js`:

| Category | Action | Examples |
|---|---|---|
| **Ignored** | Dropped entirely | `.snap`, `.png`, `.woff2`, `.Designer.cs` |
| **Auto-summarized** | LOW risk, no LLM call | Lock files, `.min.js`, `.resx`, `.xlf`, `/dist/`, `.map` |
| **Needs diff** | Full diff sent to LLM | Everything else |

Per-repo custom rules exist for CampaignUI (localization), MT (generated code), and AdsAppUI (localization). Commits with >50 files get file-list-only summaries.

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
    "AdsAppUI": { "..." : "..." }
  },
  "summary": {
    "totalCommits": 98,
    "totalHigh": 8,
    "totalMedium": 56,
    "totalLow": 34,
    "totalConfigChanges": 30,
    "reposIncluded": ["AdsAppsCampaignUI", "AdsAppsMT", "AdsAppUI"]
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
| Dashboard metrics | Aggregate views: commits/day trend, flag change frequency, high-risk change heatmap. | [10544202](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544202) |

### 6.5 LLM Chat Integration

| Work Item | Description | ADO |
|---|---|---|
| Chat interface | Web-based chat UI for engineers to describe incidents and ask questions. | [10544301](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544301) |
| Retrieval layer (RAG) | Given a user query, retrieve relevant daily report segments by date range, repo, page/component keywords. Apply the 2-day release buffer automatically. | [10544206](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544206) |
| Prompt engineering | System prompts that instruct the model to correlate user-described symptoms with retrieved change data and produce ranked suspect lists with links. | [10544208](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544208) |
| Context window management | Handle large report windows (multiple days × multiple repos) within token limits — summarize or paginate as needed. | [10544209](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544209) |
| Response formatting | Structured output: ranked suspects, links, risk assessment, suggested next steps. | [10544210](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544210) |

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
| Auth & access control | Entra ID / existing internal auth |

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

---

## 11. Open Questions

1. How are release tags structured in each repo? Are they consistent or repo-specific?
2. Where do pilot flag definitions live — in code, in a config service, or both?
3. What is the current dynamic config management system (Experimentation platform, feature management service, etc.)?
4. Should the chat interface be a standalone web app, a Teams bot, or integrated into an existing portal?
5. What access control is needed — should all engineers see all repos, or scope by team?
6. Are there existing ADO dashboards or telemetry systems (Kusto, Application Insights) to integrate with for the visualization layer?
7. What is the token budget / cost ceiling for daily LLM processing?
