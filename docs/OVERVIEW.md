# Commit AI Resolver

**AI-Powered Change Tracking & Incident Investigation for Microsoft Advertising**

Commit AI Resolver automatically ingests, summarizes, and indexes code commits across Azure DevOps repositories, then lets engineers investigate production incidents through natural-language conversation. Instead of spending 30-60 minutes manually reviewing git logs and diffs, DRIs can ask "What caused the latency spike starting April 9?" and get ranked suspect commits with root-cause analysis in under 5 minutes.

---

## The Problem

When a production incident hits, the first question is always: **"What changed?"**

Today, answering that question means:

- Manually browsing commits across multiple ADO repositories
- Reading through dozens of diffs to understand what each change does
- Cross-referencing deployment timelines with incident start times
- Tracking down config/pilot flag ramps that may have increased blast radius

This process takes **30-60 minutes per incident** and relies heavily on tribal knowledge about which repos and features are relevant.

---

## The Solution

Commit AI Resolver provides two interfaces to answer "what changed?" instantly:

### 1. Interactive Dashboard

A dark-themed React dashboard with a timeline chart, risk metrics, and drill-down commit details.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Commit AI Resolver — Daily Change Tracking & Regression Diagnosis  │
├───────────────────────────────────────────────┬─────────────────────┤
│  Date Range Picker  [7d] [14d] [30d]          │                     │
│  Repo Filter  [CampaignUI] [MT] [AdsAppUI]    │   AI Chat Panel     │
├───────────────────────────────────────────────┤   (Resizable)       │
│                                               │                     │
│  ██▇▅▃▇██▄▅▇█▅▃  ← Stacked risk bars        │  "What shipped      │
│  Mon Tue Wed Thu   (HIGH/MEDIUM/LOW)          │   yesterday?"       │
│                                               │                     │
├────────┬──────────────────────────────────────│  "Latency spike     │
│Metrics │ Day Detail                           │   starting Apr 9"   │
│        │                                      │                     │
│ Total  │ [AdsAppsCampaignUI] — 65 commits     │  "Any HIGH risk     │
│  197   │  🔴 Ramp pilot to 100% prod          │   changes today?"   │
│        │  🟡 Add bulk edit drawer              │                     │
│ HIGH   │  🟢 Fix TypeScript errors             │                     │
│   8    │                                      │                     │
│        │ [AdsAppsMT] — 98 commits             │                     │
│ Config │  🟡 Enable perf prediction rollout    │                     │
│  31    │  🟢 Update unit tests                 │                     │
└────────┴──────────────────────────────────────┴─────────────────────┘
```

**Key features:**
- Stacked bar chart showing daily commit volume by risk level
- One-click date range presets (7/14/30 days)
- Per-repo filtering
- Metrics sidebar (total commits, HIGH/MEDIUM/LOW breakdown, config changes)
- Commit cards with risk badges, config change indicators, feature flag names, and ADO links

### 2. AI Chat — Agentic Search Pipeline

The chat panel uses a 3-agent pipeline that goes beyond simple keyword search:

```
User Question
    │
    ├── Agent 1: Intent Extractor (with self-validation)
    │   Parses dates, repos, authors, risk levels, and rewrites the query
    │   for semantic search. Generates a secondary search query for work items.
    │   Self-validates extraction quality (replaces separate Analyzer agent).
    │   Applies a 2-day release buffer for incidents.
    │
    ├── Multi-Query RAG Search (LanceDB Vector Store)
    │   Up to 3 parallel searches merged via Reciprocal Rank Fusion (RRF):
    │     1. Primary LLM-crafted query (weight 1)
    │     2. Secondary query — different angle on the same bug (weight 1)
    │     3. Bug title verbatim — high semantic overlap with fix commits (weight 5)
    │
    ├── Agent 2: Answer Synthesizer
    │   Ranks results by relevance, generates actionable answer with
    │   commit SHAs, ADO links, and suggested next steps.
    │   Supports multimodal input — bug screenshots passed as images.
    │
    ├── Agent 3: Answer Evaluator
    │   Checks answer quality. If insufficient, refines the search query
    │   and loops (up to 3 iterations).
    │
    └── Response with confidence score, metadata, and suggested follow-ups
```

**If the query is ambiguous**, the system asks for clarification before searching:

> **User:** "something broke"
> **System:** "Could you be more specific? Which page or feature is affected? When did the issue start?"

### 2.1 Work Item Integration

Paste an **ADO work item URL** (bug, task, etc.) directly into the chat, and the system will:

1. **Detect** the work item ID from the URL (supports multiple ADO URL formats)
2. **Fetch** the full work item from ADO (title, description, repro steps, area path, state)
3. **Extract screenshots** embedded in the Description/ReproSteps HTML fields (up to 5 images, max 2MB each)
4. **Anchor search dates** to the bug's creation date with a 2-day release buffer
5. **Run multi-query RRF search** using the bug title, description-derived queries, and fix-mechanism queries
6. **Pass screenshots** to the Answer Synthesizer as multimodal content so the LLM can correlate visual symptoms with code changes

```
You:    https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10552393
System: [Fetches bug "The grid is missing for Products."]
        [Extracts 2 screenshots from bug description]
        [Runs 3 parallel searches: primary query, secondary query, bug title]
        [Merges results via RRF, passes images to LLM]
        → Ranked suspect commits with visual correlation
```

### 3. Deep Investigation — Commit Diff Analysis

When the search returns suspect commits, engineers can click **"Investigate these commits"** to trigger deep analysis:

1. The system fetches **actual code diffs** from Azure DevOps for the top 5 suspects
2. An LLM agent analyzes each diff against the incident description
3. Returns a **root-cause analysis** ranking commits by likelihood with specific code-level reasoning

```
## Root Cause Analysis

### Most Likely: 25d4ebdf by Jiayu Lou
**Likelihood: HIGH**

The change enables production rollout for performance prediction and adds a new
paging path via @LastEntityId. This introduces additional DB queries on the hot
path that could cause latency under load...

### Recommended Actions
1. Check production telemetry for prc_FetchEntitiesWithoutPerformancePredictionScore
2. Consider reverting the production rollout flag
3. Monitor query execution times in SQL dashboards
```

---

## Target Use Cases

### On-Call DRI — Incident Triage

**Scenario:** A page is crashing in beta-prod. You're the DRI and need to identify the root cause fast.

```
You:    "Campaign editor crashing since this morning"
System: [Ranks 5 suspect commits with ADO links and risk levels]
You:    [Clicks "Investigate these commits"]
System: [Fetches actual diffs, analyzes code changes, identifies root cause]
        "Most likely: commit abc123 removed null check in editor init path"
```

**Time saved:** 30-60 min manual review → 3-5 min AI-assisted

### Performance Engineer — Latency Investigation

**Scenario:** Monitoring shows a P99 latency regression starting April 9. You need to correlate with code changes.

```
You:    "Latency spike starting April 9"
System: The system automatically applies a 2-day release buffer (checks Apr 7-9)
        and returns commits that could affect performance — API changes,
        config rollouts, query modifications, caching changes.
```

### Team Lead — Daily Standup Prep

**Scenario:** Quick summary of what shipped for standup.

```
You:    "What shipped yesterday?"
System: Summary across all 3 repos with risk breakdown, config changes,
        and notable items highlighted.
```

### Incident Postmortem — Change Timeline

**Scenario:** Building a timeline for a postmortem document.

```
You:    "What changed in AdsAppsMT between April 5 and April 8?"
System: Chronological list of commits scoped to that repo and date range,
        with risk levels and feature flag changes called out.
```

### Compliance Audit — Config & Pilot Tracking

**Scenario:** Reviewing all high-risk or config-only changes for a release review.

```
You:    "Show all HIGH risk changes this week"
System: Filtered list of HIGH risk commits with links, authors, and
        config change details (flag names, ramp percentages).
```

---

## How It Works

### Data Pipeline

```
Azure DevOps (3 repos)
        │
        ▼
  Fetch commits + diffs (ADO REST API v7.1)
        │
        ▼
  Filter noise (lock files, binaries, auto-generated code)
        │
        ▼
  LLM Summarization (Azure OpenAI GPT-5.4)
  • Title, summary, risk level (HIGH/MEDIUM/LOW)
  • Affected areas, feature flags, config changes
  • 10 concurrent LLM calls with retry logic
        │
        ▼
  Store daily JSON (data/daily/YYYY-MM-DD.json)
        │
        ▼
  Generate embeddings (text-embedding-3-large, 3072 dims)
        │
        ▼
  Index in LanceDB vector store (incremental, cached)
```

### Repositories Covered

| Repository | Description | Tag Strategy |
|-----------|-------------|--------------|
| AdsAppsCampaignUI | Campaign management frontend | Date-sorted LKG tags |
| AdsAppsMT | Middle-tier services | Rolling gate tags (STAGING/LKG) |
| AdsAppUI | Shared UI platform | SHA-versioned tags |

### Risk Assessment Criteria

| Level | Criteria |
|-------|----------|
| **HIGH** | Shared infrastructure, auth changes, DB schema, pilot ramps >= 50% or to 100%, feature gate removals |
| **MEDIUM** | Business logic in single feature, pilot ramps < 50%, new API parameters, config file changes |
| **LOW** | Tests, docs, comments, lock files, version bumps, localization |

---

## Getting Started

### Prerequisites

- Node.js 18+
- Azure CLI logged in (`az login`) — required for ADO API access and Azure OpenAI
- Access to the target Azure DevOps repositories

### Setup

```bash
# 1. Install dependencies
cd src && npm install
cd ../api && npm install
cd ../ui && npm install

# 2. Generate daily summaries (fetches commits from ADO, runs LLM summarization)
cd ../src
node scripts/generate-sample-data.js --days 7

# 3. Build vector index (generates embeddings, indexes in LanceDB)
node scripts/generate-embeddings.js

# 4. Start the API server (port 4399)
cd ../api
node server.js

# 5. Start the React frontend (port 5173)
cd ../ui
npx vite --host

# 6. Open http://localhost:5173
```

### Example Chat Queries

| Query | What it does |
|-------|-------------|
| "What shipped yesterday?" | Daily summary across all repos |
| "Any high-risk changes this week?" | Filters by risk level + date range |
| "What changed in AdsAppsCampaignUI recently?" | Scoped to specific repo |
| "Latency spike starting March 28" | Incident correlation with 2-day release buffer |
| "What did Beina Zhang work on?" | Author-specific commit search |
| "Show pilot flag changes" | Config/feature-flag focused search |
| `https://msasg.visualstudio.com/.../edit/10552393` | Paste ADO work item URL — fetches bug, extracts screenshots, runs multi-query search |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **LLM** | Azure OpenAI GPT-5.4 (summarization + agents) |
| **Embeddings** | text-embedding-3-large (3,072 dimensions) |
| **Vector DB** | LanceDB (embedded, no server required) |
| **Source Control** | Azure DevOps REST API v7.1 |
| **Auth** | DefaultAzureCredential (zero-config) |
| **Backend** | Node.js + Express 5 |
| **Frontend** | React 19 + Vite |
| **Chat Rendering** | React Markdown |

---

## Architecture

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Azure DevOps    │     │  Azure OpenAI    │     │  LanceDB         │
│  (3 repos)       │     │  GPT-5.4 +       │     │  Vector Store    │
│                  │     │  Embeddings      │     │  (local)         │
└────────┬─────────┘     └────────┬─────────┘     └────────┬─────────┘
         │                        │                        │
         ▼                        ▼                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Node.js Backend (port 4399)                    │
│                                                                     │
│  POST /api/chat        → Agentic Search Pipeline (3 agents)        │
│  POST /api/investigate → Deep Diff Investigation                    │
│  GET  /api/days        → Daily Summary Data                         │
│  GET  /api/days/:date  → Single Day Detail                          │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    React Frontend (port 5173)                       │
│                                                                     │
│  Timeline Chart  │  Metrics Board  │  Day Detail  │  AI Chat Panel  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Impact

| Metric | Before | After |
|--------|--------|-------|
| Incident triage time | 30-60 min | < 5 min |
| Daily standup prep | 10-15 min reviewing logs | < 30 sec |
| Config change audit | Manual search across repos | Instant filtered view |
| Cross-repo correlation | Requires tribal knowledge | AI handles automatically |
| Diff-level root cause | Manual ADO navigation | One-click investigation |
