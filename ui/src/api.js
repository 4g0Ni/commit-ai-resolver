const API_BASE = 'http://localhost:3001/api';

export async function fetchDays() {
    const res = await fetch(`${API_BASE}/days`);
    if (!res.ok) throw new Error(`Failed to fetch days: ${res.statusText}`);
    return res.json();
}

export async function fetchDay(date) {
    const res = await fetch(`${API_BASE}/days/${date}`);
    if (!res.ok) throw new Error(`Failed to fetch day ${date}: ${res.statusText}`);
    return res.json();
}

export async function fetchDayRange(from, to) {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const res = await fetch(`${API_BASE}/days?${params}`);
    if (!res.ok) throw new Error(`Failed to fetch range: ${res.statusText}`);
    return res.json();
}

export async function sendChatMessage(message, history = []) {
    const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history }),
    });
    if (!res.ok) throw new Error(`Chat error: ${res.statusText}`);
    return res.json();
}
