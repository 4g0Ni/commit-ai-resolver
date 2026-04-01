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

## Risk Level Criteria

| Level | Criteria |
|---|---|
| 🟢 LOW | Docs, tests, comments, lock files, version bumps, minor config |
| 🟡 MEDIUM | Business logic scoped to one feature, new pilot-gated code, API param changes |
| 🔴 HIGH | Shared infra, auth changes, DB schema, pilot ramp changes, removal of feature gates |

---

## Project Structure

```
src/
├── index.js                        # CLI entry point
├── config/
│   └── repositories.js             # Repo definitions and tag strategies
├── services/
│   ├── ado-git-client.js           # Azure DevOps REST API client
│   ├── llm-helper.js               # Azure OpenAI client wrapper
│   └── commit-summarizer.js        # LLM-based commit summarization
└── package.json
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
