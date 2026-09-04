const MAX_DETAIL_STRING = 2_000;
const MAX_DETAIL_ARRAY = 30;

function sanitizeDetails(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (depth > 4) return '[max-depth]';
    if (typeof value === 'string') {
        return value.length > MAX_DETAIL_STRING
            ? `${value.slice(0, MAX_DETAIL_STRING)}... [truncated]`
            : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
        return value.slice(0, MAX_DETAIL_ARRAY).map(item => sanitizeDetails(item, depth + 1));
    }
    if (typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .filter(([key]) => !/(api.?key|authorization|password|secret|bearer|credential|diff)$/iu.test(key))
            .map(([key, item]) => [key, sanitizeDetails(item, depth + 1)]));
    }
    return String(value);
}

/** Records a bounded, local-only trajectory and mirrors progress to SSE. */
export class TrajectoryRecorder {
    constructor({ runId, onProgress, maxEvents = 200 } = {}) {
        this.runId = runId;
        this.onProgress = onProgress;
        this.maxEvents = maxEvents;
        this.startedAt = Date.now();
        this.events = [];
        this.droppedEvents = 0;
    }

    record({ agent = 'harness', stage, status, details = {} }) {
        if (this.events.length >= this.maxEvents) {
            this.droppedEvents += 1;
            return null;
        }
        const event = {
            sequence: this.events.length + 1,
            runId: this.runId,
            timestamp: Date.now(),
            elapsedMs: Date.now() - this.startedAt,
            agent,
            stage,
            status,
            details: sanitizeDetails(details),
        };
        this.events.push(event);
        if (typeof this.onProgress === 'function') {
            this.onProgress(event.sequence, stage, {
                status,
                agent,
                ...event.details,
            });
        }
        return event;
    }

    snapshot() {
        return this.events.map(event => ({ ...event }));
    }
}

export { sanitizeDetails };
