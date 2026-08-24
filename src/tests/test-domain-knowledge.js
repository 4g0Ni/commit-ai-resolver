import { splitDomainSections, selectDomainKnowledge } from '../services/domain-knowledge.js';

let passed = 0;
function assert(condition, message) {
    if (!condition) throw new Error(message);
    passed++;
    console.log(`  ✓ ${message}`);
}

const sections = splitDomainSections('# Overview\nintro\n## Budget Drawer\nbudget rows\n## Auth\nlogin');
assert(sections.length === 3, 'markdown is split into heading sections');
assert(sections[1].heading === 'Budget Drawer', 'section heading is retained');

const selected = selectDomainKnowledge('AdsAppsMT', {
    changedFiles: ['/src/Dynamic.config'],
    commitMessage: 'Update dynamic pilot rollout',
    maxChars: 1200,
});
assert(typeof selected === 'string', 'selector always returns text');
assert(selected.length <= 1200, 'selector respects the character budget');

const missing = selectDomainKnowledge('NotARealRepository', { changedFiles: ['/foo.js'] });
assert(missing === '', 'missing repository knowledge returns empty text');

console.log(`\n== Domain knowledge tests: ${passed} passed ==`);
