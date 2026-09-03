import { strict as assert } from 'node:assert';
import { expandRetrievalQuery } from '../../api/agents/retrieval-query-expander.js';

const llm = {
    chat: {
        completions: {
            create: async () => ({
                choices: [{ message: { content: JSON.stringify({
                    symptomQuery: 'Hydration mismatch after a suspended tree resumes.',
                    mechanismQuery: 'Hydration cursor is not restored while replaying a suspended host component.',
                    fixQuery: 'Restore hydration state before replaying host components after a microtask suspension.',
                }) } }],
                usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
            }),
        },
    },
};

const expanded = await expandRetrievalQuery(llm, 'Issue #35210 hydration mismatch');
assert.equal(expanded.applied, true);
assert.equal(expanded.queries.length, 3);
assert.deepEqual(expanded.queries.map(item => item.field), ['symptomQuery', 'mechanismQuery', 'fixQuery']);
assert.equal(expanded._tokens, 35);

const invalid = await expandRetrievalQuery({
    chat: { completions: { create: async () => ({ choices: [{ message: { content: '{}' } }] }) } },
}, 'reported failure');
assert.equal(invalid.applied, false);
assert.deepEqual(invalid.queries, []);

console.log('retrieval query expander: PASS');
