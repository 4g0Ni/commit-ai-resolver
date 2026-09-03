function finiteNumber(value, fallback, { minimum = 0 } = {}) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

/** Return the shared dense-primary fusion contract used by API, MCP, and Eval. */
export function getRankFusionConfig(env = process.env) {
    return {
        k: Math.max(1, Math.round(finiteNumber(env.RRF_K, 5, { minimum: 1 }))),
        denseWeight: finiteNumber(env.RRF_DENSE_WEIGHT, 1),
        lexicalWeight: finiteNumber(env.RRF_LEXICAL_WEIGHT, 0.33),
        secondaryWeight: finiteNumber(env.RRF_SECONDARY_WEIGHT, 0.7),
        bugTitleWeight: finiteNumber(env.RRF_BUG_TITLE_WEIGHT, 1.5),
    };
}
