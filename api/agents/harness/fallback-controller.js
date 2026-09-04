function isCancellation(error) {
    return error?.name === 'AbortError' || /abort|cancel/iu.test(error?.message || '');
}

/** Run a primary implementation and switch to the known-safe baseline on failure. */
export async function runWithFallback({ primary, fallback, onFallback }) {
    try {
        return await primary();
    } catch (error) {
        if (isCancellation(error) || typeof fallback !== 'function') throw error;
        if (typeof onFallback === 'function') await onFallback(error);
        const result = await fallback(error);
        return {
            ...result,
            orchestrationFallback: {
                used: true,
                reason: error?.code || error?.name || 'multi_agent_failure',
            },
        };
    }
}

