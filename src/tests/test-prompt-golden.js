import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const evalDir = join(__dirname, '..', 'evals');
const cases = JSON.parse(readFileSync(join(evalDir, 'prompt-golden.json'), 'utf8'));
const baseline = JSON.parse(readFileSync(join(evalDir, 'prompt-golden-baseline.json'), 'utf8'));
let passed = 0;

function assert(condition, message) {
    if (!condition) throw new Error(message);
    passed++;
    console.log(`  ✓ ${message}`);
}

assert(Array.isArray(cases) && cases.length >= 10, 'golden set has at least ten cases');
assert(new Set(cases.map(item => item.id)).size === cases.length, 'golden case IDs are unique');
assert(typeof baseline.datasetVersion === 'string', 'baseline pins the dataset version');
assert(baseline.minimumPassRate > 0 && baseline.minimumPassRate <= 1, 'baseline has a valid minimum pass rate');
assert(baseline.maximumRegression >= 0 && baseline.maximumRegression < 1, 'baseline has a valid regression budget');

for (const item of cases) {
    assert(typeof item.id === 'string' && item.id.length > 0, `${item.id}: has an ID`);
    assert(typeof item.query === 'string' && item.query.length > 0, `${item.id}: has a query`);
    assert(/^\d{4}-\d{2}-\d{2}$/.test(item.today), `${item.id}: pins the reference date`);
    assert(['GOOD', 'ASK_USER'].includes(item.expected?.verdict), `${item.id}: has a supported verdict`);
    if (item.expected.specificityVerdict) {
        assert(['SUFFICIENT', 'AMBIGUOUS'].includes(item.expected.specificityVerdict), `${item.id}: has a supported specificity verdict`);
    }
    for (const field of item.expected.specificitySignals || []) {
        assert(['component', 'symptom', 'time', 'errorCode', 'fileOrSymbol'].includes(field), `${item.id}: has a supported specificity signal`);
    }
    for (const key of ['dateFrom', 'dateTo']) {
        if (item.expected[key]) assert(/^\d{4}-\d{2}-\d{2}$/.test(item.expected[key]), `${item.id}: ${key} is ISO date`);
    }
}

console.log(`\n== Prompt golden schema: ${passed} passed ==`);
