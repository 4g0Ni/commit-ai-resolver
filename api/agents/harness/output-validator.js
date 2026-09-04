import { SUPERVISOR_OUTPUT } from '../agent-schemas.js';

function parseOutput(output) {
    if (typeof output !== 'string') return output;
    try {
        return JSON.parse(output);
    } catch {
        return null;
    }
}

function queryLanguage(query) {
    return /\p{Script=Han}/u.test(String(query || '')) ? 'zh' : 'en';
}

function isCausalQuery(query) {
    return /\b(why|root cause|caused|regression|incident|broke|failure|outage)\b/iu.test(String(query || ''))
        || /(?:为什么|根因|导致|回归|事故|故障|线上问题)/u.test(String(query || ''));
}

function canonicalizeCommitLinks(reply, ledger) {
    return String(reply || '').replace(/\[([0-9a-f]{6,40})\]\((https?:\/\/[^)]+)\)/giu, (_match, rawId) => {
        const candidate = ledger.resolve(rawId);
        if (!candidate?._evidenceAuthorized) return rawId;
        const id = candidate.id || candidate.shortId || rawId;
        const url = candidate.metadata?.url || candidate.url;
        return url ? `[${id}](${url})` : id;
    });
}

function safeSuggestedActions(actions) {
    const allowed = /(?:search|query|commit|diff|compare|clarif|file|symbol|time window|搜索|查询|提交|差异|对比|比较|补充|文件|符号|时间范围)/iu;
    return [...new Set((actions || [])
        .map(value => String(value || '').trim())
        .filter(value => value && value.length <= 300 && allowed.test(value)))]
        .slice(0, 5);
}

/** Validate, ground, and canonicalize the supervisor's final output. */
export function validateSupervisorOutput(rawOutput, context) {
    const parsed = SUPERVISOR_OUTPUT.safeParse(parseOutput(rawOutput));
    if (!parsed.success) {
        const error = new Error('Supervisor returned an invalid structured output.');
        error.code = 'invalid_supervisor_output';
        error.cause = parsed.error;
        throw error;
    }

    const output = parsed.data;
    const hasSuccessfulGate = context.evidenceGates?.some(gate => gate.verdict === 'SEARCH');
    const gateVerdict = hasSuccessfulGate ? 'SEARCH' : context.lastEvidenceGate?.verdict;
    if (gateVerdict === 'ASK_USER') {
        const language = queryLanguage(context.query);
        return {
            ...output,
            type: 'clarification',
            reply: output.type === 'clarification' && output.reply.trim()
                ? output.reply.trim()
                : language === 'zh'
                    ? '请补充受影响的功能或组件、具体症状，以及大致开始时间。'
                    : 'Could you share the affected feature or component, the concrete symptom, and roughly when it started?',
            confidence: 0,
            citedCandidateKeys: [],
            suggestedActions: [],
            validationRejections: output.citedCandidateKeys.length,
        };
    }
    if (gateVerdict === 'ABSTAIN') {
        const language = queryLanguage(context.query);
        return {
            ...output,
            type: 'answer',
            reply: language === 'zh'
                ? '我没有在当前索引和时间范围内找到足够可靠的提交证据。请补充组件、文件、错误信息、commit ID 或更精确的时间范围。'
                : 'I could not find sufficiently strong commit evidence in the current index and date range. Add a component, file, error term, commit ID, or narrower time window.',
            confidence: 0,
            citedCandidateKeys: [],
            suggestedActions: safeSuggestedActions(output.suggestedActions),
            validationRejections: output.citedCandidateKeys.length,
        };
    }
    if (!gateVerdict && context.candidates.list({ limit: 1, authorizedOnly: true }).length === 0) {
        const error = new Error('Supervisor attempted to answer without an evidence-gated retrieval result.');
        error.code = 'missing_evidence_gate';
        throw error;
    }
    const groundedKeys = output.citedCandidateKeys
        .map(reference => {
            const candidate = context.candidates.resolve(reference);
            return candidate?._evidenceAuthorized ? candidate.candidateKey : null;
        })
        .filter(Boolean);
    const rejectedCount = output.citedCandidateKeys.length - groundedKeys.length;
    let confidence = output.confidence;
    let reply = canonicalizeCommitLinks(output.reply.trim(), context.candidates);
    const language = queryLanguage(context.query);

    if (output.type === 'answer' && groundedKeys.length === 0) {
        confidence = Math.min(confidence, 0.2);
    }

    const passedCritique = context.critiques.some(critique => critique?.verdict === 'PASS');
    if (output.type === 'answer' && isCausalQuery(context.query) && confidence > 0.6 && !passedCritique) {
        confidence = 0.6;
        const note = language === 'zh'
            ? '当前根因判断尚未通过独立证据审查，因此置信度已由系统下调。'
            : 'The root-cause assessment has not passed independent evidence review, so confidence was capped by the harness.';
        if (!reply.includes(note)) reply = `${reply}\n\n> ${note}`;
    }

    const citedCandidates = [...new Set(groundedKeys)]
        .map(key => context.candidates.resolve(key))
        .filter(Boolean);
    const missingCitations = citedCandidates.filter(candidate => {
        const id = candidate.id || candidate.shortId;
        return id && !reply.includes(`[${id}](`);
    });
    if (output.type === 'answer' && missingCitations.length > 0) {
        const label = language === 'zh' ? '证据提交' : 'Evidence commits';
        const citations = missingCitations.map(candidate => {
            const id = candidate.id || candidate.shortId;
            const url = candidate.metadata?.url || candidate.url;
            return url ? `[${id}](${url})` : id;
        });
        reply = `${reply}\n\n${label}: ${citations.join(', ')}`;
    }

    if (!reply) {
        throw Object.assign(new Error('Supervisor returned an empty reply.'), { code: 'empty_supervisor_reply' });
    }

    if (rejectedCount > 0) {
        context.trajectory.record({
            agent: 'harness',
            stage: 'output-validation',
            status: 'rejected-citations',
            details: { rejectedCount },
        });
    }

    return {
        ...output,
        reply,
        confidence,
        citedCandidateKeys: [...new Set(groundedKeys)],
        suggestedActions: safeSuggestedActions(output.suggestedActions),
        validationRejections: rejectedCount,
    };
}
