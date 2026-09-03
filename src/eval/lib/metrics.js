function identity(item) {
    return `${item.repo || ''}:${item.id || String(item.commitId || '').slice(0, 8)}`;
}

export function scoreRanking(results, relevantCommits, k = 10) {
    const gold = new Map(relevantCommits.map(item => [identity(item), item.relevance ?? 1]));
    const ranked = results.slice(0, k);
    const hits = ranked.filter(item => gold.has(identity(item))).length;
    const required = relevantCommits.filter(item => item.required !== false);
    const requiredIds = new Set(required.map(identity));
    const requiredHits = ranked.filter(item => requiredIds.has(identity(item))).length;
    const firstRelevant = ranked.findIndex(item => gold.has(identity(item)));

    let dcg = 0;
    for (let rank = 0; rank < ranked.length; rank++) {
        const relevance = gold.get(identity(ranked[rank])) || 0;
        dcg += (2 ** relevance - 1) / Math.log2(rank + 2);
    }
    const ideal = [...gold.values()].sort((a, b) => b - a).slice(0, k);
    const idcg = ideal.reduce((sum, relevance, rank) => sum + (2 ** relevance - 1) / Math.log2(rank + 2), 0);

    return {
        recallAtK: gold.size ? hits / gold.size : null,
        requiredRecallAtK: requiredIds.size ? requiredHits / requiredIds.size : null,
        precisionAtK: ranked.length ? hits / ranked.length : (gold.size ? 0 : 1),
        mrr: firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0,
        ndcg: idcg ? dcg / idcg : null,
        hitAtK: hits > 0,
    };
}

export function aggregateCaseMetrics(caseResults, mode) {
    const scored = caseResults.map(item => item.channels[mode]).filter(Boolean);
    const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    const summarize = items => {
        const positive = items.filter(item => item.metrics?.recallAtK !== null);
        const negative = items.filter(item => item.expectedBehavior === 'abstain');
        const summary = {
            cases: items.length,
            positiveCases: positive.length,
            recallAt10: mean(positive.map(item => item.metrics.recallAtK)),
            requiredRecallAt10: mean(positive.map(item => item.metrics.requiredRecallAtK)),
            precisionAt10: mean(positive.map(item => item.metrics.precisionAtK)),
            mrrAt10: mean(positive.map(item => item.metrics.mrr)),
            ndcgAt10: mean(positive.map(item => item.metrics.ndcg).filter(value => value !== null)),
            hitRateAt10: mean(positive.map(item => item.metrics.hitAtK ? 1 : 0)),
            noResultAccuracy: mean(negative.map(item => item.resultCount === 0 ? 1 : 0)),
            latencyMs: {
                mean: mean(items.map(item => item.elapsedMs)),
                p95: percentile(items.map(item => item.elapsedMs), 0.95),
            },
        };
        for (const k of [20, 50, 100, 200]) {
            const candidates = positive.filter(item => item.candidateMetrics?.[k]?.recallAtK != null);
            summary[`recallAt${k}`] = mean(candidates.map(item => item.candidateMetrics[k].recallAtK));
            summary[`requiredRecallAt${k}`] = mean(candidates.map(item => item.candidateMetrics[k].requiredRecallAtK));
            summary[`hitRateAt${k}`] = mean(candidates.map(item => item.candidateMetrics[k].hitAtK ? 1 : 0));
        }
        return summary;
    };
    const summary = summarize(scored);
    summary.byCategory = Object.fromEntries(
        [...new Set(scored.map(item => item.category))].sort().map(category => [category, summarize(scored.filter(item => item.category === category))])
    );
    summary.bySplit = Object.fromEntries(
        [...new Set(scored.map(item => item.split))].sort().map(split => [split, summarize(scored.filter(item => item.split === split))])
    );
    return summary;
}

export function percentile(values, quantile) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
}

export function expectedCalibrationError(items, bins = 10) {
    const calibrated = items.filter(item => Number.isFinite(item.confidence));
    if (!calibrated.length) return null;
    let error = 0;
    for (let index = 0; index < bins; index++) {
        const lower = index / bins;
        const upper = (index + 1) / bins;
        const bucket = calibrated.filter(item => item.confidence >= lower && (index === bins - 1 ? item.confidence <= upper : item.confidence < upper));
        if (!bucket.length) continue;
        const averageConfidence = bucket.reduce((sum, item) => sum + item.confidence, 0) / bucket.length;
        const accuracy = bucket.reduce((sum, item) => sum + (item.correct ? 1 : 0), 0) / bucket.length;
        error += (bucket.length / calibrated.length) * Math.abs(averageConfidence - accuracy);
    }
    return error;
}

export function compareSummaries(baseline, candidate) {
    const higherIsBetter = [
        'recallAt10', 'requiredRecallAt10', 'precisionAt10', 'mrrAt10', 'ndcgAt10', 'hitRateAt10',
        'recallAt20', 'requiredRecallAt20', 'hitRateAt20', 'recallAt50', 'requiredRecallAt50', 'hitRateAt50',
        'recallAt100', 'requiredRecallAt100', 'hitRateAt100', 'recallAt200', 'requiredRecallAt200', 'hitRateAt200',
        'noResultAccuracy',
    ];
    const comparison = {};
    for (const [channel, current] of Object.entries(candidate.retrieval || {})) {
        const previous = baseline.retrieval?.[channel];
        if (!previous) continue;
        comparison[channel] = {};
        for (const metric of higherIsBetter) {
            if (current[metric] == null || previous[metric] == null) continue;
            comparison[channel][metric] = current[metric] - previous[metric];
        }
        if (current.latencyMs?.p95 != null && previous.latencyMs?.p95 != null) {
            comparison[channel].p95LatencyMs = current.latencyMs.p95 - previous.latencyMs.p95;
        }
    }
    return comparison;
}

export { identity };
