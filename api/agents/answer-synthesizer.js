/** Agent 3: synthesize a cited answer from ranked commit evidence. */

import {
    SYNTHESIS_SCHEMA,
    SYNTHESIZER_FALLBACK_SYSTEM_PROMPT,
    SYNTHESIZER_PROMPT_VERSION,
    SYNTHESIZER_SYSTEM_PROMPT,
    buildSynthesisEvidence,
    normalizeSynthesisObject,
    parseSynthesisOutput,
} from './synthesis-prompt.js';
import {
    canUseStructuredOutputs,
    createStructuredCompletion,
    isJsonSchemaUnsupported,
    markStructuredOutputsUnsupported,
    parseJsonObject,
    structuredResponseFormat,
} from './prompt-utils.js';
import {
    applyPromptVariant,
    reportPromptOutcome,
    selectPromptVariant,
} from '../../src/prompts/prompt-registry.js';

const JSON_MARKER = '|||JSON|||';

function compactFileTokens(paths, max = 10) {
    if (!Array.isArray(paths) || paths.length === 0) return [];
    const seen = new Set();
    const tokens = [];
    for (const path of paths) {
        if (!path) continue;
        const segments = path.replace(/^\/+/, '').split('/').filter(Boolean);
        const base = segments.at(-1) || path;
        const packageIndex = segments.lastIndexOf('packages');
        const token = packageIndex !== -1 && segments[packageIndex + 1]
            ? `${segments[packageIndex + 1]}/${base}`
            : segments.length >= 2 ? `${segments.at(-2)}/${base}` : base;
        if (!seen.has(token)) {
            seen.add(token);
            tokens.push(token);
        }
    }
    if (tokens.length <= max) return tokens;
    return [...tokens.slice(0, max), `+${tokens.length - max} more files`];
}

function scoreStats(results) {
    const scores = results.map(result => Number(result.score)).filter(Number.isFinite);
    if (scores.length === 0) return { count: results.length, avgScore: null, maxScore: null, minScore: null };
    return {
        count: results.length,
        avgScore: Number((scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(3)),
        maxScore: Number(Math.max(...scores).toFixed(3)),
        minScore: Number(Math.min(...scores).toFixed(3)),
    };
}

function formatCommitEvidence(results, topN) {
    return results.slice(0, topN).map(result => {
        const metadata = result.metadata || {};
        return {
            shortId: result.id,
            commitId: result.commitId,
            date: result.date,
            repo: result.repo,
            author: result.author || metadata.author,
            url: metadata.url || null,
            title: metadata.title,
            summary: metadata.summary,
            riskLevel: metadata.riskLevel,
            changeType: metadata.changeType,
            flags: metadata.flags || [],
            affectedAreas: metadata.affectedAreas || [],
            changedFiles: compactFileTokens(metadata.changedFiles, 10),
            denseSimilarity: Number.isFinite(Number(result.score)) ? Number(Number(result.score).toFixed(3)) : null,
            retrievalChannels: result._retrievalChannels || [result._retrievalMode || 'dense'],
        };
    });
}

function prepareRequest(results, intent, context, iteration) {
    const { query, history = [], workItemContext } = context;
    const topN = workItemContext ? 15 : 10;
    const stats = scoreStats(results);
    const evidenceData = buildSynthesisEvidence({
        query,
        history,
        workItemContext,
        priorSuspects: context.priorSuspects,
        intent,
        commitContext: formatCommitEvidence(results, topN),
        scoreStats: stats,
    });
    const evidenceText = JSON.stringify(evidenceData);
    const images = iteration === 1 ? (workItemContext?.images || []) : [];
    const userContent = images.length > 0
        ? [
            { type: 'text', text: evidenceText },
            ...images.map(image => ({
                type: 'image_url',
                image_url: { url: image.base64DataUrl, detail: 'low' },
            })),
        ]
        : evidenceText;
    return { stats, userContent, evidenceData, topN, imageCount: images.length };
}

function emptyResult(results, stats, startedAt, message, metadata = {}) {
    return {
        answer: message,
        confidence: 0,
        searchCoverage: 'insufficient',
        suspectCount: 0,
        rankedSuspects: [],
        suggestedActions: [],
        resultCount: results.length,
        scoreStats: stats,
        _promptVersion: SYNTHESIZER_PROMPT_VERSION,
        _structuredOutput: false,
        _parseError: true,
        _elapsed: Date.now() - startedAt,
        ...metadata,
    };
}

function finalize(fullText, results, stats, startedAt, tokens, metadata = {}) {
    const normalized = parseSynthesisOutput(fullText, results);
    return {
        ...normalized,
        resultCount: results.length,
        scoreStats: stats,
        _elapsed: Date.now() - startedAt,
        ...metadata,
        ...(tokens === undefined ? {} : { _tokens: tokens }),
    };
}

function finalizeStructured(parsed, results, stats, startedAt, tokens, metadata = {}) {
    return {
        ...normalizeSynthesisObject(parsed, results),
        resultCount: results.length,
        scoreStats: stats,
        _elapsed: Date.now() - startedAt,
        ...metadata,
        ...(tokens === undefined ? {} : { _tokens: tokens }),
    };
}

function readJsonStringField(text, fieldName) {
    const keyIndex = text.indexOf(`"${fieldName}"`);
    if (keyIndex < 0) return { found: false, value: '', complete: false };
    const colonIndex = text.indexOf(':', keyIndex + fieldName.length + 2);
    if (colonIndex < 0) return { found: false, value: '', complete: false };
    let index = colonIndex + 1;
    while (/\s/.test(text[index] || '')) index++;
    if (text[index] !== '"') return { found: false, value: '', complete: false };
    index++;

    let value = '';
    const simpleEscapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
    while (index < text.length) {
        const char = text[index++];
        if (char === '"') return { found: true, value, complete: true };
        if (char !== '\\') {
            value += char;
            continue;
        }
        if (index >= text.length) break;
        const escaped = text[index++];
        if (escaped === 'u') {
            const hex = text.slice(index, index + 4);
            if (!/^[0-9a-f]{4}$/i.test(hex)) break;
            value += String.fromCharCode(Number.parseInt(hex, 16));
            index += 4;
        } else if (Object.hasOwn(simpleEscapes, escaped)) {
            value += simpleEscapes[escaped];
        }
    }
    return { found: true, value, complete: false };
}

/** Generate a non-streaming cited answer. */
export async function synthesizeAnswer(llm, results, intent, context, iteration = 1) {
    const startedAt = Date.now();
    const prompt = selectPromptVariant('answer-synthesizer', context.correlationId || context.query);
    const { stats, userContent, topN, imageCount } = prepareRequest(results, intent, context, iteration);
    if (imageCount > 0) {
        console.log(`  [Synthesizer] multimodal: ${imageCount} image(s), ${results.length} commits (top ${topN})`);
    }

    try {
        const { parsed, result, structuredOutput, fallbackUsed } = await createStructuredCompletion(llm, {
            systemPrompt: applyPromptVariant(SYNTHESIZER_SYSTEM_PROMPT, prompt),
            userContent,
            schemaName: 'commit_answer_synthesis',
            schema: SYNTHESIS_SCHEMA,
            maxCompletionTokens: 4096,
        });
        const finishReason = result.choices?.[0]?.finish_reason;
        const usage = result.usage;
        console.log(`  [Synthesizer] LLM done: ${((Date.now() - startedAt) / 1000).toFixed(1)}s, prompt=${usage?.prompt_tokens || '?'} completion=${usage?.completion_tokens || '?'} total=${usage?.total_tokens || '?'}, finish=${finishReason || '?'}`);
        if (!parsed.answer?.trim()) {
            reportPromptOutcome('answer-synthesizer', prompt.variant, { failed: true });
            return emptyResult(results, stats, startedAt, `I found ${results.length} commits but could not generate a supported answer.`, {
                _promptVersion: prompt.version, _promptVariant: prompt.variant,
            });
        }
        reportPromptOutcome('answer-synthesizer', prompt.variant, { failed: false });
        return finalizeStructured(parsed, results, stats, startedAt, usage?.total_tokens, {
            _promptVersion: prompt.version,
            _promptVariant: prompt.variant,
            _structuredOutput: structuredOutput,
            _structuredFallback: fallbackUsed,
            _promptTokens: usage?.prompt_tokens,
            _completionTokens: usage?.completion_tokens,
        });
    } catch (error) {
        console.error('  [AnswerSynthesizer] failed:', error.message);
        reportPromptOutcome('answer-synthesizer', prompt.variant, { failed: true });
        return emptyResult(results, stats, startedAt, 'I encountered an error while analyzing the commit evidence.', {
            _promptVersion: prompt.version, _promptVariant: prompt.variant,
        });
    }
}

/** Generate a cited answer while streaming only the human-readable portion. */
export async function synthesizeAnswerStream(llm, results, intent, context, iteration = 1, onToken) {
    const startedAt = Date.now();
    const prompt = selectPromptVariant('answer-synthesizer', context.correlationId || context.query);
    const { stats, userContent } = prepareRequest(results, intent, context, iteration);

    try {
        let useStructured = canUseStructuredOutputs(llm);
        let stream;
        try {
            stream = await llm.chat.completions.create({
                messages: [
                    { role: 'system', content: applyPromptVariant(useStructured ? SYNTHESIZER_SYSTEM_PROMPT : SYNTHESIZER_FALLBACK_SYSTEM_PROMPT, prompt) },
                    { role: 'user', content: userContent },
                ],
                temperature: 0.3,
                stream: true,
                ...(useStructured ? { response_format: structuredResponseFormat('commit_answer_synthesis', SYNTHESIS_SCHEMA) } : {}),
            });
        } catch (error) {
            if (!useStructured || !isJsonSchemaUnsupported(error)) throw error;
            markStructuredOutputsUnsupported(llm);
            useStructured = false;
            console.warn('  [StructuredOutput] streaming synthesis: provider rejected JSON schema; using delimiter fallback');
            stream = await llm.chat.completions.create({
                messages: [
                    { role: 'system', content: applyPromptVariant(SYNTHESIZER_FALLBACK_SYSTEM_PROMPT, prompt) },
                    { role: 'user', content: userContent },
                ],
                temperature: 0.3,
                stream: true,
            });
        }

        let fullText = '';
        let pending = '';
        let metadataStarted = false;
        let emittedAnswerLength = 0;
        for await (const chunk of stream) {
            const delta = chunk.choices?.[0]?.delta?.content;
            if (!delta) continue;
            fullText += delta;
            if (useStructured) {
                const answerField = readJsonStringField(fullText, 'answer');
                if (answerField.found && answerField.value.length > emittedAnswerLength) {
                    const answerChunk = answerField.value.slice(emittedAnswerLength);
                    emittedAnswerLength = answerField.value.length;
                    if (answerChunk && onToken) onToken(answerChunk);
                }
                continue;
            }
            if (metadataStarted) continue;

            pending += delta;
            const markerIndex = pending.indexOf(JSON_MARKER);
            if (markerIndex >= 0) {
                const answerChunk = pending.slice(0, markerIndex);
                if (answerChunk && onToken) onToken(answerChunk);
                pending = '';
                metadataStarted = true;
                continue;
            }

            // Retain a marker-sized suffix so a marker split across chunks never leaks to the UI.
            const safeLength = Math.max(0, pending.length - (JSON_MARKER.length - 1));
            if (safeLength > 0) {
                const answerChunk = pending.slice(0, safeLength);
                pending = pending.slice(safeLength);
                if (answerChunk && onToken) onToken(answerChunk);
            }
        }
        if (!useStructured && !metadataStarted && pending && onToken) onToken(pending);

        if (!fullText.trim()) {
            reportPromptOutcome('answer-synthesizer', prompt.variant, { failed: true });
            return emptyResult(results, stats, startedAt, `I found ${results.length} commits but could not generate a supported answer.`, {
                _promptVersion: prompt.version, _promptVariant: prompt.variant,
            });
        }
        reportPromptOutcome('answer-synthesizer', prompt.variant, { failed: false });
        if (useStructured) return finalizeStructured(parseJsonObject(fullText), results, stats, startedAt, undefined, {
            _promptVersion: prompt.version,
            _promptVariant: prompt.variant,
            _structuredOutput: true,
            _structuredFallback: false,
        });
        return finalize(fullText, results, stats, startedAt, undefined, {
            _promptVersion: prompt.version,
            _promptVariant: prompt.variant,
            _structuredOutput: false,
            _structuredFallback: true,
        });
    } catch (error) {
        console.error('  [AnswerSynthesizer] streaming failed:', error.message);
        reportPromptOutcome('answer-synthesizer', prompt.variant, { failed: true });
        return emptyResult(results, stats, startedAt, 'I encountered an error while analyzing the commit evidence.', {
            _promptVersion: prompt.version, _promptVariant: prompt.variant,
        });
    }
}
