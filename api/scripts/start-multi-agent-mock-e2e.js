// Local-only launcher for exercising the real Express + Agents SDK HTTP path
// against scripts/mock-openai-agent-server.js without external credentials.
const mockPort = process.env.MOCK_OPENAI_PORT || '4401';

process.env.OPENAI_API_KEY = 'mock';
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${mockPort}/v1`;
process.env.OPENAI_EMBEDDING_API_KEY = 'mock';
process.env.OPENAI_EMBEDDING_BASE_URL = `http://127.0.0.1:${mockPort}/v1`;
process.env.OPENAI_EMBEDDING_MODEL = 'Qwen/Qwen3-Embedding-0.6B';
process.env.OPENAI_EMBEDDING_DIMENSIONS = '1024';
process.env.AGENT_ORCHESTRATION_MODE = 'multi_agent';
process.env.AGENT_LEGACY_FALLBACK = '0';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';

await import('../server.js');
