/** Optional LLM query expansion for recall-oriented commit candidate generation. */

import { createStructuredCompletion } from './prompt-utils.js';

const PROMPT_VERSION = 'retrieval-query-expander-v1';
const EXPANSION_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        symptomQuery: { type: 'string' },
        mechanismQuery: { type: 'string' },
        fixQuery: { type: 'string' },
    },
    required: ['symptomQuery', 'mechanismQuery', 'fixQuery'],
};

const SYSTEM_PROMPT = `Prompt version: ${PROMPT_VERSION}
You generate complementary semantic-search queries for finding source-code commits that may explain or fix a reported software problem.

Produce exactly three queries:
1. symptomQuery: a concise restatement preserving concrete APIs, errors, components, environment, and observable behavior.
2. mechanismQuery: a plausible internal failure mechanism and subsystem, written in language likely to occur in a technical commit summary.
3. fixQuery: a hypothetical fixing change, written like a concise commit title plus one-sentence implementation summary.

Rules:
- Use only the reported problem as evidence. Plausible mechanisms are search hypotheses, not factual claims.
- Preserve exact technical identifiers and error text when useful.
- Do not include issue, PR, or commit numbers, even if they appear in the input.
- Do not invent exact source file paths or symbols that the report did not supply.
- Make the three queries meaningfully different. Each must be self-contained and at most 500 characters.

Return exactly one JSON object and no Markdown:
{"symptomQuery":"...","mechanismQuery":"...","fixQuery":"..."}`;

function normalizeQuery(value) {
    return String(value || '')
        .replace(/(?:^|\s)(?:issue|pull request|pr|commit)\s*#?\d+\b/giu, ' ')
        .replace(/https?:\/\/\S+/giu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
}
/**
 * Generate gold-independent retrieval queries that bridge symptom and fix wording.
 * Returns `applied=false` on provider, parse, or validation failures.
 */
export async function expandRetrievalQuery(llm, reportedProblem) {
    const startedAt = Date.now();
    if (!llm || !String(reportedProblem || '').trim()) {
        return { applied: false, queries: [], reason: 'missing-query-or-model', _elapsed: 0 };
    }
    try {
        const { parsed, result, structuredOutput, fallbackUsed } = await createStructuredCompletion(llm, {
            systemPrompt: SYSTEM_PROMPT,
            userData: { reportedProblem: String(reportedProblem).slice(0, 4000) },
            schemaName: 'retrieval_query_expansion',
            schema: EXPANSION_SCHEMA,
            maxCompletionTokens: 500,
        });
        const fields = ['symptomQuery', 'mechanismQuery', 'fixQuery'];
        const entries = fields
            .map(field => ({ field, query: normalizeQuery(parsed[field]) }))
            .filter(item => item.query.length >= 10);
        const seen = new Set();
        const queries = entries.filter(item => {
            const key = item.query.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        if (queries.length < 2) throw new Error(`query expander returned only ${queries.length}/3 usable queries`);
        return {
            applied: true,
            queries,
            _structuredOutput: structuredOutput,
            _structuredFallback: fallbackUsed,
            _promptVersion: PROMPT_VERSION,
            _promptTokens: result.usage?.prompt_tokens,
            _completionTokens: result.usage?.completion_tokens,
            _tokens: result.usage?.total_tokens,
            _elapsed: Date.now() - startedAt,
        };
    } catch (error) {
        return {
            applied: false,
            queries: [],
            reason: error.message,
            _promptVersion: PROMPT_VERSION,
            _elapsed: Date.now() - startedAt,
        };
    }
}
