import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const apiDir = join(repoRoot, 'api');
const apiPort = 4419;
const mockPort = 4420;
const apiBase = `http://127.0.0.1:${apiPort}`;
const logs = [];

function startNode(args, env = {}) {
    const child = spawn(process.execPath, args, {
        cwd: apiDir,
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', chunk => {
            logs.push(String(chunk));
            if (logs.length > 100) logs.shift();
        });
    }
    return child;
}

async function waitFor(url, timeoutMs = 10_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch {
            // The child process may still be starting.
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${url}\n${logs.join('').slice(-4_000)}`);
}

function stop(child) {
    if (child && child.exitCode === null && !child.killed) child.kill();
}

const mock = startNode(['scripts/mock-openai-agent-server.js'], {
    MOCK_OPENAI_PORT: String(mockPort),
    MOCK_EMBEDDING_DIMENSIONS: '1024',
});
let api;

try {
    await waitFor(`http://127.0.0.1:${mockPort}/health`);
    api = startNode(['scripts/start-multi-agent-mock-e2e.js'], {
        PORT: String(apiPort),
        MOCK_OPENAI_PORT: String(mockPort),
    });
    await waitFor(`${apiBase}/api/vectors/stats`);

    const body = JSON.stringify({
        message: 'What changed in facebook/react recently?',
        history: [],
    });
    const jsonResponse = await fetch(`${apiBase}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-eval-harness': '1' },
        body,
    });
    const json = await jsonResponse.json();
    assert.equal(jsonResponse.status, 200);
    assert.equal(json.searchMethod, 'multi-agent');
    assert.equal(json.orchestrationMode, 'multi_agent');
    assert(json.suspects.length > 0);
    assert(json.iterationLog.some(event => event.stage === 'delegate_commit_retrieval'));

    const sseResponse = await fetch(`${apiBase}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body,
    });
    const sse = await sseResponse.text();
    const events = [...sse.matchAll(/^event: (.+)$/gm)].map(match => match[1]);
    assert.equal(sseResponse.status, 200);
    assert(events.includes('status'));
    assert(events.includes('token'));
    assert(events.includes('complete'));

    console.log('multi-agent HTTP + SSE E2E: PASS');
} finally {
    stop(api);
    stop(mock);
}

