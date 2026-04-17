/**
 * SQLite telemetry database — logs chat queries and user feedback.
 * DB file: data/feedback.db (auto-created on first import).
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'feedback.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS chat_queries (
    id TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    response TEXT,
    confidence REAL,
    iterations INTEGER,
    search_method TEXT,
    result_count INTEGER,
    iteration_log TEXT,
    work_item_id TEXT,
    work_item_title TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query_id TEXT NOT NULL REFERENCES chat_queries(id),
    vote TEXT NOT NULL CHECK(vote IN ('up', 'down')),
    comment TEXT,
    voted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_queries_created_at ON chat_queries(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_feedback_query_id ON chat_feedback(query_id);
`);

const insertQuery = db.prepare(`
    INSERT INTO chat_queries (id, query, response, confidence, iterations, search_method, result_count, iteration_log, work_item_id, work_item_title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertFeedback = db.prepare(`
    INSERT INTO chat_feedback (query_id, vote, comment)
    VALUES (?, ?, ?)
`);

const getStats = db.prepare(`
    SELECT
        (SELECT COUNT(*) FROM chat_queries) AS total_queries,
        (SELECT AVG(confidence) FROM chat_queries WHERE confidence IS NOT NULL) AS avg_confidence,
        (SELECT COUNT(*) FROM chat_feedback WHERE vote = 'up') AS thumbs_up,
        (SELECT COUNT(*) FROM chat_feedback WHERE vote = 'down') AS thumbs_down,
        (SELECT COUNT(*) FROM chat_feedback) AS total_votes
`);

const getRecent = db.prepare(`
    SELECT
        q.id, q.query, q.response, q.confidence, q.iterations,
        q.search_method, q.result_count, q.work_item_id, q.work_item_title,
        q.created_at,
        f.vote, f.comment, f.voted_at
    FROM chat_queries q
    LEFT JOIN chat_feedback f ON f.query_id = q.id
    ORDER BY q.created_at DESC
    LIMIT ?
`);

export function logQuery({ id, query, response, confidence, iterations, searchMethod, resultCount, iterationLog, workItemId, workItemTitle }) {
    insertQuery.run(id, query, response, confidence, iterations, searchMethod, resultCount, JSON.stringify(iterationLog || []), workItemId || null, workItemTitle || null);
}

export function recordFeedback({ queryId, vote, comment }) {
    insertFeedback.run(queryId, vote, comment || null);
}

export function logQueryStub({ id, query, response, confidence, searchMethod }) {
    insertQuery.run(id, query || '', response || '', confidence || null, null, searchMethod || null, null, '[]', null, null);
}

export function getFeedbackStats() {
    return getStats.get();
}

export function getRecentFeedback(limit = 50) {
    return getRecent.all(limit);
}

export default db;
