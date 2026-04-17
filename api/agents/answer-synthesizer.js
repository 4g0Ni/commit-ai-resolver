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
export async function synthesizeAnswer(llm, results, intent, context, iteration = 1) {
    const { query, history = [], workItemContext } = context;

    const topN = workItemContext ? 15 : 10;
    const commitContext = results.slice(0, topN).map(r =>
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

    const priorSuspectsContext = context.priorSuspects?.length > 0
        ? `\nPreviously discussed commits (user may reference these):\n${context.priorSuspects.slice(-10).map(s =>
            `- ${s.commitId} (${s.repo}) by ${s.author}: ${s.title}`).join('\n')}\n`
        : '';

    const bugContextSection = workItemContext ? `
BUG CONTEXT — The user is investigating this work item:
Title: ${workItemContext.title}
Type: ${workItemContext.type} | State: ${workItemContext.state}
Created: ${workItemContext.createdDate}
Description: ${(workItemContext.description || '').slice(0, 500)}
${workItemContext.reproSteps ? `Repro Steps: ${workItemContext.reproSteps.slice(0, 300)}` : ''}
${workItemContext.images?.length ? `\nAttached screenshots from the bug report are included as images in this message. Use them to understand the visual symptom and correlate with suspect commits.` : ''}
When ranking suspects, consider ALL categories of changes that could cause the bug:
- Navigation/routing changes that could prevent a page or component from loading
- Template/rendering changes that could hide, remove, or break UI elements
- Data-fetching changes that could return empty or incorrect data
- Config/pilot changes that could gate or disable features
- Shared component changes (grid, table, layout) that could affect the affected area
Explain specifically how each suspect's changes relate to the bug symptom.
` : '';

    const systemPrompt = `You are an expert change analysis assistant for the Microsoft Advertising engineering team.
Analyze the search results and generate a comprehensive answer to the user's question.
${conversationContext}
${priorSuspectsContext}
${bugContextSection}
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
4. For EVERY commit you mention, include a clickable markdown link using the URL from the data. Format: [shortId](url). Example: [abc123](https://msasg.visualstudio.com/...). If a URL is "N/A" or missing, just show the SHA without a link.
5. When correlating with incidents, consider a 2-day release buffer.
6. Be concise and actionable.

After your answer, output a JSON block on a new line starting with |||JSON||| containing:
{
  "confidence": 0.0-1.0,
  "searchCoverage": "full" | "partial" | "insufficient",
  "suspectCount": number,
  "rankedSuspects": ["shortId1", "shortId2", ...],
  "suggestedActions": ["actionable next steps"]
}

Rules for suggestedActions:
- Only suggest actions that THIS TOOL can perform — i.e., commit search, diff inspection, and code change analysis.
- GOOD examples: "Investigate the diff for commit 519cdc3f to see exact code changes", "Search for other commits by the same author in this date range", "Check config/pilot changes in AdsAppUI around the same date", "Look at related commits in the shared grid component", "Broaden the date range to find earlier related changes"
- BAD examples (do NOT suggest these): "Reproduce the bug in staging", "Check runtime logs", "Monitor production metrics", "Verify in the browser", "Run tests locally", "Check network responses", "Deploy a fix", "Revert the commit", "Contact the author"
- Keep suggestions focused on deeper commit/code investigation that the user can do through this chat interface.

Rules for rankedSuspects:
- List the commit shortIds in order from most to least likely suspect
- Include ALL commits you mentioned as suspects in your answer
- The first entry should be your #1 suspect

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
        // Build user message: plain text or multimodal with bug screenshots
        // Only include images on the first iteration — retries already have text context
        const bugImages = (iteration === 1) ? (workItemContext?.images || []) : [];
        let userContent;
        if (bugImages.length > 0) {
            console.log(`  [Synthesizer] multimodal: ${bugImages.length} image(s), ${results.length} commits (top ${topN})`);
            userContent = [
                { type: 'text', text: query },
                ...bugImages.map(img => ({
                    type: 'image_url',
                    image_url: { url: img.base64DataUrl, detail: 'low' },
                })),
            ];
        } else {
            userContent = query;
        }

        const result = await llm.chat.completions.create({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent },
            ],
            temperature: 0.3,
        });
        const fullText = result.choices?.[0]?.message?.content ?? '';
        const finishReason = result.choices?.[0]?.finish_reason;
        const usage = result.usage;
        console.log(`  [Synthesizer] LLM done: ${((Date.now() - t0) / 1000).toFixed(1)}s, prompt=${usage?.prompt_tokens || '?'} completion=${usage?.completion_tokens || '?'} total=${usage?.total_tokens || '?'}, finish=${finishReason}`);
        if (finishReason === 'length') {
            console.warn(`  [Synthesizer] WARNING: output truncated at max_completion_tokens — JSON metadata block likely missing`);
        }

        // Guard: if LLM returned empty, return a meaningful fallback
        if (!fullText.trim()) {
            return {
                answer: `I found ${results.length} commits matching your query but was unable to generate a summary. The top results were from ${[...new Set(results.slice(0, 5).map(r => r.repo))].join(', ')}.`,
                confidence: 0.3,
                searchCoverage: results.length >= 10 ? 'partial' : 'insufficient',
                suspectCount: 0,
                suggestedActions: ['Try a more specific query'],
                resultCount: results.length,
                scoreStats,
                _elapsed: Date.now() - t0,
            };
        }

        // Parse out the JSON metadata block
        let answer = fullText;
        let metadata = { confidence: 0.5, searchCoverage: 'partial', suspectCount: 0, rankedSuspects: [], suggestedActions: [] };

        const jsonSplit = fullText.split('|||JSON|||');
        if (jsonSplit.length > 1) {
            answer = jsonSplit[0].trim();
            try {
                const jsonMatch = jsonSplit[1].match(/\{[\s\S]*\}/);
                if (jsonMatch) metadata = { ...metadata, ...JSON.parse(jsonMatch[0]) };
            } catch { /* keep defaults */ }
        } else if (finishReason === 'length') {
            // Output was truncated — JSON block is missing.
            // Try to extract suspect commit IDs from the answer text using markdown links [shortId](url)
            const commitRefs = [...answer.matchAll(/\[([a-f0-9]{6,10})\]\(https?:\/\/[^)]+\)/g)];
            const extractedIds = [...new Set(commitRefs.map(m => m[1]))];
            if (extractedIds.length > 0) {
                metadata.rankedSuspects = extractedIds;
                metadata.suspectCount = extractedIds.length;
                metadata.confidence = 0.55; // reasonable default for a real answer with suspects
                metadata.searchCoverage = 'partial';
                console.log(`  [Synthesizer] truncation recovery: extracted ${extractedIds.length} suspect(s) from answer text: ${extractedIds.join(', ')}`);
            }
        }

        // Clamp confidence based on objective metrics to prevent inflated scores
        let confidence = metadata.confidence;
        if (results.length === 0) {
            confidence = 0;
        } else if (results.length <= 2 && parseFloat(scoreStats.avgScore) < 0.3) {
            confidence = Math.min(confidence, 0.5);
        }

        return {
            answer,
            confidence,
            searchCoverage: metadata.searchCoverage,
            suspectCount: metadata.suspectCount,
            rankedSuspects: metadata.rankedSuspects || [],
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

/**
 * Streaming version of synthesizeAnswer — yields answer tokens via onToken callback.
 * Returns the same structured result as synthesizeAnswer.
 *
 * @param {AzureOpenAI} llm - OpenAI client
 * @param {Array} results - RAG search results
 * @param {object} intent - Extracted intent
 * @param {object} context - { query, history }
 * @param {number} iteration
 * @param {Function} onToken - Called with each text chunk: (token: string) => void
 * @returns {Promise<object>} Same as synthesizeAnswer
 */
export async function synthesizeAnswerStream(llm, results, intent, context, iteration = 1, onToken) {
    const { query, workItemContext } = context;

    const topN = workItemContext ? 15 : 10;
    const commitContext = results.slice(0, topN).map(r =>
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

    const conversationContext = context.history?.length > 0
        ? `\nConversation context:\n${context.history.slice(-4).map(h => `${h.role}: ${h.content?.slice(0, 200)}`).join('\n')}\n`
        : '';

    const priorSuspectsContext = context.priorSuspects?.length > 0
        ? `\nPreviously discussed commits (user may reference these):\n${context.priorSuspects.slice(-10).map(s =>
            `- ${s.commitId} (${s.repo}) by ${s.author}: ${s.title}`).join('\n')}\n`
        : '';

    const bugContextSection = workItemContext ? `
BUG CONTEXT — The user is investigating this work item:
Title: ${workItemContext.title}
Type: ${workItemContext.type} | State: ${workItemContext.state}
Created: ${workItemContext.createdDate}
Description: ${(workItemContext.description || '').slice(0, 500)}
${workItemContext.reproSteps ? `Repro Steps: ${workItemContext.reproSteps.slice(0, 300)}` : ''}
${workItemContext.images?.length ? `\nAttached screenshots from the bug report are included as images in this message. Use them to understand the visual symptom and correlate with suspect commits.` : ''}
When ranking suspects, consider ALL categories of changes that could cause the bug:
- Navigation/routing changes that could prevent a page or component from loading
- Template/rendering changes that could hide, remove, or break UI elements
- Data-fetching changes that could return empty or incorrect data
- Config/pilot changes that could gate or disable features
- Shared component changes (grid, table, layout) that could affect the affected area
Explain specifically how each suspect's changes relate to the bug symptom.
` : '';

    // Reuse the same system prompt from synthesizeAnswer
    const systemPrompt = `You are an expert change analysis assistant for the Microsoft Advertising engineering team.
Analyze the search results and generate a comprehensive answer to the user's question.
${conversationContext}
${priorSuspectsContext}
${bugContextSection}
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
4. For EVERY commit you mention, include a clickable markdown link using the URL from the data. Format: [shortId](url). Example: [abc123](https://msasg.visualstudio.com/...). If a URL is "N/A" or missing, just show the SHA without a link.
5. When correlating with incidents, consider a 2-day release buffer.
6. Be concise and actionable.

After your answer, output a JSON block on a new line starting with |||JSON||| containing:
{
  "confidence": 0.0-1.0,
  "searchCoverage": "full" | "partial" | "insufficient",
  "suspectCount": number,
  "rankedSuspects": ["shortId1", "shortId2", ...],
  "suggestedActions": ["actionable next steps"]
}

Rules for suggestedActions:
- Only suggest actions that THIS TOOL can perform — i.e., commit search, diff inspection, and code change analysis.
- GOOD examples: "Investigate the diff for commit 519cdc3f to see exact code changes", "Search for other commits by the same author in this date range", "Check config/pilot changes in AdsAppUI around the same date", "Look at related commits in the shared grid component", "Broaden the date range to find earlier related changes"
- BAD examples (do NOT suggest these): "Reproduce the bug in staging", "Check runtime logs", "Monitor production metrics", "Verify in the browser", "Run tests locally", "Check network responses", "Deploy a fix", "Revert the commit", "Contact the author"
- Keep suggestions focused on deeper commit/code investigation that the user can do through this chat interface.

Rules for rankedSuspects:
- List the commit shortIds in order from most to least likely suspect
- Include ALL commits you mentioned as suspects in your answer
- The first entry should be your #1 suspect

Rules for confidence:
- 0.8-1.0: Strong match — multiple relevant commits found with high similarity scores
- 0.5-0.7: Moderate — some relevant results but not conclusive
- 0.2-0.4: Weak — few results, low scores, or tangential matches
- 0.0-0.2: Very weak — essentially no useful results found

Rules for searchCoverage:
- "full": 10+ results with avg score > 0.4
- "partial": 3-10 results or avg score 0.2-0.4
- "insufficient": < 3 results or avg score < 0.2`;

    const bugImages = (iteration === 1) ? (workItemContext?.images || []) : [];
    let userContent;
    if (bugImages.length > 0) {
        userContent = [
            { type: 'text', text: query },
            ...bugImages.map(img => ({
                type: 'image_url',
                image_url: { url: img.base64DataUrl, detail: 'low' },
            })),
        ];
    } else {
        userContent = query;
    }

    const t0 = Date.now();
    try {
        const stream = await llm.chat.completions.create({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent },
            ],
            temperature: 0.3,
            stream: true,
        });

        let fullText = '';
        for await (const chunk of stream) {
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
                fullText += delta;
                // Only stream the answer part (before |||JSON|||)
                if (!fullText.includes('|||JSON|||')) {
                    if (onToken) onToken(delta);
                }
            }
        }

        if (!fullText.trim()) {
            return {
                answer: `I found ${results.length} commits matching your query but was unable to generate a summary.`,
                confidence: 0.3,
                searchCoverage: results.length >= 10 ? 'partial' : 'insufficient',
                suspectCount: 0,
                suggestedActions: ['Try a more specific query'],
                resultCount: results.length,
                scoreStats,
                _elapsed: Date.now() - t0,
            };
        }

        let answer = fullText;
        let metadata = { confidence: 0.5, searchCoverage: 'partial', suspectCount: 0, rankedSuspects: [], suggestedActions: [] };

        const jsonSplit = fullText.split('|||JSON|||');
        if (jsonSplit.length > 1) {
            answer = jsonSplit[0].trim();
            try {
                const jsonMatch = jsonSplit[1].match(/\{[\s\S]*\}/);
                if (jsonMatch) metadata = { ...metadata, ...JSON.parse(jsonMatch[0]) };
            } catch { /* keep defaults */ }
        } else {
            const commitRefs = [...answer.matchAll(/\[([a-f0-9]{6,10})\]\(https?:\/\/[^)]+\)/g)];
            const extractedIds = [...new Set(commitRefs.map(m => m[1]))];
            if (extractedIds.length > 0) {
                metadata.rankedSuspects = extractedIds;
                metadata.suspectCount = extractedIds.length;
                metadata.confidence = 0.55;
                metadata.searchCoverage = 'partial';
            }
        }

        let confidence = metadata.confidence;
        if (results.length === 0) {
            confidence = 0;
        } else if (results.length <= 2 && parseFloat(scoreStats.avgScore) < 0.3) {
            confidence = Math.min(confidence, 0.5);
        }

        return {
            answer,
            confidence,
            searchCoverage: metadata.searchCoverage,
            suspectCount: metadata.suspectCount,
            rankedSuspects: metadata.rankedSuspects || [],
            suggestedActions: metadata.suggestedActions,
            resultCount: results.length,
            scoreStats,
            _elapsed: Date.now() - t0,
        };
    } catch (err) {
        console.error('  [AnswerSynthesizer] streaming failed:', err.message);
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
