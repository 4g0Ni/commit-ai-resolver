/**
 * Agent 1: Intent Extractor
 *
 * Extracts structured search filters + confidence from a natural language query.
 * Accepts optional feedback from the Extraction Analyzer for reformulation.
 */

function daysAgo(n, today) {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
}

/**
 * @param {AzureOpenAI} llm - OpenAI client
 * @param {object} context
 * @param {string} context.query - Original user query
 * @param {Array} context.history - Conversation history
 * @param {object|null} context.feedback - Feedback from Analyzer or Evaluator on previous attempt
 * @returns {Promise<object>} Structured intent
 */
export async function extractIntent(llm, context) {
    const { query, history = [], feedback } = context;
    const today = new Date().toISOString().slice(0, 10);
    const repoList = 'AdsAppsCampaignUI, AdsAppsMT, AdsAppUI';

    let feedbackBlock = '';
    if (feedback) {
        feedbackBlock = `\n\nPREVIOUS ATTEMPT FEEDBACK — Use this to improve your extraction:
Issues: ${JSON.stringify(feedback.issues || feedback.reasoning || feedback)}
Suggestions: ${JSON.stringify(feedback.suggestions || feedback.retryStrategy || '')}
${feedback.reformulatedQuery ? `Suggested reformulation: "${feedback.reformulatedQuery}"` : ''}
${feedback.newKeywords ? `Additional keywords to include: ${feedback.newKeywords.join(', ')}` : ''}`;
    }

    const conversationContext = history.length > 0
        ? `\nRecent conversation for context:\n${history.slice(-4).map(h => `${h.role}: ${h.content?.slice(0, 200)}`).join('\n')}\n`
        : '';

    const prompt = `Extract search filters from the user's question about code commits. Today is ${today}.
${conversationContext}
Return ONLY a JSON object with these fields (use null for missing):
- "author": full person name if asking about a specific person's commits (null if not person-specific)
- "repo": exact repo name from [${repoList}] if mentioned. Recognize aliases: "campaignui"/"cmui" → AdsAppsCampaignUI, "mt"/"middle tier" → AdsAppsMT, "appui"/"shell" → AdsAppUI. (null if not repo-specific)
- "dateFrom": start date YYYY-MM-DD if a time range is mentioned (null if open-ended)
- "dateTo": end date YYYY-MM-DD if a time range is mentioned (null if open-ended)
- "searchQuery": a rewritten version optimized for semantic search against commit summaries. Remove person names and date references, keep the technical intent.
- "keywords": array of 3-6 specific technical keywords for fallback text matching
- "confidence": number 0-1 indicating how confident you are in the extraction accuracy
- "ambiguities": array of strings describing any parts of the query that are unclear or could be interpreted multiple ways (empty array if everything is clear)

Examples:
User: "what did Beina Zhang change last week"
{"author":"Beina Zhang","repo":null,"dateFrom":"${daysAgo(7, today)}","dateTo":"${today}","searchQuery":"code changes and modifications","keywords":["changes","modifications","code"],"confidence":0.9,"ambiguities":[]}

User: "something broke"
{"author":null,"repo":null,"dateFrom":null,"dateTo":null,"searchQuery":"bug error crash broken regression","keywords":["bug","error","crash","broken","regression"],"confidence":0.3,"ambiguities":["which page or feature is affected?","when did the issue start?","what kind of breakage — errors, crashes, or slowness?"]}
${feedbackBlock}

Now extract from:
User: "${query.replace(/"/g, '\\"')}"`;

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
            return { searchQuery: query, keywords: [], confidence: 0.3, ambiguities: ['failed to parse extraction'], _elapsed: Date.now() - t0 };
        }
        const parsed = JSON.parse(jsonMatch[0]);
        return {
            author: parsed.author || null,
            repo: parsed.repo || null,
            dateFrom: parsed.dateFrom || null,
            dateTo: parsed.dateTo || null,
            searchQuery: parsed.searchQuery || query,
            keywords: parsed.keywords || [],
            confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
            ambiguities: parsed.ambiguities || [],
            _elapsed: Date.now() - t0,
        };
    } catch (err) {
        console.error('  [IntentExtractor] failed:', err.message);
        return { searchQuery: query, keywords: [], confidence: 0.2, ambiguities: ['extraction error'], _elapsed: Date.now() - t0 };
    }
}
