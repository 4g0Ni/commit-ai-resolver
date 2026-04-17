/**
 * Column Whitelist Utility for Aria Telemetry
 *
 * Defines allowed columns for each Kusto table and provides
 * filtering + convenience logging functions.
 */

import { trackEvent } from './aria-client.js';

// --- Column whitelists (must match Kusto table schemas) ---

export const INFO_COLUMNS = [
    'Timestamp',
    'CorrelationId',
    'EventName',
    'Level',
    'Component',
    'Message',
    'Query',
    'Intent',
    'Repo',
    'DateRange',
    'ResultCount',
    'Confidence',
    'Verdict',
    'ElapsedMs',
    'TokensUsed',
    'Model',
    'SuspectsCount',
    'IterationIndex',
    'UserId',
    'SessionId',
];

export const ERROR_COLUMNS = [
    'Timestamp',
    'CorrelationId',
    'EventName',
    'Component',
    'ErrorMessage',
    'ErrorStack',
    'ErrorCode',
    'Query',
    'HttpStatus',
    'ElapsedMs',
    'UserId',
    'SessionId',
];

/**
 * Filter an object to only include whitelisted keys.
 * @param {object} data - Raw data object
 * @param {string[]} whitelist - Allowed column names
 * @returns {object} Filtered object
 */
export function filterColumns(data, whitelist) {
    const result = {};
    for (const key of whitelist) {
        if (key in data) result[key] = data[key];
    }
    return result;
}

/**
 * Log an info/tracing event to CommitAIResolver_Info table.
 * Automatically adds Timestamp and filters to whitelisted columns.
 */
export function logInfo(eventName, data = {}) {
    const payload = filterColumns(
        { Timestamp: new Date().toISOString(), EventName: eventName, ...data },
        INFO_COLUMNS,
    );
    trackEvent('commitairesolver_tracing', payload);
}

/**
 * Log an error event to CommitAIResolver_Error table.
 * Automatically adds Timestamp and filters to whitelisted columns.
 */
export function logError(eventName, data = {}) {
    const payload = filterColumns(
        { Timestamp: new Date().toISOString(), EventName: eventName, ...data },
        ERROR_COLUMNS,
    );
    trackEvent('commitairesolver_errors', payload);
}
