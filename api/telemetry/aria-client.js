/**
 * Aria / 1DS Telemetry Client
 *
 * Uses @microsoft/1ds-core-js + @microsoft/1ds-post-js with a Node.js
 * fetch-based HTTP override. Pattern follows the AriaLogger used in AdsApps.
 */

import { AppInsightsCore } from '@microsoft/1ds-core-js';
import { PostChannel } from '@microsoft/1ds-post-js';

let analytics = null;

/**
 * Create HTTP override for Node.js using native fetch.
 */
function createNodeHttpOverride() {
    return {
        sendPOST: (payload, oncomplete) => {
            console.log(`[Aria] POST ${payload.urlString} (${typeof payload.data === 'string' ? payload.data.length : 0} bytes)`);
            fetch(payload.urlString, {
                method: 'POST',
                headers: { ...(payload.headers ?? {}) },
                body: payload.data,
            })
                .then(async (res) => {
                    const text = await res.text();
                    const headers = {};
                    res.headers.forEach((value, key) => { headers[key] = value; });
                    console.log(`[Aria] Response: ${res.status} — ${text.slice(0, 200)}`);
                    oncomplete(res.status, headers, text);
                })
                .catch((err) => {
                    console.warn(`[Aria] Fetch error: ${err.message}`);
                    oncomplete(0, {}, '');
                });
        },
    };
}

/**
 * Initialize the 1DS SDK. Safe to call multiple times.
 * @param {string} [token] - Ingestion token override (defaults to env var)
 */
export function initAria(token) {
    if (analytics) return true;

    const ingestionToken = token || process.env.ARIA_INGESTION_TOKEN;
    if (!ingestionToken) {
        console.warn('[Aria] No ingestion token — telemetry disabled');
        return false;
    }

    try {
        analytics = new AppInsightsCore();
        const postChannel = new PostChannel();

        analytics.initialize({
            instrumentationKey: ingestionToken,
            channels: [[postChannel]],
            extensionConfig: {
                [postChannel.identifier]: {
                    alwaysUseXhrOverride: true,
                    httpXHROverride: createNodeHttpOverride(),
                },
            },
            disableCookiesUsage: true,
            disableDbgExt: true,
            disableInstrumentationKeyValidation: true,
            loggingLevelTelemetry: 0,
            loggingLevelConsole: 0,
            enableDebug: true,
        }, []);

        console.log('[Aria] Telemetry initialized');
        return true;
    } catch (err) {
        console.warn(`[Aria] Failed to initialize: ${err.message}`);
        analytics = null;
        return false;
    }
}

/**
 * Send a single event to Aria.
 *
 * @param {string} tableName - Target Kusto table (e.g. "CommitAIResolver_Info")
 * @param {object} properties - Column name → value map (should be pre-filtered by whitelist)
 */
export function trackEvent(tableName, properties) {
    if (!analytics) return;

    try {
        console.log(`[Aria] track: ${tableName}`, JSON.stringify(properties).slice(0, 200));
        analytics.track({
            name: tableName,
            data: { ...properties },
        });
    } catch (err) {
        console.warn(`[Aria] trackEvent error: ${err.message}`);
    }
}

/**
 * Flush pending events. Call before process exit.
 */
export function flushAria() {
    if (!analytics) return Promise.resolve();
    return new Promise((resolve) => {
        analytics.flush(true, (completed) => {
            resolve(completed);
        });
    });
}
