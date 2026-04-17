/**
 * Agent: Diff Investigator
 *
 * Analyzes actual commit diffs against an incident description to determine
 * which suspect commit is most likely the root cause.
 *
 * Takes: incident context + diffs for top suspect commits
 * Returns: ranked analysis with per-commit reasoning and root-cause assessment
 */

/**
 * @param {AzureOpenAI} llm - OpenAI client
 * @param {object} params
 * @param {string} params.query - Original incident description
 * @param {Array} params.suspects - Suspect commits with diffs:
 *   [{ commitId, shortId, repo, author, title, url, summary, riskLevel, diff }]
 * @param {Array} params.history - Conversation history
 * @returns {Promise<object>} Investigation result
 */
export async function investigateDiffs(llm, { query, suspects, history = [] }) {
    const suspectContext = suspects.map((s, i) => {
        const diffPreview = s.diff
            ? s.diff.slice(0, 8000) + (s.diff.length > 8000 ? '\n... (diff truncated)' : '')
            : '(diff not available)';
        return `### Suspect ${i + 1}: [${s.shortId}](${s.url}) by ${s.author} — ${s.repo}
**Title:** ${s.title}
**Risk Level:** ${s.riskLevel}
**Summary:** ${s.summary}

**Code Diff:**
\`\`\`
${diffPreview}
\`\`\``;
    }).join('\n\n---\n\n');

    const conversationContext = history.length > 0
        ? `\nConversation context:\n${history.slice(-4).map(h => `${h.role}: ${h.content?.slice(0, 200)}`).join('\n')}\n`
        : '';

    const systemPrompt = `You are a senior software engineer performing root-cause analysis for the Microsoft Advertising engineering team.
You are given an incident description and the actual code diffs of the top suspect commits.
${conversationContext}

INCIDENT: "${query}"

SUSPECT COMMITS WITH DIFFS:
${suspectContext}

INSTRUCTIONS:
1. For EACH suspect commit, analyze the code diff and assess whether it could cause the reported incident.
2. Be specific — point to exact changes in the diff that could cause the issue (function names, config keys, API calls, query changes, etc.).
3. Consider:
   - Does the change affect the area mentioned in the incident?
   - Could it introduce latency (new API calls, larger queries, missing caching)?
   - Could it cause errors (null access, missing imports, wrong parameters)?
   - Could it break functionality (removed code, changed behavior, feature gate misconfiguration)?
   - Is it a config/pilot ramp that could increase blast radius?
4. Rank suspects from most to least likely root cause.
5. For the top candidate, explain the specific mechanism: what line/change causes what symptom.
6. Suggest concrete next steps that THIS TOOL can perform — i.e., further commit search, diff inspection, code change analysis.
   - GOOD: "Investigate other commits by Siye Liu in the same date range", "Search for related changes in the shared grid template", "Check if any config/pilot changes accompanied this code change", "Look for follow-up fix commits after this date"
   - BAD (do NOT suggest): "Revert the commit", "Check runtime logs", "Reproduce in staging", "Monitor production", "Contact the author", "Deploy a fix", "Run tests locally"

Format your response as:

## Root Cause Analysis

### Most Likely: [shortId](url) by Author
**Likelihood: HIGH/MEDIUM/LOW**
[Detailed explanation pointing to specific diff lines]

### Other Suspects
[Brief assessment of each remaining commit]

## Recommended Actions
[Numbered list of specific next steps]

After your analysis, output a JSON block on a new line starting with |||JSON||| containing:
{
  "rootCauseCandidate": "shortId or null",
  "rootCauseRepo": "repo name",
  "confidence": 0.0-1.0,
  "mechanism": "one-line explanation of how the change causes the issue",
  "nextSteps": ["specific actionable steps within this tool's scope — commit search, diff analysis, related change investigation"]
}`;

    const t0 = Date.now();
    try {
        const result = await llm.chat.completions.create({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Analyze these ${suspects.length} suspect commits for the incident: "${query}"` },
            ],
            temperature: 0.2,
        });
        const fullText = result.choices?.[0]?.message?.content ?? '';

        if (!fullText.trim()) {
            return {
                analysis: 'Unable to generate diff analysis. The diffs may be too large or complex.',
                rootCauseCandidate: null,
                confidence: 0,
                nextSteps: ['Review diffs manually in ADO'],
                _elapsed: Date.now() - t0,
            };
        }

        // Parse out JSON metadata block
        let analysis = fullText;
        let metadata = { rootCauseCandidate: null, confidence: 0.5, nextSteps: [] };

        const jsonSplit = fullText.split('|||JSON|||');
        if (jsonSplit.length > 1) {
            analysis = jsonSplit[0].trim();
            try {
                const jsonMatch = jsonSplit[1].match(/\{[\s\S]*\}/);
                if (jsonMatch) metadata = { ...metadata, ...JSON.parse(jsonMatch[0]) };
            } catch { /* keep defaults */ }
        }

        return {
            analysis,
            rootCauseCandidate: metadata.rootCauseCandidate,
            rootCauseRepo: metadata.rootCauseRepo || null,
            confidence: metadata.confidence,
            mechanism: metadata.mechanism || null,
            nextSteps: metadata.nextSteps || [],
            suspectsAnalyzed: suspects.length,
            _elapsed: Date.now() - t0,
            _tokens: result.usage?.total_tokens,
        };
    } catch (err) {
        console.error('  [DiffInvestigator] failed:', err.message);
        return {
            analysis: 'Investigation failed due to an error. Please try again.',
            rootCauseCandidate: null,
            confidence: 0,
            nextSteps: ['Review diffs manually in ADO'],
            _elapsed: Date.now() - t0,
        };
    }
}
