/**
 * Vector database — LanceDB-backed vector store for commit embeddings.
 *
 * Uses LanceDB (embedded, no server needed) stored at data/lancedb/.
 * Table schema: id, commitId, repo, date, author, text, vector (Float32[3072]), metadata (JSON string).
 *
 * LanceDB handles ANN indexing and fast cosine similarity search natively.
 */

import * as lancedb from '@lancedb/lancedb';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LANCEDB_DIR = join(__dirname, '..', '..', 'data', 'lancedb');
const TABLE_NAME = 'commits';

let _db = null;

/**
 * Get or create the LanceDB connection (singleton).
 */
async function getDb() {
    if (!_db) {
        _db = await lancedb.connect(LANCEDB_DIR);
    }
    return _db;
}

/**
 * Get the commits table, or null if it doesn't exist.
 */
async function getTable() {
    const db = await getDb();
    try {
        return await db.openTable(TABLE_NAME);
    } catch {
        return null;
    }
}

/**
 * Cosine similarity between two vectors (kept for unit tests and fallback).
 */
function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Search the vector store for commits most similar to a query embedding.
 *
 * @param {number[]} queryEmbedding - The query embedding vector
 * @param {object} opts - Search options
 * @param {number} opts.topK - Number of results to return (default: 10)
 * @param {number} opts.minScore - Minimum similarity threshold (default: 0.3)
 * @param {string} opts.repo - Filter by repo name (optional)
 * @param {string} opts.author - Filter by author name, case-insensitive substring (optional)
 * @param {string} opts.dateFrom - Filter by start date (optional)
 * @param {string} opts.dateTo - Filter by end date (optional)
 * @returns {Promise<Array>} Ranked results with score and metadata
 */
async function searchVectors(queryEmbedding, opts = {}) {
    const { topK = 10, minScore = 0.3, repo, author, dateFrom, dateTo } = opts;
    const table = await getTable();
    if (!table) return [];

    // Build WHERE clauses for LanceDB pre-filtering
    const whereClauses = [];
    if (repo) whereClauses.push(`repo = '${repo.replace(/'/g, "''")}' `);
    if (author) whereClauses.push(`lower(author) LIKE '%${author.toLowerCase().replace(/'/g, "''")}%'`);
    if (dateFrom) whereClauses.push(`date >= '${dateFrom}'`);
    if (dateTo) whereClauses.push(`date <= '${dateTo}'`);

    let query = table.vectorSearch(queryEmbedding).distanceType('cosine').limit(topK * 2);
    if (whereClauses.length > 0) {
        query = query.where(whereClauses.join(' AND '));
    }

    const raw = await query.toArray();

    // Convert results
    let results = raw.map(row => {
        // LanceDB returns _distance for cosine: distance = 1 - similarity
        const score = 1 - (row._distance ?? 0);
        return {
            id: row.id,
            commitId: row.commitId,
            repo: row.repo,
            date: row.date,
            author: row.author,
            text: row.text,
            score,
            metadata: JSON.parse(row.metadata),
        };
    });

    return results
        .filter(r => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
}

/**
 * Add or update commits in the vector store.
 * Deduplicates by commit id + repo using overwrite mode.
 *
 * @param {Array} entries - Array of { id, repo, date, text, embedding, metadata }
 * @returns {Promise<number>} Number of entries upserted
 */
async function upsertVectors(entries) {
    if (entries.length === 0) return 0;

    const db = await getDb();
    const rows = entries.map(e => ({
        id: e.id,
        commitId: e.commitId || '',
        repo: e.repo,
        date: e.date,
        author: e.author || e.metadata?.author || '',
        text: e.text,
        vector: e.embedding,
        metadata: JSON.stringify(e.metadata),
    }));

    const table = await getTable();
    if (!table) {
        // Create table with first batch — LanceDB infers schema from data
        await db.createTable(TABLE_NAME, rows, { mode: 'overwrite' });
    } else {
        // Merge-insert: update existing rows by id+repo, insert new ones
        try {
            await table.mergeInsert('id', 'repo')
                .whenMatchedUpdateAll()
                .whenNotMatchedInsertAll()
                .execute(rows);
        } catch {
            // Fallback: just add rows (older LanceDB versions)
            await table.add(rows);
        }
    }

    return entries.length;
}

/**
 * Get stats about the vector store.
 */
async function getVectorStats() {
    const table = await getTable();
    if (!table) {
        return {
            totalCommits: 0,
            repos: [],
            dateRange: null,
            model: 'text-embedding-3-large',
            lastUpdated: null,
        };
    }

    const allRows = await table.query().select(['repo', 'date', 'author']).toArray();
    const repos = [...new Set(allRows.map(r => r.repo))];
    const dates = [...new Set(allRows.map(r => r.date))].sort();

    return {
        totalCommits: allRows.length,
        repos,
        dateRange: dates.length > 0 ? { from: dates[0], to: dates[dates.length - 1] } : null,
        model: 'text-embedding-3-large',
        lastUpdated: new Date().toISOString(),
    };
}

/**
 * Load the vector store (compatibility shim — returns stats-like object).
 */
async function loadVectorStore() {
    const table = await getTable();
    if (!table) {
        return { commits: [], meta: { model: 'text-embedding-3-large', dimensions: 3072, lastUpdated: null } };
    }
    const allRows = await table.query().toArray();
    return {
        commits: allRows.map(r => ({
            id: r.id,
            commitId: r.commitId,
            repo: r.repo,
            date: r.date,
            author: r.author,
            text: r.text,
            embedding: Array.from(r.vector),
            metadata: JSON.parse(r.metadata),
        })),
        meta: { model: 'text-embedding-3-large', dimensions: 3072, lastUpdated: new Date().toISOString() },
    };
}

export { loadVectorStore, searchVectors, upsertVectors, getVectorStats, cosineSimilarity };
