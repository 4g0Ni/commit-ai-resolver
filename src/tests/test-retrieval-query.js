import { strict as assert } from 'node:assert';
import { getRankFusionConfig } from '../services/retrieval-config.js';
import { buildCompactRetrievalQuery, buildRetrievalQueryViews, retrievalTitle, selectLexicalTerms } from '../services/retrieval-query.js';

const issue = `Bug: useSyncExternalStore does not schedule update after mutation

React version: 19
Steps To Reproduce
https://example.com/a/very/noisy/link
Open the reproduction and click the button.
The current behavior
Subscriber misses the mutation and throws SnapshotMismatchError.
The expected behavior
useSyncExternalStore should schedule a render after the Activity tree is restored.`;

assert.equal(retrievalTitle(issue), 'Bug: useSyncExternalStore does not schedule update after mutation');
const compact = buildCompactRetrievalQuery(issue);
assert.ok(compact.includes('useSyncExternalStore'));
assert.ok(compact.includes('SnapshotMismatchError'));
assert.ok(!compact.includes('https://'));
assert.ok(!compact.includes('React version:'));

const terms = selectLexicalTerms(issue, 8);
assert.ok(terms.includes('useSyncExternalStore'));
assert.ok(terms.includes('SnapshotMismatchError'));
assert.ok(!terms.map(term => term.toLowerCase()).includes('steps'));

assert.equal(buildRetrievalQueryViews(issue, 'raw').dense.length, 1);
assert.equal(buildRetrievalQueryViews(issue, 'multi').dense.length, 3);
assert.deepEqual(getRankFusionConfig({}), {
    k: 5,
    denseWeight: 1,
    lexicalWeight: 0.33,
    secondaryWeight: 0.7,
    bugTitleWeight: 1.5,
});

console.log('retrieval query and fusion config: PASS');
