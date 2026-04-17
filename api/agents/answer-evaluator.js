/**
 * Agent 4: Answer Evaluator
 *
 * Evaluates the quality of the synthesized answer.
 * Decides: PASS (return to user), RETRY (search again with refined query), or PARTIAL (return with disclaimer).
 */

/**
 * @param {AzureOpenAI} llm - OpenAI client
 * @param {object} synthesis - Output from Answer Synthesizer
 * @param {object} context - { query, history, iteration }
 * @param {Array} results - RAG search results
 * @returns {Promise<object>} Evaluation verdict with retry strategy
 */
export async function evaluateAnswer(llm, synthesis, context, results, maxIterations = 3) {
    const { query, iteration = 1 } = context;

    // Fast-path: if synthesizer is confident with enough results, skip LLM eval
    if (synthesis.confidence >= 0.65 && synthesis.resultCount >= 3) {
        console.log(`  [Evaluator] fast-path PASS: confidence=${synthesis.confidence} >= 0.65, results=${synthesis.resultCount} >= 3`);
        return {
            verdict: 'PASS',
            qualityScore: synthesis.confidence,
            issues: [],
            retryStrategy: null,
            _elapsed: 0,
            _fastPath: true,
        };
    }

    // Fast-path: if this is the last iteration, just return what we have
    if (iteration >= 3) {
        const verdict = synthesis.confidence >= 0.4 ? 'PASS' : 'PARTIAL';
        console.log(`  [Evaluator] fast-path ${verdict}: last iteration (${iteration}), confidence=${synthesis.confidence}`);
        return {
            verdict,
            qualityScore: synthesis.confidence,
            issues: ['max iterations reached'],
            retryStrategy: null,
            _elapsed: 0,
            _fastPath: true,
        };
    }

    const prompt = `You are a quality evaluator for an AI-generated answer about code commits.

USER QUESTION: "${query.replace(/"/g, '\\"')}"

ANSWER METADATA:
- Self-reported confidence: ${synthesis.confidence}
- Search coverage: ${synthesis.searchCoverage}
- Results found: ${synthesis.resultCount}
- Score stats: avg=${synthesis.scoreStats?.avgScore}, max=${synthesis.scoreStats?.maxScore}, min=${synthesis.scoreStats?.minScore}
- Iteration: ${iteration} of ${maxIterations}

ANSWER (first 500 chars):
${synthesis.answer.slice(0, 500)}

Evaluate the answer quality and decide whether to return it or retry with a different search.

Return ONLY a JSON object:
{
  "verdict": "PASS" | "RETRY" | "PARTIAL",
  "qualityScore": 0.0-1.0,
  "issues": ["list of problems"],
  "retryStrategy": {
    "action": "broaden_search" | "add_keywords" | "expand_dates" | "try_different_repo" | "remove_filters",
    "newKeywords": ["additional search terms"],
    "expandedDateFrom": "YYYY-MM-DD or null",
    "expandedDateTo": "YYYY-MM-DD or null",
    "reasoning": "why this retry strategy"
  }
}

Rules:
- PASS if qualityScore >= 0.7 — answer is good enough to return
- RETRY if qualityScore < 0.5 AND iteration < 4 — worth trying again with different search
- PARTIAL if qualityScore 0.5-0.7 OR iteration >= 4 — return with caveat that results may be incomplete
- retryStrategy is required when verdict=RETRY, null otherwise
- For retryStrategy, suggest SPECIFIC additional keywords related to the user's question that weren't in the original search`;

    const t0 = Date.now();
    try {
        const result = await llm.chat.completions.create({
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            max_completion_tokens: 512,
        });
        const text = result.choices?.[0]?.message?.content?.trim() || '{}';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return { verdict: 'PASS', qualityScore: synthesis.confidence, issues: [], retryStrategy: null, _elapsed: Date.now() - t0 };
        }
        const parsed = JSON.parse(jsonMatch[0]);
        return {
            verdict: ['PASS', 'RETRY', 'PARTIAL'].includes(parsed.verdict) ? parsed.verdict : 'PASS',
            qualityScore: typeof parsed.qualityScore === 'number' ? parsed.qualityScore : synthesis.confidence,
            issues: parsed.issues || [],
            retryStrategy: parsed.retryStrategy || null,
            _elapsed: Date.now() - t0,
        };
    } catch (err) {
        console.error('  [AnswerEvaluator] failed:', err.message);
        return { verdict: 'PASS', qualityScore: synthesis.confidence, issues: ['evaluator error'], retryStrategy: null, _elapsed: Date.now() - t0 };
    }
}
