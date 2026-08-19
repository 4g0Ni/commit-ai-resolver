/** Shared embedding/index configuration for OpenAI-compatible local or hosted providers. */

const DEFAULT_MODEL = 'text-embedding-3-large';
const DEFAULT_DIMENSIONS = 3072;
const DEFAULT_BATCH_SIZE = 16;

const MODEL_DIMENSIONS = [
    [/qwen3-embedding-0\.6b/i, 1024],
    [/qwen3-embedding-4b/i, 2560],
    [/qwen3-embedding-8b/i, 4096],
    [/bge-m3/i, 1024],
    [/nomic-embed-text/i, 768],
    [/text-embedding-3-small/i, 1536],
    [/text-embedding-3-large/i, 3072],
];

const COMMIT_QUERY_INSTRUCTION =
    'Instruct: Retrieve source-code commits that may explain the reported software symptom, regression, configuration change, or production incident.\nQuery: ';

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function inferDimensions(model) {
    return MODEL_DIMENSIONS.find(([pattern]) => pattern.test(model))?.[1] || DEFAULT_DIMENSIONS;
}

/** Return the model contract shared by embedding generation and vector storage. */
function getEmbeddingConfig() {
    const model = process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_MODEL;
    const dimensions = positiveInteger(
        process.env.OPENAI_EMBEDDING_DIMENSIONS || process.env.EMBEDDING_DIMENSIONS,
        inferDimensions(model)
    );
    const batchSize = positiveInteger(process.env.EMBEDDING_BATCH_SIZE, DEFAULT_BATCH_SIZE);
    const explicitInstruction = process.env.EMBEDDING_QUERY_INSTRUCTION;
    const queryInstruction = explicitInstruction !== undefined
        ? explicitInstruction
        : (/qwen3-embedding/i.test(model) ? COMMIT_QUERY_INSTRUCTION : '');

    return {
        model,
        dimensions,
        batchSize,
        queryInstruction,
        documentTemplateVersion: process.env.EMBEDDING_DOCUMENT_TEMPLATE_VERSION || '2',
        requestDimensions: process.env.OPENAI_EMBEDDING_REQUEST_DIMENSIONS === '1',
    };
}

/** Build one provider request while keeping query/document preprocessing asymmetric. */
function buildEmbeddingRequest(texts, inputType = 'document') {
    const config = getEmbeddingConfig();
    const input = inputType === 'query' && config.queryInstruction
        ? texts.map(text => `${config.queryInstruction}${text}`)
        : texts;
    return {
        input,
        model: config.model,
        ...(config.requestDimensions ? { dimensions: config.dimensions } : {}),
    };
}

export { buildEmbeddingRequest, getEmbeddingConfig, inferDimensions };
