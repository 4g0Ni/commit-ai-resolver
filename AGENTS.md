# AGENTS.md — Project Guidelines for Copilot CLI

> **Primary agent toolchain:** GitHub Copilot CLI. The Copilot + Core Experiences org standardizes on Copilot CLI as the primary agentic CLI tool by **June 30, 2026**. This file is the canonical agent-instructions document and is auto-loaded by Copilot CLI (it also reads `CLAUDE.md` and `.github/copilot-instructions.md` for backward compatibility).
>
> **Models:** Copilot CLI supports a broad mix of models (Anthropic, OpenAI, Microsoft-internal). Switch with `/model`. This standardization is about toolchain, not model choice.

## Project Overview

Commit AI Resolver is a daily change tracking and regression analysis tool for Microsoft Advertising repos. It fetches commits from Azure DevOps, summarizes them with LLM, stores vector embeddings, and serves a React dashboard with an AI chat interface.

## Architecture

```
src/           — CLI: commit fetching, summarization, embedding pipeline
  config/      — Repository configuration (ADO repos, tag strategies)
  services/    — Business logic (ADO client, commit summarizer, diff filter, vector store, LLM helper)
api/           — Express backend (REST API + SSE streaming chat)
  agents/      — LLM agent implementations (orchestrator, intent extractor, synthesizer, evaluator)
  db.js        — Local SQLite DB (queries, feedback, usage metrics)
ui/            — React (Vite) frontend
  src/components/  — React components
  src/api.js       — API client functions
deploy/        — Legacy packaging assets and MCP installer
scripts/       — CLI utilities (reset-and-refresh.js)
data/          — Runtime data (daily JSON, diffs, SQLite vector store) — gitignored
.github/
  agents/      — Repository-level Copilot CLI custom agents (api-backend, ui-dev, qa, etc.)
  copilot-instructions.md — Pointer to this file (loaded by Copilot CLI)
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
- **Verify after you write:** After implementing any backend/service change, start the server (`node api/server.js`) and confirm the new code path runs without errors. Do not consider the work done until it has been executed at least once.
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
- Two OpenAI-compatible client views: `openaiClient` (quality model) and `openaiMiniClient` (fast model). Models and endpoint are configured through `OPENAI_*` environment variables.
- Embedding model and dimensions are configured with `OPENAI_EMBEDDING_MODEL` and `OPENAI_EMBEDDING_DIMENSIONS`; use `OPENAI_EMBEDDING_BASE_URL` and `OPENAI_EMBEDDING_API_KEY` when embeddings come from a different OpenAI-compatible provider than chat. The default remains `text-embedding-3-large` (3072 dimensions), while local Qwen3/BGE-compatible endpoints are supported.
- Chat endpoint supports both JSON response and SSE streaming (via `Accept: text/event-stream` header).
- LLM agents receive the client as a parameter (`llm` or `llmFast`) — never import the client directly.
- Usage metrics endpoint: `GET /api/metrics/usage` — returns query volume, confidence distribution, method breakdown, error rate, feedback stats, DAU/WAU/MAU, latency percentiles (p50/p95), user engagement, and adoption metrics from local SQLite.

## Access And Credentials

- The UI, REST API, and MCP endpoint have no application-level user login.
- The server binds to `127.0.0.1` by default. Do not expose it publicly without an external authentication layer.
- Do not add MSAL, JWT/JWKS middleware, OAuth proxy routes, or automatic enterprise credential discovery.
- AI is optional and configured with `OPENAI_API_KEY` and/or `OPENAI_BASE_URL`; model names use `OPENAI_MODEL`, `OPENAI_FAST_MODEL`, and `OPENAI_EMBEDDING_MODEL`.
- Live ADO access is optional and configured explicitly with `ADO_PAT` or `ADO_BEARER_TOKEN`.
- Background ADO refresh is opt-in with `ENABLE_SCHEDULED_REFRESH=1`.
- Provider credentials remain server-side and must never be sent to the browser, logged, or committed.

## LLM Agent Pipeline

The agentic search pipeline in `api/agents/orchestrator.js`:
1. **Intent Extractor** (fast model) — parses user query into structured filters
2. **RAG Search** — vector similarity + metadata filtering via SQLite/sqlite-vec
3. **Answer Synthesizer** (quality model) — generates answer from search results (supports streaming)
4. **Answer Evaluator** (fast model) — quality gate: PASS / RETRY / PARTIAL

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
- **Running E2E tests:**
  ```bash
  # 1. Start the local server
  node api/server.js &
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

## Copilot CLI Workflow

- **Custom agents** live in `.github/agents/` (repo-level) and are auto-discovered. Pick one with `/agent` or call inline (e.g., "use the api-backend agent to add a new route"). See [Copilot CLI docs → custom agents](https://docs.github.com/copilot/how-tos/use-copilot-agents/use-copilot-cli#use-custom-agents).
- **Skills:** project-level skills live in `.github/skills/` (Copilot CLI also reads `.claude/skills/` for backward compat). The shipped `commit-resolver` skill in `deploy/skills/commit-resolver/` is installed to `~/.copilot/skills/commit-resolver/` by `deploy/setup-commit-resolver.ps1`.
- **MCP:** add servers with `/mcp add`. The installer wires the Commit AI Resolver MCP into `~/.copilot/mcp-config.json` (Copilot CLI), `~/.claude/mcp.json` (Claude Code transitional), `%APPDATA%\Claude\claude_desktop_config.json` (Claude Desktop), and VS Code.
- **Modes:** `Shift+Tab` toggles plan mode. `/fleet` enables parallel subagent execution. `/delegate` ships the session to a GitHub-hosted agent that opens a PR.
- **Feedback:** log Copilot CLI bugs at <https://github.com/1ES-microsoft/GitHub-Copilot-CLI-Request/discussions/new?category=bugs>. Submit eval scenarios at <https://github.com/1ES-microsoft/GitHub-Copilot-CLI-Request/discussions/new?category=new-eval>.

## Tools & Skills

- **Playwright MCP:** Use Playwright browser tools for UI verification. Navigate to `http://localhost:5173`, take snapshots, click elements, and verify rendering after UI changes.
- **SmartRepo Skill:** Use the `/smartrepo-ask` or `/smartrepo-summarize` skills to refresh domain knowledge about tracked repositories when working on commit summarization, diff filtering, or intent extraction. This helps ensure config rules and aliases stay accurate as repos evolve.
- **Web research:** prefer `web_fetch` (built-in) for documentation lookups. Exa MCP (`web_search_exa`, `web_fetch_exa`) is still available when installed.

## Telemetry

- No remote telemetry is sent. Aria / 1DS integration has been removed.
- `api/db.js` stores query volume, confidence, elapsed time, source, feedback, and usage metrics locally in SQLite.
- Never add a remote telemetry sink without explicit user consent and documented data fields.

## Dependencies

- Install with `npm install --registry https://registry.npmjs.org/`.
- Backend: `express`, `cors`, `openai`, `better-sqlite3`, `sqlite-vec`, and MCP packages.
- Frontend: `react`, `react-dom`, `react-markdown`, and `vite`.

## Deployment

- The supported auth-free workflow is local-only.
- Scripts under `deploy/` are legacy Azure deployment history and may require unavailable Azure credentials.
- Do not deploy the anonymous API/MCP endpoint to a public interface without adding an authentication layer.

## Common Patterns

- Filter pipeline in Timeline: repo filter → risk/type/author filter (split into preAuthorData for available authors computation, then filteredDayData with author applied).
- SSE streaming: server sends `event: status`, `event: token`, `event: complete` events. Frontend parses via `ReadableStream`.
- Provider credentials are read only from explicit server-side environment variables.
- UI requests contain no bearer token or user identity.
