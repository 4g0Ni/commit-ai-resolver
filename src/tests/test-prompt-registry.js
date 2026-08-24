import {
    PROMPT_VERSIONS,
    applyPromptVariant,
    getPromptRegistrySnapshot,
    reportPromptOutcome,
    resetPromptExperimentState,
    selectPromptVariant,
} from '../prompts/prompt-registry.js';

let passed = 0;
function assert(condition, message) {
    if (!condition) throw new Error(message);
    passed++;
    console.log(`  ✓ ${message}`);
}

const previousExperiments = process.env.PROMPT_EXPERIMENTS;
const previousKillSwitch = process.env.PROMPT_EXPERIMENT_KILL_SWITCH;
const previousThreshold = process.env.PROMPT_AUTO_ROLLBACK_FAILURES;

try {
    process.env.PROMPT_EXPERIMENTS = JSON.stringify({ 'intent-extractor': 100 });
    delete process.env.PROMPT_EXPERIMENT_KILL_SWITCH;
    process.env.PROMPT_AUTO_ROLLBACK_FAILURES = '2';
    resetPromptExperimentState();

    const candidate = selectPromptVariant('intent-extractor', 'query-1');
    assert(candidate.variant === 'candidate', '100% experiment selects candidate');
    assert(candidate.version !== PROMPT_VERSIONS['intent-extractor'], 'candidate has a distinct version');
    assert(applyPromptVariant('Prompt version: old\nRules', candidate).includes(candidate.version), 'variant replaces embedded version');

    reportPromptOutcome('intent-extractor', 'candidate', { failed: true });
    reportPromptOutcome('intent-extractor', 'candidate', { failed: true });
    const rolledBack = selectPromptVariant('intent-extractor', 'query-1');
    assert(rolledBack.variant === 'stable', 'consecutive failures automatically roll back to stable');
    assert(getPromptRegistrySnapshot()['intent-extractor'].rollbackReason, 'rollback reason is observable');

    resetPromptExperimentState();
    process.env.PROMPT_EXPERIMENT_KILL_SWITCH = '1';
    assert(selectPromptVariant('intent-extractor', 'query-1').variant === 'stable', 'kill switch forces stable prompt');
} finally {
    if (previousExperiments === undefined) delete process.env.PROMPT_EXPERIMENTS;
    else process.env.PROMPT_EXPERIMENTS = previousExperiments;
    if (previousKillSwitch === undefined) delete process.env.PROMPT_EXPERIMENT_KILL_SWITCH;
    else process.env.PROMPT_EXPERIMENT_KILL_SWITCH = previousKillSwitch;
    if (previousThreshold === undefined) delete process.env.PROMPT_AUTO_ROLLBACK_FAILURES;
    else process.env.PROMPT_AUTO_ROLLBACK_FAILURES = previousThreshold;
    resetPromptExperimentState();
}

console.log(`\n== Prompt registry tests: ${passed} passed ==`);
