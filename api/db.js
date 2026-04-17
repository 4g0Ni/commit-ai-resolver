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
    elapsed_ms INTEGER,
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

// Add elapsed_ms column if missing (existing DBs)
try { db.exec('ALTER TABLE chat_queries ADD COLUMN elapsed_ms INTEGER'); } catch {}
// Add user_id column if missing (existing DBs)
try { db.exec('ALTER TABLE chat_queries ADD COLUMN user_id TEXT'); } catch {}

const insertQuery = db.prepare(`
    INSERT INTO chat_queries (id, query, response, confidence, iterations, search_method, result_count, iteration_log, work_item_id, work_item_title, elapsed_ms, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

export function logQuery({ id, query, response, confidence, iterations, searchMethod, resultCount, iterationLog, workItemId, workItemTitle, elapsedMs, userId }) {
    insertQuery.run(id, query, response, confidence, iterations, searchMethod, resultCount, JSON.stringify(iterationLog || []), workItemId || null, workItemTitle || null, elapsedMs || null, userId || null);
}

export function recordFeedback({ queryId, vote, comment }) {
    insertFeedback.run(queryId, vote, comment || null);
}

export function logQueryStub({ id, query, response, confidence, searchMethod }) {
    insertQuery.run(id, query || '', response || '', confidence || null, null, searchMethod || null, null, '[]', null, null, null, null);
}

export function getFeedbackStats() {
    return getStats.get();
}

export function getRecentFeedback(limit = 50) {
    return getRecent.all(limit);
}

const getDailyVolume = db.prepare(`
    SELECT date(created_at) AS date, COUNT(*) AS count
    FROM chat_queries
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY date(created_at)
    ORDER BY date ASC
`);

const getConfidenceDist = db.prepare(`
    SELECT
        SUM(CASE WHEN confidence < 0.25 THEN 1 ELSE 0 END) AS low,
        SUM(CASE WHEN confidence >= 0.25 AND confidence < 0.5 THEN 1 ELSE 0 END) AS med_low,
        SUM(CASE WHEN confidence >= 0.5 AND confidence < 0.75 THEN 1 ELSE 0 END) AS med_high,
        SUM(CASE WHEN confidence >= 0.75 THEN 1 ELSE 0 END) AS high
    FROM chat_queries
    WHERE confidence IS NOT NULL
`);

const getMethodBreakdown = db.prepare(`
    SELECT search_method AS method, COUNT(*) AS count
    FROM chat_queries
    WHERE search_method IS NOT NULL
    GROUP BY search_method
    ORDER BY count DESC
`);

/**
 * Get comprehensive usage metrics from the SQLite database.
 */
export function getUsageMetrics() {
    const total = db.prepare('SELECT COUNT(*) AS c FROM chat_queries').get().c;
    const today = db.prepare("SELECT COUNT(*) AS c FROM chat_queries WHERE created_at >= date('now')").get().c;
    const thisWeek = db.prepare("SELECT COUNT(*) AS c FROM chat_queries WHERE created_at >= date('now', '-7 days')").get().c;
    const thisMonth = db.prepare("SELECT COUNT(*) AS c FROM chat_queries WHERE created_at >= date('now', '-30 days')").get().c;
    const avgConfidence = db.prepare('SELECT AVG(confidence) AS v FROM chat_queries WHERE confidence IS NOT NULL').get().v;
    const avgElapsed = db.prepare('SELECT AVG(elapsed_ms) AS v FROM chat_queries WHERE elapsed_ms IS NOT NULL').get().v;
    const errorCount = db.prepare("SELECT COUNT(*) AS c FROM chat_queries WHERE response IS NULL OR response = '' OR confidence <= 0").get().c;
    const feedbackStats = getStats.get();
    const dailyVolume = getDailyVolume.all();
    const confidenceDist = getConfidenceDist.get();
    const methodBreakdown = getMethodBreakdown.all();

    // DAU / MAU (based on user_id, falls back to 0 if no user_id tracked yet)
    const dau = db.prepare("SELECT COUNT(DISTINCT user_id) AS c FROM chat_queries WHERE user_id IS NOT NULL AND created_at >= date('now')").get().c;
    const wau = db.prepare("SELECT COUNT(DISTINCT user_id) AS c FROM chat_queries WHERE user_id IS NOT NULL AND created_at >= date('now', '-7 days')").get().c;
    const mau = db.prepare("SELECT COUNT(DISTINCT user_id) AS c FROM chat_queries WHERE user_id IS NOT NULL AND created_at >= date('now', '-30 days')").get().c;

    // Daily active users over last 30 days
    const dailyActiveUsers = db.prepare(`
        SELECT date(created_at) AS date, COUNT(DISTINCT user_id) AS users
        FROM chat_queries
        WHERE user_id IS NOT NULL AND created_at >= datetime('now', '-30 days')
        GROUP BY date(created_at)
        ORDER BY date ASC
    `).all();

    // Feedback rates
    const feedbackRate = total > 0 ? Math.round((feedbackStats.total_votes / total) * 10000) / 100 : 0;
    const positiveRate = feedbackStats.total_votes > 0
        ? Math.round((feedbackStats.thumbs_up / feedbackStats.total_votes) * 10000) / 100 : 0;
    const negativeRate = feedbackStats.total_votes > 0
        ? Math.round((feedbackStats.thumbs_down / feedbackStats.total_votes) * 10000) / 100 : 0;

    // Latency percentiles (p50, p95)
    const latencies = db.prepare(
        "SELECT elapsed_ms FROM chat_queries WHERE elapsed_ms IS NOT NULL ORDER BY elapsed_ms ASC"
    ).all().map(r => r.elapsed_ms);
    const p50 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.5)] : null;
    const p95 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : null;

    // Avg queries per user (engagement depth)
    const avgQueriesPerUser = db.prepare(
        "SELECT AVG(cnt) AS v FROM (SELECT COUNT(*) AS cnt FROM chat_queries WHERE user_id IS NOT NULL GROUP BY user_id)"
    ).get()?.v || null;

    // Returning users (users who queried on more than 1 distinct day)
    const returningUsers = db.prepare(
        "SELECT COUNT(*) AS c FROM (SELECT user_id FROM chat_queries WHERE user_id IS NOT NULL GROUP BY user_id HAVING COUNT(DISTINCT date(created_at)) > 1)"
    ).get().c;
    const totalUsers = db.prepare(
        "SELECT COUNT(DISTINCT user_id) AS c FROM chat_queries WHERE user_id IS NOT NULL"
    ).get().c;
    const retentionRate = totalUsers > 0 ? Math.round((returningUsers / totalUsers) * 10000) / 100 : 0;

    return {
        summary: { total, today, thisWeek, thisMonth },
        activeUsers: { dau, wau, mau },
        dailyActiveUsers,
        avgConfidence: avgConfidence ? Math.round(avgConfidence * 100) / 100 : null,
        avgElapsedMs: avgElapsed ? Math.round(avgElapsed) : null,
        latency: { p50, p95 },
        errorRate: total > 0 ? Math.round((errorCount / total) * 10000) / 100 : 0,
        dailyVolume,
        confidenceDist: confidenceDist || { low: 0, med_low: 0, med_high: 0, high: 0 },
        methodBreakdown,
        feedback: {
            thumbsUp: feedbackStats.thumbs_up,
            thumbsDown: feedbackStats.thumbs_down,
            totalVotes: feedbackStats.total_votes,
            feedbackRate,
            positiveRate,
            negativeRate,
        },
        engagement: {
            avgQueriesPerUser: avgQueriesPerUser ? Math.round(avgQueriesPerUser * 10) / 10 : null,
            totalUsers,
            returningUsers,
            retentionRate,
        },
    };
}

export default db;
