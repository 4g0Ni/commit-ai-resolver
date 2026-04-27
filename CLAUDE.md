# CLAUDE.md — Project Guidelines for Claude Code

## Project Overview

Commit AI Resolver is a daily change tracking and regression analysis tool for Microsoft Advertising repos. It fetches commits from Azure DevOps, summarizes them with LLM, stores vector embeddings, and serves a React dashboard with an AI chat interface.

## Architecture

```
src/           — CLI: commit fetching, summarization, embedding pipeline
  config/      — Repository configuration (ADO repos, tag strategies)
  services/    — Business logic (ADO client, commit summarizer, diff filter, vector store, LLM helper)
api/           — Express backend (REST API + SSE streaming chat)
  agents/      — LLM agent implementations (orchestrator, intent extractor, synthesizer, evaluator)
  db.js        — SQLite telemetry DB (queries, feedback, usage metrics)
  telemetry/   — Aria / 1DS telemetry client and column whitelist
ui/            — React (Vite) frontend
  src/components/  — React components
  src/api.js       — API client functions
deploy/        — Azure deployment scripts (prepare-api.ps1, deploy.ps1)
data/          — Runtime data (daily JSON, diffs, LanceDB vector store) — gitignored
```

**Rules:**
- Business logic goes in `src/services/`. API route handlers go in `api/server.js`. LLM agents go in `api/agents/`.
- React components go in `ui/src/components/`. API client functions go in `ui/src/api.js`.
- Repository config (repos, tag strategies, display names) goes in `src/config/repositories.js`.
- Diff filter rules (per-repo skip/auto-summary patterns) go in `src/services/diff-filter.js`.

## Language & Module System

- **JavaScript only** (no TypeScript). All packages use `"type": "module"` (ES modules).
- Use `import`/`export`, never `require()`/`module.exports`.
- React components are `.jsx`, everything else is `.js`.

## Coding Standards

- **Read before you write:** Before importing or using any module, read its source to verify the export names, data shapes (object vs array vs function), and parameter signatures. Never assume — a wrong assumption (e.g., iterating an object as an array) causes runtime crashes that are trivially avoidable.
- **Verify after you write:** After implementing any backend/service change, start the server (`node api/server.js --no-auth`) and confirm the new code path runs without errors. Do not consider the work done until it has been executed at least once.
- Functional components only (no class components).
- Use React hooks (`useState`, `useEffect`, `useCallback`, `useMemo`, `useRef`) for state and side effects.
- Default exports for React components: `export default ComponentName;`
- Named exports for services and utilities: `export function functionName() {}`
- Use `async`/`await` over raw Promises.
- JSDoc comments for public functions in services and agents. Skip docstrings on simple/obvious functions.

## Naming Conventions

- **Files:** PascalCase for React components (`ChatBox.jsx`, `DayDetail.jsx`). kebab-case for services and config (`commit-summarizer.js`, `ado-git-client.js`).
- **Variables/functions:** camelCase (`fetchDays`, `selectedRepos`, `handleSend`).
- **Constants:** UPPER_SNAKE_CASE for true constants (`MAX_FILES_FOR_DIFF`, `RISK_LEVELS`).
- **CSS classes:** kebab-case (`chat-panel`, `filter-btn`, `typing-indicator`).
- **React components:** PascalCase (`Timeline`, `MetricsBoard`, `RepoFilter`).

## Styling

- Plain CSS with global stylesheets (no CSS modules, no styled-components).
- CSS custom properties (variables) for theming — defined in `ui/src/index.css`.
- Theme variables are prefixed: `--bg-*`, `--text-*`, `--border-*`, `--accent-*`, `--risk-*`, `--shadow-*`.
- Both dark and light themes must be maintained: `[data-theme="dark"]` and `[data-theme="light"]`.
- Component styles go in `ui/src/App.css`.

## API & Backend

- Express server in `api/server.js`. All routes under `/api/`.
- Two Azure OpenAI clients: `openaiClient` (gpt-5.4, quality tasks) and `openaiMiniClient` (gpt-5.4-mini, fast tasks like intent extraction and evaluation).
- Embedding model: `text-embedding-3-large` (3072 dimensions).
- Chat endpoint supports both JSON response and SSE streaming (via `Accept: text/event-stream` header).
- LLM agents receive the client as a parameter (`llm` or `llmFast`) — never import the client directly.
- Usage metrics endpoint: `GET /api/metrics/usage` — returns query volume, confidence distribution, method breakdown, error rate, feedback stats, DAU/WAU/MAU, latency percentiles (p50/p95), user engagement (retention rate, avg queries/user), and adoption metrics from SQLite. User tracking is based on authenticated user email from Microsoft Entra ID token.

## Authentication

- **Microsoft Entra ID (MSAL)** — all API endpoints require a valid JWT (ID token).
- Frontend: `@azure/msal-browser` + `@azure/msal-react` with redirect flow. MSAL config in `ui/src/authConfig.js`.
- Backend: `jsonwebtoken` + `jwks-rsa` middleware in `api/server.js` validates ID tokens against Microsoft's JWKS endpoint.
- App registration: Client ID `bc4d2d3c-b205-42f4-90f6-8bac756fd7f5`, Tenant ID `72f988bf-86f1-41af-91ab-2d7cd011db47` (Microsoft corporate tenant).
- Session persistence: MSAL `localStorage` cache + `storeAuthStateInCookie: true` — survives browser refresh.
- User identity: `req.user.email` (from `preferred_username` claim) used as `userId` in SQLite for DAU/MAU tracking.
- Azure portal: Redirect URI `http://localhost:5173` must be registered under **Single-page application** platform (not Web).

## LLM Agent Pipeline

The agentic search pipeline in `api/agents/orchestrator.js`:
1. **Intent Extractor** (gpt-5.4-mini) — parses user query into structured filters
2. **RAG Search** — vector similarity + metadata filtering via LanceDB
3. **Answer Synthesizer** (gpt-5.4) — generates answer from search results (supports streaming)
4. **Answer Evaluator** (gpt-5.4-mini) — quality gate: PASS / RETRY / PARTIAL

When adding or modifying agents, follow the existing pattern: accept `llm` as first param, return a structured object, log timing with `_elapsed`.

## Repository Configuration

Five tracked repos: AdsAppsCampaignUI, AdsAppsMT, AdsAppUI, AnB, AdsAppsDB.

Display name mapping (used in UI):
- AdsAppsCampaignUI → CMUI
- AdsAppsMT → MT
- AdsAppUI → UIServer
- AnB → AnB
- AdsAppsDB → CMDB

When adding a new repo, update:
1. `src/config/repositories.js` — repo entry
2. `src/services/diff-filter.js` — per-repo filter rules
3. `src/services/commit-summarizer.js` — config detection rules
4. `api/agents/intent-extractor.js` — repoList + aliases
5. `ui/src/components/RepoFilter.jsx` — DISPLAY_NAMES map

## State Management

- React hooks only (no Redux, Zustand, or Context).
- `localStorage` for UI preferences: theme, chat history, chat panel width.
- No global state — pass data via props.

## Testing

- Test files in `src/tests/` using Node.js scripts (no framework).
- No UI tests currently exist.
- **No-auth mode:** The API server supports `--no-auth` (or `NO_AUTH=1` env var) to disable JWT authentication. This injects a stub `req.user` so all routes work without a real token. Use this for running the E2E test suite.
- **Running E2E tests:**
  ```bash
  # 1. Start server without auth
  node api/server.js --no-auth &
  # 2. Run test suite
  cd src && node tests/test-search-e2e.js
  # 3. Kill the server when done
  kill %1   # or: kill $(lsof -ti:4399)
  ```
- **Verification requirement:** When adding or modifying a feature, always start the API server (`node api/server.js`) and run simulation queries to verify end-to-end behavior before considering the work done. For example:
  - For backend/agent changes: `curl -X POST http://localhost:4399/api/chat -H "Content-Type: application/json" -d '{"message":"what changed yesterday?","history":[]}'` and verify the response is correct.
  - For SSE streaming changes: add `Accept: text/event-stream` header and verify `status`, `token`, and `complete` events flow properly.
  - For UI changes: run `npm run dev` in `ui/` and use the **Playwright MCP tools** (`browser_navigate`, `browser_snapshot`, `browser_click`, etc.) to verify the feature visually — check layout, interactions, and styling rather than just building.
  - For repo config changes: query with repo aliases (e.g., "what changed in CMDB?") to confirm alias resolution works.
- Build the UI (`npm run build` in `ui/`) to catch compile errors before committing.

## Tools & Skills

- **Playwright MCP:** Use Playwright browser tools for UI verification. Navigate to `http://localhost:5173`, take snapshots, click elements, and verify rendering after UI changes.
- **SmartRepo Skill:** Use the `/smartrepo-ask` or `/smartrepo-summarize` skills to refresh domain knowledge about tracked repositories when working on commit summarization, diff filtering, or intent extraction. This helps ensure config rules and aliases stay accurate as repos evolve.
- **Exa Search:** Prefer Exa MCP tools (`web_search_exa`, `web_fetch_exa`) over `WebSearch`/`WebFetch` for web research — better results for technical queries.

## Telemetry

- **Aria / 1DS SDK:** Telemetry is sent to Aria Kusto via `@microsoft/1ds-core-js` + `@microsoft/1ds-post-js`.
- Client wrapper: `api/telemetry/aria-client.js` — initializes 1DS with Node.js fetch override.
- Column whitelist: `api/telemetry/column-whitelist.js` — `logInfo(eventName, data)` and `logError(eventName, data)` filter to whitelisted columns before sending.
- Two Kusto tables: `commitairesolver_tracing` (info/tracing) and `commitairesolver_errors` (errors). Table names are lowercase (Aria auto-creates tables on first event).
- Ingestion token stored in `.env` (gitignored). See `.env.example` for required vars.
- Telemetry is non-blocking — failures log a warning, never crash the server.
- **Usage metrics:** `api/db.js` tracks query volume, confidence, elapsed time, user identity (`user_id` via authenticated email from ID token), and feedback in SQLite. The `getUsageMetrics()` function computes: summary counts, DAU/WAU/MAU, daily active users trend, confidence distribution, search method breakdown, feedback rates (feedback/positive/negative), latency percentiles (p50/p95), error rate, and engagement metrics (retention rate, avg queries/user, returning users). Exposed via `GET /api/metrics/usage`.

## Dependencies

- Install with `npm install --registry https://registry.npmjs.org/` (corporate registry may need explicit override).
- Backend: `express`, `cors`, `openai`, `@azure/identity`, `@lancedb/lancedb`, `better-sqlite3`, `jsonwebtoken`, `jwks-rsa`.
- Frontend: `react`, `react-dom`, `react-markdown`, `vite`, `@azure/msal-browser`, `@azure/msal-react`.

## Deployment

- **Target:** Single Azure App Service (Linux B1, Node 20 LTS) at `commit-ai-resolver.azurewebsites.net`
- **Architecture:** Express API + React UI served from the same origin (no separate SWA)
- **Scripts:** `deploy/deploy.ps1` (full provision + deploy), `deploy/prepare-api.ps1` (package API + UI into zip)
- **Build system:** Oryx (triggered by `az webapp deployment source config-zip`) — runs `npm install` on server, compresses `node_modules` to `tar.gz`
- **Data persistence:** `/home/data/` (survives redeployments). Uploaded separately via Kudu ZIP API, not included in deployment package
- **Startup:** `startup.sh` creates symlinks (`/home/site/data → /home/data`, `/home/site/src → wwwroot/src`) then runs `node server.js`
- **Identity:** System-assigned MI for Azure OpenAI, user-assigned MI (set via `AZURE_CLIENT_ID`) for ADO access
- **Zip creation:** Uses .NET `ZipFile` (not `Compress-Archive`) to ensure forward-slash paths for Linux compatibility
- **Deploy commands:** `.\deploy\deploy.ps1 -SkipProvision` (redeploy code), `.\deploy\deploy.ps1 -SkipProvision -SkipBuild` (redeploy existing package)

## Common Patterns

- Filter pipeline in Timeline: repo filter → risk/type/author filter (split into preAuthorData for available authors computation, then filteredDayData with author applied).
- SSE streaming: server sends `event: status`, `event: token`, `event: complete` events. Frontend parses via `ReadableStream`.
- Azure auth for OpenAI: `DefaultAzureCredential` with `cognitiveservices.azure.com` scope.
- Azure auth for users: MSAL redirect flow → ID token → JWT validation middleware on all `/api` routes.
