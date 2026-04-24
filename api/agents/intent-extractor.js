/**
 * Agent 1: Intent Extractor
 *
 * Extracts structured search filters + confidence from a natural language query.
 * Accepts optional feedback from the Extraction Analyzer for reformulation.
 */

/** Extract commit SHA patterns (7-40 hex chars) from query text. */
function extractCommitIds(query) {
    // Match 7-40 character hex strings that look like git SHAs
    // Avoid matching common hex words/numbers by requiring 7+ chars
    const matches = query.match(/\b[0-9a-f]{7,40}\b/gi) || [];
    return [...new Set(matches.map(m => m.toLowerCase()))];
}

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
    const { query, history = [], feedback, workItemContext } = context;
    const today = new Date().toISOString().slice(0, 10);
    const repoList = 'AdsAppsCampaignUI, AdsAppsMT, AdsAppUI, AnB, AdsAppsDB';

    let feedbackBlock = '';
    if (feedback) {
        feedbackBlock = `\n\nPREVIOUS ATTEMPT FEEDBACK — Use this to improve your extraction:
Issues: ${JSON.stringify(feedback.issues || feedback.reasoning || feedback)}
Suggestions: ${JSON.stringify(feedback.suggestions || feedback.retryStrategy || '')}
${feedback.reformulatedQuery ? `Suggested reformulation: "${feedback.reformulatedQuery}"` : ''}
${feedback.newKeywords ? `Additional keywords to include: ${feedback.newKeywords.join(', ')}` : ''}`;
    }

    const conversationContext = history.length > 0
        ? `\nRecent conversation for context:\n${history.slice(-4).map(h => `${h.role}: ${h.content?.slice(0, 200)}`).join('\n')}\n\nIMPORTANT: The user's current message may be a follow-up that references or refines a previous question. If the current message is short or uses words like "I mean", "actually", "but for", "instead", "no", "change to", etc., treat it as a REFINEMENT of the previous query — carry forward all filters (repo, keywords, topic) from the prior question and only modify what the user is explicitly changing. Do NOT generate a generic search query when the user is clearly refining a prior specific question.\n`
        : '';

    const priorCommitContext = context.priorSuspects?.length > 0
        ? `\nCommit IDs from previous search results that the user may reference: ${context.priorSuspects.map(s => s.commitId).join(', ')}\n`
        : '';

    const prompt = `Extract search filters from the user's question about code commits. Today is ${today}.
${conversationContext}
${priorCommitContext}
Return ONLY a JSON object with these fields (use null for missing):
- "author": full person name if asking about a specific person's commits (null if not person-specific)
- "repo": exact repo name from [${repoList}] if mentioned. Recognize aliases: "campaignui"/"cmui" → AdsAppsCampaignUI, "mt"/"middle tier" → AdsAppsMT, "appui"/"shell"/"uiserver" → AdsAppUI, "anb"/"ccdb"/"ccmt"/"client center db"/"client center mt" → AnB, "cmdb"/"campaign db"/"db"/"adsappsdb" → AdsAppsDB. (null if not repo-specific)
- "dateFrom": start date YYYY-MM-DD if a time range is mentioned. For incident/regression queries ("spike", "broke", "error", "crash", "regression", "production issue", "live-site"), expand the start date 2 days earlier to account for release buffer. For "this week", use Monday of the current week. For "recently" or vague time references, use 30 days ago. If the user does not mention any time range, use null — the system will apply a sensible default. (null if open-ended)
- "dateTo": end date YYYY-MM-DD if a time range is mentioned (null if open-ended)
- "searchQuery": a rewritten version optimized for semantic search against commit summaries. Remove person names and date references. Keep the technical intent specific. For author queries, include broad technical terms like "feature implementation configuration API change". For broad queries like "what changed", use "code changes features configuration deployment updates".
- "secondarySearchQuery": (only when a work item/bug context is provided) a SECOND, DIFFERENT semantic query focusing on the fix mechanism — component names, template changes, routing, configuration keys, data model, CSS/layout. Use different terms from searchQuery. (null if no work item context)
- "riskLevel": "HIGH", "MEDIUM", or "LOW" if the user is asking about a specific risk level (null if not risk-specific)
- "changeType": "config", "code", or "mixed" if the user is asking about config/pilot/flag changes vs code changes (null if not type-specific)
- "keywords": array of 3-6 specific technical keywords for fallback text matching
- "confidence": number 0-1 indicating how confident you are in the extraction accuracy
- "ambiguities": array of strings describing any parts of the query that are unclear or could be interpreted multiple ways (empty array if everything is clear)
- "verdict": "GOOD" or "ASK_USER". Use "GOOD" if confidence >= 0.3 or the search query contains at least one technical term. Use "ASK_USER" ONLY if the query is genuinely too ambiguous to produce useful results (e.g., "something broke" with zero context about what/when/where).
- "clarificationQuestion": a specific question to ask the user (only when verdict is "ASK_USER", null otherwise)

Examples:
User: "what did Beina Zhang change last week"
{"author":"Beina Zhang","repo":null,"dateFrom":"${daysAgo(7, today)}","dateTo":"${today}","searchQuery":"feature implementation configuration API code changes deployment updates","riskLevel":null,"changeType":null,"keywords":["feature","implementation","configuration","API","changes"],"confidence":0.9,"ambiguities":[],"verdict":"GOOD","clarificationQuestion":null}

User: "show me all HIGH risk changes this week"
{"author":null,"repo":null,"dateFrom":"${daysAgo(7, today)}","dateTo":"${today}","searchQuery":"high risk breaking changes pilot ramp deployment configuration removal","riskLevel":"HIGH","changeType":null,"keywords":["high","risk","breaking","pilot","ramp","deployment"],"confidence":0.9,"ambiguities":[],"verdict":"GOOD","clarificationQuestion":null}

User: "what pilot flags were changed recently"
{"author":null,"repo":null,"dateFrom":"${daysAgo(30, today)}","dateTo":"${today}","searchQuery":"pilot flag feature gate configuration ramp percentage rollout enable disable","riskLevel":null,"changeType":"config","keywords":["pilot","flag","config","ramp","feature","gate"],"confidence":0.85,"ambiguities":[],"verdict":"GOOD","clarificationQuestion":null}

User: "something broke"
{"author":null,"repo":null,"dateFrom":null,"dateTo":null,"searchQuery":"bug error crash broken regression","riskLevel":null,"changeType":null,"keywords":["bug","error","crash","broken","regression"],"confidence":0.3,"ambiguities":["which page or feature is affected?","when did the issue start?","what kind of breakage — errors, crashes, or slowness?"],"verdict":"ASK_USER","clarificationQuestion":"What exactly broke, in which feature or area, and roughly when did it start happening?"}
${feedbackBlock}${workItemContext ? `

WORK ITEM CONTEXT — The user is asking about this Azure DevOps ${workItemContext.type}:
ID: ${workItemContext.id}
Title: ${workItemContext.title}
State: ${workItemContext.state}
Created: ${workItemContext.createdDate}
Area: ${workItemContext.areaPath || 'N/A'}
Description: ${(workItemContext.description || '').slice(0, 500)}
${workItemContext.reproSteps ? `Repro Steps: ${workItemContext.reproSteps.slice(0, 300)}` : ''}

IMPORTANT: Use the bug title and description to craft a highly targeted searchQuery with specific technical terms, feature names, error messages, and affected areas from the bug. Set dateFrom to 2 days before the bug creation date (${workItemContext.createdDate.slice(0, 10)}) and dateTo to the bug creation date. Your verdict MUST be "GOOD" since the work item provides sufficient context.

ALSO produce a "secondarySearchQuery" — a DIFFERENT semantic query that focuses on the FIX MECHANISM rather than the symptom. Think about what a developer would change to fix this bug: component names, template files, configuration keys, routing changes, data model changes, CSS/layout changes. The secondary query should use DIFFERENT terms from searchQuery to maximize coverage.
Example: if the bug is "grid is missing on campaign page", searchQuery might be "campaign grid missing data display", but secondarySearchQuery should be "grid template component render view reset filters hide show".` : ''}

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
            secondarySearchQuery: parsed.secondarySearchQuery || null,
            riskLevel: parsed.riskLevel || null,
            changeType: parsed.changeType || null,
            commitIds: extractCommitIds(query),
            keywords: parsed.keywords || [],
            confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
            ambiguities: parsed.ambiguities || [],
            verdict: ['GOOD', 'ASK_USER'].includes(parsed.verdict) ? parsed.verdict : 'GOOD',
            clarificationQuestion: parsed.clarificationQuestion || null,
            _elapsed: Date.now() - t0,
        };
    } catch (err) {
        console.error('  [IntentExtractor] failed:', err.message);
        return { searchQuery: query, keywords: [], confidence: 0.2, ambiguities: ['extraction error'], verdict: 'GOOD', clarificationQuestion: null, _elapsed: Date.now() - t0 };
    }
}
