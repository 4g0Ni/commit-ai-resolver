/**
 * Vector database — sqlite-vec-backed vector store for commit embeddings.
 *
 * Storage: SQLite DB at data/vectors.db with four logical tables/indexes:
 *   - commit_vectors  (vec0 virtual table): rowid, configurable float embedding, repo partition key
 *   - commit_metadata (regular table):      rowid, id, commitId, repo, date, author, text, metadata (JSON)
 *   - commit_fts      (FTS5 table):          lexical index over the same searchable commit text
 *   - vector_store_meta:                     embedding/index contract used to reject stale indexes
 *
 * Joined by rowid. Repo is a vec0 partition key for fast per-repo KNN; date/author/risk/changeType
 * are filtered on the JOIN (or post-filtered from metadata JSON for risk/changeType).
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { getEmbeddingConfig } from './embedding-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = process.env.DATA_DIR || join(__dirname, '..', '..', 'data');
const VECTORS_DB_PATH = process.env.VECTORS_DB || join(DATA_ROOT, 'vectors.db');
const EXACT_FILTER_LIMIT = Number.parseInt(process.env.VECTOR_EXACT_FILTER_LIMIT || '20000', 10);

let _db = null;

/**
 * Open (and lazily initialize) the vectors DB. Idempotent.
 */
function getDb() {
    if (_db) return _db;
    mkdirSync(dirname(VECTORS_DB_PATH), { recursive: true });
    const db = new Database(VECTORS_DB_PATH);
    try {
        sqliteVec.load(db);
        db.pragma('journal_mode = WAL');
        const embeddingConfig = getEmbeddingConfig();
        db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS commit_vectors USING vec0(
                embedding float[${embeddingConfig.dimensions}] distance_metric=cosine,
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
            CREATE INDEX IF NOT EXISTS idx_meta_repo_date ON commit_metadata(repo, date);
            CREATE VIRTUAL TABLE IF NOT EXISTS commit_fts USING fts5(text, tokenize='unicode61');
            CREATE TABLE IF NOT EXISTS vector_store_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);
        ensureIndexContract(db, embeddingConfig);
        ensureFtsSynchronized(db);
        _db = db;
        return _db;
    } catch (error) {
        db.close();
        throw error;
    }
}

function ensureIndexContract(db, config) {
    const expected = {
        embeddingModel: config.model,
        embeddingDimensions: String(config.dimensions),
        documentTemplateVersion: config.documentTemplateVersion,
    };
    const readMeta = db.prepare('SELECT value FROM vector_store_meta WHERE key = ?');
    const writeMeta = db.prepare('INSERT OR IGNORE INTO vector_store_meta(key, value) VALUES (?, ?)');
    const total = db.prepare('SELECT COUNT(*) AS c FROM commit_metadata').get().c;
    const contractCount = db.prepare('SELECT COUNT(*) AS c FROM vector_store_meta').get().c;

    // Databases created before the manifest existed used the hard-coded v1 contract.
    // Record that contract first so a v2/model change fails closed instead of silently mixing spaces.
    if (total > 0 && contractCount === 0) {
        const firstVector = db.prepare('SELECT embedding FROM commit_vectors LIMIT 1').get();
        const legacyDimensions = firstVector?.embedding?.byteLength
            ? String(firstVector.embedding.byteLength / 4)
            : '3072';
        writeMeta.run('embeddingModel', 'text-embedding-3-large');
        writeMeta.run('embeddingDimensions', legacyDimensions);
        writeMeta.run('documentTemplateVersion', '1');
    }

    for (const [key, value] of Object.entries(expected)) {
        const existing = readMeta.get(key)?.value;
        if (existing === undefined) {
            writeMeta.run(key, value);
        } else if (existing !== value) {
            throw new Error(
                `Vector index contract mismatch for ${key}: database=${existing}, configured=${value}. ` +
                'Rebuild data/vectors.db with node scripts/reset-and-refresh.js --rebuild-embeddings.'
            );
        }
    }
}

function ensureFtsSynchronized(db) {
    const metadataCount = db.prepare('SELECT COUNT(*) AS c FROM commit_metadata').get().c;
    const ftsCount = db.prepare('SELECT COUNT(*) AS c FROM commit_fts').get().c;
    if (metadataCount === ftsCount) return;

    const rebuild = db.transaction(() => {
        db.exec('DELETE FROM commit_fts');
        db.exec('INSERT INTO commit_fts(rowid, text) SELECT rowid, text FROM commit_metadata');
    });
    rebuild();
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
    if (a.length !== b.length) return Number.NEGATIVE_INFINITY;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function metadataFilters(opts, alias = 'm') {
    const { repo, author, dateFrom, dateTo, riskLevel, changeType } = opts;
    const clauses = [];
    const params = [];
    if (repo) {
        clauses.push(`${alias}.repo = ?`);
        params.push(repo);
    }
    if (author) {
        clauses.push(`lower(${alias}.author) LIKE ?`);
        params.push(`%${author.toLowerCase()}%`);
    }
    if (dateFrom) {
        clauses.push(`${alias}.date >= ?`);
        params.push(dateFrom);
    }
    if (dateTo) {
        clauses.push(`${alias}.date <= ?`);
        params.push(dateTo);
    }
    if (riskLevel) {
        clauses.push(`json_extract(${alias}.metadata, '$.riskLevel') = ?`);
        params.push(riskLevel);
    }
    if (changeType === 'config') {
        clauses.push(`json_extract(${alias}.metadata, '$.changeType') IN ('config', 'mixed')`);
    } else if (changeType) {
        clauses.push(`json_extract(${alias}.metadata, '$.changeType') = ?`);
        params.push(changeType);
    }
    return { clauses, params };
}

function rowToResult(row, score, extra = {}) {
    return {
        id: row.id,
        commitId: row.commitId,
        repo: row.repo,
        date: row.date,
        author: row.author,
        text: row.text,
        score,
        metadata: JSON.parse(row.metadata),
        ...extra,
    };
}

function exactFilteredSearch(db, queryEmbedding, opts) {
    const { topK = 10, minScore = 0.3 } = opts;
    const { clauses, params } = metadataFilters(opts);
    if (clauses.length === 0) return null;

    const rows = db.prepare(`
        SELECT m.rowid, m.id, m.commitId, m.repo, m.date, m.author, m.text, m.metadata, v.embedding
        FROM commit_metadata m
        JOIN commit_vectors v ON v.rowid = m.rowid
        WHERE ${clauses.join(' AND ')}
        LIMIT ?
    `).all(...params, EXACT_FILTER_LIMIT + 1);

    if (rows.length > EXACT_FILTER_LIMIT) return null;
    return rows
        .map(row => {
            const buffer = row.embedding;
            const vector = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
            return rowToResult(row, cosineSimilarity(queryEmbedding, vector), { _retrievalMode: 'exact-filtered' });
        })
        .filter(result => result.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
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
    const { dimensions } = getEmbeddingConfig();
    if (queryEmbedding.length !== dimensions) {
        throw new Error(`Query embedding has ${queryEmbedding.length} dimensions; vector index expects ${dimensions}.`);
    }

    // For selective filters, compute exact cosine only over the SQL-filtered candidates.
    // This prevents globally top-ranked rows from crowding out the requested date/author/risk slice.
    const exactResults = exactFilteredSearch(db, queryEmbedding, opts);
    if (exactResults !== null) return exactResults;

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
    const preFilterLimit = hasAnyFilter ? Math.max(topK * 10, 500) : topK * 3;
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
    let results = raw.map(row => rowToResult(row, 1 - row.distance, { _retrievalMode: 'knn' }));

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

function buildFtsQuery(query) {
    const rawTerms = String(query || '').match(/[\p{L}\p{N}_./:-]{2,}/gu) || [];
    const terms = [];
    for (const raw of rawTerms) {
        terms.push(raw);
        const split = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s./:_-]+/);
        terms.push(...split.filter(part => part.length >= 2));
    }
    return [...new Set(terms)]
        .slice(0, 16)
        .map(term => `"${term.replace(/"/g, '""')}"`)
        .join(' OR ');
}

/** Search exact identifiers, paths, error terms, and commit wording through SQLite FTS5. */
async function searchLexical(query, opts = {}) {
    const { topK = 30 } = opts;
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];
    const db = getDb();
    const { clauses, params } = metadataFilters(opts);
    const rows = db.prepare(`
        SELECT f.rowid, bm25(commit_fts) AS lexicalRank,
               m.id, m.commitId, m.repo, m.date, m.author, m.text, m.metadata
        FROM commit_fts f
        JOIN commit_metadata m ON m.rowid = f.rowid
        WHERE commit_fts MATCH ?
        ${clauses.length ? `AND ${clauses.join(' AND ')}` : ''}
        ORDER BY lexicalRank
        LIMIT ?
    `).all(ftsQuery, ...params, topK);

    return rows.map((row, index) => rowToResult(row, 0, {
        _lexicalScore: 1 / (index + 1),
        _bm25: row.lexicalRank,
        _retrievalMode: 'fts5',
    }));
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
    const deleteFts = db.prepare('DELETE FROM commit_fts WHERE rowid = ?');
    const insertFts = db.prepare('INSERT INTO commit_fts(rowid, text) VALUES (?, ?)');
    const { dimensions } = getEmbeddingConfig();

    const upsertOne = (e) => {
        const author = e.author || e.metadata?.author || '';
        const metaJson = JSON.stringify(e.metadata);
        const embedding = new Float32Array(e.embedding);
        if (embedding.length !== dimensions) {
            throw new Error(`Embedding for ${e.repo}:${e.id} has ${embedding.length} dimensions; expected ${dimensions}.`);
        }

        const existing = findRowid.get(e.repo, e.id);
        if (existing) {
            updateMeta.run(e.commitId || '', e.date, author, e.text, metaJson, existing.rowid);
            // vec0 UPDATE on partitioned tables varies by version; delete+insert with same rowid is safe.
            deleteVec.run(existing.rowid);
            insertVec.run(BigInt(existing.rowid), embedding, e.repo);
            deleteFts.run(existing.rowid);
            insertFts.run(existing.rowid, e.text);
        } else {
            const info = insertMeta.run(e.id, e.commitId || '', e.repo, e.date, author, e.text, metaJson);
            insertVec.run(BigInt(info.lastInsertRowid), embedding, e.repo);
            insertFts.run(info.lastInsertRowid, e.text);
        }
    };

    const upsertAll = db.transaction((items) => {
        for (const e of items) upsertOne(e);
    });

    upsertAll(entries);
    db.prepare(`
        INSERT INTO vector_store_meta(key, value) VALUES ('lastUpdated', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(new Date().toISOString());
    return entries.length;
}

/**
 * Get stats about the vector store.
 */
async function getVectorStats() {
    const db = getDb();
    const embeddingConfig = getEmbeddingConfig();
    const lastUpdated = db.prepare("SELECT value FROM vector_store_meta WHERE key = 'lastUpdated'").get()?.value || null;
    const total = db.prepare('SELECT COUNT(*) AS c FROM commit_metadata').get().c;
    if (total === 0) {
        return {
            totalCommits: 0,
            repos: [],
            dateRange: null,
            model: embeddingConfig.model,
            dimensions: embeddingConfig.dimensions,
            documentTemplateVersion: embeddingConfig.documentTemplateVersion,
            retrieval: ['dense-cosine', 'fts5'],
            lastUpdated,
        };
    }
    const repos = db.prepare('SELECT DISTINCT repo FROM commit_metadata').all().map(r => r.repo);
    const range = db.prepare('SELECT MIN(date) AS minD, MAX(date) AS maxD FROM commit_metadata').get();

    return {
        totalCommits: total,
        repos,
        dateRange: range.minD && range.maxD ? { from: range.minD, to: range.maxD } : null,
        model: embeddingConfig.model,
        dimensions: embeddingConfig.dimensions,
        documentTemplateVersion: embeddingConfig.documentTemplateVersion,
        retrieval: ['dense-cosine', 'fts5'],
        lastUpdated,
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

    // Preserve a full SHA for exact matching. Short SHAs are matched as an ID
    // prefix because callers commonly provide seven or eight characters.
    const normalizedIds = [...new Set(shortIds.map(value => String(value).trim().toLowerCase()).filter(Boolean))];
    if (normalizedIds.length === 0) return [];
    const clauses = [];
    const params = [];
    for (const value of normalizedIds) {
        if (value.length > 8) {
            clauses.push('lower(commitId) = ?');
            params.push(value);
        } else {
            clauses.push('lower(id) LIKE ?');
            params.push(`${value}%`);
        }
    }
    const rows = db.prepare(
        `SELECT id, commitId, repo, date, author, text, metadata FROM commit_metadata WHERE ${clauses.join(' OR ')}`
    ).all(...params);

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
    const embeddingConfig = getEmbeddingConfig();
    const metaRows = db.prepare(
        'SELECT rowid, id, commitId, repo, date, author, text, metadata FROM commit_metadata'
    ).all();
    if (metaRows.length === 0) {
        return { commits: [], meta: { model: embeddingConfig.model, dimensions: embeddingConfig.dimensions, lastUpdated: null } };
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
        meta: { model: embeddingConfig.model, dimensions: embeddingConfig.dimensions, lastUpdated: new Date().toISOString() },
    };
}

export { loadVectorStore, searchVectors, searchLexical, lookupByCommitIds, upsertVectors, getVectorStats, cosineSimilarity, closeVectorStore };
