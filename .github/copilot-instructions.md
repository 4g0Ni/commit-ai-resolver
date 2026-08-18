# Copilot CLI Instructions

The canonical project guidelines for Copilot CLI (and any other agentic CLI) live in [`AGENTS.md`](../AGENTS.md) at the repo root.

Please load and follow `AGENTS.md`. It covers:

- Architecture and module layout (`src/`, `api/`, `ui/`, `deploy/`)
- Coding standards (ES modules, functional React, JSDoc, "read before you write")
- API/backend rules (OpenAI-compatible clients, SSE streaming, anonymous localhost access)
- LLM agent pipeline (intent → RAG → synthesize → evaluate)
- Repository configuration map (5 tracked Microsoft Advertising repos + display-name aliases)
- Testing + verification requirements (start the server, run sample queries, build the UI)
- Copilot CLI workflow notes (custom agents in `.github/agents/`, skills in `.github/skills/`, MCP in `~/.copilot/mcp-config.json`)
- Local metrics, dependencies, deployment safety, and common patterns

> **Migration note:** Copilot + Core Experiences standardizes on **GitHub Copilot CLI** as the primary agentic CLI tool by **June 30, 2026**. The repo continues to ship `CLAUDE.md` (which now redirects here) for Claude Code users during the transition.
