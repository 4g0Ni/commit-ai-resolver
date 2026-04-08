/**
 * Text embedding client — Azure OpenAI text-embedding-3-large.
 * Uses DefaultAzureCredential for auth, same endpoint as the LLM.
 */

import { DefaultAzureCredential } from '@azure/identity';
import { AzureOpenAI } from 'openai';

const AZURE_OPENAI_ENDPOINT = 'https://yizha-maz2xf24-swedencentral.openai.azure.com/';
const EMBEDDING_DEPLOYMENT = 'text-embedding-3-large';
const EMBEDDING_API_VERSION = '2023-05-15';
const COGNITIVE_SERVICES_SCOPE = 'https://cognitiveservices.azure.com/.default';

let _instance = null;

function getEmbeddingClient() {
    if (_instance) return _instance;

    const credential = new DefaultAzureCredential();
    _instance = new AzureOpenAI({
        endpoint: AZURE_OPENAI_ENDPOINT,
        apiKey: '',
        azureADTokenProvider: () =>
            credential.getToken(COGNITIVE_SERVICES_SCOPE).then(at => at.token),
        apiVersion: EMBEDDING_API_VERSION,
        deployment: EMBEDDING_DEPLOYMENT,
    });
    return _instance;
}

/**
 * Generate embeddings for an array of text strings.
 * Batches up to 16 inputs per API call.
 *
 * @param {string[]} texts - Array of text strings to embed
 * @returns {Promise<number[][]>} Array of embedding vectors
 */
async function generateEmbeddings(texts) {
    const client = getEmbeddingClient();
    const BATCH_SIZE = 16;
    const allEmbeddings = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const result = await client.embeddings.create({
            input: batch,
            model: EMBEDDING_DEPLOYMENT,
        });
        for (const item of result.data) {
            allEmbeddings.push(item.embedding);
        }
    }

    return allEmbeddings;
}

/**
 * Generate a single embedding for a text string.
 *
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} Embedding vector
 */
async function generateEmbedding(text) {
    const [embedding] = await generateEmbeddings([text]);
    return embedding;
}

export { generateEmbeddings, generateEmbedding, getEmbeddingClient };
