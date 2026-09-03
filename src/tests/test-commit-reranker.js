import { strict as assert } from 'node:assert';
import { rerankCommits, rerankCommitsBatched } from '../../api/agents/commit-reranker.js';

const candidates = ['a', 'b', 'c', 'd', 'e'].map((id, index) => ({
    repo: 'demo',
    id,
    score: 0.9 - index * 0.1,
    metadata: { title: `Commit ${id}`, summary: `Summary ${id}`, changedFiles: [`src/${id}.js`] },
}));
const llm = {
    chat: {
        completions: {
            create: async () => ({
                choices: [{ message: { content: JSON.stringify({
                    rankedKeys: ['demo:e', 'demo:d', 'demo:c', 'demo:b', 'demo:a'],
                    rationale: 'The reverse order is more relevant for this fixture.',
                }) } }],
                usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            }),
        },
    },
};

const reranked = await rerankCommits(llm, 'reported failure', candidates, { limit: 5 });
assert.equal(reranked.applied, true);
assert.deepEqual(reranked.results.map(item => item.id), ['e', 'd', 'c', 'b', 'a']);

const invalidLlm = {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: '{"rankedKeys":["unknown"],"rationale":"bad"}' } }] }) } },
};
const fallback = await rerankCommits(invalidLlm, 'reported failure', candidates, { limit: 5 });
assert.equal(fallback.applied, false);
assert.deepEqual(fallback.results.map(item => item.id), ['a', 'b', 'c', 'd', 'e']);

const scoreByKey = new Map([
    ['demo:a', 0], ['demo:b', 0], ['demo:c', 1], ['demo:d', 2], ['demo:e', 3],
]);
const batchedLlm = {
    chat: {
        completions: {
            create: async params => {
                const payload = JSON.parse(params.messages[1].content);
                return {
                    choices: [{ message: { content: JSON.stringify({
                        scores: payload.candidates.map(item => ({ key: item.key, score: scoreByKey.get(item.key) })),
                    }) } }],
                    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                };
            },
        },
    },
};
const batchRanked = await rerankCommitsBatched(batchedLlm, 'reported failure', candidates, {
    limit: 5,
    batchSize: 2,
    concurrency: 2,
});
assert.equal(batchRanked.applied, true);
assert.deepEqual(batchRanked.results.map(item => item.id), ['e', 'd', 'c', 'a', 'b']);
assert.deepEqual(batchRanked.scoreHistogram, { 0: 2, 1: 1, 2: 1, 3: 1 });
assert.equal(batchRanked._tokens, 45);

console.log('commit reranker: PASS');
