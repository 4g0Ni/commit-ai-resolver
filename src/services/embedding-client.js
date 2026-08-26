/** Text embedding client for an OpenAI-compatible API. */

import OpenAI from 'openai';
import { buildEmbeddingRequest, getEmbeddingConfig, getEmbeddingProviderConfig } from './embedding-config.js';

let _instance = null;

function getEmbeddingClient() {
    if (_instance) return _instance;
    const provider = getEmbeddingProviderConfig();
    if (!provider.configured) {
        throw new Error(
            'Embeddings are not configured. Set OPENAI_EMBEDDING_BASE_URL, OPENAI_EMBEDDING_API_KEY, ' +
            'OPENAI_BASE_URL, or OPENAI_API_KEY.'
        );
    }
    _instance = new OpenAI({
        apiKey: provider.apiKey,
        ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
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
async function generateEmbeddings(texts, { inputType = 'document' } = {}) {
    const client = getEmbeddingClient();
    const { batchSize, dimensions, model } = getEmbeddingConfig();
    const allEmbeddings = [];

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const result = await client.embeddings.create(buildEmbeddingRequest(batch, inputType));
        for (const item of result.data) {
            if (item.embedding.length !== dimensions) {
                throw new Error(
                    `Embedding dimension mismatch for ${model}: expected ${dimensions}, received ${item.embedding.length}. ` +
                    'Set OPENAI_EMBEDDING_DIMENSIONS to the provider output and rebuild the vector store.'
                );
            }
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
    const [embedding] = await generateEmbeddings([text], { inputType: 'query' });
    return embedding;
}

export { generateEmbeddings, generateEmbedding, getEmbeddingClient };
