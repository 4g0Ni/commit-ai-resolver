import { z } from 'zod';

const STRUCTURED_OUTPUT_MODES = new Set(['auto', 'json_schema', 'json_object']);

function isNativeOpenAIEndpoint(baseURL) {
    if (!baseURL) return true;
    try {
        return new URL(baseURL).hostname.toLowerCase() === 'api.openai.com';
    } catch {
        return false;
    }
}

function isDeepSeekEndpoint(baseURL) {
    if (!baseURL) return false;
    try {
        const hostname = new URL(baseURL).hostname.toLowerCase();
        return hostname === 'api.deepseek.com' || hostname.endsWith('.deepseek.com');
    } catch {
        return false;
    }
}

/** Select the wire format for native OpenAI or OpenAI-compatible providers. */
export function resolveStructuredOutputMode(configuredMode = 'auto', baseURL = null) {
    const normalized = String(configuredMode || 'auto').trim().toLowerCase();
    if (!STRUCTURED_OUTPUT_MODES.has(normalized)) {
        throw new Error(`Unsupported AGENT_STRUCTURED_OUTPUT_MODE: ${configuredMode}`);
    }
    if (normalized !== 'auto') return normalized;
    return isNativeOpenAIEndpoint(baseURL) ? 'json_schema' : 'json_object';
}

/** Build first-turn tool enforcement settings with provider-specific compatibility. */
export function createRequiredToolModelSettings(baseURL = null, outputMode = 'json_schema') {
    const providerData = {
        ...(outputMode === 'json_object'
            ? { response_format: { type: 'json_object' } }
            : {}),
        ...(isDeepSeekEndpoint(baseURL)
            ? { thinking: { type: 'disabled' } }
            : {}),
    };
    return {
        toolChoice: 'required',
        ...(Object.keys(providerData).length > 0 ? { providerData } : {}),
    };
}

function promptSchema(schema) {
    const jsonSchema = z.toJSONSchema(schema);
    delete jsonSchema.$schema;
    return JSON.stringify(jsonSchema);
}

/** Build an SDK output type plus a prompt contract for compatibility mode. */
export function createStructuredOutputContract(schema, name, mode) {
    if (mode === 'json_schema') {
        return { outputType: schema, instructions: '' };
    }
    return {
        // Keep the SDK output as text so provider-specific JSON can always be
        // parsed and validated by the local Harness rather than SDK internals.
        outputType: 'text',
        instructions: `Return only one valid JSON object. It must match this JSON Schema exactly: ${promptSchema(schema)}`,
    };
}

/** Parse a provider JSON response, tolerating a single Markdown JSON fence. */
export function parseModelJson(rawOutput) {
    if (typeof rawOutput !== 'string') return rawOutput;
    let text = rawOutput.trim();
    const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
    if (fenced) text = fenced[1].trim();
    try {
        return JSON.parse(text);
    } catch (firstError) {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
        throw firstError;
    }
}

/** Parse and locally validate output from a JSON-object compatibility run. */
export function validateStructuredAgentOutput(rawOutput, schema, label) {
    let parsed = rawOutput;
    if (typeof rawOutput === 'string') {
        try {
            parsed = parseModelJson(rawOutput);
        } catch (error) {
            const invalidJson = new Error(`${label} returned invalid JSON.`);
            invalidJson.code = 'invalid_agent_json';
            invalidJson.cause = error;
            throw invalidJson;
        }
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
        const invalidOutput = new Error(`${label} returned an object that failed local schema validation.`);
        invalidOutput.code = 'invalid_agent_output';
        invalidOutput.cause = result.error;
        throw invalidOutput;
    }
    return result.data;
}
