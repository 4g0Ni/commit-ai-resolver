/**
 * FeedbackPanel — Modal overlay showing recent chat queries and user feedback.
 */
import { useState, useEffect } from 'react';
import { fetchFeedbackStats, fetchRecentFeedback } from '../api';

function FeedbackPanel({ onClose }) {
    const [stats, setStats] = useState(null);
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        Promise.all([fetchFeedbackStats(), fetchRecentFeedback(50)])
            .then(([s, r]) => { setStats(s); setRows(r); })
            .catch(err => console.error('Failed to load feedback:', err))
            .finally(() => setLoading(false));
    }, []);

    return (
        <div className="feedback-overlay" onClick={onClose}>
            <div className="feedback-panel" onClick={e => e.stopPropagation()}>
                <div className="feedback-panel-header">
                    <h2>Chat Feedback</h2>
                    <button className="feedback-close-btn" onClick={onClose}>&times;</button>
                </div>

                {loading ? (
                    <div className="feedback-loading">Loading...</div>
                ) : (
                    <>
                        {stats && (
                            <div className="feedback-stats-bar">
                                <span>Queries: <strong>{stats.total_queries}</strong></span>
                                <span>Avg confidence: <strong>{stats.avg_confidence != null ? (stats.avg_confidence * 100).toFixed(0) + '%' : 'N/A'}</strong></span>
                                <span className="feedback-stat-up">&#128077; <strong>{stats.thumbs_up}</strong></span>
                                <span className="feedback-stat-down">&#128078; <strong>{stats.thumbs_down}</strong></span>
                            </div>
                        )}

                        <div className="feedback-table-wrap">
                            <table className="feedback-table">
                                <thead>
                                    <tr>
                                        <th>Time</th>
                                        <th>Query</th>
                                        <th>Confidence</th>
                                        <th>Method</th>
                                        <th>Iters</th>
                                        <th>Vote</th>
                                        <th>Comment</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.length === 0 && (
                                        <tr><td colSpan="7" className="feedback-empty">No queries yet. Send a chat message to start logging.</td></tr>
                                    )}
                                    {rows.map((row, i) => (
                                        <tr key={i} className={row.vote === 'down' ? 'feedback-row-down' : ''}>
                                            <td className="feedback-time">{row.created_at?.replace('T', ' ').slice(0, 16)}</td>
                                            <td className="feedback-query" title={row.query}>{row.query?.slice(0, 80)}{row.query?.length > 80 ? '...' : ''}</td>
                                            <td>{row.confidence != null ? (row.confidence * 100).toFixed(0) + '%' : '-'}</td>
                                            <td>{row.search_method || '-'}</td>
                                            <td>{row.iterations ?? '-'}</td>
                                            <td className="feedback-vote">
                                                {row.vote === 'up' ? '\u{1F44D}' : row.vote === 'down' ? '\u{1F44E}' : '-'}
                                            </td>
                                            <td className="feedback-comment" title={row.comment}>{row.comment || ''}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

export default FeedbackPanel;
