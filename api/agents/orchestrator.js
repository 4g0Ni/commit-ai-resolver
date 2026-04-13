/**
 * Agentic Search Orchestrator
 *
 * Coordinates the 4-agent pipeline with iterative refinement:
 *   Intent Extractor → Extraction Analyzer → RAG Search → Answer Synthesizer → Answer Evaluator
 *
 * Max 5 iterations per query. Returns best answer found or a clarification question.
 */

import { extractIntent } from './intent-extractor.js';
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
    maxIterations = 3,
    workItemContext,
    onProgress,
}) {
    let bestAnswer = null;
    let bestScore = 0;
    let bestResults = [];
    const iterationLog = [];

    const log = (iteration, stage, details) => {
        const entry = { iteration, stage, ...details, timestamp: Date.now() };
        iterationLog.push(entry);
        if (onProgress) onProgress(iteration, stage, details);
        const detailStr = details.elapsed ? ` (${details.elapsed}ms)` : '';
        console.log(`  [Agent ${iteration}/${maxIterations}] ${stage}${detailStr}`);
    };

    let context = { query, history, feedback: null, workItemContext };

    // If a work item is provided, anchor dates to its creation date
    if (workItemContext?.createdDate) {
        const bugDate = new Date(workItemContext.createdDate);
        const searchFrom = new Date(bugDate);
        searchFrom.setDate(searchFrom.getDate() - 2); // 2-day release buffer
        context.dateOverrides = {
            dateFrom: searchFrom.toISOString().slice(0, 10),
            dateTo: bugDate.toISOString().slice(0, 10),
        };
        log(0, 'work-item', { id: workItemContext.id, title: workItemContext.title, createdDate: workItemContext.createdDate });
    }

    for (let i = 1; i <= maxIterations; i++) {
        // --- Agent 1: Intent Extraction (includes self-validation) ---
        log(i, 'intent-extractor', { status: 'running' });
        const intent = await extractIntent(llm, context);
        log(i, 'intent-extractor', { status: 'done', confidence: intent.confidence, verdict: intent.verdict, elapsed: intent._elapsed });
        console.log(`  [Intent] searchQuery: "${intent.searchQuery}"`);
        if (intent.secondarySearchQuery) console.log(`  [Intent] secondarySearchQuery: "${intent.secondarySearchQuery}"`);

        if (intent.verdict === 'ASK_USER') {
            // Pause pipeline — return clarification question to user
            return {
                type: 'clarification',
                question: intent.clarificationQuestion || 'Could you provide more details about what you\'re looking for?',
                reply: intent.clarificationQuestion || 'Could you provide more details about what you\'re looking for?',
                searchMethod: 'agentic',
                iterations: i,
                iterationLog,
            };
        }

        // --- RAG Search ---
        log(i, 'rag-search', { status: 'running', query: intent.searchQuery.slice(0, 80) });

        const hasFilters = intent.author || intent.repo || intent.dateFrom || intent.dateTo;
        const hasMetadataFilters = intent.riskLevel || intent.changeType;
        const t0 = Date.now();
        const queryEmbedding = await embedQuery(intent.searchQuery);
        const embeddingMs = Date.now() - t0;

        // Determine effective dates: use retry date overrides if available
        const effectiveDateFrom = context.dateOverrides?.dateFrom || intent.dateFrom || undefined;
        const effectiveDateTo = context.dateOverrides?.dateTo || intent.dateTo || undefined;

        const searchOpts = {
            topK: workItemContext ? 50 : (hasMetadataFilters ? 50 : 30),
            minScore: intent.author ? 0.01 : (hasFilters ? 0.05 : 0.15),
            author: intent.author || undefined,
            repo: intent.repo || undefined,
            dateFrom: effectiveDateFrom,
            dateTo: effectiveDateTo,
            riskLevel: intent.riskLevel || undefined,
            changeType: intent.changeType || undefined,
        };

        // Broad search opts: no riskLevel/changeType filters for secondary and title queries
        // to avoid filtering out relevant commits with different metadata classifications
        const broadSearchOpts = {
            topK: searchOpts.topK,
            minScore: searchOpts.minScore,
            author: searchOpts.author,
            repo: searchOpts.repo,
            dateFrom: searchOpts.dateFrom,
            dateTo: searchOpts.dateTo,
        };

        const t1 = Date.now();
        const primaryResults = await searchVectors(queryEmbedding, searchOpts);
        const searchMs = Date.now() - t1;

        // Collect all result lists for multi-query fusion
        // Each entry: { results, weight } — title search gets higher weight
        // because it's deterministic and directly matches bug symptoms
        const allResultLists = [{ results: primaryResults, weight: 1 }];

        // Second search using LLM secondary query — may bridge semantic gap
        if (intent.secondarySearchQuery) {
            log(i, 'rag-search-secondary', { status: 'running', query: intent.secondarySearchQuery.slice(0, 80) });
            const t2 = Date.now();
            const secondaryEmbedding = await embedQuery(intent.secondarySearchQuery);
            const secondaryResults = await searchVectors(secondaryEmbedding, broadSearchOpts);
            const secondaryMs = Date.now() - t2;
            log(i, 'rag-search-secondary', { status: 'done', resultCount: secondaryResults.length, elapsed: secondaryMs });
            allResultLists.push({ results: secondaryResults, weight: 1 });
        }

        // Third search using the bug title directly — the title's natural language
        // often has better semantic overlap with commit summaries than LLM rewrites
        if (workItemContext?.title) {
            const cleanTitle = workItemContext.title.replace(/\[[^\]]*\]\s*/g, '').trim();
            log(i, 'rag-search-title', { status: 'running', query: cleanTitle.slice(0, 80) });
            const t3 = Date.now();
            const titleEmbedding = await embedQuery(cleanTitle);
            const titleResults = await searchVectors(titleEmbedding, { ...broadSearchOpts, minScore: 0.05 });
            const titleMs = Date.now() - t3;
            log(i, 'rag-search-title', { status: 'done', resultCount: titleResults.length, elapsed: titleMs });
            allResultLists.push({ results: titleResults, weight: 5 });
        }

        // Merge results using Reciprocal Rank Fusion when multiple queries were used
        let results;
        if (allResultLists.length > 1) {
            results = fuseResults(allResultLists);
        } else {
            results = primaryResults;
        }

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

        // Guard: if answer is empty, fall back to full context on first occurrence
        if ((!synthesis.answer || synthesis.answer.trim().length === 0) && i === 1) {
            log(i, 'fallback', { reason: 'empty synthesis answer' });
            return await fallbackFullContext({ llm, buildFullContext, query, history, iterationLog, i });
        }

        // Track best answer
        if (synthesis.confidence > bestScore && synthesis.answer && synthesis.answer.trim().length > 0) {
            bestScore = synthesis.confidence;
            bestAnswer = synthesis;
            bestResults = results;
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
            return formatAnswer(synthesis, 'agentic', i, iterationLog, null, results, workItemContext);
        }

        if (evaluation.verdict === 'PARTIAL') {
            return formatAnswer(synthesis, 'agentic', i, iterationLog, 'Results may be incomplete — I searched with the best available context.', results, workItemContext);
        }

        // RETRY — prepare feedback for next iteration
        if (evaluation.retryStrategy && i < maxIterations) {
            context.feedback = evaluation.retryStrategy;
            // Apply date expansion overrides for next iteration's RAG search
            if (evaluation.retryStrategy.expandedDateFrom || evaluation.retryStrategy.expandedDateTo) {
                context.dateOverrides = {
                    dateFrom: evaluation.retryStrategy.expandedDateFrom || effectiveDateFrom,
                    dateTo: evaluation.retryStrategy.expandedDateTo || effectiveDateTo,
                };
            }
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
            bestScore < 0.5 ? 'I wasn\'t fully confident in these results after multiple search attempts. Consider refining your question with more specific details.' : null,
            bestResults,
            workItemContext
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

/**
 * Merge multiple ranked result lists using Reciprocal Rank Fusion (RRF).
 * Commits appearing in multiple lists get boosted. Preserves the original
 * result object (from the list where it scored highest).
 *
 * RRF score = sum over lists of weight * 1/(k + rank), where k=60 (standard constant).
 * @param {Array<{results: Array, weight: number}>} weightedLists
 */
function fuseResults(weightedLists, k = 60) {
    const scoreMap = new Map(); // id → { rrfScore, bestResult }

    for (const { results: list, weight = 1 } of weightedLists) {
        for (let rank = 0; rank < list.length; rank++) {
            const r = list[rank];
            const rrfContribution = weight * (1 / (k + rank + 1));
            const existing = scoreMap.get(r.id);
            if (existing) {
                existing.rrfScore += rrfContribution;
                // Keep the result object with the higher original score
                if (r.score > existing.bestResult.score) {
                    existing.bestResult = r;
                }
            } else {
                scoreMap.set(r.id, { rrfScore: rrfContribution, bestResult: r });
            }
        }
    }

    // Sort by RRF score descending, attach RRF score to result for transparency
    return [...scoreMap.values()]
        .sort((a, b) => b.rrfScore - a.rrfScore)
        .map(entry => ({ ...entry.bestResult, score: entry.bestResult.score, _rrfScore: entry.rrfScore }));
}

function formatAnswer(synthesis, searchMethod, iterations, iterationLog, disclaimer, results, workItemContext) {
    let reply = synthesis.answer;
    if (disclaimer) {
        reply += `\n\n---\n*⚠️ ${disclaimer}*`;
    }

    // Extract top suspects for deep investigation — more for work item queries
    const suspectCount = workItemContext ? 20 : 10;
    const suspects = (results || []).slice(0, suspectCount).map(r => ({
        commitId: r.commitId,
        shortId: r.id,
        repo: r.repo,
        date: r.date,
        author: r.author || r.metadata?.author,
        title: r.metadata?.title,
        summary: r.metadata?.summary,
        riskLevel: r.metadata?.riskLevel,
        url: r.metadata?.url,
        score: r.score,
    }));

    return {
        type: 'answer',
        reply,
        searchMethod,
        confidence: synthesis.confidence,
        searchCoverage: synthesis.searchCoverage,
        suggestedActions: synthesis.suggestedActions || [],
        resultCount: synthesis.resultCount,
        suspects,
        workItem: workItemContext ? {
            id: workItemContext.id,
            title: workItemContext.title,
            url: workItemContext.url,
            type: workItemContext.type,
            state: workItemContext.state,
            createdDate: workItemContext.createdDate,
        } : undefined,
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
