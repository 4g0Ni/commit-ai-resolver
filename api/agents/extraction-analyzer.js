/**
 * Agent 2: Extraction Analyzer
 *
 * Evaluates the quality of the Intent Extractor's output.
 * Decides: GOOD (proceed), REFORMULATE (try again with feedback), or ASK_USER (need clarification).
 */

/**
 * @param {AzureOpenAI} llm - OpenAI client
 * @param {object} intent - Output from Intent Extractor
 * @param {object} context - { query, history }
 * @returns {Promise<object>} Analysis verdict
 */
export async function analyzeExtraction(llm, intent, context) {
    const { query } = context;

    const prompt = `You are a quality evaluator for search intent extraction. Analyze whether the extracted filters are good enough to search a commit database.

ORIGINAL USER QUERY: "${query.replace(/"/g, '\\"')}"

EXTRACTED INTENT:
${JSON.stringify(intent, null, 2)}

Evaluate on these criteria:
1. FILTER COHERENCE: Do the filters make logical sense together?
2. DATE RANGE: Is the date range reasonable? (>14 days is too broad unless explicitly asked; missing dates when query implies recency is a problem)
3. SEARCH QUERY QUALITY: Is the rewritten search query specific enough for embedding similarity? ("code changes" or "modifications" alone are too generic)
4. CONFIDENCE: Is the self-reported confidence believable given the query?
5. AMBIGUITIES: Are flagged ambiguities real blockers or can we proceed?

Return ONLY a JSON object:
{
  "verdict": "GOOD" | "REFORMULATE" | "ASK_USER",
  "issues": ["list of specific problems found"],
  "suggestions": ["actionable suggestions to fix the issues"],
  "reformulatedQuery": "improved search query text (only if verdict=REFORMULATE)",
  "clarificationQuestion": "question to ask the user (only if verdict=ASK_USER)"
}

Rules:
- verdict=GOOD if confidence >= 0.5 AND search query contains at least one technical term. Prefer GOOD — it's better to search and evaluate results than to keep reformulating.
- verdict=REFORMULATE only if the search query is clearly too vague to match anything (e.g., just "changes" or "code") AND you can provide a significantly better version. Max 1 reformulation per pipeline run.
- verdict=ASK_USER only if the query is genuinely too ambiguous to produce useful results (e.g., "something broke" with zero context about what/when/where)
- Be lenient — prefer GOOD over REFORMULATE. Searching with an imperfect query is better than not searching at all.`;

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
            return { verdict: 'GOOD', issues: [], suggestions: [], _elapsed: Date.now() - t0 };
        }
        const parsed = JSON.parse(jsonMatch[0]);
        return {
            verdict: ['GOOD', 'REFORMULATE', 'ASK_USER'].includes(parsed.verdict) ? parsed.verdict : 'GOOD',
            issues: parsed.issues || [],
            suggestions: parsed.suggestions || [],
            reformulatedQuery: parsed.reformulatedQuery || null,
            clarificationQuestion: parsed.clarificationQuestion || null,
            _elapsed: Date.now() - t0,
        };
    } catch (err) {
        console.error('  [ExtractionAnalyzer] failed:', err.message);
        // On error, proceed rather than blocking
        return { verdict: 'GOOD', issues: ['analyzer error'], suggestions: [], _elapsed: Date.now() - t0 };
    }
}
