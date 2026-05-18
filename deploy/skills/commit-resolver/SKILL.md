---
name: commit-resolver
description: |
  Commit AI Resolver — search and retrieve recent commit data from Microsoft Advertising repositories.
  Use when investigating live-site issues, finding suspect commits, checking config/flag changes,
  or retrieving daily commit summaries. Queries the Commit AI Resolver MCP server for semantic
  vector search over commit summaries with filtering by repo, author, date, risk level, and change type.
version: 1.3.0
user-invocable: true
allowed-tools: Bash, Read, Grep, Glob, AskUserQuestion
---

# Commit AI Resolver Skill

Search and retrieve recent commit data from Microsoft Advertising repositories via the Commit AI Resolver MCP server.

## When to Use

- User asks about recent code changes, commits, or deployments
- User is investigating a live-site incident and needs suspect commits
- User asks about config/pilot flag changes
- User wants daily commit summaries or change reports
- User asks "what changed in [repo]?" or "who changed [feature]?"
- User mentions commit IDs and wants details
- Trigger phrases: "recent commits", "what changed", "suspect commits", "config changes", "flag changes", "daily summary", "commit resolver"

## How It Works

This skill uses the **CommitResolver MCP server** configured in `~/.claude/mcp.json`.

The default endpoint after running `setup-commit-resolver.ps1` is the deployed Azure App Service:
`https://commit-ai-resolver-win.azurewebsites.net/mcp`.

For local development, point the MCP entry at `http://localhost:4399/mcp` (start with `node api/server.js` for auth, or `node api/server.js --no-auth` to skip sign-in).

## Authentication

The `/mcp` endpoint is gated by Microsoft Entra ID OAuth 2.1 (per MCP auth spec 2025-06-18). On first connection, your MCP client (Claude Code, Claude Desktop, VS Code) will discover the authorization server via `/.well-known/oauth-protected-resource` and pop a browser tab for Microsoft corporate sign-in. Tokens are cached by the client; subsequent calls are silent.

For local iteration without OAuth, run the server with `--no-auth` — the gate is bypassed and a stub user is injected.

The server exposes 4 tools and 1 resource over Streamable HTTP.

## MCP Tools Reference

### 1. `search_commits` — Semantic Search

Search commits using natural language. Returns ranked results with relevance scores.

**Input Schema:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | **Yes** | Natural language search (e.g., "authentication config changes") |
| `repo` | string | No | Repository filter (see aliases below) |
| `author` | string | No | Author name filter |
| `dateFrom` | string | No | Start date (YYYY-MM-DD) |
| `dateTo` | string | No | End date (YYYY-MM-DD) |
| `riskLevel` | enum | No | `HIGH`, `MEDIUM`, or `LOW` |
| `changeType` | enum | No | `config`, `code`, or `mixed` |
| `topK` | number | No | Max results (default 10, max 50) |

**Repository Names and Aliases:**

| Canonical Name | Aliases |
|---------------|---------|
| AdsAppsCampaignUI | CMUI, campaignui |
| AdsAppsMT | MT, middle-tier |
| AdsAppUI | UIServer, appui, shell |
| AnB | anb, ccdb, ccmt |
| AdsAppsDB | CMDB, campaign-db |

**Risk Level Guide:**
- `HIGH` — Breaking changes, large refactors, auth/security changes, feature gate removals
- `MEDIUM` — Moderate feature changes, new endpoints, significant UI changes
- `LOW` — Minor fixes, typos, config tweaks, comment updates

**Change Type Guide:**
- `config` — Configuration, feature flags, pilot changes
- `code` — Source code changes
- `mixed` — Both config and code in one commit

**Example queries:**
- `search_commits({ query: "pilot flag changes in campaign UI", repo: "CMUI", riskLevel: "HIGH" })`
- `search_commits({ query: "authentication middleware changes", dateFrom: "2026-04-20", topK: 5 })`
- `search_commits({ query: "store page crash", repo: "AdsAppsCampaignUI", changeType: "code" })`

### 2. `get_commit` — Lookup by ID

Look up commits by their short ID (7-8 character hex SHA).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `commitIds` | string[] | **Yes** | Array of short commit IDs |

**Example:** `get_commit({ commitIds: ["519cdc3f", "a1b2c3d4"] })`

### 3. `get_daily_summary` — Daily Report

Get all commits for a specific date, grouped by repository with stats.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `date` | string | **Yes** | Date in YYYY-MM-DD format |
| `repo` | string | No | Repository filter (accepts aliases) |

**Example:** `get_daily_summary({ date: "2026-04-23", repo: "MT" })`

### 4. `list_available_dates` — Date Range

List all dates that have commit data. Optionally filter by range.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | string | No | Start date (YYYY-MM-DD) |
| `to` | string | No | End date (YYYY-MM-DD) |

**Example:** `list_available_dates({ from: "2026-04-01" })`

## Resource

- `commit://stats` — Vector store statistics (total indexed commits, repos, date range)

## Usage Pattern for Investigations

When a user reports a bug and asks "what commit caused this?", follow this exact order. Skipping steps is the most common cause of missing the real culprit.

### Step 0 — Always call `search_commits` FIRST

Do **not** start with local `git log`, `git blame`, or path-scoped searches. Local git is path-scoped and will silently miss bugs caused by upstream shared-component changes (renderers, theme switches, generator libraries). The MCP tool searches commit *summaries* semantically, which is path-independent and is the only reliable way to find cross-cutting changes.

Only fall back to local `git log` if `search_commits` returns nothing plausible — and even then, follow the upstream-hop rule (Step 5).

### Step 1 — Read the bug, extract two vocabularies

From the bug title/repro, write down:
- **User vocabulary** — surface words the reporter used (e.g. "wider", "not friendly", "broken layout")
- **Engineer vocabulary** — likely commit-message words for the same change (e.g. "Fluent V2 migration", "responsive", "panel primitive", "ui-generator")

Bug titles use user words; commit messages use engineer words. You must search for both.

### Step 2 — Fire 3–5 `search_commits` queries in parallel

Each query covers a different angle. Take the **union** of results, not a single best query.

Angles to cover:
- **Feature name** the user mentioned (e.g. "Performance Max summary page")
- **Underlying shared component / renderer** (e.g. "UI generator", "summary page renderer", "panel primitive")
- **Symptom in engineer words** (e.g. "width layout wider style responsive")
- **Suspected change family** (e.g. "Fluent V2 component variants", "theme migration", "pilot flag flip")

Each query must include:
- `repo` filter (use the alias, e.g. `CMUI`)
- `dateFrom` = bug-report-date − 7 days
- `dateTo` = bug-report-date
- `topK: 50`

### Step 3 — Re-rank the union by `affectedAreas`, not just score

The embedding score alone is unreliable when vocabulary mismatches. Once you have the union of results, scan each commit's `affectedAreas` array for direct overlap with the bug's feature/component. A commit whose `affectedAreas` contains the bug's feature should be promoted above higher-scoring commits whose areas are unrelated, even if its raw score is lower.

### Step 4 — `get_commit` on top 3 candidates

Pull full details for the top 3 candidates and present them with: commit URL, author, date, risk level, summary, and your reasoning for ranking.

### Step 5 — Only if Steps 0–4 yielded nothing: local `git log` with upstream-hop

If semantic search truly returned nothing useful, fall back to local `git log` — but do **not** stop at the feature directory. Open one entry file in the feature dir, read its `import` statements, and run `git log` on each upstream package path too. UI bugs frequently come from shared renderers, not the feature folder. Tell the user that semantic search was unavailable so confidence is lower.

## Search Strategy — Detailed Rules

`search_commits` uses vector embedding similarity. A single biased query can bury the real culprit deep in the result list. The rules below are how to avoid that.

### 1. Narrow date window first (~7 days, not a month)

A recently filed bug is almost always caused by a recent commit. Default `dateFrom` = bug-report-date − 7 days.

- ✅ Start narrow: 7 days back
- ❌ Don't start with a month — too much noise buries the real suspect
- Only widen the window (to 2 weeks, then a month) if the narrow window returns nothing plausible

### 2. Use the maximum `topK` (50), not the default (10)

Vector similarity may rank the true culprit at position #15–#30 if its summary uses different vocabulary than the bug report. Capping `topK` low will hide it entirely.

- ✅ `topK: 50` for investigations
- ❌ `topK: 10` is fine for casual lookups, but not for bug hunts

### 3. Fire multiple queries with different keyword angles — in parallel

A bug's surface vocabulary often doesn't match the culprit commit's summary. Run 3–5 queries covering distinct angles and take the **union** of results, not a single biased query. See Step 2 above for the angles to cover.

### 4. Always pass `dateFrom`/`dateTo` and a `repo` filter

Without date filters, the embedding search ranges over months of history and dilutes recency. Without a repo filter, results span unrelated repos. Both filters are cheap to add and dramatically improve precision.

### 5. Use `affectedAreas` as the strongest signal after retrieval

Each result includes an `affectedAreas` array (e.g. `["Unified Campaign Summary Page", "UI Generator", "Panel rendering"]`). This is more reliable than the raw similarity score for ranking. Promote commits whose `affectedAreas` directly overlap the bug's feature area.

## Worked Example — Vocabulary Matters

Bug 10725304: *"PerfMax summary page panels became wider, display is not friendly."* Filed 2026-05-18.

**Query A (good):** `"PerfMax summary page panel width fluent v2 wider layout"`
- → Rank 1, score 0.472: `802669b1` "Add Fluent V2 component variants to summary page UI generator" ✅ correct
- `affectedAreas` literally contained "Unified Campaign Summary Page" + "Panel rendering"

**Query B (bad):** `"summary page panel styling change"`
- → `802669b1` not in top 10. Top hits were unrelated *Accounts* Summary, *Overview*, OMS drawer.

**Lesson:** Query A added engineer vocabulary (`"fluent v2"`, `"width"`, `"wider"`) drawn from the symptom. Query B used only generic user vocabulary. The same commit went from "rank 1" to "not in top 10" based on query phrasing alone. **Always fire multiple queries with engineer-vocabulary variants and take the union.**

**Also note:** Path-scoped `git log` on `perf-max-wizard-north-star/steps/summary/` would *never* surface `802669b1`, because the culprit lives in `component-react-fluent-v2/ui-generator/` — one hop upstream in the import graph. This is exactly why Step 0 mandates `search_commits` first.

## Setup

Run the installer (no admin needed):

```powershell
# From the repo:
.\deploy\setup-commit-resolver.ps1

# Or override the endpoint (e.g. point at local dev):
.\deploy\setup-commit-resolver.ps1 -McpUrl "http://localhost:4399/mcp"

# Uninstall:
.\deploy\setup-commit-resolver.ps1 -Uninstall
```

This configures the MCP server in Claude Desktop, Claude Code CLI, and VS Code.

The deployed endpoint requires Microsoft Entra ID sign-in on first use; tokens are cached by your MCP client.
