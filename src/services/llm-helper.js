/**
 * LLM helper — Azure OpenAI client with DefaultAzureCredential.
 *
 * Reference: DRIAgent llm-helper.js
 */

import { DefaultAzureCredential } from '@azure/identity';
import { AzureOpenAI } from 'openai';

const AZURE_OPENAI_ENDPOINT = 'https://yizha-maz2xf24-swedencentral.openai.azure.com/';
const AZURE_OPENAI_DEPLOYMENT = 'gpt-5.4';
const AZURE_OPENAI_API_VERSION = '2025-04-01-preview';
const COGNITIVE_SERVICES_SCOPE = 'https://cognitiveservices.azure.com/.default';

const credential = new DefaultAzureCredential();

const client = new AzureOpenAI({
    endpoint: AZURE_OPENAI_ENDPOINT,
    apiKey: '',
    azureADTokenProvider: () =>
        credential.getToken(COGNITIVE_SERVICES_SCOPE).then(at => at.token),
    apiVersion: AZURE_OPENAI_API_VERSION,
    deployment: AZURE_OPENAI_DEPLOYMENT,
});

/**
 * Send a chat completion request to Azure OpenAI.
 * Retries up to `maxRetries` times on transient errors.
 *
 * @param {string} systemPrompt - System prompt
 * @param {Array} messages - Array of { role, content } messages
 * @param {object} opts - Optional overrides (temperature, max_completion_tokens, maxRetries)
 * @returns {Promise<string>} LLM response text
 */
async function llmHelper(systemPrompt, messages, opts = {}) {
    const maxRetries = opts.maxRetries ?? 3;
    const absoluteMaxRetries = Math.max(maxRetries, 5); // upper bound for 429 retries
    let lastError;

    for (let attempt = 1; attempt <= absoluteMaxRetries; attempt++) {
        try {
            const timeoutMs = opts.timeout ?? 120000; // 2 min timeout
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);

            const llmStart = Date.now();
            const inputChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
            const result = await client.chat.completions.create({
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
                console.warn(`      ⏱ LLM slow (${(llmElapsed/1000).toFixed(1)}s) input=${(inputChars/1024).toFixed(0)}KB tokens=${usage?.prompt_tokens || '?'}/${usage?.completion_tokens || '?'}`);
            }
            return result.choices?.[0]?.message?.content ?? '';
        } catch (err) {
            lastError = err;
            // Don't retry on 4xx client errors (except 429 rate limit)
            const status = err.status || err.statusCode;
            if (status && status >= 400 && status < 500 && status !== 429) {
                throw err;
            }
            // For 429 rate limits, allow more retries since they're transient
            const effectiveMaxRetries = (status === 429) ? absoluteMaxRetries : maxRetries;
            if (attempt >= effectiveMaxRetries) {
                throw err;
            }
            const expDelay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
            // Parse Retry-After header if available (seconds)
            const retryAfter = err.headers?.['retry-after'] ?? err.error?.retry_after;
            const baseDelay = retryAfter ? Math.max(Number(retryAfter) * 1000, expDelay) : expDelay;
            // Add jitter ±30% to prevent thundering herd
            const delay = Math.round(baseDelay * (0.7 + Math.random() * 0.6));
            if (status === 429 && retryAfter) {
                console.warn(`  LLM 429 retry ${attempt}/${effectiveMaxRetries} — Retry-After: ${retryAfter}s, waiting ${delay}ms`);
            } else {
                console.warn(`  LLM retry ${attempt}/${effectiveMaxRetries} after ${delay}ms: ${err.message}`);
            }
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastError;
}

export { llmHelper, client };
