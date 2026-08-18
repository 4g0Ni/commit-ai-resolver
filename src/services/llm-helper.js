/** OpenAI-compatible LLM clients with lazy, explicit configuration. */

import OpenAI from 'openai';

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';
const OPENAI_FAST_MODEL = process.env.OPENAI_FAST_MODEL || 'gpt-4.1-mini';

let openaiClient = null;

function getOpenAIClient() {
    if (openaiClient) return openaiClient;
    if (!process.env.OPENAI_API_KEY && !OPENAI_BASE_URL) {
        throw new Error('AI is not configured. Set OPENAI_API_KEY or OPENAI_BASE_URL.');
    }
    openaiClient = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY || 'local',
        ...(OPENAI_BASE_URL ? { baseURL: OPENAI_BASE_URL } : {}),
    });
    return openaiClient;
}

function makeClient(model) {
    return {
        chat: {
            completions: {
                create: (params, options) => getOpenAIClient().chat.completions.create({ model, ...params }, options),
            },
        },
    };
}

const client = makeClient(OPENAI_MODEL);
const clientMini = makeClient(OPENAI_FAST_MODEL);

/**
 * Internal: retry/backoff loop wrapping a single deployment client.
 */
async function callWithRetry(targetClient, deploymentLabel, systemPrompt, messages, opts) {
    const maxRetries = opts.maxRetries ?? 3;
    const absoluteMaxRetries = Math.max(maxRetries, 5); // upper bound for 429 retries
    let lastError;

    for (let attempt = 1; attempt <= absoluteMaxRetries; attempt++) {
        try {
            const timeoutMs = opts.timeout ?? 120000;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);

            const llmStart = Date.now();
            const inputChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
            const result = await targetClient.chat.completions.create({
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...messages,
                ],
                temperature: opts.temperature ?? 0.2,
                max_completion_tokens: opts.max_completion_tokens ?? opts.max_tokens ?? 128000,
            }, { signal: controller.signal });

            clearTimeout(timer);
            const llmElapsed = Date.now() - llmStart;
            const usage = result.usage;
            if (llmElapsed > 10000) {
                console.warn(`      ⏱ LLM[${deploymentLabel}] slow (${(llmElapsed/1000).toFixed(1)}s) input=${(inputChars/1024).toFixed(0)}KB tokens=${usage?.prompt_tokens || '?'}/${usage?.completion_tokens || '?'}`);
            }
            return result.choices?.[0]?.message?.content ?? '';
        } catch (err) {
            lastError = err;
            const status = err.status || err.statusCode;
            if (status && status >= 400 && status < 500 && status !== 429) {
                throw err;
            }
            const effectiveMaxRetries = (status === 429) ? absoluteMaxRetries : maxRetries;
            if (attempt >= effectiveMaxRetries) {
                throw err;
            }
            const expDelay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
            const retryAfter = err.headers?.['retry-after'] ?? err.error?.retry_after;
            const baseDelay = retryAfter ? Math.max(Number(retryAfter) * 1000, expDelay) : expDelay;
            const delay = Math.round(baseDelay * (0.7 + Math.random() * 0.6));
            if (status === 429 && retryAfter) {
                console.warn(`  LLM[${deploymentLabel}] 429 retry ${attempt}/${effectiveMaxRetries} — Retry-After: ${retryAfter}s, waiting ${delay}ms`);
            } else {
                console.warn(`  LLM[${deploymentLabel}] retry ${attempt}/${effectiveMaxRetries} after ${delay}ms: ${err.message}`);
            }
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastError;
}

/**
 * Send a chat completion request to gpt-5.4 (quality model).
 * @param {string} systemPrompt
 * @param {Array} messages
 * @param {object} opts - { temperature, max_completion_tokens, maxRetries, timeout }
 * @returns {Promise<string>}
 */
async function llmHelper(systemPrompt, messages, opts = {}) {
    return callWithRetry(client, OPENAI_MODEL, systemPrompt, messages, opts);
}

/**
 * Send a chat completion request to gpt-5.4-mini (fast tie-breaker / classifier).
 * Same retry/backoff/429 handling as llmHelper. Use for cheap, high-volume tasks.
 * @param {string} systemPrompt
 * @param {Array} messages
 * @param {object} opts
 * @returns {Promise<string>}
 */
async function llmHelperMini(systemPrompt, messages, opts = {}) {
    return callWithRetry(clientMini, OPENAI_FAST_MODEL, systemPrompt, messages, opts);
}

export { llmHelper, llmHelperMini, client, clientMini };
