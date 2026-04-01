/**
 * LLM helper — Azure OpenAI client with DefaultAzureCredential.
 *
 * Reference: DRIAgent llm-helper.js
 */

import { DefaultAzureCredential } from '@azure/identity';
import { AzureOpenAI } from 'openai';

const AZURE_OPENAI_ENDPOINT = 'https://chezh-m7lorxce-eastus2.openai.azure.com/';
const AZURE_OPENAI_DEPLOYMENT = 'gpt-4.1';
const AZURE_OPENAI_API_VERSION = '2025-01-01-preview';
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
 *
 * @param {string} systemPrompt - System prompt
 * @param {Array} messages - Array of { role, content } messages
 * @param {object} opts - Optional overrides (temperature, max_tokens)
 * @returns {Promise<string>} LLM response text
 */
async function llmHelper(systemPrompt, messages, opts = {}) {
    const result = await client.chat.completions.create({
        messages: [
            { role: 'system', content: systemPrompt },
            ...messages,
        ],
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.max_tokens ?? 2048,
    });

    return result.choices?.[0]?.message?.content ?? '';
}

export { llmHelper, client };
