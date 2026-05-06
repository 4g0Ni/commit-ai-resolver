/**
 * Vector database — sqlite-vec-backed vector store for commit embeddings.
 *
 * Storage: SQLite DB at data/vectors.db with two tables:
 *   - commit_vectors  (vec0 virtual table): rowid, embedding float[3072] cosine, repo partition key
 *   - commit_metadata (regular table):      rowid, id, commitId, repo, date, author, text, metadata (JSON)
 *
 * Joined by rowid. Repo is a vec0 partition key for fast per-repo KNN; date/author/risk/changeType
 * are filtered on the JOIN (or post-filtered from metadata JSON for risk/changeType).
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = process.env.DATA_DIR || join(__dirname, '..', '..', 'data');
const VECTORS_DB_PATH = process.env.VECTORS_DB || join(DATA_ROOT, 'vectors.db');
const EMBEDDING_DIM = 3072;
const EMBEDDING_MODEL = 'text-embedding-3-large';

let _db = null;

/**
 * Open (and lazily initialize) the vectors DB. Idempotent.
 */
function getDb() {
    if (_db) return _db;
    mkdirSync(dirname(VECTORS_DB_PATH), { recursive: true });
    _db = new Database(VECTORS_DB_PATH);
    sqliteVec.load(_db);
    _db.pragma('journal_mode = WAL');
    _db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS commit_vectors USING vec0(
            embedding float[${EMBEDDING_DIM}] distance_metric=cosine,
            repo text partition key
        );
        CREATE TABLE IF NOT EXISTS commit_metadata (
            rowid INTEGER PRIMARY KEY,
            id TEXT NOT NULL,
            commitId TEXT,
            repo TEXT NOT NULL,
            date TEXT NOT NULL,
            author TEXT,
            text TEXT,
            metadata TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_repo_id ON commit_metadata(repo, id);
        CREATE INDEX IF NOT EXISTS idx_meta_date ON commit_metadata(date);
    `);
    return _db;
}

/**
 * Close the SQLite connection. Used before file deletion (Windows file lock).
 * The next call to getDb() will reopen.
 */
function closeVectorStore() {
    if (_db) {
        _db.close();
        _db = null;
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
 * @param {string} opts.riskLevel - Filter by risk level: HIGH, MEDIUM, LOW (optional)
 * @param {string} opts.changeType - Filter by change type: code, config, mixed (optional)
 * @returns {Promise<Array>} Ranked results with score and metadata
 */
async function searchVectors(queryEmbedding, opts = {}) {
    const { topK = 10, minScore = 0.3, repo, author, dateFrom, dateTo, riskLevel, changeType } = opts;
    const db = getDb();

    // Build vec0 MATCH clauses (and their params) — these go FIRST in the SQL.
    // Bind order must match SQL placeholder order, so push k BEFORE the JOIN-side filters.
    const matchClauses = ['v.embedding MATCH ?'];
    const matchParams = [new Float32Array(queryEmbedding)];

    if (repo) {
        matchClauses.push('v.repo = ?');
        matchParams.push(repo);
    }

    // Over-fetch when filters narrow the result set, so KNN candidates survive post-filtering.
    // `k` is a vec0 constraint and lives inside the MATCH WHERE clause.
    const hasAnyFilter = !!(repo || author || dateFrom || dateTo || riskLevel || changeType);
    const preFilterLimit = hasAnyFilter ? Math.max(topK * 5, 200) : topK * 2;
    matchClauses.push('k = ?');
    matchParams.push(preFilterLimit);

    // JOIN-side filters apply to the metadata table.
    const joinClauses = [];
    const joinParams = [];
    if (author) {
        joinClauses.push('lower(m.author) LIKE ?');
        joinParams.push(`%${author.toLowerCase()}%`);
    }
    if (dateFrom) {
        joinClauses.push('m.date >= ?');
        joinParams.push(dateFrom);
    }
    if (dateTo) {
        joinClauses.push('m.date <= ?');
        joinParams.push(dateTo);
    }

    const params = [...matchParams, ...joinParams];

    const sql = `
        SELECT v.rowid AS rowid, v.distance AS distance,
               m.id, m.commitId, m.repo, m.date, m.author, m.text, m.metadata
        FROM commit_vectors v
        JOIN commit_metadata m ON m.rowid = v.rowid
        WHERE ${matchClauses.join(' AND ')}
        ${joinClauses.length ? 'AND ' + joinClauses.join(' AND ') : ''}
        ORDER BY v.distance
    `;

    const raw = db.prepare(sql).all(...params);

    // Convert to result objects (cosine distance → similarity score)
    let results = raw.map(row => ({
        id: row.id,
        commitId: row.commitId,
        repo: row.repo,
        date: row.date,
        author: row.author,
        text: row.text,
        score: 1 - row.distance,
        metadata: JSON.parse(row.metadata),
    }));

    // Post-filter by metadata JSON fields not promoted to columns
    if (riskLevel) {
        results = results.filter(r => r.metadata.riskLevel === riskLevel);
    }
    if (changeType) {
        if (changeType === 'config') {
            results = results.filter(r => r.metadata.changeType === 'config' || r.metadata.changeType === 'mixed');
        } else {
            results = results.filter(r => r.metadata.changeType === changeType);
        }
    }

    return results
        .filter(r => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
}

/**
 * Add or update commits in the vector store.
 * Deduplicates by (repo, id). Wrapped in a single transaction for atomicity and speed.
 *
 * @param {Array} entries - Array of { id, commitId, repo, date, author, text, embedding, metadata }
 * @returns {Promise<number>} Number of entries upserted
 */
async function upsertVectors(entries) {
    if (entries.length === 0) return 0;
    const db = getDb();

    const findRowid = db.prepare('SELECT rowid FROM commit_metadata WHERE repo = ? AND id = ?');
    const insertMeta = db.prepare(`
        INSERT INTO commit_metadata (id, commitId, repo, date, author, text, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const updateMeta = db.prepare(`
        UPDATE commit_metadata SET commitId = ?, date = ?, author = ?, text = ?, metadata = ?
        WHERE rowid = ?
    `);
    const insertVec = db.prepare('INSERT INTO commit_vectors(rowid, embedding, repo) VALUES (?, ?, ?)');
    const deleteVec = db.prepare('DELETE FROM commit_vectors WHERE rowid = ?');

    const upsertOne = (e) => {
        const author = e.author || e.metadata?.author || '';
        const metaJson = JSON.stringify(e.metadata);
        const embedding = new Float32Array(e.embedding);

        const existing = findRowid.get(e.repo, e.id);
        if (existing) {
            updateMeta.run(e.commitId || '', e.date, author, e.text, metaJson, existing.rowid);
            // vec0 UPDATE on partitioned tables varies by version; delete+insert with same rowid is safe.
            deleteVec.run(existing.rowid);
            insertVec.run(BigInt(existing.rowid), embedding, e.repo);
        } else {
            const info = insertMeta.run(e.id, e.commitId || '', e.repo, e.date, author, e.text, metaJson);
            insertVec.run(BigInt(info.lastInsertRowid), embedding, e.repo);
        }
    };

    const upsertAll = db.transaction((items) => {
        for (const e of items) upsertOne(e);
    });

    upsertAll(entries);
    return entries.length;
}

/**
 * Get stats about the vector store.
 */
async function getVectorStats() {
    const db = getDb();
    const total = db.prepare('SELECT COUNT(*) AS c FROM commit_metadata').get().c;
    if (total === 0) {
        return {
            totalCommits: 0,
            repos: [],
            dateRange: null,
            model: EMBEDDING_MODEL,
            lastUpdated: null,
        };
    }
    const repos = db.prepare('SELECT DISTINCT repo FROM commit_metadata').all().map(r => r.repo);
    const range = db.prepare('SELECT MIN(date) AS minD, MAX(date) AS maxD FROM commit_metadata').get();

    return {
        totalCommits: total,
        repos,
        dateRange: range.minD && range.maxD ? { from: range.minD, to: range.maxD } : null,
        model: EMBEDDING_MODEL,
        lastUpdated: new Date().toISOString(),
    };
}

/**
 * Look up commits by their short IDs (exact match).
 * Used when users query specific commit SHAs directly.
 *
 * @param {Array<string>} shortIds - Array of short commit IDs (e.g., ['519cdc3f', '7507bb7b'])
 * @returns {Promise<Array>} Matching commits with score=1.0
 */
async function lookupByCommitIds(shortIds) {
    if (!shortIds || shortIds.length === 0) return [];
    const db = getDb();

    const placeholders = shortIds.map(() => '?').join(', ');
    const rows = db.prepare(
        `SELECT id, commitId, repo, date, author, text, metadata FROM commit_metadata WHERE id IN (${placeholders})`
    ).all(...shortIds);

    return rows.map(row => ({
        id: row.id,
        commitId: row.commitId,
        repo: row.repo,
        date: row.date,
        author: row.author,
        text: row.text,
        score: 1.0, // exact match
        metadata: JSON.parse(row.metadata),
    }));
}

/**
 * Load the entire vector store (compatibility shim for scripts/tests).
 * Pulls all metadata + embeddings into memory; intended for batch consumers, not request paths.
 */
async function loadVectorStore() {
    const db = getDb();
    const metaRows = db.prepare(
        'SELECT rowid, id, commitId, repo, date, author, text, metadata FROM commit_metadata'
    ).all();
    if (metaRows.length === 0) {
        return { commits: [], meta: { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIM, lastUpdated: null } };
    }

    const vecRows = db.prepare('SELECT rowid, embedding FROM commit_vectors').all();
    const vecByRowid = new Map();
    for (const v of vecRows) {
        const buf = v.embedding; // Buffer
        const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        vecByRowid.set(v.rowid, Array.from(f32));
    }

    const commits = metaRows.map(r => ({
        id: r.id,
        commitId: r.commitId,
        repo: r.repo,
        date: r.date,
        author: r.author,
        text: r.text,
        embedding: vecByRowid.get(r.rowid) || [],
        metadata: JSON.parse(r.metadata),
    }));

    return {
        commits,
        meta: { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIM, lastUpdated: new Date().toISOString() },
    };
}

export { loadVectorStore, searchVectors, lookupByCommitIds, upsertVectors, getVectorStats, cosineSimilarity, closeVectorStore };
