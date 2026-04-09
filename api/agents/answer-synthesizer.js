/**
 * Agent 3: Answer Synthesizer
 *
 * Analyzes RAG search results and generates a structured answer
 * with ranked suspects, commit links, and confidence assessment.
 */

/**
 * @param {AzureOpenAI} llm - OpenAI client
 * @param {Array} results - RAG search results (commits with metadata)
 * @param {object} intent - Extracted intent from Agent 1
 * @param {object} context - { query, history }
 * @returns {Promise<object>} Structured answer with suspects and confidence
 */
export async function synthesizeAnswer(llm, results, intent, context) {
    const { query, history = [] } = context;

    const commitContext = results.map(r =>
        `[${r.date}] ${r.repo} | ${r.metadata.riskLevel} | ${r.id} by ${r.metadata.author}\n` +
        `  URL: ${r.metadata.url || 'N/A'}\n` +
        `  Title: ${r.metadata.title}\n` +
        `  Summary: ${r.metadata.summary}\n` +
        (r.metadata.flags?.length ? `  Flags: ${r.metadata.flags.join(', ')}\n` : '') +
        (r.metadata.affectedAreas?.length ? `  Areas: ${r.metadata.affectedAreas.join(', ')}\n` : '') +
        `  Similarity: ${r.score.toFixed(3)}`
    ).join('\n\n');

    const scoreStats = results.length > 0 ? {
        count: results.length,
        avgScore: (results.reduce((s, r) => s + r.score, 0) / results.length).toFixed(3),
        maxScore: Math.max(...results.map(r => r.score)).toFixed(3),
        minScore: Math.min(...results.map(r => r.score)).toFixed(3),
    } : { count: 0, avgScore: 0, maxScore: 0, minScore: 0 };

    const conversationContext = history.length > 0
        ? `\nConversation context:\n${history.slice(-4).map(h => `${h.role}: ${h.content?.slice(0, 200)}`).join('\n')}\n`
        : '';

    const systemPrompt = `You are an expert change analysis assistant for the Microsoft Advertising engineering team.
Analyze the search results and generate a comprehensive answer to the user's question.
${conversationContext}

SEARCH METADATA:
- Results found: ${scoreStats.count}
- Score range: ${scoreStats.minScore} – ${scoreStats.maxScore} (avg: ${scoreStats.avgScore})
- Search query used: "${intent.searchQuery}"
- Filters applied: author=${intent.author || 'any'}, repo=${intent.repo || 'any'}, dates=${intent.dateFrom || 'open'}..${intent.dateTo || 'open'}

COMMIT DATA:
${commitContext || '(no results found)'}

INSTRUCTIONS:
1. Answer the user's question based ONLY on the commit data above. Do NOT hallucinate commits that aren't listed.
2. Rank suspect commits by relevance. For each suspect, explain WHY it might be related.
3. Always include commit SHAs and author names when referencing changes.
4. When correlating with incidents, consider a 2-day release buffer.
5. Be concise and actionable.

After your answer, output a JSON block on a new line starting with |||JSON||| containing:
{
  "confidence": 0.0-1.0,
  "searchCoverage": "full" | "partial" | "insufficient",
  "suspectCount": number,
  "suggestedActions": ["actionable next steps"]
}

Rules for confidence:
- 0.8-1.0: Strong match — multiple relevant commits found with high similarity scores
- 0.5-0.7: Moderate — some relevant results but not conclusive
- 0.2-0.4: Weak — few results, low scores, or tangential matches
- 0.0-0.2: Very weak — essentially no useful results found

Rules for searchCoverage:
- "full": 10+ results with avg score > 0.4
- "partial": 3-10 results or avg score 0.2-0.4
- "insufficient": < 3 results or avg score < 0.2`;

    const t0 = Date.now();
    try {
        const result = await llm.chat.completions.create({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: query },
            ],
            temperature: 0.3,
            max_completion_tokens: 2048,
        });
        const fullText = result.choices?.[0]?.message?.content ?? '';

        // Parse out the JSON metadata block
        let answer = fullText;
        let metadata = { confidence: 0.5, searchCoverage: 'partial', suspectCount: 0, suggestedActions: [] };

        const jsonSplit = fullText.split('|||JSON|||');
        if (jsonSplit.length > 1) {
            answer = jsonSplit[0].trim();
            try {
                const jsonMatch = jsonSplit[1].match(/\{[\s\S]*\}/);
                if (jsonMatch) metadata = { ...metadata, ...JSON.parse(jsonMatch[0]) };
            } catch { /* keep defaults */ }
        }

        return {
            answer,
            confidence: metadata.confidence,
            searchCoverage: metadata.searchCoverage,
            suspectCount: metadata.suspectCount,
            suggestedActions: metadata.suggestedActions,
            resultCount: results.length,
            scoreStats,
            _elapsed: Date.now() - t0,
            _tokens: result.usage?.total_tokens,
        };
    } catch (err) {
        console.error('  [AnswerSynthesizer] failed:', err.message);
        return {
            answer: 'I encountered an error while analyzing the results. Please try again.',
            confidence: 0,
            searchCoverage: 'insufficient',
            suspectCount: 0,
            suggestedActions: [],
            resultCount: results.length,
            scoreStats,
            _elapsed: Date.now() - t0,
        };
    }
}
