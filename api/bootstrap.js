/**
 * Process bootstrap / crash guard.
 *
 * This is the real entry point (the deploy points node at bootstrap.js).
 * It exists to make fatal errors observable in Kusto:
 *
 *   1. Initializes Aria telemetry BEFORE loading the server, so even a
 *      startup/module-load crash (e.g. a native-module ABI mismatch in db.js)
 *      can be reported — the previous entry (server.js) only initialized Aria
 *      inside app.listen(), which never runs when an import throws.
 *   2. Registers global uncaughtException / unhandledRejection handlers that
 *      log to the commitairesolver_errors table and flush before exit.
 *   3. Loads ./server.js inside try/catch and reports startup failures.
 *
 * Telemetry is best-effort: if there is no ingestion token (e.g. local dev),
 * logging is a no-op and the server still starts normally.
 */

import { initAria, flushAria } from './telemetry/aria-client.js';
import { logError } from './telemetry/column-whitelist.js';

initAria();

/**
 * Report a fatal error to Kusto and flush before the process exits.
 * @param {string} eventName - Error event name (maps to EventName column)
 * @param {unknown} err - The thrown error or rejection reason
 */
async function reportFatal(eventName, err) {
    const error = err instanceof Error ? err : new Error(String(err));
    try {
        logError(eventName, {
            Component: 'startup',
            ErrorMessage: error.message,
            ErrorStack: error.stack?.slice(0, 2000),
            ErrorCode: error.code,
            HttpStatus: 0,
        });
        await flushAria();
    } catch (telemetryErr) {
        console.warn(`[Bootstrap] Failed to report telemetry: ${telemetryErr.message}`);
    }
}

process.on('uncaughtException', async (err) => {
    console.error('[Bootstrap] uncaughtException:', err);
    await reportFatal('UncaughtException', err);
    process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
    console.error('[Bootstrap] unhandledRejection:', reason);
    await reportFatal('UnhandledRejection', reason);
    process.exit(1);
});

try {
    await import('./server.js');
} catch (err) {
    console.error('[Bootstrap] Server failed to start:', err);
    await reportFatal('StartupCrash', err);
    process.exit(1);
}
