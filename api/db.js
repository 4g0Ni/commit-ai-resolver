/**
 * SQLite telemetry database — logs chat queries and user feedback.
 * DB file: data/feedback.db (auto-created on first import).
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import {
    registerPromptRollbackListener,
    reportPromptOutcome,
    restorePromptRollback,
} from '../src/prompts/prompt-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_BASE = process.env.DATA_DIR || join(__dirname, '..', 'data');
mkdirSync(DATA_BASE, { recursive: true });
const DB_PATH = join(DATA_BASE, 'feedback.db');

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
    prompt_versions TEXT,
    prompt_metrics TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query_id TEXT NOT NULL REFERENCES chat_queries(id),
    vote TEXT NOT NULL CHECK(vote IN ('up', 'down')),
    comment TEXT,
    voted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query_id TEXT NOT NULL REFERENCES chat_queries(id) ON DELETE CASCADE,
    iteration INTEGER,
    agent TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    prompt_variant TEXT NOT NULL DEFAULT 'stable',
    structured_output INTEGER NOT NULL DEFAULT 0,
    fallback_used INTEGER NOT NULL DEFAULT 0,
    parse_error INTEGER NOT NULL DEFAULT 0,
    validation_rejections INTEGER NOT NULL DEFAULT 0,
    elapsed_ms INTEGER,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_experiment_state (
    agent TEXT PRIMARY KEY,
    disabled INTEGER NOT NULL DEFAULT 0,
    rollback_reason TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_queries_created_at ON chat_queries(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_feedback_query_id ON chat_feedback(query_id);
CREATE INDEX IF NOT EXISTS idx_prompt_events_query_id ON prompt_events(query_id);
CREATE INDEX IF NOT EXISTS idx_prompt_events_agent_version ON prompt_events(agent, prompt_version);
`);

const savePromptRollback = db.prepare(`
    INSERT INTO prompt_experiment_state (agent, disabled, rollback_reason, updated_at)
    VALUES (?, 1, ?, datetime('now'))
    ON CONFLICT(agent) DO UPDATE SET disabled = 1, rollback_reason = excluded.rollback_reason, updated_at = datetime('now')
`);

if (process.env.PROMPT_EXPERIMENT_RESET_ROLLBACKS === '1') {
    db.exec('DELETE FROM prompt_experiment_state');
} else {
    for (const row of db.prepare('SELECT agent, rollback_reason FROM prompt_experiment_state WHERE disabled = 1').all()) {
        restorePromptRollback(row.agent, row.rollback_reason);
    }
}
registerPromptRollbackListener(({ agent, reason }) => savePromptRollback.run(agent, reason));

// Add elapsed_ms column if missing (existing DBs)
try { db.exec('ALTER TABLE chat_queries ADD COLUMN elapsed_ms INTEGER'); } catch {}
// Add user_id column if missing (existing DBs)
try { db.exec('ALTER TABLE chat_queries ADD COLUMN user_id TEXT'); } catch {}
// Add source + tool_name for unified UI/API/MCP usage tracking
try { db.exec("ALTER TABLE chat_queries ADD COLUMN source TEXT"); } catch {}
try { db.exec("ALTER TABLE chat_queries ADD COLUMN tool_name TEXT"); } catch {}
try { db.exec("ALTER TABLE chat_queries ADD COLUMN prompt_versions TEXT"); } catch {}
try { db.exec("ALTER TABLE chat_queries ADD COLUMN prompt_metrics TEXT"); } catch {}
db.exec("UPDATE chat_queries SET source = 'ui' WHERE source IS NULL");
db.exec("CREATE INDEX IF NOT EXISTS idx_chat_queries_source ON chat_queries(source)");

const insertQuery = db.prepare(`
    INSERT INTO chat_queries (id, query, response, confidence, iterations, search_method, result_count, iteration_log, work_item_id, work_item_title, elapsed_ms, user_id, source, tool_name, prompt_versions, prompt_metrics)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertFeedback = db.prepare(`
    INSERT INTO chat_feedback (query_id, vote, comment)
    VALUES (?, ?, ?)
`);

const insertPromptEvent = db.prepare(`
    INSERT INTO prompt_events (
        query_id, iteration, agent, prompt_version, prompt_variant,
        structured_output, fallback_used, parse_error, validation_rejections,
        elapsed_ms, prompt_tokens, completion_tokens, total_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertQueryWithEvents = db.transaction((queryValues, iterationLog) => {
    insertQuery.run(...queryValues);
    for (const entry of iterationLog || []) {
        if (entry.status !== 'done' || !entry.promptVersion) continue;
        insertPromptEvent.run(
            queryValues[0], entry.iteration || null, entry.stage, entry.promptVersion,
            entry.promptVariant || 'stable', entry.structuredOutput ? 1 : 0,
            entry.structuredFallback ? 1 : 0, entry.parseError ? 1 : 0,
            entry.validationRejections || 0, entry.elapsed || null,
            entry.promptTokens || null, entry.completionTokens || null, entry.totalTokens || null,
        );
    }
});

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
        q.prompt_versions, q.prompt_metrics, q.created_at,
        f.vote, f.comment, f.voted_at
    FROM chat_queries q
    LEFT JOIN chat_feedback f ON f.query_id = q.id
    ORDER BY q.created_at DESC
    LIMIT ?
`);

export function logQuery({ id, query, response, confidence, iterations, searchMethod, resultCount, iterationLog, workItemId, workItemTitle, elapsedMs, userId, source, toolName, promptVersions, promptMetrics }) {
    insertQueryWithEvents([
        id, query, response, confidence, iterations, searchMethod, resultCount,
        JSON.stringify(iterationLog || []), workItemId || null, workItemTitle || null,
        elapsedMs || null, userId || null, source || 'ui', toolName || null,
        promptVersions ? JSON.stringify(promptVersions) : null,
        promptMetrics ? JSON.stringify(promptMetrics) : null,
    ], iterationLog || []);
}

export function recordFeedback({ queryId, vote, comment }) {
    insertFeedback.run(queryId, vote, comment || null);
    const candidateEvents = db.prepare(`
        SELECT DISTINCT agent, prompt_variant
        FROM prompt_events
        WHERE query_id = ? AND prompt_variant = 'candidate'
    `).all(queryId);
    for (const event of candidateEvents) {
        reportPromptOutcome(event.agent, event.prompt_variant, { failed: vote === 'down' });
    }
}

export function logQueryStub({ id, query, response, confidence, searchMethod, source }) {
    insertQuery.run(id, query || '', response || '', confidence || null, null, searchMethod || null, null, '[]', null, null, null, null, source || 'ui', null, null, null);
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
 * Compute the full metrics block for an optional source filter.
 * sourceFilter: null | 'ui' | 'api' | 'mcp'
 */
function computeBlock(sourceFilter) {
    const whereSource = sourceFilter ? `source = '${sourceFilter}'` : '1=1';
    const andSource = sourceFilter ? ` AND source = '${sourceFilter}'` : '';

    const total = db.prepare(`SELECT COUNT(*) AS c FROM chat_queries WHERE ${whereSource}`).get().c;
    const today = db.prepare(`SELECT COUNT(*) AS c FROM chat_queries WHERE ${whereSource} AND created_at >= date('now')`).get().c;
    const thisWeek = db.prepare(`SELECT COUNT(*) AS c FROM chat_queries WHERE ${whereSource} AND created_at >= date('now', '-7 days')`).get().c;
    const thisMonth = db.prepare(`SELECT COUNT(*) AS c FROM chat_queries WHERE ${whereSource} AND created_at >= date('now', '-30 days')`).get().c;
    const avgConfidence = db.prepare(`SELECT AVG(confidence) AS v FROM chat_queries WHERE confidence IS NOT NULL${andSource}`).get().v;
    const avgElapsed = db.prepare(`SELECT AVG(elapsed_ms) AS v FROM chat_queries WHERE elapsed_ms IS NOT NULL${andSource}`).get().v;
    const errorCount = db.prepare(`SELECT COUNT(*) AS c FROM chat_queries WHERE (response IS NULL OR response = '' OR confidence <= 0)${andSource}`).get().c;

    const dailyVolume = db.prepare(`
        SELECT date(created_at) AS date, COUNT(*) AS count
        FROM chat_queries
        WHERE created_at >= datetime('now', '-30 days')${andSource}
        GROUP BY date(created_at)
        ORDER BY date ASC
    `).all();

    const confidenceDist = db.prepare(`
        SELECT
            SUM(CASE WHEN confidence < 0.25 THEN 1 ELSE 0 END) AS low,
            SUM(CASE WHEN confidence >= 0.25 AND confidence < 0.5 THEN 1 ELSE 0 END) AS med_low,
            SUM(CASE WHEN confidence >= 0.5 AND confidence < 0.75 THEN 1 ELSE 0 END) AS med_high,
            SUM(CASE WHEN confidence >= 0.75 THEN 1 ELSE 0 END) AS high
        FROM chat_queries
        WHERE confidence IS NOT NULL${andSource}
    `).get() || { low: 0, med_low: 0, med_high: 0, high: 0 };

    const methodBreakdown = db.prepare(`
        SELECT search_method AS method, COUNT(*) AS count
        FROM chat_queries
        WHERE search_method IS NOT NULL${andSource}
        GROUP BY search_method
        ORDER BY count DESC
    `).all();

    const dau = db.prepare(`SELECT COUNT(DISTINCT user_id) AS c FROM chat_queries WHERE user_id IS NOT NULL${andSource} AND created_at >= date('now')`).get().c;
    const wau = db.prepare(`SELECT COUNT(DISTINCT user_id) AS c FROM chat_queries WHERE user_id IS NOT NULL${andSource} AND created_at >= date('now', '-7 days')`).get().c;
    const mau = db.prepare(`SELECT COUNT(DISTINCT user_id) AS c FROM chat_queries WHERE user_id IS NOT NULL${andSource} AND created_at >= date('now', '-30 days')`).get().c;

    const dailyActiveUsers = db.prepare(`
        SELECT date(created_at) AS date, COUNT(DISTINCT user_id) AS users
        FROM chat_queries
        WHERE user_id IS NOT NULL AND created_at >= datetime('now', '-30 days')${andSource}
        GROUP BY date(created_at)
        ORDER BY date ASC
    `).all();

    // Feedback only meaningful for UI today; for filtered blocks we still scope by query source.
    const feedbackStats = db.prepare(`
        SELECT
            (SELECT COUNT(*) FROM chat_feedback f JOIN chat_queries q ON q.id = f.query_id WHERE ${whereSource}) AS total_votes,
            (SELECT COUNT(*) FROM chat_feedback f JOIN chat_queries q ON q.id = f.query_id WHERE f.vote = 'up' AND ${whereSource}) AS thumbs_up,
            (SELECT COUNT(*) FROM chat_feedback f JOIN chat_queries q ON q.id = f.query_id WHERE f.vote = 'down' AND ${whereSource}) AS thumbs_down
    `).get();

    const feedbackRate = total > 0 ? Math.round((feedbackStats.total_votes / total) * 10000) / 100 : 0;
    const positiveRate = feedbackStats.total_votes > 0
        ? Math.round((feedbackStats.thumbs_up / feedbackStats.total_votes) * 10000) / 100 : 0;
    const negativeRate = feedbackStats.total_votes > 0
        ? Math.round((feedbackStats.thumbs_down / feedbackStats.total_votes) * 10000) / 100 : 0;

    const latencies = db.prepare(
        `SELECT elapsed_ms FROM chat_queries WHERE elapsed_ms IS NOT NULL${andSource} ORDER BY elapsed_ms ASC`
    ).all().map(r => r.elapsed_ms);
    const p50 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.5)] : null;
    const p95 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : null;

    const avgQueriesPerUser = db.prepare(
        `SELECT AVG(cnt) AS v FROM (SELECT COUNT(*) AS cnt FROM chat_queries WHERE user_id IS NOT NULL${andSource} GROUP BY user_id)`
    ).get()?.v || null;

    const returningUsers = db.prepare(
        `SELECT COUNT(*) AS c FROM (SELECT user_id FROM chat_queries WHERE user_id IS NOT NULL${andSource} GROUP BY user_id HAVING COUNT(DISTINCT date(created_at)) > 1)`
    ).get().c;
    const totalUsers = db.prepare(
        `SELECT COUNT(DISTINCT user_id) AS c FROM chat_queries WHERE user_id IS NOT NULL${andSource}`
    ).get().c;
    const retentionRate = totalUsers > 0 ? Math.round((returningUsers / totalUsers) * 10000) / 100 : 0;

    const promptMetricRows = db.prepare(
        `SELECT prompt_metrics FROM chat_queries WHERE prompt_metrics IS NOT NULL${andSource}`
    ).all();
    const promptQuality = promptMetricRows.reduce((totals, row) => {
        try {
            const value = JSON.parse(row.prompt_metrics);
            totals.structuredCalls += Number(value.structuredCalls) || 0;
            totals.structuredFallbacks += Number(value.structuredFallbacks) || 0;
            totals.parseErrors += Number(value.parseErrors) || 0;
            totals.validationRejections += Number(value.validationRejections) || 0;
            totals.promptTokens += Number(value.promptTokens) || 0;
            totals.completionTokens += Number(value.completionTokens) || 0;
            totals.totalTokens += Number(value.totalTokens) || 0;
        } catch { /* retain query telemetry even if an old row contains malformed JSON */ }
        return totals;
    }, {
        structuredCalls: 0, structuredFallbacks: 0, parseErrors: 0, validationRejections: 0,
        promptTokens: 0, completionTokens: 0, totalTokens: 0,
    });

    const promptBreakdown = db.prepare(`
        SELECT e.agent, e.prompt_version AS version, e.prompt_variant AS variant,
            COUNT(*) AS calls,
            SUM(e.fallback_used) AS fallbacks,
            SUM(e.parse_error) AS parse_errors,
            SUM(e.validation_rejections) AS validation_rejections,
            ROUND(AVG(e.elapsed_ms)) AS avg_elapsed_ms,
            SUM(COALESCE(e.prompt_tokens, 0)) AS prompt_tokens,
            SUM(COALESCE(e.completion_tokens, 0)) AS completion_tokens,
            SUM(COALESCE(e.total_tokens, 0)) AS total_tokens,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM chat_feedback f WHERE f.query_id = e.query_id AND f.vote = 'up') THEN 1 ELSE 0 END) AS thumbs_up,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM chat_feedback f WHERE f.query_id = e.query_id AND f.vote = 'down') THEN 1 ELSE 0 END) AS thumbs_down
        FROM prompt_events e
        JOIN chat_queries q ON q.id = e.query_id
        WHERE ${sourceFilter ? `q.source = '${sourceFilter}'` : '1=1'}
        GROUP BY e.agent, e.prompt_version, e.prompt_variant
        ORDER BY e.agent, calls DESC
    `).all();

    return {
        summary: { total, today, thisWeek, thisMonth },
        activeUsers: { dau, wau, mau },
        dailyActiveUsers,
        avgConfidence: avgConfidence ? Math.round(avgConfidence * 100) / 100 : null,
        avgElapsedMs: avgElapsed ? Math.round(avgElapsed) : null,
        latency: { p50, p95 },
        errorRate: total > 0 ? Math.round((errorCount / total) * 10000) / 100 : 0,
        dailyVolume,
        confidenceDist,
        methodBreakdown,
        promptQuality,
        promptBreakdown,
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

/**
 * Get comprehensive usage metrics from the SQLite database, broken out by source.
 * Returns { all, ui, api, mcp } — each block has the same shape; mcp additionally has toolBreakdown.
 */
export function getUsageMetrics() {
    const toolBreakdown = db.prepare(`
        SELECT tool_name AS tool, COUNT(*) AS count
        FROM chat_queries
        WHERE source = 'mcp' AND tool_name IS NOT NULL
        GROUP BY tool_name
        ORDER BY count DESC
    `).all();

    return {
        all: computeBlock(null),
        ui: computeBlock('ui'),
        api: computeBlock('api'),
        mcp: { ...computeBlock('mcp'), toolBreakdown },
    };
}

/**
 * Delete all rows from chat_feedback and chat_queries tables.
 */
export function clearDatabase() {
    db.exec('DELETE FROM prompt_events');
    db.exec('DELETE FROM chat_feedback');
    db.exec('DELETE FROM chat_queries');
}

export default db;
