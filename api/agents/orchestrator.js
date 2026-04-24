/**
 * Agentic Search Orchestrator
 *
 * Coordinates the 4-agent pipeline with iterative refinement:
 *   Intent Extractor → Extraction Analyzer → RAG Search → Answer Synthesizer → Answer Evaluator
 *
 * Max 5 iterations per query. Returns best answer found or a clarification question.
 */

import { extractIntent } from './intent-extractor.js';
import { synthesizeAnswer, synthesizeAnswerStream } from './answer-synthesizer.js';
import { evaluateAnswer } from './answer-evaluator.js';
import { logInfo, logError } from '../telemetry/column-whitelist.js';

function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
}

/**
 * Run the agentic search pipeline.
 *
 * @param {object} params
 * @param {AzureOpenAI} params.llm - OpenAI client for chat completions (gpt-5.4, used for synthesis)
 * @param {AzureOpenAI} params.llmFast - OpenAI client for fast tasks (gpt-5.4-mini, used for intent/eval)
 * @param {Function} params.embedQuery - Async function: (text) => embedding vector
 * @param {Function} params.searchVectors - Async function: (embedding, opts) => results[]
 * @param {Function} params.lookupByCommitIds - Async function: (shortIds) => results[] (exact match)
 * @param {Function} params.buildFullContext - Async function: () => string (fallback)
 * @param {string} params.query - User's question
 * @param {Array} params.history - Conversation history
 * @param {number} params.maxIterations - Max loop iterations (default: 5)
 * @param {Function} params.onProgress - Optional callback: (iteration, stage, details) => void
 * @param {Function} params.onToken - Optional callback for streaming synthesizer tokens: (token: string) => void
 * @returns {Promise<object>} { type: 'answer'|'clarification', reply, searchMethod, iterations, ... }
 */
export async function agenticSearch({
    llm,
    llmFast,
    embedQuery,
    searchVectors,
    lookupByCommitIds,
    buildFullContext,
    query,
    history = [],
    maxIterations = 3,
    workItemContext,
    onProgress,
    onToken,
    correlationId,
}) {
    let bestAnswer = null;
    let bestScore = 0;
    let bestResults = [];
    let prevResultCount = 0;
    const iterationLog = [];
    const pipelineStart = Date.now();

    const log = (iteration, stage, details) => {
        const entry = { iteration, stage, ...details, timestamp: Date.now() };
        iterationLog.push(entry);
        if (onProgress) onProgress(iteration, stage, details);
        const detailStr = details.elapsed ? ` (${details.elapsed}ms)` : '';
        console.log(`  [Agent ${iteration}/${maxIterations}] ${stage}${detailStr}`);
    };

    // Extract prior search results from conversation history so follow-up
    // queries can reference specific commits from earlier answers
    const priorSuspects = history
        .filter(h => h.role === 'assistant' && h.suspects?.length)
        .flatMap(h => h.suspects);

    let context = { query, history, feedback: null, workItemContext, priorSuspects };

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
        const intent = await extractIntent(llmFast || llm, context);
        log(i, 'intent-extractor', { status: 'done', confidence: intent.confidence, verdict: intent.verdict, elapsed: intent._elapsed });
        logInfo('IntentExtraction', {
            CorrelationId: correlationId,
            Component: 'intent-extractor',
            Intent: intent.searchQuery?.slice(0, 200),
            Repo: intent.repo || null,
            Confidence: intent.confidence,
            Verdict: intent.verdict,
            ElapsedMs: intent._elapsed,
            TokensUsed: intent._tokens || 0,
            IterationIndex: i,
        });
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

        // Apply default date range when no dates specified:
        // - Incident queries (crash, broke, regression, etc.) → 7 days (tight window)
        // - General queries → 30 days
        // - Max supported range: 6 months
        let finalDateFrom = effectiveDateFrom;
        let finalDateTo = effectiveDateTo;
        if (!finalDateFrom) {
            const q = (intent.searchQuery || '').toLowerCase();
            const isIncident = /\b(spike|broke|break|error|crash|regression|outage|down|incident|live.?site|production.?issue)\b/.test(q)
                || /\b(spike|broke|break|error|crash|regression|outage|down|incident|live.?site|production.?issue)\b/.test(query.toLowerCase());
            finalDateFrom = daysAgo(isIncident ? 7 : 30);
        }
        if (!finalDateTo) {
            finalDateTo = new Date().toISOString().slice(0, 10);
        }
        // Clamp to max 6 months
        const sixMonthsAgo = daysAgo(180);
        if (finalDateFrom < sixMonthsAgo) {
            finalDateFrom = sixMonthsAgo;
        }

        const searchOpts = {
            topK: workItemContext ? 50 : (hasMetadataFilters ? 50 : 30),
            minScore: intent.author ? 0.01 : (hasFilters ? 0.05 : 0.15),
            author: intent.author || undefined,
            repo: intent.repo || undefined,
            dateFrom: finalDateFrom,
            dateTo: finalDateTo,
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

        // Direct commit ID lookup — if the user referenced specific SHAs, ensure
        // those commits are in the results regardless of vector similarity score.
        // Also include commit IDs from prior search results that the user may reference.
        const priorSuspectIds = priorSuspects.map(s => s.commitId).filter(Boolean);
        const queryCommitIds = intent.commitIds || [];
        const allCommitIds = [...new Set([...queryCommitIds, ...priorSuspectIds.filter(id =>
            query.toLowerCase().includes(id.slice(0, 7).toLowerCase())
        )])];

        if (allCommitIds.length > 0 && lookupByCommitIds) {
            log(i, 'commit-lookup', { status: 'running', commitIds: allCommitIds });
            const directMatches = await lookupByCommitIds(allCommitIds);
            if (directMatches.length > 0) {
                // Prepend direct matches, dedup against existing results
                const existingIds = new Set(results.map(r => r.id));
                const newMatches = directMatches.filter(m => !existingIds.has(m.id));
                results = [...newMatches, ...results];
                log(i, 'commit-lookup', { status: 'done', found: directMatches.length, added: newMatches.length });
            } else {
                log(i, 'commit-lookup', { status: 'done', found: 0 });
            }
        }

        const topScores = results.slice(0, 5).map(r => r.score?.toFixed(3)).join(', ');
        log(i, 'rag-search', { status: 'done', resultCount: results.length, embeddingMs, searchMs });
        if (results.length > 0) {
            console.log(`  [Search] ${results.length} results, top-5 scores: [${topScores}], date range: ${finalDateFrom || 'open'}..${finalDateTo || 'open'}`);
        }

        // If vector search returned nothing and this is the first iteration, try full context
        if (results.length === 0 && i === 1) {
            log(i, 'fallback', { reason: 'no vector results' });
            return await fallbackFullContext({ llm, buildFullContext, query, history, iterationLog, i });
        }

        // --- Agent 3: Answer Synthesizer ---
        // Only stream tokens on the last iteration to avoid sending partial
        // responses to the UI that get replaced on retry.
        const isLastIteration = i >= maxIterations;
        const canStream = onToken && isLastIteration;
        log(i, 'answer-synthesizer', { status: 'running', resultCount: results.length });
        const synthesis = canStream
            ? await synthesizeAnswerStream(llm, results, intent, context, i, onToken)
            : await synthesizeAnswer(llm, results, intent, context, i);
        log(i, 'answer-synthesizer', {
            status: 'done',
            confidence: synthesis.confidence,
            coverage: synthesis.searchCoverage,
            elapsed: synthesis._elapsed,
        });
        console.log(`  [Synthesizer] confidence=${synthesis.confidence}, coverage=${synthesis.searchCoverage}, suspects=${synthesis.suspectCount}, tokens=${synthesis._tokens || '?'}, ${(synthesis._elapsed / 1000).toFixed(1)}s`);
        logInfo('AnswerSynthesis', {
            CorrelationId: correlationId,
            Component: 'answer-synthesizer',
            Confidence: synthesis.confidence,
            ResultCount: results.length,
            ElapsedMs: synthesis._elapsed,
            TokensUsed: synthesis._tokens || 0,
            SuspectsCount: synthesis.suspectCount || 0,
            IterationIndex: i,
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
        const evaluation = await evaluateAnswer(llmFast || llm, synthesis, { ...context, iteration: i }, results, maxIterations);
        log(i, 'answer-evaluator', {
            status: 'done',
            verdict: evaluation.verdict,
            qualityScore: evaluation.qualityScore,
            elapsed: evaluation._elapsed,
        });
        console.log(`  [Evaluator] verdict=${evaluation.verdict}, qualityScore=${evaluation.qualityScore}, fastPath=${evaluation._fastPath || false}`);
        logInfo('AnswerEvaluation', {
            CorrelationId: correlationId,
            Component: 'answer-evaluator',
            Confidence: evaluation.qualityScore,
            Verdict: evaluation.verdict,
            ElapsedMs: evaluation._elapsed,
            IterationIndex: i,
        });
        if (evaluation.issues?.length > 0) {
            console.log(`  [Evaluator] issues: ${evaluation.issues.join('; ')}`);
        }
        if (evaluation.retryStrategy) {
            console.log(`  [Evaluator] retryStrategy: action=${evaluation.retryStrategy.action}, reasoning=${evaluation.retryStrategy.reasoning || 'none'}`);
            if (evaluation.retryStrategy.newKeywords?.length > 0) {
                console.log(`  [Evaluator] newKeywords: ${evaluation.retryStrategy.newKeywords.join(', ')}`);
            }
            if (evaluation.retryStrategy.expandedDateFrom || evaluation.retryStrategy.expandedDateTo) {
                console.log(`  [Evaluator] expandedDates: ${evaluation.retryStrategy.expandedDateFrom || '?'}..${evaluation.retryStrategy.expandedDateTo || '?'}`);
            }
        }

        if (evaluation.verdict === 'PASS') {
            // If we didn't stream yet, re-run with streaming for the final answer
            if (onToken && !canStream) {
                log(i, 'answer-synthesizer', { status: 'streaming', resultCount: results.length });
                const streamedSynthesis = await synthesizeAnswerStream(llm, results, intent, context, i, onToken);
                console.log(`  [Pipeline] PASS — streamed final answer (iteration ${i}, ${((Date.now() - pipelineStart) / 1000).toFixed(1)}s total)`);
                return await formatAnswer(streamedSynthesis, 'agentic', i, iterationLog, null, results, workItemContext, lookupByCommitIds);
            }
            console.log(`  [Pipeline] PASS — returning answer (iteration ${i}, ${((Date.now() - pipelineStart) / 1000).toFixed(1)}s total)`);
            return await formatAnswer(synthesis, 'agentic', i, iterationLog, null, results, workItemContext, lookupByCommitIds);
        }

        if (evaluation.verdict === 'PARTIAL') {
            if (onToken && !canStream) {
                log(i, 'answer-synthesizer', { status: 'streaming', resultCount: results.length });
                const streamedSynthesis = await synthesizeAnswerStream(llm, results, intent, context, i, onToken);
                console.log(`  [Pipeline] PARTIAL — streamed final answer with disclaimer (iteration ${i}, ${((Date.now() - pipelineStart) / 1000).toFixed(1)}s total)`);
                return await formatAnswer(streamedSynthesis, 'agentic', i, iterationLog, 'Results may be incomplete — I searched with the best available context.', results, workItemContext, lookupByCommitIds);
            }
            console.log(`  [Pipeline] PARTIAL — returning answer with disclaimer (iteration ${i}, ${((Date.now() - pipelineStart) / 1000).toFixed(1)}s total)`);
            return await formatAnswer(synthesis, 'agentic', i, iterationLog, 'Results may be incomplete — I searched with the best available context.', results, workItemContext, lookupByCommitIds);
        }

        // RETRY — but detect stale retries (same result count as previous iteration)
        if (results.length <= prevResultCount && results.length > 0 && i > 1) {
            console.log(`  [Pipeline] STALE RETRY — result count unchanged (${results.length}), returning as PARTIAL`);
            if (onToken) {
                log(i, 'answer-synthesizer', { status: 'streaming', resultCount: results.length });
                const streamedSynthesis = await synthesizeAnswerStream(llm, results, intent, context, i, onToken);
                return await formatAnswer(streamedSynthesis, 'agentic', i, iterationLog, 'Results may be incomplete — I searched with the best available context.', results, workItemContext, lookupByCommitIds);
            }
            return await formatAnswer(synthesis, 'agentic', i, iterationLog, 'Results may be incomplete — I searched with the best available context.', results, workItemContext, lookupByCommitIds);
        }
        prevResultCount = results.length;

        // RETRY — prepare feedback for next iteration
        console.log(`  [Pipeline] RETRY — will retry (iteration ${i} → ${i + 1})`);
        if (evaluation.retryStrategy && i < maxIterations) {
            context.feedback = evaluation.retryStrategy;
            // Apply date expansion overrides for next iteration's RAG search
            if (evaluation.retryStrategy.expandedDateFrom || evaluation.retryStrategy.expandedDateTo) {
                context.dateOverrides = {
                    dateFrom: evaluation.retryStrategy.expandedDateFrom || finalDateFrom,
                    dateTo: evaluation.retryStrategy.expandedDateTo || finalDateTo,
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
    const totalElapsed = Date.now() - pipelineStart;
    console.log(`  [Pipeline] MAX ITERATIONS (${maxIterations}) — returning best answer, bestScore=${bestScore.toFixed(2)}, totalElapsed=${(totalElapsed / 1000).toFixed(1)}s`);
    if (bestAnswer) {
        return await formatAnswer(
            bestAnswer,
            'agentic',
            maxIterations,
            iterationLog,
            bestScore < 0.5 ? 'I wasn\'t fully confident in these results after multiple search attempts. Consider refining your question with more specific details.' : null,
            bestResults,
            workItemContext,
            lookupByCommitIds
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

async function formatAnswer(synthesis, searchMethod, iterations, iterationLog, disclaimer, results, workItemContext, lookupByCommitIds) {
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

    // Reorder suspects so the LLM's ranked suspects come first.
    // The LLM ranks by semantic relevance to the bug, which can differ
    // from vector similarity score order. Without reordering, the
    // investigate endpoint's slice(0, 5) may miss the LLM's top pick.
    const rankedIds = synthesis.rankedSuspects || [];
    if (rankedIds.length > 0) {
        const suspectMap = new Map(suspects.map(s => [s.shortId, s]));
        const reordered = [];
        for (const id of rankedIds) {
            const match = suspectMap.get(id);
            if (match) {
                reordered.push(match);
                suspectMap.delete(id);
            }
        }
        // Append remaining suspects not in the LLM ranking
        for (const s of suspects) {
            if (suspectMap.has(s.shortId)) {
                reordered.push(s);
            }
        }
        suspects.length = 0;
        suspects.push(...reordered);
    }

    // Backfill: find commit IDs referenced in the answer text but missing from suspects.
    // This happens when the synthesizer mentions commits from the full result set that
    // fell outside the top-N suspects slice, or from broader context.
    const existingIds = new Set(suspects.map(s => s.shortId));
    const answerRefs = [...(synthesis.answer || '').matchAll(/\[([a-f0-9]{6,10})\]\(https?:\/\/[^)]+\)/g)];
    const missingIds = [...new Set(answerRefs.map(m => m[1]))].filter(id => !existingIds.has(id));

    if (missingIds.length > 0) {
        // Check the full results array first (cheaper than a DB lookup)
        const fullResultMap = new Map((results || []).map(r => [r.id, r]));
        for (const id of missingIds) {
            const r = fullResultMap.get(id);
            if (r) {
                suspects.push({
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
                });
            }
        }

        // Any still missing — try vector store lookup
        const stillMissing = missingIds.filter(id => !fullResultMap.has(id));
        if (stillMissing.length > 0 && lookupByCommitIds) {
            try {
                const found = await lookupByCommitIds(stillMissing);
                for (const r of found) {
                    suspects.push({
                        commitId: r.commitId,
                        shortId: r.id,
                        repo: r.repo,
                        date: r.date,
                        author: r.author || r.metadata?.author,
                        title: r.metadata?.title,
                        summary: r.metadata?.summary,
                        riskLevel: r.metadata?.riskLevel,
                        url: r.metadata?.url,
                        score: r.score || 0,
                    });
                }
                if (found.length > 0) {
                    console.log(`  [formatAnswer] backfilled ${found.length} commit(s) from vector store: ${found.map(r => r.id).join(', ')}`);
                }
            } catch (err) {
                console.warn(`  [formatAnswer] backfill lookup failed: ${err.message}`);
            }
        }
    }

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
    });

    return {
        type: 'answer',
        reply: result.choices?.[0]?.message?.content ?? 'No response from LLM.',
        searchMethod: 'fallback-full',
        iterations: i,
        iterationLog,
    };
}
