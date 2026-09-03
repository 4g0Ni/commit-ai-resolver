/**
 * Agentic Search Orchestrator
 *
 * Coordinates the 4-agent pipeline with iterative refinement:
 *   Intent Extractor → Extraction Analyzer → RAG Search → Answer Synthesizer → Answer Evaluator
 *
 * Max 3 iterations per query by default. Returns best answer found or a clarification question.
 */

import { extractIntent } from './intent-extractor.js';
import { synthesizeAnswer, synthesizeAnswerStream } from './answer-synthesizer.js';
import { evaluateAnswer } from './answer-evaluator.js';
import { rerankCommits } from './commit-reranker.js';
import { FALLBACK_SYSTEM_PROMPT } from './synthesis-prompt.js';
import { fuseRankedResults } from '../../src/services/rank-fusion.js';
import { evaluateEvidence } from '../../src/services/evidence-gate.js';
import { getRankFusionConfig } from '../../src/services/retrieval-config.js';

const FUSION = getRankFusionConfig();
const RRF_K = FUSION.k;
const SECONDARY_QUERY_WEIGHT = FUSION.secondaryWeight;
const BUG_TITLE_WEIGHT = FUSION.bugTitleWeight;
const VECTOR_MIN_SCORE = Number.parseFloat(process.env.VECTOR_MIN_SCORE || '0');
const ENABLE_LLM_RERANKER = process.env.ENABLE_LLM_RERANKER === '1';
const LLM_RERANK_CANDIDATES = Math.max(2, Math.min(50, Number.parseInt(process.env.LLM_RERANK_CANDIDATES || '20', 10) || 20));
const SPECIFICITY_FIELDS = ['component', 'symptom', 'time', 'errorCode', 'fileOrSymbol'];

const GENERIC_CLARIFICATION = {
    zh: '请提供受影响的功能或组件、具体症状或错误，以及大致开始时间。',
    en: 'Could you share the affected feature or component, the concrete symptom or error, and roughly when it started?',
};

const CLARIFICATION_FIELD_LABELS = {
    zh: {
        component: '受影响的功能或组件',
        symptom: '具体症状',
        time: '大致开始时间',
        errorCode: '错误码',
        fileOrSymbol: '相关文件、配置键或 symbol',
    },
    en: {
        component: 'the affected feature or component',
        symptom: 'the concrete symptom',
        time: 'roughly when it started',
        errorCode: 'the error code',
        fileOrSymbol: 'the related file, configuration key, or symbol',
    },
};

const CLARIFICATION_FIELD_HINTS = {
    component: /(?:功能|组件|页面|模块|哪里|哪个|feature|component|page|screen|module|where)/iu,
    symptom: /(?:症状|现象|表现|错误|发生|变慢|失败|symptom|behavior|error|happen|slow|fail|issue)/iu,
    time: /(?:时间|何时|什么时候|开始|when|time|start|since)/iu,
    errorCode: /(?:错误码|错误代码|异常|error\s*code|exception)/iu,
    fileOrSymbol: /(?:文件|配置|键|符号|file|config|key|symbol)/iu,
};

function daysBefore(n, referenceDate = new Date().toISOString().slice(0, 10)) {
    const d = new Date(`${referenceDate}T00:00:00Z`);
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
}

function queryLanguage(query) {
    return /\p{Script=Han}/u.test(String(query || '')) ? 'zh' : 'en';
}

function languageMatches(question, language) {
    const containsHan = /\p{Script=Han}/u.test(question);
    return language === 'zh' ? containsHan : !containsHan;
}

function targetsMissingField(question, missingFields) {
    return missingFields.some(field => CLARIFICATION_FIELD_HINTS[field]?.test(question));
}

function selectClarification(intent, query) {
    const language = queryLanguage(query);
    const missingFields = [...new Set(Array.isArray(intent.specificity?.missingFields)
        ? intent.specificity.missingFields.filter(field => SPECIFICITY_FIELDS.includes(field))
        : [])];
    const generated = [intent.specificity?.clarificationQuestion, intent.clarificationQuestion]
        .find(question => typeof question === 'string'
            && question.trim().length > 0
            && question.trim().length <= 300
            && missingFields.length > 0
            && languageMatches(question.trim(), language)
            && targetsMissingField(question.trim(), missingFields));
    if (generated) return generated.trim();

    if (missingFields.length > 0) {
        const labels = missingFields.slice(0, 2).map(field => CLARIFICATION_FIELD_LABELS[language][field]);
        if (language === 'zh') return `请提供${labels.join('和')}。`;
        return `Could you share ${labels.join(' and ')}?`;
    }
    return GENERIC_CLARIFICATION[language];
}

/**
 * Run the agentic search pipeline.
 *
 * @param {object} params
 * @param {object} params.llm - OpenAI-compatible client used for synthesis
 * @param {object} params.llmFast - OpenAI-compatible client used for intent extraction and evaluation
 * @param {Function} params.embedQuery - Async function: (text) => embedding vector
 * @param {Function} params.searchVectors - Async function: (embedding, opts) => results[]
 * @param {Function} params.lookupByCommitIds - Async function: (shortIds) => results[] (exact match)
 * @param {Function} params.buildFullContext - Async function: () => string (fallback)
 * @param {string} params.query - User's question
 * @param {Array} params.history - Conversation history
 * @param {number} params.maxIterations - Max loop iterations (default: 3)
 * @param {Function} params.onProgress - Optional callback: (iteration, stage, details) => void
 * @param {Function} params.onToken - Optional callback for streaming synthesizer tokens: (token: string) => void
 * @returns {Promise<object>} { type: 'answer'|'clarification', reply, searchMethod, iterations, ... }
 */
export async function agenticSearch({
    llm,
    llmFast,
    embedQuery,
    searchVectors,
    searchLexical,
    lookupByCommitIds,
    getVectorStats,
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
    let prevResultKeys = null;
    const iterationLog = [];
    const pipelineStart = Date.now();

    const log = (iteration, stage, details) => {
        const entry = { iteration, stage, ...details, timestamp: Date.now() };
        iterationLog.push(entry);
        if (onProgress) onProgress(iteration, stage, details);
        const detailStr = details.elapsed ? ` (${details.elapsed}ms)` : '';
        console.log(`  [Agent ${iteration}/${maxIterations}] ${stage}${detailStr}`);
    };
    const logSynthesisCompletion = (iteration, synthesis, phase = 'search-answer') => log(iteration, 'answer-synthesizer', {
        status: 'done',
        phase,
        confidence: synthesis.confidence,
        coverage: synthesis.searchCoverage,
        elapsed: synthesis._elapsed,
        promptVersion: synthesis._promptVersion,
        promptVariant: synthesis._promptVariant,
        structuredOutput: synthesis._structuredOutput,
        structuredFallback: synthesis._structuredFallback,
        parseError: synthesis._parseError,
        validationRejections: synthesis._validation?.rejectedCandidateIds || 0,
        promptTokens: synthesis._promptTokens,
        completionTokens: synthesis._completionTokens,
        totalTokens: synthesis._tokens,
    });

    // Extract prior search results from conversation history so follow-up
    // queries can reference specific commits from earlier answers
    const priorSuspects = history
        .filter(h => h.role === 'assistant' && h.suspects?.length)
        .flatMap(h => h.suspects);

    let indexStats = null;
    if (getVectorStats) {
        try {
            indexStats = await getVectorStats();
        } catch (err) {
            console.warn(`  [Search] Unable to read vector stats: ${err.message}`);
        }
    }
    const referenceDate = indexStats?.dateRange?.to || new Date().toISOString().slice(0, 10);
    let context = {
        query,
        history,
        feedback: null,
        workItemContext,
        priorSuspects,
        referenceDate,
        availableRepos: indexStats?.repos || [],
        correlationId,
    };

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
        log(i, 'intent-extractor', {
            status: 'done', confidence: intent.confidence, verdict: intent.verdict, elapsed: intent._elapsed,
            promptVersion: intent._promptVersion,
            promptVariant: intent._promptVariant,
            structuredOutput: intent._structuredOutput,
            structuredFallback: intent._structuredFallback,
            specificityFallback: intent._specificityFallback,
            parseError: intent._parseError,
            promptTokens: intent._promptTokens,
            completionTokens: intent._completionTokens,
            totalTokens: intent._tokens,
            intent: {
                author: intent.author || null,
                repo: intent.repo || null,
                dateFrom: intent.dateFrom || null,
                dateTo: intent.dateTo || null,
                riskLevel: intent.riskLevel || null,
                changeType: intent.changeType || null,
                commitIds: intent.commitIds || [],
                searchQuery: intent.searchQuery,
                secondarySearchQuery: intent.secondarySearchQuery || null,
                verdict: intent.verdict,
                specificity: intent.specificity,
            },
            specificity: intent.specificity,
        });
        console.log(`  [Intent] searchQuery: "${intent.searchQuery}"`);
        if (intent.secondarySearchQuery) console.log(`  [Intent] secondarySearchQuery: "${intent.secondarySearchQuery}"`);

        // --- RAG Search ---
        log(i, 'rag-search', { status: 'running', query: intent.searchQuery.slice(0, 80) });

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
            finalDateFrom = daysBefore(isIncident ? 7 : 30, referenceDate);
        }
        if (!finalDateTo) {
            finalDateTo = referenceDate;
        }
        // Clamp to max 6 months
        const sixMonthsAgo = daysBefore(180, referenceDate);
        if (finalDateFrom < sixMonthsAgo) {
            finalDateFrom = sixMonthsAgo;
        }

        const searchOpts = {
            topK: workItemContext ? 50 : (hasMetadataFilters ? 50 : 30),
            // Candidate recall is rank-based; model-specific cutoffs are opt-in and eval-calibrated.
            minScore: VECTOR_MIN_SCORE,
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
        const lexicalQuery = `${query}\n${intent.searchQuery}`;
        const [primaryResults, lexicalResults] = await Promise.all([
            searchVectors(queryEmbedding, searchOpts),
            searchLexical ? searchLexical(lexicalQuery, { ...searchOpts, minScore: 0 }) : Promise.resolve([]),
        ]);
        const searchMs = Date.now() - t1;

        // Collect all result lists for multi-query fusion
        // Each entry: { results, weight } — title search gets higher weight
        // because it's deterministic and directly matches bug symptoms
        const allResultLists = [{ results: primaryResults, weight: FUSION.denseWeight, channel: 'dense-primary' }];
        if (lexicalResults.length > 0 && FUSION.lexicalWeight > 0) {
            allResultLists.push({ results: lexicalResults, weight: FUSION.lexicalWeight, channel: 'lexical-fts5' });
            log(i, 'rag-search-lexical', {
                status: 'done',
                resultCount: lexicalResults.length,
                rankedIds: lexicalResults.map(result => `${result.repo}:${result.id}`),
            });
        }

        // Second search using LLM secondary query — may bridge semantic gap
        if (intent.secondarySearchQuery) {
            log(i, 'rag-search-secondary', { status: 'running', query: intent.secondarySearchQuery.slice(0, 80) });
            const t2 = Date.now();
            const secondaryEmbedding = await embedQuery(intent.secondarySearchQuery);
            const secondaryResults = await searchVectors(secondaryEmbedding, broadSearchOpts);
            const secondaryMs = Date.now() - t2;
            log(i, 'rag-search-secondary', {
                status: 'done', resultCount: secondaryResults.length, elapsed: secondaryMs,
                rankedIds: secondaryResults.map(result => `${result.repo}:${result.id}`),
            });
            allResultLists.push({ results: secondaryResults, weight: SECONDARY_QUERY_WEIGHT, channel: 'dense-secondary' });
        }

        // Third search using the bug title directly — the title's natural language
        // often has better semantic overlap with commit summaries than LLM rewrites
        if (workItemContext?.title) {
            const cleanTitle = workItemContext.title.replace(/\[[^\]]*\]\s*/g, '').trim();
            log(i, 'rag-search-title', { status: 'running', query: cleanTitle.slice(0, 80) });
            const t3 = Date.now();
            const titleEmbedding = await embedQuery(cleanTitle);
            const titleResults = await searchVectors(titleEmbedding, broadSearchOpts);
            const titleMs = Date.now() - t3;
            log(i, 'rag-search-title', {
                status: 'done', resultCount: titleResults.length, elapsed: titleMs,
                rankedIds: titleResults.map(result => `${result.repo}:${result.id}`),
            });
            allResultLists.push({ results: titleResults, weight: BUG_TITLE_WEIGHT, channel: 'dense-bug-title' });
        }

        // Merge results using Reciprocal Rank Fusion when multiple queries were used
        let results;
        if (allResultLists.length > 1) {
            results = fuseRankedResults(allResultLists, { k: RRF_K, limit: searchOpts.topK });
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
        let directMatchCount = 0;

        if (allCommitIds.length > 0 && lookupByCommitIds) {
            log(i, 'commit-lookup', { status: 'running', commitIds: allCommitIds });
            const directMatches = await lookupByCommitIds(allCommitIds);
            directMatchCount = directMatches.length;
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
        const rankedResults = results.slice(0, 50).map((result, rank) => ({
            rank: rank + 1,
            repo: result.repo,
            id: result.id,
            commitId: result.commitId,
            score: result.score,
            rrfScore: result._rrfScore,
            channels: result._retrievalChannels,
        }));
        log(i, 'rag-search', {
            status: 'done', resultCount: results.length, embeddingMs, searchMs,
            filters: searchOpts,
            rankedResults,
        });
        if (results.length > 0) {
            console.log(`  [Search] ${results.length} results, top-5 scores: [${topScores}], date range: ${finalDateFrom || 'open'}..${finalDateTo || 'open'}`);
        }

        const evidenceGate = evaluateEvidence({
            query,
            results,
            denseResults: primaryResults,
            lexicalResults,
            filters: {
                repo: intent.repo || undefined,
                author: intent.author || undefined,
                // Only model-extracted user/work-item constraints count as explicit.
                // Automatic default windows and evaluator retry expansions never do.
                dateFrom: intent.dateFrom || undefined,
                dateTo: intent.dateTo || undefined,
                riskLevel: intent.riskLevel || undefined,
                changeType: intent.changeType || undefined,
            },
            directMatchCount,
            specificity: intent.specificity,
            specificityFallback: intent._specificityFallback,
        });
        log(i, 'evidence-gate', {
            status: 'done',
            verdict: evidenceGate.verdict,
            evidenceScore: evidenceGate.evidenceScore,
            reason: evidenceGate.reason,
            features: evidenceGate.features,
            specificity: intent.specificity,
        });

        if (evidenceGate.verdict === 'ASK_USER') {
            const clarification = selectClarification(intent, query);
            return {
                type: 'clarification',
                question: clarification,
                reply: clarification,
                confidence: 0,
                evidenceGate,
                searchMethod: 'agentic',
                iterations: i,
                resultCount: results.length,
                iterationLog,
                ...buildPromptTelemetry(iterationLog),
            };
        }

        if (evidenceGate.verdict === 'ABSTAIN') {
            return {
                type: 'answer',
                reply: 'I could not find sufficiently strong commit evidence for this question in the indexed repository and date range. Try adding a component, file, error term, commit ID, or narrower time window.',
                confidence: 0,
                evidenceGate,
                searchMethod: 'agentic',
                iterations: i,
                resultCount: results.length,
                suspects: [],
                iterationLog,
                ...buildPromptTelemetry(iterationLog),
            };
        }

        if (ENABLE_LLM_RERANKER && directMatchCount === 0 && results.length > 1) {
            log(i, 'commit-reranker', { status: 'running', candidateCount: Math.min(results.length, LLM_RERANK_CANDIDATES) });
            const reranking = await rerankCommits(llmFast || llm, query, results, {
                limit: LLM_RERANK_CANDIDATES,
                correlationId,
            });
            results = reranking.results;
            log(i, 'commit-reranker', {
                status: reranking.applied ? 'done' : 'fallback',
                applied: reranking.applied,
                candidateCount: reranking.candidateCount,
                reason: reranking.reason,
                elapsed: reranking._elapsed,
                promptVersion: reranking._promptVersion,
                promptVariant: reranking._promptVariant,
                structuredOutput: reranking._structuredOutput,
                structuredFallback: reranking._structuredFallback,
                promptTokens: reranking._promptTokens,
                completionTokens: reranking._completionTokens,
                totalTokens: reranking._tokens,
            });
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
        logSynthesisCompletion(i, synthesis);
        console.log(`  [Synthesizer] confidence=${synthesis.confidence}, coverage=${synthesis.searchCoverage}, suspects=${synthesis.suspectCount}, tokens=${synthesis._tokens || '?'}, ${(synthesis._elapsed / 1000).toFixed(1)}s`);

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
            promptVersion: evaluation._promptVersion,
            promptVariant: evaluation._promptVariant,
            structuredOutput: evaluation._structuredOutput,
            structuredFallback: evaluation._structuredFallback,
            parseError: evaluation._parseError,
            promptTokens: evaluation._promptTokens,
            completionTokens: evaluation._completionTokens,
            totalTokens: evaluation._tokens,
        });
        console.log(`  [Evaluator] verdict=${evaluation.verdict}, qualityScore=${evaluation.qualityScore}, fastPath=${evaluation._fastPath || false}`);
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
                logSynthesisCompletion(i, streamedSynthesis, 'final-stream');
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
                logSynthesisCompletion(i, streamedSynthesis, 'final-stream');
                console.log(`  [Pipeline] PARTIAL — streamed final answer with disclaimer (iteration ${i}, ${((Date.now() - pipelineStart) / 1000).toFixed(1)}s total)`);
                return await formatAnswer(streamedSynthesis, 'agentic', i, iterationLog, 'Results may be incomplete — I searched with the best available context.', results, workItemContext, lookupByCommitIds);
            }
            console.log(`  [Pipeline] PARTIAL — returning answer with disclaimer (iteration ${i}, ${((Date.now() - pipelineStart) / 1000).toFixed(1)}s total)`);
            return await formatAnswer(synthesis, 'agentic', i, iterationLog, 'Results may be incomplete — I searched with the best available context.', results, workItemContext, lookupByCommitIds);
        }

        // RETRY — detect a genuinely stale result set rather than only comparing counts.
        const resultKeys = new Set(results.map(result => `${result.repo}:${result.id}`));
        const sameResultSet = prevResultKeys
            && resultKeys.size === prevResultKeys.size
            && [...resultKeys].every(key => prevResultKeys.has(key));
        if (sameResultSet && results.length > 0 && i > 1) {
            console.log(`  [Pipeline] STALE RETRY — result set unchanged (${results.length}), returning as PARTIAL`);
            log(i, 'stale-retry', { resultCount: results.length, reason: 'unchanged-result-set' });
            if (onToken) {
                log(i, 'answer-synthesizer', { status: 'streaming', resultCount: results.length });
                const streamedSynthesis = await synthesizeAnswerStream(llm, results, intent, context, i, onToken);
                logSynthesisCompletion(i, streamedSynthesis, 'final-stream');
                return await formatAnswer(streamedSynthesis, 'agentic', i, iterationLog, 'Results may be incomplete — I searched with the best available context.', results, workItemContext, lookupByCommitIds);
            }
            return await formatAnswer(synthesis, 'agentic', i, iterationLog, 'Results may be incomplete — I searched with the best available context.', results, workItemContext, lookupByCommitIds);
        }
        prevResultKeys = resultKeys;

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
        ...buildPromptTelemetry(iterationLog),
    };
}

function buildPromptTelemetry(iterationLog) {
    const completed = iterationLog.filter(entry => entry.status === 'done' && entry.promptVersion);
    const promptVersions = {};
    for (const entry of completed) promptVersions[entry.stage] = entry.promptVersion;
    return {
        promptVersions,
        promptMetrics: {
            structuredCalls: completed.filter(entry => entry.structuredOutput === true).length,
            structuredFallbacks: completed.filter(entry => entry.structuredFallback === true).length,
            parseErrors: completed.filter(entry => entry.parseError === true).length,
            validationRejections: completed.reduce((sum, entry) => sum + (entry.validationRejections || 0), 0),
            promptTokens: completed.reduce((sum, entry) => sum + (entry.promptTokens || 0), 0),
            completionTokens: completed.reduce((sum, entry) => sum + (entry.completionTokens || 0), 0),
            totalTokens: completed.reduce((sum, entry) => sum + (entry.totalTokens || 0), 0),
        },
    };
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
        ...buildPromptTelemetry(iterationLog),
    };
}

async function fallbackFullContext({ llm, buildFullContext, query, history, iterationLog, i }) {
    const contextText = await buildFullContext();
    const result = await llm.chat.completions.create({
        messages: [
            { role: 'system', content: FALLBACK_SYSTEM_PROMPT },
            ...history.map(h => ({ role: h.role, content: h.content })),
            { role: 'user', content: JSON.stringify({ query, commitSummaries: contextText }) },
        ],
        temperature: 0.3,
    });

    const telemetry = buildPromptTelemetry(iterationLog);
    return {
        type: 'answer',
        reply: result.choices?.[0]?.message?.content ?? 'No response from LLM.',
        searchMethod: 'fallback-full',
        iterations: i,
        iterationLog,
        promptVersions: { ...telemetry.promptVersions, fallback: 'fallback-v1' },
        promptMetrics: telemetry.promptMetrics,
    };
}
