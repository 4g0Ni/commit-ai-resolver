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
  db.js        — SQLite telemetry DB
ui/            — React (Vite) frontend
  src/components/  — React components
  src/api.js       — API client functions
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
- Client wrapper: `api/telemetry/aria-client.js` — initializes 1DS with Node.js XHR override.
- Column whitelist: `api/telemetry/column-whitelist.js` — `logInfo(eventName, data)` and `logError(eventName, data)` filter to whitelisted columns before sending.
- Two Kusto tables: `CommitAIResolver_Info` (tracing) and `CommitAIResolver_Error` (errors).
- Ingestion token stored in `.env` (gitignored). See `.env.example` for required vars.
- Telemetry is non-blocking — failures log a warning, never crash the server.

## Dependencies

- Install with `npm install --registry https://registry.npmjs.org/` (corporate registry may need explicit override).
- Backend: `express`, `cors`, `openai`, `@azure/identity`, `@lancedb/lancedb`, `better-sqlite3`.
- Frontend: `react`, `react-dom`, `react-markdown`, `vite`.

## Common Patterns

- Filter pipeline in Timeline: repo filter → risk/type/author filter (split into preAuthorData for available authors computation, then filteredDayData with author applied).
- SSE streaming: server sends `event: status`, `event: token`, `event: complete` events. Frontend parses via `ReadableStream`.
- Azure auth: `DefaultAzureCredential` with `cognitiveservices.azure.com` scope for OpenAI.
