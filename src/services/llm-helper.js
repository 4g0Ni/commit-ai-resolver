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
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await client.chat.completions.create({
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...messages,
                ],
                temperature: opts.temperature ?? 0.2,
                max_completion_tokens: opts.max_completion_tokens ?? opts.max_tokens ?? 128000,
            });
            return result.choices?.[0]?.message?.content ?? '';
        } catch (err) {
            lastError = err;
            // Don't retry on 4xx client errors (except 429 rate limit)
            const status = err.status || err.statusCode;
            if (status && status >= 400 && status < 500 && status !== 429) {
                throw err;
            }
            if (attempt < maxRetries) {
                const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
                console.warn(`  LLM retry ${attempt}/${maxRetries} after ${delay}ms: ${err.message}`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastError;
}

export { llmHelper, client };
