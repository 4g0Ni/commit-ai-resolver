---
name: commit-resolver
description: |
  Commit AI Resolver — search and retrieve recent commit data from Microsoft Advertising repositories.
  Use when investigating live-site issues, finding suspect commits, checking config/flag changes,
  or retrieving daily commit summaries. Queries the Commit AI Resolver MCP server for semantic
  vector search over commit summaries with filtering by repo, author, date, risk level, and change type.
version: 1.1.0
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

When a user is investigating a live-site issue:

1. **Start broad** — `search_commits` with the symptom description and `riskLevel: "HIGH"`
2. **Narrow by repo/date** — Add `repo` and `dateFrom`/`dateTo` filters
3. **Get details** — Use `get_commit` on suspect short IDs
4. **Check daily context** — `get_daily_summary` to see what else shipped that day
5. **Present suspects** — Include commit URLs, risk levels, and summaries

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
