import http from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number.parseInt(process.env.MOCK_OPENAI_PORT || '4401', 10);
const dimensions = Number.parseInt(process.env.MOCK_EMBEDDING_DIMENSIONS || '1024', 10);

function readJson(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                reject(error);
            }
        });
        request.on('error', reject);
    });
}

function sendJson(response, status, body) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
}

function toolNames(body) {
    return (body.tools || []).map(item => item?.function?.name).filter(Boolean);
}

function toolMessages(body) {
    return (body.messages || []).filter(message => message.role === 'tool');
}

function parseJsonValues(body) {
    return toolMessages(body).flatMap(message => {
        const candidates = [message.content];
        if (Array.isArray(message.content)) {
            candidates.push(...message.content.map(item => item?.text));
        }
        return candidates.flatMap(value => {
            if (typeof value !== 'string') return [];
            try {
                return [JSON.parse(value)];
            } catch {
                return [];
            }
        });
    });
}

function findCandidateKeys(body) {
    const keys = [];
    for (const value of parseJsonValues(body)) {
        if (Array.isArray(value?.candidateKeys)) keys.push(...value.candidateKeys);
        if (Array.isArray(value?.candidates)) {
            keys.push(...value.candidates.map(candidate => candidate?.candidateKey).filter(Boolean));
        }
    }
    return [...new Set(keys)];
}

function completion(body, message, finishReason = 'stop') {
    return {
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1_000),
        model: body.model || 'mock-agent-model',
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
    };
}

function functionCall(body, name, args) {
    return completion(body, {
        role: 'assistant',
        content: null,
        tool_calls: [{
            id: `call_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
        }],
    }, 'tool_calls');
}

function structuredCompletion(body, value) {
    return completion(body, { role: 'assistant', content: JSON.stringify(value) });
}

function chatCompletion(body) {
    const names = toolNames(body);
    const hasToolResult = toolMessages(body).length > 0;

    if (names.includes('delegate_commit_retrieval')) {
        if (!hasToolResult) {
            return functionCall(body, 'delegate_commit_retrieval', {
                input: 'Find recent facebook/react commits relevant to the user question.',
            });
        }
        const [candidateKey] = findCandidateKeys(body);
        return structuredCompletion(body, {
            type: 'answer',
            reply: candidateKey
                ? 'The indexed evidence contains a recent matching facebook/react commit.'
                : 'I could not find sufficiently strong indexed evidence for this request.',
            confidence: candidateKey ? 0.72 : 0.1,
            citedCandidateKeys: candidateKey ? [candidateKey] : [],
            suggestedActions: candidateKey ? ['Inspect the matching commit diff'] : ['Refine the commit search'],
            decisionSummary: 'The supervisor delegated retrieval and stopped when the evidence was sufficient for a scoped answer.',
        });
    }

    if (names.includes('search_commits')) {
        if (!hasToolResult) {
            return functionCall(body, 'search_commits', {
                semanticQuery: 'recent React changes',
                secondaryQuery: null,
                repo: 'facebook/react',
                author: null,
                dateFrom: null,
                dateTo: null,
                riskLevel: null,
                changeType: null,
                topK: 10,
            });
        }
        const candidateKeys = findCandidateKeys(body).slice(0, 10);
        return structuredCompletion(body, {
            evidenceSummary: candidateKeys.length
                ? 'Hybrid retrieval returned grounded recent React commits.'
                : 'No grounded candidate survived retrieval.',
            candidateKeys,
            confidence: candidateKeys.length ? 0.75 : 0.1,
            evidenceVerdict: candidateKeys.length ? 'SEARCH' : 'ABSTAIN',
            needsClarification: false,
            clarificationQuestion: null,
            recommendedNextStep: candidateKeys.length ? 'answer' : 'abstain',
            queriesUsed: ['recent React changes'],
        });
    }

    return structuredCompletion(body, {
        type: 'answer',
        reply: 'Mock provider received an unsupported agent state.',
        confidence: 0,
        citedCandidateKeys: [],
        suggestedActions: ['Refine the commit search'],
        decisionSummary: 'Unsupported mock state.',
    });
}

const server = http.createServer(async (request, response) => {
    try {
        if (request.method === 'GET' && request.url === '/health') {
            return sendJson(response, 200, { ok: true });
        }
        if (request.method === 'POST' && request.url?.endsWith('/embeddings')) {
            const body = await readJson(request);
            const inputs = Array.isArray(body.input) ? body.input : [body.input];
            const data = inputs.map((_input, index) => {
                const embedding = Array(dimensions).fill(0);
                embedding[index % dimensions] = 1;
                return { object: 'embedding', index, embedding };
            });
            return sendJson(response, 200, {
                object: 'list',
                data,
                model: body.model || 'mock-embedding-model',
                usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
            });
        }
        if (request.method === 'POST' && request.url?.endsWith('/chat/completions')) {
            const body = await readJson(request);
            return sendJson(response, 200, chatCompletion(body));
        }
        return sendJson(response, 404, { error: { message: `Unknown route: ${request.method} ${request.url}` } });
    } catch (error) {
        return sendJson(response, 500, { error: { message: error.message } });
    }
});

server.listen(port, '127.0.0.1', () => {
    console.log(`Mock OpenAI agent server listening on http://127.0.0.1:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
}

