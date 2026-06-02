---
name: commit-resolver
description: |
  Use when investigating live-site issues, finding suspect commits, checking config/flag changes,
  or retrieving daily commit summaries for Microsoft Advertising repositories (AdsAppsCampaignUI,
  AdsAppsMT, AdsAppUI, AnB, AdsAppsDB). Trigger phrases: "recent commits", "what changed",
  "suspect commits", "config changes", "flag changes", "daily summary", "commit resolver".
version: 1.7.0
user-invocable: true
allowed-tools: Bash, Read, Grep, Glob, AskUserQuestion, Skill
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

This skill uses the **CommitResolver MCP server** configured in your agentic CLI's MCP file:

- **GitHub Copilot CLI** (primary): `~/.copilot/mcp-config.json`
- **Claude Code** (transitional): `~/.claude/mcp.json`
- **Claude Desktop**: `%APPDATA%\Claude\claude_desktop_config.json`
- **VS Code**: `%APPDATA%\Code\User\mcp.json`

The `deploy/setup-commit-resolver.ps1` installer writes all of these for you.

The default endpoint after running `setup-commit-resolver.ps1` is the deployed Azure App Service:
`https://commit-ai-resolver-win.azurewebsites.net/mcp`.

For local development, point the MCP entry at `http://localhost:4399/mcp` (start with `node api/server.js` for auth, or `node api/server.js --no-auth` to skip sign-in).

## Authentication

The `/mcp` endpoint is gated by Microsoft Entra ID OAuth 2.1 (per MCP auth spec 2025-06-18). On first connection, your MCP client (GitHub Copilot CLI, Claude Code, Claude Desktop, VS Code) will discover the authorization server via `/.well-known/oauth-protected-resource` and pop a browser tab for Microsoft corporate sign-in. Tokens are cached by the client; subsequent calls are silent.

For local iteration without OAuth, run the server with `--no-auth` — the gate is bypassed and a stub user is injected.

The server exposes 6 tools and 1 resource over Streamable HTTP.

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

### 5. `get_commit_diff` — Inspect Actual Changes

Fetch the file-level diff for a single commit when the LLM summary isn't specific enough to confirm what changed. Noise files (lock files, generated code, localization, build artifacts) are filtered out automatically by the same rules the daily summarizer uses.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `commitId` | string | **Yes** | Full or short SHA |
| `repo` | string | **Yes** | Repository name or alias — required because SHAs are not unique across our 5 repos |
| `maxFiles` | number | No | Max files to include diffs for (default 20, max 50) |
| `includePatch` | boolean | No | When `true` (default) returns full patch text. When `false` returns only file paths + change types (cheap inspection) |

Response includes `totalFiles`, `analyzableFiles`, `autoSkipped`, `ignored`, `truncated` (true when `analyzableFiles > maxFiles`), the `files` list, and `patches` (only when `includePatch` is true).

**Examples:**
- `get_commit_diff({ commitId: "8019434c", repo: "MT", includePatch: false })` — quick file-list scan
- `get_commit_diff({ commitId: "8019434c", repo: "MT", maxFiles: 50 })` — full patch text up to 50 files

### 6. `list_commits_by_filter` — Metadata-Only Listing

List commits matching pure metadata filters, without needing a semantic query. Use when you want **all** commits in a window (e.g., for a release-notes pass) rather than the most semantically relevant ones.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repo` | string | No | Repository filter (accepts aliases) |
| `dateFrom` | string | No | Start date (YYYY-MM-DD, inclusive) |
| `dateTo` | string | No | End date (YYYY-MM-DD, inclusive) |
| `changeType` | enum | No | `config`, `code`, or `mixed` |
| `limit` | number | No | Max commits to return (default 50, max 200) |

Results are sorted newest-first.

**Examples:**
- `list_commits_by_filter({ repo: "MT", dateFrom: "2026-05-12", dateTo: "2026-05-18" })` — full week of MT changes
- `list_commits_by_filter({ changeType: "config", limit: 100 })` — recent config-only commits across all repos

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

### Step 1.5 — Smell test: is this a config / pilot bug?

Config and pilot flips are invisible to a path-scoped search and frequently live in a **different repo** from the broken feature (e.g., a flag is defined in `AdsAppUI`'s `sharedfeatures.config` but consumed in `CMUI`). Before firing search queries, decide whether this bug smells like a config/pilot change.

Symptoms that suggest config/pilot flip rather than a code change:
- "Stopped working overnight / this morning" with no obvious deploy correlation
- Behavior differs by account, tenant, or ring (e.g., "only for some users")
- Feature visibly **appearing or disappearing** (rather than misbehaving)
- User explicitly asks "is this a pilot?" / "is this rolled out?" / "is the flag on?"
- A previously-shipping feature suddenly regresses with no related code commits in the feature folder

If **any** of these match, mark the investigation as a **config/pilot suspect** and run **both** the regular code-change flow (Steps 2–4) **and** the cross-repo config flow (Step 6) in parallel.

### Step 2 — Fire 3–5 `search_commits` queries in parallel

Each query covers a different angle. Take the **union** of results, not a single best query.

Angles to cover:
- **Feature name** the user mentioned (e.g. "Performance Max summary page")
- **Underlying shared component / renderer** (e.g. "UI generator", "summary page renderer", "panel primitive")
- **Symptom in engineer words** (e.g. "width layout wider style responsive")
- **Suspected change family** (e.g. "Fluent V2 component variants", "theme migration", "pilot flag flip")
- **Flag / pilot name guesses** (only when the bug text itself names something flag-shaped — e.g., the user wrote "the X experiment", "the Y rollout", or referenced a specific feature toggle by name). Do NOT invent flag names from training-data memory.
- **Unusual URL params, test overrides, or escape hatches in the bug** (e.g., a repro URL containing `?debug=1`, `?cctest=1`, `?force=...`, or any non-standard query parameter). These usually exist because recent code added them as gating/escape hatches; searching for the parameter name surfaces the commit that introduced it.

Each query must include:
- `repo` filter (use the alias, e.g. `CMUI`)
- `dateFrom` = bug-report-date − 7 days
- `dateTo` = bug-report-date
- `topK: 50`

### Step 3 — Re-rank the union by `affectedAreas`, not just score

The embedding score alone is unreliable when vocabulary mismatches. Once you have the union of results, scan each commit's `affectedAreas` array for direct overlap with the bug's feature/component. A commit whose `affectedAreas` contains the bug's feature should be promoted above higher-scoring commits whose areas are unrelated, even if its raw score is lower.

**Also factor in recency.** Bugs found in production are usually caused by recent changes — a regression typically surfaces within a day or two of the commit that introduced it, rarely later than 3–4 days. When two candidates have comparable `affectedAreas` overlap, **prefer the one dated closer to the bug report date**.

Caveat: this is a heuristic, not a rule. Latent bugs (edge-case branches, low-traffic flows, internal-only paths) can sit unnoticed for weeks before someone trips over them. If the strongest area-overlap candidate is older than ~5 days, do not dismiss it — present it alongside the more recent candidates and note the date gap so the user can judge.

### Step 4 — `get_commit` on top 3 candidates

Pull full details for the top 3 candidates and present them with: commit URL, author, date, risk level, summary, and your reasoning for ranking.

If the summary alone isn't specific enough to confirm a candidate (e.g., the summary mentions a broad area but you need to see the exact code change), call `get_commit_diff({ commitId, repo, includePatch: false })` first for a cheap file-list scan, then call again with `includePatch: true` if a specific file looks relevant. This is especially useful when ranking two candidates with similar summaries.

### Step 5 — Only if Steps 0–4 yielded nothing: local `git log` with upstream-hop

If semantic search truly returned nothing useful, fall back to local `git log` — but do **not** stop at the feature directory. Open one entry file in the feature dir, read its `import` statements, and run `git log` on each upstream package path too. UI bugs frequently come from shared renderers, not the feature folder. Tell the user that semantic search was unavailable so confidence is lower.

### Step 6 — Cross-repo config / pilot resolution (run when Step 1.5 marked this as a config/pilot suspect)

Run this **in parallel** with Steps 2–4, not after. Config flips in one repo (most often AdsAppUI server config, AdsAppsMT pilot routes, or AdsAppsDB metadata) commonly cause visible bugs in a different repo (most often CMUI) — single-repo search will miss them.

**6a — Cross-repo config sweep.** Call `list_commits_by_filter` or `search_commits` with:
- `changeType: "config"`
- **no `repo` filter** (search all repos)
- `dateFrom` = bug-report-date − 7 days, `dateTo` = bug-report-date
- For `search_commits`, use a query that names the affected feature in engineer vocabulary

Collect every config commit whose `flags` field is non-empty. Each flag string is a candidate cause.

**6b — Resolve flag consumers via `smartrepo-ask`.** For the top 3 candidate flags (sorted by recency, then by `riskLevel`), invoke the **smartrepo-ask** skill to map flag → consuming repo / file. Example invocation:

> Use the `smartrepo-ask` skill: *"Which packages, files, or features reference the feature flag `BulkEditPanelV2Enabled`? Return file paths and the repo each belongs to."*

`smartrepo-ask` can be slow (default 15-min timeout). Only run it for flags that already passed the cross-repo sweep — don't blanket-call it on every config commit.

**6c — Promote and present.** If a flag's consumer repo / file matches the bug's surface repo / feature area, promote that config commit to the top of the candidate list above any same-repo code candidates from Steps 2–4. Present it as: commit URL + the flag name + which consuming file makes it relevant to the bug.

**6d — Treat smartrepo-ask output as a ranking hint, not ground truth.** It is LLM-generated and can be wrong about consumers. If the user disagrees with the linkage, fall back to Step 4 candidates.

**6e — Cross-repo *code* search on server repos.** Config-only sweep in 6a misses regressions caused by **code changes gated on existing flags** (e.g., a new branch added to `UserWorkflowHelper` behind `RootPageSimplifiedCTA`). For these, also run `search_commits` with `changeType:"code"` (or no changeType filter) against the other repos most likely to contain server-side routing/gating logic:

- Bug surface is **CMUI** → also search **AdsAppUI** (server config + routing) and **AdsAppsMT** (middle-tier APIs)
- Bug surface is **AdsAppUI** → also search **AdsAppsMT** and **AdsAppsDB**
- Bug surface is **AdsAppsMT** → also search **AdsAppsDB** and **AdsAppUI**

Use the same engineer-vocabulary queries as Step 2 with the alternate `repo` filter. A code change in the server repo that touches a routing/gating file (`UserWorkflowHelper`, `*Resolver`, `*Router`, `*ViewModelBuilder`) is the most common cross-repo regression source and is invisible to single-repo CMUI search.

## Release-cadence-aware date alignment

**Check-in date ≠ user-impact date.** When correlating a metric or data anomaly with a commit, shift the commit date forward through the deployment pipeline before comparing it to when the anomaly appeared. Skipping this shift causes correct culprits to be dismissed ("the commit landed 4 days before the jump, can't be it") and date-adjacent but innocent commits to be falsely blamed.

### Standard Microsoft Ads release cadence (default assumption)

Releases run on **US business hours / US time zone**. No deploys on weekends.

| Stage | Typical delay from US check-in date |
|---|---|
| Check-in to master | T+0 |
| Deploy to SI / Beta-Prod | T+1 US business day |
| Flip to Prod | T+2 US business days |
| Weekend skip | Fri US check-in → Mon SI → Tue Prod |

So a config/flag ramp checked in on **Friday (US)** typically reaches **prod users on Tuesday** (4 calendar days later), not the next day.

### Time-zone gotcha — China check-ins vs US release calendar

Many committers are in China (UTC+8) while the release pipeline runs on US time. The "check-in day" the release calendar cares about is the **US calendar day** when the commit landed, not the local day of the author.

Examples:
- A commit pushed **Saturday 10:00 AM China time** = **Friday ~10 PM US Eastern / 7 PM US Pacific** — still a Friday US business day, so it makes the same week's SI deploy.
- A commit pushed **Monday 9:00 AM China time** = **Sunday evening US time** — does *not* make Monday's SI deploy in some setups (release branch may have been cut Friday US); often ships in the next cycle.
- A commit pushed **Friday 9:00 PM China time** = **Friday morning US time** — clearly hits Friday SI.

Practical rules:
1. **Do not trust the date string in the commit list at face value** when correlating with deploy windows. The MCP/ADO timestamp may be normalized to UTC, the author's local zone, or US time depending on the source — verify before reasoning about it.
2. When the suspected check-in is on a **Friday or Monday** (the boundary days), convert the commit timestamp to **US Pacific time** explicitly and re-check which US business day it falls on.
3. If the commit shows a Saturday/Sunday date in the API but the author is in China, the underlying US time is very likely **Friday evening US** — treat it as a Friday US check-in for cadence purposes.

When in doubt, ask the user which time zone the displayed dates are in, or get the full UTC timestamp from the commit URL on ADO.

### How to apply when investigating a data/metric anomaly

1. **Identify the anomaly date** — the day a metric, count, or behavior visibly shifted (e.g., "row count doubled on 2026-05-19").
2. **Compute the expected US check-in window** — subtract the cadence delay (and weekend skip) from the anomaly date. For a Tuesday-prod anomaly, the suspect check-in window is the **previous Thursday or Friday (US)**, not Monday.
3. **Search commits in that shifted window**, not the anomaly date itself. `dateFrom` = anomaly-date − 5 days, `dateTo` = anomaly-date − 1 day is a good default.
4. **Don't dismiss a commit just because its date doesn't match the anomaly date.** A 4-day gap between a Friday US check-in and a Tuesday prod-visible jump is exactly what the cadence predicts.
5. **Convert author-local timestamps to US time** before judging which US business day a commit really lands in (especially for boundary days). See the time-zone gotcha above.
6. **Pilot ramps amplify this.** A flag ramped from 50% → 100% can roughly double the affected metric. If the anomaly ratio looks like ~2x (or matches another ramp percentage), prioritize config commits with non-empty `flags` from the shifted window.

### Worked example — Task Engine execution-count jump

Anomaly: `GetTaskExecutionPercentage` row count for same-day buckets jumped from a stuck `1,196` (5/14–5/18) to `2,264` on **2026-05-19** (Tuesday), roughly 1.89×.

Naive analysis: search around 5/19 → finds two TaskEngine MISE auth commits dated 5/18 and 5/19. Both look temporally plausible, but their *prod deploy* lands on 5/20–5/21 under the cadence, **after** the jump. So they can't be the cause.

Cadence-shifted analysis: 5/19 prod ⇒ expected US check-in window is **Friday 5/15 (US)**, with the weekend skipping past Sat/Sun deploys. `list_commits_by_filter` against AdsAppsMT for 5/14–5/16 surfaces `1fb6a016` (Qiyang Cao, 5/15): "Ramp `SupportStartDateSortInGetTaskExecutionPercentage` to 100% in prod." Flag ramp from 50% → 100% predicts ~2× volume — matches the 1.89× observed.

**Lesson:** Without the cadence shift, the real culprit (`1fb6a016`) looks 4 days too early and would be dismissed. The date-adjacent but innocent MISE auth commits would be falsely promoted. Always shift the date window backward through the deploy pipeline before ranking candidates, and convert author-local times to US time when the check-in falls on a boundary day.

### When the cadence doesn't apply

- **Hotfixes / emergency rollouts** can deploy same-day. If the user mentions "hotfix," "Sev2," or "emergency," widen the window to include the anomaly date itself.
- **Dynamic config / pilot flags** sometimes apply within minutes of a config push, bypassing the build/deploy cycle. For `changeType: "config"` commits the delay can be T+0 to T+1, not T+2. Ask the user or check the flag's rollout system if unsure.
- **Per-ring rollouts** (e.g., SI-only, Beta-only) change which environments see the change first. If the anomaly is from SI/Beta data, use T+1; if from Prod, use T+2 + weekend.
- **Release freezes** (mobile cuts, holidays, end-of-year) extend the delay further. Confirm with the user if any freeze was active.

When in doubt, **present both windows** — the cadence-shifted candidate and the same-day candidate — and let the user pick.

## CRITICAL: Date cutoff discipline

**Never include commits dated after the bug report date.** A commit that landed after the bug was filed cannot have caused it — at best it's a related fix.

- `dateTo` MUST equal the bug report date (or earlier).
- `dateFrom` defaults to bug report date − 7 days; widen only after a narrow window returns nothing plausible.
- If a returned commit's `date` field is after the bug date, **reject it** even if it matches the vocabulary or area perfectly.
- If you only have a vague bug date ("filed last week"), pick the **earliest** plausible date as `dateTo` rather than the latest. False negatives are easier to recover from than confidently presenting a wrong culprit.
- **For metric / data anomalies (not bug reports), the cutoff is different.** Use `dateTo = anomaly-date − 1 day`, because same-day commits have not yet deployed to prod under the standard cadence and cannot have caused the jump. See the "Release-cadence-aware date alignment" section above for the full shifted window.

This rule cost a real investigation: a fix commit dated 11 days after the bug was incorrectly identified as the cause because the search window extended past the bug date. Get the cutoff right first.

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

This configures the MCP server and installs the skill into GitHub Copilot CLI, Claude Desktop, Claude Code CLI, and VS Code.

The deployed endpoint requires Microsoft Entra ID sign-in on first use; tokens are cached by your MCP client.
