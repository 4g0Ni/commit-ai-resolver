/**
 * Agentic Search Orchestrator
 *
 * Coordinates the 4-agent pipeline with iterative refinement:
 *   Intent Extractor → Extraction Analyzer → RAG Search → Answer Synthesizer → Answer Evaluator
 *
 * Max 5 iterations per query. Returns best answer found or a clarification question.
 */

import { extractIntent } from './intent-extractor.js';
import { analyzeExtraction } from './extraction-analyzer.js';
import { synthesizeAnswer } from './answer-synthesizer.js';
import { evaluateAnswer } from './answer-evaluator.js';

/**
 * Run the agentic search pipeline.
 *
 * @param {object} params
 * @param {AzureOpenAI} params.llm - OpenAI client for chat completions
 * @param {Function} params.embedQuery - Async function: (text) => embedding vector
 * @param {Function} params.searchVectors - Async function: (embedding, opts) => results[]
 * @param {Function} params.buildFullContext - Async function: () => string (fallback)
 * @param {string} params.query - User's question
 * @param {Array} params.history - Conversation history
 * @param {number} params.maxIterations - Max loop iterations (default: 5)
 * @param {Function} params.onProgress - Optional callback: (iteration, stage, details) => void
 * @returns {Promise<object>} { type: 'answer'|'clarification', reply, searchMethod, iterations, ... }
 */
export async function agenticSearch({
    llm,
    embedQuery,
    searchVectors,
    buildFullContext,
    query,
    history = [],
    maxIterations = 5,
    onProgress,
}) {
    let bestAnswer = null;
    let bestScore = 0;
    const iterationLog = [];

    const log = (iteration, stage, details) => {
        const entry = { iteration, stage, ...details, timestamp: Date.now() };
        iterationLog.push(entry);
        if (onProgress) onProgress(iteration, stage, details);
        const detailStr = details.elapsed ? ` (${details.elapsed}ms)` : '';
        console.log(`  [Agent ${iteration}/${maxIterations}] ${stage}${detailStr}`);
    };

    let context = { query, history, feedback: null };

    for (let i = 1; i <= maxIterations; i++) {
        // --- Agent 1: Intent Extraction ---
        log(i, 'intent-extractor', { status: 'running' });
        const intent = await extractIntent(llm, context);
        log(i, 'intent-extractor', { status: 'done', confidence: intent.confidence, elapsed: intent._elapsed });

        // --- Agent 2: Extraction Analyzer ---
        log(i, 'extraction-analyzer', { status: 'running' });
        const analysis = await analyzeExtraction(llm, intent, context);
        log(i, 'extraction-analyzer', { status: 'done', verdict: analysis.verdict, elapsed: analysis._elapsed });

        if (analysis.verdict === 'ASK_USER') {
            // Pause pipeline — return clarification question to user
            return {
                type: 'clarification',
                question: analysis.clarificationQuestion || 'Could you provide more details about what you\'re looking for?',
                reply: analysis.clarificationQuestion || 'Could you provide more details about what you\'re looking for?',
                searchMethod: 'agentic',
                iterations: i,
                iterationLog,
            };
        }

        if (analysis.verdict === 'REFORMULATE' && i < maxIterations) {
            // Loop back with feedback to re-extract
            context.feedback = {
                issues: analysis.issues,
                suggestions: analysis.suggestions,
                reformulatedQuery: analysis.reformulatedQuery,
            };
            log(i, 'reformulate', { reason: analysis.issues.join('; ') });
            continue; // Skip search, re-extract
        }

        // --- RAG Search ---
        log(i, 'rag-search', { status: 'running', query: intent.searchQuery.slice(0, 80) });

        const hasFilters = intent.author || intent.repo || intent.dateFrom || intent.dateTo;
        const t0 = Date.now();
        const queryEmbedding = await embedQuery(intent.searchQuery);
        const embeddingMs = Date.now() - t0;

        const t1 = Date.now();
        const results = await searchVectors(queryEmbedding, {
            topK: 30,
            minScore: hasFilters ? 0.05 : 0.15,
            author: intent.author || undefined,
            repo: intent.repo || undefined,
            dateFrom: intent.dateFrom || undefined,
            dateTo: intent.dateTo || undefined,
        });
        const searchMs = Date.now() - t1;
        log(i, 'rag-search', { status: 'done', resultCount: results.length, embeddingMs, searchMs });

        // If vector search returned nothing and this is the first iteration, try full context
        if (results.length === 0 && i === 1) {
            log(i, 'fallback', { reason: 'no vector results' });
            return await fallbackFullContext({ llm, buildFullContext, query, history, iterationLog, i });
        }

        // --- Agent 3: Answer Synthesizer ---
        log(i, 'answer-synthesizer', { status: 'running', resultCount: results.length });
        const synthesis = await synthesizeAnswer(llm, results, intent, context);
        log(i, 'answer-synthesizer', {
            status: 'done',
            confidence: synthesis.confidence,
            coverage: synthesis.searchCoverage,
            elapsed: synthesis._elapsed,
        });

        // Track best answer
        if (synthesis.confidence > bestScore) {
            bestScore = synthesis.confidence;
            bestAnswer = synthesis;
        }

        // --- Agent 4: Answer Evaluator ---
        log(i, 'answer-evaluator', { status: 'running' });
        const evaluation = await evaluateAnswer(llm, synthesis, { ...context, iteration: i }, results);
        log(i, 'answer-evaluator', {
            status: 'done',
            verdict: evaluation.verdict,
            qualityScore: evaluation.qualityScore,
            elapsed: evaluation._elapsed,
        });

        if (evaluation.verdict === 'PASS') {
            return formatAnswer(synthesis, 'agentic', i, iterationLog);
        }

        if (evaluation.verdict === 'PARTIAL') {
            return formatAnswer(synthesis, 'agentic', i, iterationLog, 'Results may be incomplete — I searched with the best available context.');
        }

        // RETRY — prepare feedback for next iteration
        if (evaluation.retryStrategy && i < maxIterations) {
            context.feedback = evaluation.retryStrategy;
            log(i, 'retry', {
                action: evaluation.retryStrategy.action,
                newKeywords: evaluation.retryStrategy.newKeywords,
                reasoning: evaluation.retryStrategy.reasoning,
            });
        }
    }

    // Max iterations reached — return best answer found
    if (bestAnswer) {
        return formatAnswer(
            bestAnswer,
            'agentic',
            maxIterations,
            iterationLog,
            bestScore < 0.5 ? 'I wasn\'t fully confident in these results after multiple search attempts. Consider refining your question with more specific details.' : null
        );
    }

    // No answer at all — shouldn't happen but handle gracefully
    return {
        type: 'answer',
        reply: 'I wasn\'t able to find relevant commits for your question. Could you try rephrasing with more specific details about the feature, page, or time period?',
        searchMethod: 'agentic',
        iterations: maxIterations,
        iterationLog,
    };
}

function formatAnswer(synthesis, searchMethod, iterations, iterationLog, disclaimer) {
    let reply = synthesis.answer;
    if (disclaimer) {
        reply += `\n\n---\n*⚠️ ${disclaimer}*`;
    }
    return {
        type: 'answer',
        reply,
        searchMethod,
        confidence: synthesis.confidence,
        searchCoverage: synthesis.searchCoverage,
        iterations,
        iterationLog,
    };
}

async function fallbackFullContext({ llm, buildFullContext, query, history, iterationLog, i }) {
    const contextText = await buildFullContext();
    const systemPrompt = `You are an expert change analysis assistant for the Microsoft Advertising engineering team.
You have access to commit summaries across repositories.
Use this data to answer questions about:
- What changed on a specific day or date range
- Which commits might be related to an incident or regression
- Risk assessment of recent changes
- Pilot flag and feature flag changes
- Identifying suspect commits for latency, errors, or crashes

When correlating incidents with changes, consider a 2-day buffer (releases take up to 2 days to reach production).
Always cite specific commit SHAs and authors when referencing changes.
For EVERY commit you mention, include a clickable markdown link using the URL from the data. Format: [shortId](url). If a URL is "N/A" or missing, just show the SHA.
Be concise and actionable.

--- COMMIT SUMMARIES (full) ---
${contextText}
--- END SUMMARIES ---`;

    const result = await llm.chat.completions.create({
        messages: [
            { role: 'system', content: systemPrompt },
            ...history.map(h => ({ role: h.role, content: h.content })),
            { role: 'user', content: query },
        ],
        temperature: 0.3,
        max_completion_tokens: 2048,
    });

    return {
        type: 'answer',
        reply: result.choices?.[0]?.message?.content ?? 'No response from LLM.',
        searchMethod: 'fallback-full',
        iterations: i,
        iterationLog,
    };
}
