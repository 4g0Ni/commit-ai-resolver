import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cases = (await readFile(new URL('../eval/datasets/public-react-v2/cases.jsonl', import.meta.url), 'utf8'))
    .split(/\r?\n/).filter(Boolean).map(JSON.parse);
const byQuery = new Map(cases.map(item => [item.query, item]));
const output = await mkdtemp(join(tmpdir(), 'commit-rag-agent-eval-'));

function verdict(evalCase) {
    if (evalCase.expectedBehavior === 'clarify') return 'ASK_USER';
    if (evalCase.expectedBehavior === 'abstain') return 'ABSTAIN';
    return 'SEARCH';
}

const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/vectors/stats') {
        response.end(JSON.stringify({ totalCommits: 10000, model: 'mock', dimensions: 2 }));
        return;
    }
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
        const payload = JSON.parse(body);
        const evalCase = byQuery.get(payload.message);
        const gateVerdict = verdict(evalCase);
        response.end(JSON.stringify({
            queryId: `mock-${evalCase.id}`,
            reply: gateVerdict === 'SEARCH' ? `Evidence ${evalCase.relevantCommits[0]?.id || ''}` : 'No supported evidence.',
            type: gateVerdict === 'ASK_USER' ? 'clarification' : 'answer',
            confidence: gateVerdict === 'SEARCH' ? 0.8 : 0,
            iterations: 1,
            resultCount: gateVerdict === 'SEARCH' ? 1 : 0,
            evidenceGate: { verdict: gateVerdict },
            iterationLog: [{ stage: 'intent-extractor', status: 'done', intent: evalCase.expectedIntent }],
            evalMetadata: { chatModel: 'mock', fastModel: 'mock', maxIterations: 3 },
        }));
    });
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

try {
    const child = spawn(process.execPath, [
        'eval/run-agent-eval.js', '--base-url', `http://127.0.0.1:${port}`,
        '--split', 'test', '--concurrency', '4', '--output', output, '--no-score',
    ], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exitCode = await new Promise(resolve => child.on('close', resolve));
    assert.equal(exitCode, 0, stderr);
    const summary = JSON.parse(await readFile(join(output, 'agent-summary.json'), 'utf8'));
    assert.equal(summary.requested, 23);
    assert.equal(summary.succeeded, 23);
    assert.equal(summary.behaviorAccuracy, 1);
    console.log('agent eval runner: PASS');
} finally {
    await new Promise(resolve => server.close(resolve));
    await rm(output, { recursive: true, force: true });
}

