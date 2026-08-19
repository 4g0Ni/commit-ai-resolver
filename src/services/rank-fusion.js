/** Rank-fusion helpers shared by the chat and MCP retrieval surfaces. */

/**
 * Merge independently ranked result lists with weighted Reciprocal Rank Fusion.
 * The repository is part of the identity because short commit IDs are not globally unique.
 *
 * @param {Array<{results: Array, weight?: number, channel?: string}>} weightedLists
 * @param {object} options
 * @param {number} options.k RRF smoothing constant
 * @param {number|null} options.limit Maximum fused results
 */
function fuseRankedResults(weightedLists, { k = 20, limit = null } = {}) {
    const scoreMap = new Map();

    for (const { results = [], weight = 1, channel = 'unknown' } of weightedLists) {
        for (let rank = 0; rank < results.length; rank++) {
            const result = results[rank];
            const key = `${result.repo || ''}:${result.id || result.commitId || ''}`;
            const contribution = weight / (k + rank + 1);
            const existing = scoreMap.get(key);

            if (existing) {
                existing.rrfScore += contribution;
                existing.channels.add(channel);
                // Prefer a dense result object when available so `score` keeps its cosine meaning.
                if (channel.includes('dense') || !existing.hasDense) {
                    if (!existing.hasDense || (result.score ?? -Infinity) > (existing.bestResult.score ?? -Infinity)) {
                        existing.bestResult = result;
                    }
                }
                existing.hasDense ||= channel.includes('dense');
            } else {
                scoreMap.set(key, {
                    rrfScore: contribution,
                    bestResult: result,
                    channels: new Set([channel]),
                    hasDense: channel.includes('dense'),
                });
            }
        }
    }

    const fused = [...scoreMap.values()]
        .sort((a, b) => b.rrfScore - a.rrfScore)
        .map(entry => ({
            ...entry.bestResult,
            _rrfScore: entry.rrfScore,
            _retrievalChannels: [...entry.channels],
        }));

    return limit ? fused.slice(0, limit) : fused;
}

export { fuseRankedResults };
