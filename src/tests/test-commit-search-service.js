import { strict as assert } from 'node:assert';
import { createCommitSearchService } from '../services/commit-search-service.js';

const denseCandidate = {
    id: 'abc1234',
    commitId: 'abc1234def5678',
    repo: 'AdsAppUI',
    date: '2026-09-03',
    author: 'Developer',
    score: 0.86,
    metadata: { title: 'Guard login token', summary: 'Avoid a null token crash.' },
};
const observed = { embeds: [], vectorOptions: [], lexicalOptions: [] };
const service = createCommitSearchService({
    async embedQuery(query) {
        observed.embeds.push(query);
        return [query.length, 1];
    },
    async searchVectors(_embedding, options) {
        observed.vectorOptions.push(options);
        return [denseCandidate];
    },
    async searchLexical(_query, options) {
        observed.lexicalOptions.push(options);
        return [{ ...denseCandidate, score: 0 }];
    },
    async lookupByCommitIds(ids) {
        return ids.includes('abc1234') ? [denseCandidate] : [];
    },
    async getVectorStats() {
        return {
            totalCommits: 10,
            repos: ['AdsAppUI'],
            dateRange: { from: '2026-08-01', to: '2026-09-04' },
        };
    },
});

const result = await service.search({
    query: 'Why did login crash?',
    semanticQuery: 'login null token crash',
    topK: 10,
});
assert.equal(result.evidenceGate.verdict, 'SEARCH');
assert.equal(result.results.length, 1);
assert.equal(result.filters.effectiveDateFrom, '2026-08-28');
assert.equal(result.filters.effectiveDateTo, '2026-09-04');
assert.deepEqual(observed.embeds, ['login null token crash']);
assert.equal(observed.vectorOptions[0].topK, 30);
assert.equal(observed.lexicalOptions[0].minScore, 0);

const exact = await service.search({
    query: 'Explain abc1234',
    semanticQuery: 'explain commit',
    topK: 5,
});
assert.equal(exact.directMatchCount, 1);
assert.equal(exact.evidenceGate.reason, 'exact-commit-match');

console.log('commit search service: PASS');

