/** Text embedding client for an OpenAI-compatible API. */

import OpenAI from 'openai';

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-large';

let _instance = null;

function getEmbeddingClient() {
    if (_instance) return _instance;
    if (!process.env.OPENAI_API_KEY && !OPENAI_BASE_URL) {
        throw new Error('Embeddings are not configured. Set OPENAI_API_KEY or OPENAI_BASE_URL.');
    }
    _instance = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY || 'local',
        ...(OPENAI_BASE_URL ? { baseURL: OPENAI_BASE_URL } : {}),
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
            model: EMBEDDING_MODEL,
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
