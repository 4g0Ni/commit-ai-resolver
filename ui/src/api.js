import { msalInstance, loginRequest } from './authConfig.js';

const API_BASE = '/api';

async function getAuthHeaders() {
    const accounts = msalInstance.getAllAccounts();
    if (accounts.length === 0) return {};
    try {
        const response = await msalInstance.acquireTokenSilent({
            ...loginRequest,
            account: accounts[0],
        });
        return { Authorization: `Bearer ${response.idToken}` };
    } catch {
        await msalInstance.acquireTokenRedirect(loginRequest);
        return {};
    }
}

async function authFetch(url, options = {}) {
    const authHeaders = await getAuthHeaders();
    const res = await fetch(url, {
        ...options,
        headers: { ...options.headers, ...authHeaders },
    });
    if (res.status === 401) {
        await msalInstance.acquireTokenRedirect(loginRequest);
    }
    return res;
}

export async function fetchDays() {
    const res = await authFetch(`${API_BASE}/days`);
    if (!res.ok) throw new Error(`Failed to fetch days: ${res.statusText}`);
    return res.json();
}

export async function fetchDay(date) {
    const res = await authFetch(`${API_BASE}/days/${date}`);
    if (!res.ok) throw new Error(`Failed to fetch day ${date}: ${res.statusText}`);
    return res.json();
}

export async function fetchDayRange(from, to) {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const res = await authFetch(`${API_BASE}/days?${params}`);
    if (!res.ok) throw new Error(`Failed to fetch range: ${res.statusText}`);
    return res.json();
}

export async function fetchReleases() {
    const res = await authFetch(`${API_BASE}/releases`);
    if (!res.ok) throw new Error(`Failed to fetch releases: ${res.statusText}`);
    return res.json();
}

export async function sendChatMessage(message, history = []) {
    const res = await authFetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history }),
    });
    if (!res.ok) throw new Error(`Chat error: ${res.statusText}`);
    return res.json();
}

/**
 * Stream chat response via SSE.
 * @param {string} message
 * @param {Array} history
 * @param {object} callbacks - { onStatus, onToken, onComplete, onError }
 * @returns {Promise<void>}
 */
export async function sendChatMessageStream(message, history = [], { onStatus, onToken, onComplete, onError }) {
    const authHeaders = await getAuthHeaders();
    const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            ...authHeaders,
        },
        body: JSON.stringify({ message, history }),
    });
    if (!res.ok) {
        if (res.status === 401) {
            await msalInstance.acquireTokenRedirect(loginRequest);
            return;
        }
        throw new Error(`Chat error: ${res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line in buffer

        let currentEvent = null;
        for (const line of lines) {
            if (line.startsWith('event: ')) {
                currentEvent = line.slice(7);
            } else if (line.startsWith('data: ') && currentEvent) {
                try {
                    const data = JSON.parse(line.slice(6));
                    if (currentEvent === 'status' && onStatus) onStatus(data);
                    else if (currentEvent === 'token' && onToken) onToken(data.token);
                    else if (currentEvent === 'complete' && onComplete) onComplete(data);
                } catch { /* ignore parse errors */ }
                currentEvent = null;
            } else if (line === '') {
                currentEvent = null;
            }
        }
    }
}

export async function investigateCommits(message, suspects, history = []) {
    const res = await authFetch(`${API_BASE}/investigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, suspects, history }),
    });
    if (!res.ok) throw new Error(`Investigation error: ${res.statusText}`);
    return res.json();
}

export async function submitFeedback(queryId, vote, comment, metadata) {
    const res = await authFetch(`${API_BASE}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queryId, vote, comment, metadata }),
    });
    if (!res.ok) throw new Error(`Feedback error: ${res.statusText}`);
    return res.json();
}

export async function fetchFeedbackStats() {
    const res = await authFetch(`${API_BASE}/feedback/stats`);
    if (!res.ok) throw new Error(`Stats error: ${res.statusText}`);
    return res.json();
}

export async function fetchRecentFeedback(limit = 50) {
    const res = await authFetch(`${API_BASE}/feedback/recent?limit=${limit}`);
    if (!res.ok) throw new Error(`Feedback error: ${res.statusText}`);
    return res.json();
}

export async function fetchUsageMetrics() {
    const res = await authFetch(`${API_BASE}/metrics/usage`);
    if (!res.ok) throw new Error(`Metrics error: ${res.statusText}`);
    return res.json();
}
