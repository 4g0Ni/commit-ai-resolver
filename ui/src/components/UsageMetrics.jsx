import { useState, useEffect } from 'react';
import { fetchUsageMetrics } from '../api';

const SOURCE_TABS = [
    { key: 'all', label: 'All' },
    { key: 'ui', label: 'UI' },
    { key: 'api', label: 'API' },
    { key: 'mcp', label: 'MCP' },
];

function UsageMetrics({ onClose }) {
    const [metrics, setMetrics] = useState(null);
    const [loading, setLoading] = useState(true);
    const [source, setSource] = useState('all');

    useEffect(() => {
        fetchUsageMetrics()
            .then(setMetrics)
            .catch(err => console.error('Failed to load metrics:', err))
            .finally(() => setLoading(false));
    }, []);

    const data = metrics?.[source];
    const showQualityPanels = source === 'all' || source === 'ui';
    const showToolBreakdown = source === 'mcp';
    const promptQuality = data?.promptQuality || {};
    const structuredAttempts = (promptQuality.structuredCalls || 0) + (promptQuality.structuredFallbacks || 0);
    const fallbackRate = structuredAttempts > 0
        ? Math.round((promptQuality.structuredFallbacks / structuredAttempts) * 1000) / 10
        : 0;

    const maxVolume = data?.dailyVolume?.length
        ? Math.max(...data.dailyVolume.map(d => d.count))
        : 1;

    const maxDau = data?.dailyActiveUsers?.length
        ? Math.max(...data.dailyActiveUsers.map(d => d.users))
        : 1;

    const confTotal = data?.confidenceDist
        ? (data.confidenceDist.low + data.confidenceDist.med_low + data.confidenceDist.med_high + data.confidenceDist.high) || 1
        : 1;

    return (
        <div className="feedback-overlay" onClick={onClose}>
            <div className="feedback-panel usage-metrics-panel" onClick={e => e.stopPropagation()}>
                <div className="feedback-panel-header">
                    <h2>Usage Metrics</h2>
                    <button className="feedback-close-btn" onClick={onClose}>&times;</button>
                </div>

                {loading ? (
                    <div className="feedback-loading">Loading...</div>
                ) : !data ? (
                    <div className="feedback-loading">Failed to load metrics.</div>
                ) : (
                    <div className="usage-metrics-body">
                        {/* Source tabs */}
                        <div className="usage-source-tabs">
                            {SOURCE_TABS.map(t => (
                                <button
                                    key={t.key}
                                    className={`filter-btn ${source === t.key ? 'active' : ''}`}
                                    onClick={() => setSource(t.key)}
                                >
                                    {t.label}
                                    <span className="usage-source-count">
                                        {metrics?.[t.key]?.summary?.total ?? 0}
                                    </span>
                                </button>
                            ))}
                        </div>

                        {/* Summary cards */}
                        <div className="usage-stats-row">
                            <div className="usage-stat-card">
                                <div className="usage-stat-value">{data.summary.total}</div>
                                <div className="usage-stat-label">Total Queries</div>
                            </div>
                            <div className="usage-stat-card">
                                <div className="usage-stat-value">{data.summary.today}</div>
                                <div className="usage-stat-label">Today</div>
                            </div>
                            <div className="usage-stat-card">
                                <div className="usage-stat-value">{data.summary.thisWeek}</div>
                                <div className="usage-stat-label">This Week</div>
                            </div>
                            <div className="usage-stat-card">
                                <div className="usage-stat-value">{data.summary.thisMonth}</div>
                                <div className="usage-stat-label">This Month</div>
                            </div>
                            <div className="usage-stat-card">
                                <div className="usage-stat-value">
                                    {data.avgConfidence != null ? `${(data.avgConfidence * 100).toFixed(0)}%` : 'N/A'}
                                </div>
                                <div className="usage-stat-label">Avg Confidence</div>
                            </div>
                            <div className="usage-stat-card">
                                <div className="usage-stat-value">
                                    {data.avgElapsedMs != null ? `${(data.avgElapsedMs / 1000).toFixed(1)}s` : 'N/A'}
                                </div>
                                <div className="usage-stat-label">Avg Response</div>
                            </div>
                        </div>

                        {/* User engagement cards */}
                        <div className="usage-stats-row">
                            <div className="usage-stat-card usage-stat-highlight">
                                <div className="usage-stat-value">{data.activeUsers.dau}</div>
                                <div className="usage-stat-label">DAU (Today)</div>
                            </div>
                            <div className="usage-stat-card usage-stat-highlight">
                                <div className="usage-stat-value">{data.activeUsers.wau}</div>
                                <div className="usage-stat-label">WAU (7 days)</div>
                            </div>
                            <div className="usage-stat-card usage-stat-highlight">
                                <div className="usage-stat-value">{data.activeUsers.mau}</div>
                                <div className="usage-stat-label">MAU (30 days)</div>
                            </div>
                        </div>

                        {/* Daily active users chart */}
                        <div className="usage-section">
                            <h3 className="usage-section-title">Daily Active Users (30 days)</h3>
                            <div className="usage-volume-chart">
                                {data.dailyActiveUsers.length === 0 ? (
                                    <div className="usage-empty">No user data yet</div>
                                ) : (
                                    data.dailyActiveUsers.map((d, i) => (
                                        <div key={i} className="usage-bar-col" title={`${d.date}: ${d.users} users`}>
                                            <div className="usage-bar-count">{d.users}</div>
                                            <div
                                                className="usage-bar usage-bar-users"
                                                style={{ height: `${(d.users / maxDau) * 120}px` }}
                                            />
                                            <div className="usage-bar-date">{d.date.slice(5)}</div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>

                        {/* Daily volume chart */}
                        <div className="usage-section">
                            <h3 className="usage-section-title">Daily Query Volume (30 days)</h3>
                            <div className="usage-volume-chart">
                                {data.dailyVolume.length === 0 ? (
                                    <div className="usage-empty">No data yet</div>
                                ) : (
                                    data.dailyVolume.map((d, i) => (
                                        <div key={i} className="usage-bar-col" title={`${d.date}: ${d.count} queries`}>
                                            <div className="usage-bar-count">{d.count}</div>
                                            <div
                                                className="usage-bar"
                                                style={{ height: `${(d.count / maxVolume) * 120}px` }}
                                            />
                                            <div className="usage-bar-date">{d.date.slice(5)}</div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>

                        <div className="usage-grid">
                            {/* Confidence distribution */}
                            {showQualityPanels && (
                            <div className="usage-section">
                                <h3 className="usage-section-title">Confidence Distribution</h3>
                                <div className="usage-conf-bars">
                                    {[
                                        { label: '75-100%', value: data.confidenceDist.high, cls: 'high' },
                                        { label: '50-75%', value: data.confidenceDist.med_high, cls: 'med-high' },
                                        { label: '25-50%', value: data.confidenceDist.med_low, cls: 'med-low' },
                                        { label: '0-25%', value: data.confidenceDist.low, cls: 'low' },
                                    ].map((b, i) => (
                                        <div key={i} className="usage-conf-row">
                                            <span className="usage-conf-label">{b.label}</span>
                                            <div className="usage-conf-track">
                                                <div
                                                    className={`usage-conf-fill ${b.cls}`}
                                                    style={{ width: `${(b.value / confTotal) * 100}%` }}
                                                />
                                            </div>
                                            <span className="usage-conf-count">{b.value}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                            )}

                            {/* Search method breakdown */}
                            {showQualityPanels && (
                            <div className="usage-section">
                                <h3 className="usage-section-title">Search Methods</h3>
                                {data.methodBreakdown.length === 0 ? (
                                    <div className="usage-empty">No data</div>
                                ) : (
                                    <div className="usage-method-list">
                                        {data.methodBreakdown.map((m, i) => (
                                            <div key={i} className="usage-method-row">
                                                <span className="usage-method-name">{m.method}</span>
                                                <span className="usage-method-count">{m.count}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                            )}

                            {/* MCP tool breakdown */}
                            {showToolBreakdown && (
                            <div className="usage-section">
                                <h3 className="usage-section-title">MCP Tool Breakdown</h3>
                                {!data.toolBreakdown || data.toolBreakdown.length === 0 ? (
                                    <div className="usage-empty">No MCP tool calls yet</div>
                                ) : (
                                    <div className="usage-method-list">
                                        {data.toolBreakdown.map((t, i) => (
                                            <div key={i} className="usage-method-row">
                                                <span className="usage-method-name">{t.tool}</span>
                                                <span className="usage-method-count">{t.count}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                            )}

                            {/* Feedback & Quality */}
                            {showQualityPanels && (
                            <div className="usage-section">
                                <h3 className="usage-section-title">Feedback & Quality</h3>
                                <div className="usage-fe-cards">
                                    <div className="usage-fe-card">
                                        <span className="usage-fe-icon up">&#128077;</span>
                                        <span className="usage-fe-value">{data.feedback.thumbsUp}</span>
                                    </div>
                                    <div className="usage-fe-card">
                                        <span className="usage-fe-icon down">&#128078;</span>
                                        <span className="usage-fe-value">{data.feedback.thumbsDown}</span>
                                    </div>
                                </div>
                                <div className="usage-rate-list">
                                    <div className="usage-rate-row">
                                        <span className="usage-rate-label">Feedback Rate</span>
                                        <span className="usage-rate-value">{data.feedback.feedbackRate}%</span>
                                    </div>
                                    <div className="usage-rate-row positive">
                                        <span className="usage-rate-label">Positive Rate</span>
                                        <span className="usage-rate-value">{data.feedback.positiveRate}%</span>
                                    </div>
                                    <div className="usage-rate-row negative">
                                        <span className="usage-rate-label">Negative Rate</span>
                                        <span className="usage-rate-value">{data.feedback.negativeRate}%</span>
                                    </div>
                                    <div className="usage-rate-row">
                                        <span className="usage-rate-label">Error Rate</span>
                                        <span className="usage-rate-value">{data.errorRate}%</span>
                                    </div>
                                </div>
                            </div>
                            )}
                        </div>

                        {/* Prompt operations */}
                        <div className="usage-grid">
                            <div className="usage-section">
                                <h3 className="usage-section-title">Prompt Quality</h3>
                                <div className="usage-fe-cards">
                                    <div className="usage-fe-card">
                                        <span className="usage-fe-label">Schema Calls</span>
                                        <span className="usage-fe-value">{promptQuality.structuredCalls || 0}</span>
                                    </div>
                                    <div className="usage-fe-card">
                                        <span className="usage-fe-label">Fallback Rate</span>
                                        <span className="usage-fe-value">{fallbackRate}%</span>
                                    </div>
                                    <div className="usage-fe-card">
                                        <span className="usage-fe-label">Parse Errors</span>
                                        <span className="usage-fe-value">{promptQuality.parseErrors || 0}</span>
                                    </div>
                                    <div className="usage-fe-card">
                                        <span className="usage-fe-label">Rejected IDs</span>
                                        <span className="usage-fe-value">{promptQuality.validationRejections || 0}</span>
                                    </div>
                                </div>
                                <div className="usage-rate-list">
                                    <div className="usage-rate-row">
                                        <span className="usage-rate-label">Prompt Tokens</span>
                                        <span className="usage-rate-value">{(promptQuality.promptTokens || 0).toLocaleString()}</span>
                                    </div>
                                    <div className="usage-rate-row">
                                        <span className="usage-rate-label">Completion Tokens</span>
                                        <span className="usage-rate-value">{(promptQuality.completionTokens || 0).toLocaleString()}</span>
                                    </div>
                                </div>
                            </div>

                            <div className="usage-section">
                                <h3 className="usage-section-title">Agent Prompt Versions</h3>
                                {!data.promptBreakdown?.length ? (
                                    <div className="usage-empty">No prompt events yet</div>
                                ) : (
                                    <div className="usage-method-list">
                                        {data.promptBreakdown.map((item, i) => (
                                            <div className="usage-method-row" key={`${item.agent}-${item.version}-${i}`}>
                                                <span className="usage-method-name" title={`${item.calls} calls, ${item.total_tokens || 0} tokens`}>
                                                    {item.agent}: {item.version} ({item.variant})
                                                </span>
                                                <span className="usage-method-count">
                                                    {item.calls} · {item.avg_elapsed_ms != null ? `${(item.avg_elapsed_ms / 1000).toFixed(1)}s` : 'N/A'}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="usage-section">
                                <h3 className="usage-section-title">Experiment Status</h3>
                                <div className="usage-method-list">
                                    {Object.entries(metrics.promptRegistry || {}).map(([agent, item]) => (
                                        <div className="usage-method-row" key={agent}>
                                            <span className="usage-method-name" title={item.rollbackReason || ''}>
                                                {agent}: {item.stableVersion}
                                            </span>
                                            <span className="usage-method-count">
                                                {item.candidateDisabled || item.candidatePercent === 0
                                                    ? 'stable'
                                                    : `${item.candidatePercent}% candidate`}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {/* Engagement & Performance */}
                        <div className="usage-grid">
                            <div className="usage-section">
                                <h3 className="usage-section-title">Performance (Latency)</h3>
                                <div className="usage-fe-cards">
                                    <div className="usage-fe-card">
                                        <span className="usage-fe-label">P50</span>
                                        <span className="usage-fe-value">
                                            {data.latency.p50 != null ? `${(data.latency.p50 / 1000).toFixed(1)}s` : 'N/A'}
                                        </span>
                                    </div>
                                    <div className="usage-fe-card">
                                        <span className="usage-fe-label">P95</span>
                                        <span className="usage-fe-value">
                                            {data.latency.p95 != null ? `${(data.latency.p95 / 1000).toFixed(1)}s` : 'N/A'}
                                        </span>
                                    </div>
                                    <div className="usage-fe-card">
                                        <span className="usage-fe-label">Avg</span>
                                        <span className="usage-fe-value">
                                            {data.avgElapsedMs != null ? `${(data.avgElapsedMs / 1000).toFixed(1)}s` : 'N/A'}
                                        </span>
                                    </div>
                                </div>
                            </div>

                            <div className="usage-section">
                                <h3 className="usage-section-title">User Engagement</h3>
                                <div className="usage-rate-list">
                                    <div className="usage-rate-row">
                                        <span className="usage-rate-label">Total Users</span>
                                        <span className="usage-rate-value">{data.engagement.totalUsers}</span>
                                    </div>
                                    <div className="usage-rate-row">
                                        <span className="usage-rate-label">Returning Users</span>
                                        <span className="usage-rate-value">{data.engagement.returningUsers}</span>
                                    </div>
                                    <div className="usage-rate-row positive">
                                        <span className="usage-rate-label">Retention Rate</span>
                                        <span className="usage-rate-value">{data.engagement.retentionRate}%</span>
                                    </div>
                                    <div className="usage-rate-row">
                                        <span className="usage-rate-label">Avg Queries/User</span>
                                        <span className="usage-rate-value">{data.engagement.avgQueriesPerUser ?? 'N/A'}</span>
                                    </div>
                                </div>
                            </div>

                            <div className="usage-section">
                                <h3 className="usage-section-title">Adoption Summary</h3>
                                <div className="usage-rate-list">
                                    <div className="usage-rate-row">
                                        <span className="usage-rate-label">DAU / MAU Ratio</span>
                                        <span className="usage-rate-value">
                                            {data.activeUsers.mau > 0
                                                ? `${Math.round((data.activeUsers.dau / data.activeUsers.mau) * 100)}%`
                                                : 'N/A'}
                                        </span>
                                    </div>
                                    <div className="usage-rate-row">
                                        <span className="usage-rate-label">WAU / MAU Ratio</span>
                                        <span className="usage-rate-value">
                                            {data.activeUsers.mau > 0
                                                ? `${Math.round((data.activeUsers.wau / data.activeUsers.mau) * 100)}%`
                                                : 'N/A'}
                                        </span>
                                    </div>
                                    <div className="usage-rate-row">
                                        <span className="usage-rate-label">Queries Today</span>
                                        <span className="usage-rate-value">{data.summary.today}</span>
                                    </div>
                                    <div className="usage-rate-row">
                                        <span className="usage-rate-label">Queries This Month</span>
                                        <span className="usage-rate-value">{data.summary.thisMonth}</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default UsageMetrics;
