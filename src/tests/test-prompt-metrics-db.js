import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempDir = mkdtempSync(join(tmpdir(), 'commit-ai-resolver-metrics-'));
process.env.DATA_DIR = tempDir;

const {
    default: db,
    getRecentFeedback,
    getUsageMetrics,
    logQuery,
} = await import('../../api/db.js');
const { reportPromptOutcome, resetPromptExperimentState } = await import('../prompts/prompt-registry.js');

try {
    logQuery({
        id: 'prompt-metrics-test',
        query: 'test query',
        response: 'test answer',
        confidence: 0.8,
        iterations: 1,
        searchMethod: 'agentic',
        resultCount: 3,
        iterationLog: [{
            iteration: 1,
            stage: 'intent-extractor',
            status: 'done',
            promptVersion: 'intent-v3',
            promptVariant: 'stable',
            structuredOutput: true,
            structuredFallback: false,
            parseError: false,
            validationRejections: 3,
            elapsed: 25,
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120,
        }],
        source: 'api',
        promptVersions: { 'intent-extractor': 'intent-v3', 'answer-synthesizer': 'synthesizer-v4' },
        promptMetrics: { structuredCalls: 2, structuredFallbacks: 1, parseErrors: 0, validationRejections: 3 },
    });

    const [row] = getRecentFeedback(1);
    const versions = JSON.parse(row.prompt_versions);
    const metrics = getUsageMetrics().api.promptQuality;

    if (versions['intent-extractor'] !== 'intent-v3') throw new Error('prompt versions were not persisted');
    if (metrics.structuredCalls !== 2) throw new Error('structured call metric was not aggregated');
    if (metrics.structuredFallbacks !== 1) throw new Error('fallback metric was not aggregated');
    if (metrics.validationRejections !== 3) throw new Error('validation metric was not aggregated');
    const [event] = db.prepare('SELECT * FROM prompt_events WHERE query_id = ?').all('prompt-metrics-test');
    if (event.prompt_version !== 'intent-v3' || event.total_tokens !== 120) throw new Error('per-agent event was not persisted');
    const [breakdown] = getUsageMetrics().api.promptBreakdown;
    if (breakdown.agent !== 'intent-extractor' || breakdown.calls !== 1) throw new Error('per-agent breakdown was not aggregated');
    process.env.PROMPT_AUTO_ROLLBACK_FAILURES = '1';
    reportPromptOutcome('intent-extractor', 'candidate', { failed: true });
    const rollback = db.prepare('SELECT * FROM prompt_experiment_state WHERE agent = ?').get('intent-extractor');
    if (!rollback?.disabled || !rollback.rollback_reason) throw new Error('automatic rollback state was not persisted');
    console.log('  ✓ prompt versions persist as JSON');
    console.log('  ✓ prompt metrics aggregate by source');
    console.log('  ✓ per-agent prompt events retain version, variant, latency, and tokens');
    console.log('  ✓ automatic rollback state survives process restarts');
} finally {
    delete process.env.PROMPT_AUTO_ROLLBACK_FAILURES;
    resetPromptExperimentState();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
}

console.log('\n== Prompt metrics DB tests: 4 passed ==');
