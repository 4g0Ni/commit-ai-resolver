# Commit AI Resolver — User Guide

## Overview

Commit AI Resolver fetches code commits from Azure DevOps repositories between release tags and uses an LLM (Azure OpenAI) to generate summaries and risk assessments for each change.

Currently supported repositories:

| Repository | Tag Strategy | Release Tags |
|---|---|---|
| AdsAppsCampaignUI | Date-sorted (`UnifiedUIDoubleRepoLKG.YYYYMMDD.NN`) | Two most recent tags |
| AdsAppsMT | Rolling named tags | `MT_STAGING` → `MT_LKG` |

---

## Prerequisites

1. **Node.js** v18+
2. **Azure CLI** — logged in with `az login` (used for authentication to ADO and Azure OpenAI)
3. **Install dependencies:**
   ```bash
   cd src
   npm install
   ```

---

## Usage

All commands are run from the `src/` directory.

### Fetch commits between release tags (default)

```bash
node index.js
```

Fetches commits between the two most recent release tags for all configured repos.

### Fetch commits for specific repos

```bash
node index.js --repos AdsAppsCampaignUI
node index.js --repos AdsAppsCampaignUI,AdsAppsMT
```

### List recent release tags

```bash
node index.js --tags
node index.js --tags --repos AdsAppsMT
```

Shows the resolved release tag pair and the 10 most recent tags per repo.

### Fetch latest N commits

```bash
node index.js --latest
node index.js --latest 20 --repos AdsAppsCampaignUI
```

Fetches the most recent N commits (default: 10) from the default branch.

### Summarize commits with LLM

```bash
node index.js --summarize
node index.js --summarize --repos AdsAppsCampaignUI
```

Fetches release commits, retrieves the full diff for each, and sends them to Azure OpenAI for summarization. Each commit gets:

- **Title** — concise one-line summary
- **Summary** — detailed paragraph of what changed and why
- **Risk level** — `LOW` / `MEDIUM` / `HIGH` with color-coded icons
- **Affected areas** — components/features impacted
- **Flags** — any pilot or feature flags mentioned

Example output:

```
🟢 [LOW] 0e1a9b84 — Auto upgrade published packages to latest version
   Author: batadminCORP | 2025-07-10T13:03:51Z
   This commit updates dependency versions...
   Areas: Dependency Management, Build System

🔴 [HIGH] ddfe3d89 — Enable auto-triggered SI deployment in pipeline
   Author: Gavin Wang | 2025-07-10T11:33:46Z
   This commit modifies the release pipeline to enable automatic SI deployments...
   Areas: CI/CD Pipeline, SI Deployment, AKS Cluster Deployment
```

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

---

## Risk Level Criteria

| Level | Criteria |
|---|---|
| 🟢 LOW | Docs, tests, comments, lock files, version bumps, minor config |
| 🟡 MEDIUM | Business logic scoped to one feature, new pilot-gated code, API param changes |
| 🔴 HIGH | Shared infra, auth changes, DB schema, pilot ramp changes, removal of feature gates |

---

## Dashboard UI

The project includes a React-based dashboard for visualizing daily commit summaries and an LLM chat interface for investigating changes.

### Generate Sample Data

Before running the UI, generate daily summary JSON files by fetching real commits and summarizing them with the LLM:

```bash
cd src
node scripts/generate-sample-data.js --days 5 --commits-per-day 5
```

This creates JSON files in `data/daily/` (one per day) plus an `index.json` listing available dates.

### Start the Backend API

```bash
cd api
npm install
npm run dev
```

The API server runs on `http://localhost:3001` and serves:
- `GET /api/days` — list available dates
- `GET /api/days/:date` — get summary for a specific date
- `GET /api/days?from=YYYY-MM-DD&to=YYYY-MM-DD` — date range query
- `POST /api/chat` — LLM chat about commit summaries (sends `{ message, history }`)

### Start the Frontend

```bash
cd ui
npm install
npm run dev
```

The React app runs on `http://localhost:5173` and shows:
- **Timeline view** — expandable day cards showing commit summaries per repo with risk indicators
- **Chat panel** — ask questions about changes, investigate incidents, correlate regressions with recent deploys

---

## Project Structure

```
src/
├── index.js                        # CLI entry point
├── config/
│   └── repositories.js             # Repo definitions and tag strategies
├── scripts/
│   └── generate-sample-data.js     # Generate daily summary JSONs from real commits
├── services/
│   ├── ado-git-client.js           # Azure DevOps REST API client
│   ├── llm-helper.js               # Azure OpenAI client wrapper
│   └── commit-summarizer.js        # LLM-based commit summarization
└── package.json
api/
├── server.js                       # Express backend API
└── package.json
ui/
├── src/
│   ├── App.jsx                     # Main app layout (timeline + chat)
│   ├── api.js                      # API client helpers
│   └── components/
│       ├── Timeline.jsx            # Day card timeline view
│       ├── DayCard.jsx             # Expandable per-day summary card
│       ├── CommitList.jsx          # Commit list with risk indicators
│       └── ChatBox.jsx             # LLM chat interface
└── package.json
data/
└── daily/                          # Generated daily summary JSON files
    ├── index.json                  # Available dates index
    └── YYYY-MM-DD.json            # Per-day commit summaries
```

---

## Adding a New Repository

Edit `src/config/repositories.js` and add an entry:

```js
NewRepo: {
    name: 'NewRepo',
    project: ADO_PROJECT,
    defaultBranch: 'refs/heads/master',
    tagStrategy: 'dateSorted',     // or 'rolling' or 'versioned'
    tagPattern: 'tags/MyPrefix.',  // tag filter prefix
    // For rolling strategy only:
    // releaseTags: { current: 'TAG_CURRENT', previous: 'TAG_PREVIOUS' },
},
```

**Tag strategies:**
- `dateSorted` — Tags like `Prefix.YYYYMMDD.NN`, sorted by date then sequence number
- `rolling` — Fixed tag names that are updated in-place (e.g. `MT_STAGING`, `MT_LKG`)
- `versioned` — Tags like `sha-versioned.329`, sorted by version number

---

## Authentication

All API calls use `DefaultAzureCredential` from `@azure/identity`, which automatically picks up:
- **Local dev:** Your `az login` session
- **Deployed:** Managed Identity

No PAT tokens needed.

---

## Configuration

| Setting | Location | Current Value |
|---|---|---|
| Azure OpenAI endpoint | `services/llm-helper.js` | `chezh-m7lorxce-eastus2.openai.azure.com` |
| Model deployment | `services/llm-helper.js` | `gpt-4.1` |
| API version | `services/llm-helper.js` | `2025-01-01-preview` |
| ADO org | `config/repositories.js` | `msasg` |
| ADO project | `config/repositories.js` | `Bing_Ads` |
| Release pipeline ID | `config/repositories.js` | `66277` |
| Release log tasks | `config/repositories.js` | `Log AdsAppsCampaignUI`, `Log AdsAppUI_Release_WebUI` |
