import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { loadDailyCorpus } from './lib/corpus.js';
import { aggregateCaseMetrics, compareSummaries, expectedCalibrationError, identity, scoreRanking } from './lib/metrics.js';
import { evaluateEvidence } from '../services/evidence-gate.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

function parseArgs(argv) {
    const args = {
        dataset: join(here, 'datasets', 'public-react-v2'),
        mode: 'all',
        output: join(here, 'reports', `eval-${new Date().toISOString().replace(/[:.]/g, '-')}`),
        device: 'cuda',
        condaEnv: 'hello-agents',
        responses: null,
        intents: null,
        baseline: null,
        writeBaseline: null,
        gate: false,
    };
    for (let index = 0; index < argv.length; index++) {
        const key = argv[index];
        if (key === '--dataset') args.dataset = resolve(argv[++index]);
        else if (key === '--mode') args.mode = argv[++index];
        else if (key === '--output') args.output = resolve(argv[++index]);
        else if (key === '--device') args.device = argv[++index];
        else if (key === '--conda-env') args.condaEnv = argv[++index];
        else if (key === '--responses') args.responses = resolve(argv[++index]);
        else if (key === '--intents') args.intents = resolve(argv[++index]);
        else if (key === '--baseline') args.baseline = resolve(argv[++index]);
        else if (key === '--write-baseline') args.writeBaseline = resolve(argv[++index]);
        else if (key === '--gate') args.gate = true;
        else if (key === '--help') {
            console.log('node eval/run-eval.js [--mode index|lexical|dense|hybrid|all] [--device cuda|cpu] [--intents file.jsonl] [--responses file.jsonl] [--baseline summary.json] [--write-baseline path] [--gate]');
            process.exit(0);
        }
    }
    if (!['index', 'lexical', 'dense', 'hybrid', 'all'].includes(args.mode)) throw new Error(`Unsupported mode: ${args.mode}`);
    return args;
}

async function readJsonl(path) {
    return (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function inspectIndex(dbPath, corpus, manifest) {
    const db = new Database(dbPath, { readonly: true });
    sqliteVec.load(db);
    const scalar = sql => db.prepare(sql).get();
    const metadataRows = scalar('SELECT COUNT(*) AS value FROM commit_metadata').value;
    const ftsRows = scalar('SELECT COUNT(*) AS value FROM commit_fts').value;
    const vectorRows = scalar('SELECT COUNT(*) AS value FROM commit_vectors').value;
    const duplicateRows = scalar('SELECT COUNT(*) AS value FROM (SELECT repo, id FROM commit_metadata GROUP BY repo, id HAVING COUNT(*) > 1)').value;
    const metadataKeys = new Set(db.prepare('SELECT repo, id FROM commit_metadata').all().map(identity));
    const corpusKeys = new Set(corpus.commits.map(identity));
    const missingRows = [...corpusKeys].filter(key => !metadataKeys.has(key)).length;
    const staleRows = [...metadataKeys].filter(key => !corpusKeys.has(key)).length;
    const contract = Object.fromEntries(db.prepare('SELECT key, value FROM vector_store_meta').all().map(row => [row.key, row.value]));
    const firstVector = db.prepare('SELECT embedding FROM commit_vectors LIMIT 1').get();
    const vectorDimensions = firstVector?.embedding?.byteLength ? firstVector.embedding.byteLength / 4 : null;
    db.close();

    const checks = {
        corpusHashMatchesManifest: corpus.corpusHash === manifest.corpus.sha256,
        corpusCountMatchesManifest: corpus.commits.length === manifest.corpus.commits,
        metadataCountMatchesCorpus: metadataRows === corpus.commits.length,
        ftsCountMatchesMetadata: ftsRows === metadataRows,
        vectorCountMatchesMetadata: vectorRows === metadataRows,
        noDuplicateMetadataKeys: duplicateRows === 0,
        noMissingRows: missingRows === 0,
        noStaleRows: staleRows === 0,
        vectorDimensionsMatchContract: String(vectorDimensions) === contract.embeddingDimensions,
    };
    return {
        passed: Object.values(checks).every(Boolean),
        checks,
        counts: { corpus: corpus.commits.length, metadata: metadataRows, fts: ftsRows, vectors: vectorRows, duplicates: duplicateRows, missing: missingRows, stale: staleRows },
        contract: { model: contract.embeddingModel, dimensions: Number(contract.embeddingDimensions), documentTemplateVersion: contract.documentTemplateVersion, lastUpdated: contract.lastUpdated },
    };
}

function encodeQueries(queries, args) {
    const payload = JSON.stringify({ queries, device: args.device, batchSize: 32 });
    const python = process.env.EVAL_PYTHON;
    const command = python || 'conda';
    const commandArgs = python
        ? [join(here, 'embed-queries.py')]
        : ['run', '-n', args.condaEnv, '--no-capture-output', 'python', join(here, 'embed-queries.py')];
    const started = performance.now();
    const result = spawnSync(command, commandArgs, {
        cwd: projectRoot,
        input: payload,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    if (result.status !== 0) throw new Error(`Query embedding failed:\n${result.stderr || result.stdout}`);
    try {
        return { ...JSON.parse(result.stdout), elapsedMs: performance.now() - started };
    } catch (error) {
        throw new Error(`Embedding helper returned invalid JSON: ${error.message}\n${result.stdout.slice(0, 500)}`);
    }
}

function rrfContributions(lists, k = 20) {
    const output = new Map();
    for (const { results, weight, channel } of lists) {
        results.forEach((result, rank) => {
            const key = identity(result);
            if (!output.has(key)) output.set(key, {});
            output.get(key)[channel] = { rank: rank + 1, contribution: weight / (k + rank + 1) };
        });
    }
    return output;
}

async function runRetrieval(cases, index, args) {
    process.env.OPENAI_EMBEDDING_MODEL = index.contract.model;
    process.env.OPENAI_EMBEDDING_DIMENSIONS = String(index.contract.dimensions);
    process.env.EMBEDDING_DOCUMENT_TEMPLATE_VERSION = index.contract.documentTemplateVersion;
    process.env.VECTORS_DB = process.env.VECTORS_DB || join(projectRoot, 'data', 'vectors.db');
    const vectorStore = await import(pathToFileURL(join(projectRoot, 'src', 'services', 'vector-store.js')).href);
    const { fuseRankedResults } = await import(pathToFileURL(join(projectRoot, 'src', 'services', 'rank-fusion.js')).href);
    const needsDense = ['dense', 'hybrid', 'all'].includes(args.mode);
    const encoded = needsDense ? encodeQueries(cases.map(item => item.query), args) : null;
    const embeddingMsPerQuery = encoded ? encoded.elapsedMs / cases.length : 0;
    if (encoded && (encoded.model !== index.contract.model || encoded.dimensions !== index.contract.dimensions)) {
        throw new Error(`Query embedding contract mismatch: ${encoded.model}/${encoded.dimensions}, index=${index.contract.model}/${index.contract.dimensions}`);
    }

    const caseResults = [];
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
        const evalCase = cases[caseIndex];
        const channels = {};
        let direct = [];
        if (evalCase.commitIds?.length) direct = await vectorStore.lookupByCommitIds(evalCase.commitIds);

        let lexical = [];
        if (['lexical', 'hybrid', 'all'].includes(args.mode)) {
            const started = performance.now();
            lexical = await vectorStore.searchLexical(evalCase.query, { ...evalCase.filters, topK: 20 });
            channels.lexical = channelResult(evalCase, lexical, performance.now() - started);
        }

        let dense = [];
        if (needsDense) {
            const started = performance.now();
            dense = await vectorStore.searchVectors(encoded.embeddings[caseIndex], { ...evalCase.filters, topK: 20, minScore: 0 });
            channels.dense = channelResult(evalCase, dense, performance.now() - started + embeddingMsPerQuery);
        }

        if (direct.length) channels.direct = channelResult(evalCase, direct, 0);
        if (['hybrid', 'all'].includes(args.mode)) {
            const lists = [
                { results: dense, weight: 1, channel: 'dense-primary' },
                ...(lexical.length ? [{ results: lexical, weight: 1, channel: 'lexical-fts5' }] : []),
            ];
            const started = performance.now();
            let hybrid = fuseRankedResults(lists, { k: 20, limit: 20 });
            if (direct.length) {
                const directKeys = new Set(direct.map(identity));
                hybrid = [...direct, ...hybrid.filter(item => !directKeys.has(identity(item)))].slice(0, 20);
            }
            const contributions = rrfContributions(lists);
            const fusionMs = performance.now() - started;
            channels.hybrid = channelResult(
                evalCase,
                hybrid,
                (channels.dense?.elapsedMs || 0) + (channels.lexical?.elapsedMs || 0) + fusionMs,
                contributions,
            );
            const gate = evaluateEvidence({
                query: evalCase.query,
                results: hybrid,
                denseResults: dense,
                lexicalResults: lexical,
                filters: evalCase.filters,
                directMatchCount: direct.length,
            });
            channels.evidenceGate = {
                ...gate,
                expectedVerdict: expectedGateVerdict(evalCase.expectedBehavior),
                correct: gate.verdict === expectedGateVerdict(evalCase.expectedBehavior),
            };
        }
        caseResults.push({ id: evalCase.id, category: evalCase.category, split: evalCase.split || 'unspecified', query: evalCase.query, channels });
        process.stdout.write(`\rRetrieval ${caseIndex + 1}/${cases.length}`);
    }
    process.stdout.write('\n');
    vectorStore.closeVectorStore();
    return {
        caseResults,
        embedding: encoded ? {
            model: encoded.model,
            dimensions: encoded.dimensions,
            device: args.device,
            batchMs: encoded.elapsedMs,
            amortizedMsPerQuery: embeddingMsPerQuery,
        } : null,
    };
}

function expectedGateVerdict(expectedBehavior) {
    if (expectedBehavior === 'clarify') return 'ASK_USER';
    if (expectedBehavior === 'abstain') return 'ABSTAIN';
    return 'SEARCH';
}

function aggregateEvidenceGate(caseResults) {
    const rows = caseResults.map(item => ({ category: item.category, split: item.split, ...item.channels.evidenceGate })).filter(item => item.verdict);
    if (!rows.length) return null;
    const summarize = items => ({
        cases: items.length,
        accuracy: items.filter(item => item.correct).length / items.length,
        verdicts: Object.fromEntries(['SEARCH', 'ABSTAIN', 'ASK_USER'].map(verdict => [verdict, items.filter(item => item.verdict === verdict).length])),
    });
    const summary = summarize(rows);
    summary.byExpectedBehavior = Object.fromEntries(
        ['SEARCH', 'ABSTAIN', 'ASK_USER'].map(expected => [expected, summarize(rows.filter(item => item.expectedVerdict === expected))])
    );
    summary.byCategory = Object.fromEntries(
        [...new Set(rows.map(item => item.category))].sort().map(category => [category, summarize(rows.filter(item => item.category === category))])
    );
    summary.bySplit = Object.fromEntries(
        [...new Set(rows.map(item => item.split))].sort().map(split => {
            const splitRows = rows.filter(item => item.split === split);
            const splitSummary = summarize(splitRows);
            splitSummary.byExpectedBehavior = Object.fromEntries(
                ['SEARCH', 'ABSTAIN', 'ASK_USER'].map(expected => [expected, summarize(splitRows.filter(item => item.expectedVerdict === expected))])
            );
            return [split, splitSummary];
        })
    );
    return summary;
}

function channelResult(evalCase, results, elapsedMs, contributions = null) {
    return {
        category: evalCase.category,
        split: evalCase.split || 'unspecified',
        expectedBehavior: evalCase.expectedBehavior,
        resultCount: results.length,
        elapsedMs,
        metrics: scoreRanking(results, evalCase.relevantCommits, 10),
        topResults: results.slice(0, 20).map((item, rank) => ({
            rank: rank + 1,
            repo: item.repo,
            id: item.id,
            commitId: item.commitId,
            score: item.score,
            rrfScore: item._rrfScore,
            channels: item._retrievalChannels,
            contributions: contributions?.get(identity(item)) || undefined,
        })),
    };
}

async function scoreResponses(path, cases, corpus) {
    if (!path) return null;
    const responses = await readJsonl(path);
    const byCase = new Map(cases.map(item => [item.id, item]));
    const knownIds = new Set(corpus.commits.flatMap(item => [item.commitId.toLowerCase(), item.id.toLowerCase()]));
    const scores = [];
    for (const response of responses) {
        const evalCase = byCase.get(response.caseId);
        if (!evalCase) continue;
        const cited = [...new Set((String(response.reply || '').match(/\b[0-9a-f]{7,40}\b/gi) || []).map(id => id.toLowerCase()))];
        const goldIds = new Set(evalCase.relevantCommits.flatMap(item => [item.commitId.toLowerCase(), item.id.toLowerCase()]));
        const hallucinated = cited.filter(id => !knownIds.has(id));
        const covered = evalCase.relevantCommits.filter(item => cited.some(id => item.commitId.toLowerCase().startsWith(id) || id.startsWith(item.id.toLowerCase()))).length;
        const correct = evalCase.expectedBehavior === 'abstain'
            ? cited.length === 0
            : covered > 0 && hallucinated.length === 0;
        const trace = Array.isArray(response.iterationLog) ? response.iterationLog : [];
        const searches = trace.filter(entry => entry.stage === 'rag-search' && entry.status === 'done' && Array.isArray(entry.rankedResults));
        const novelties = [];
        for (let index = 1; index < searches.length; index++) {
            const previous = new Set(searches[index - 1].rankedResults.map(item => `${item.repo}:${item.id}`));
            const current = new Set(searches[index].rankedResults.map(item => `${item.repo}:${item.id}`));
            const union = new Set([...previous, ...current]);
            const intersection = [...previous].filter(key => current.has(key)).length;
            novelties.push(union.size ? 1 - intersection / union.size : 0);
        }
        scores.push({
            caseId: response.caseId,
            cited,
            hallucinated,
            citationValidity: cited.length ? (cited.length - hallucinated.length) / cited.length : (evalCase.expectedBehavior === 'abstain' ? 1 : 0),
            evidenceCoverage: evalCase.relevantCommits.length ? covered / evalCase.relevantCommits.length : null,
            correct,
            confidence: typeof response.confidence === 'number' ? response.confidence : null,
            iterations: response.iterations || 1,
            retries: trace.filter(entry => entry.stage === 'retry').length,
            staleRetries: trace.filter(entry => entry.stage === 'stale-retry').length,
            evidenceNovelty: novelties.length ? novelties.reduce((sum, value) => sum + value, 0) / novelties.length : null,
        });
    }
    const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const calibrated = scores.filter(item => item.confidence !== null);
    return {
        cases: scores.length,
        citationValidity: mean(scores.map(item => item.citationValidity)),
        evidenceCoverage: mean(scores.map(item => item.evidenceCoverage).filter(value => value !== null)),
        hallucinatedCitationRate: mean(scores.map(item => item.hallucinated.length ? 1 : 0)),
        accuracy: mean(scores.map(item => item.correct ? 1 : 0)),
        meanIterations: mean(scores.map(item => item.iterations)),
        retryRate: mean(scores.map(item => item.retries > 0 ? 1 : 0)),
        staleRetryRate: mean(scores.map(item => item.staleRetries > 0 ? 1 : 0)),
        meanEvidenceNovelty: mean(scores.map(item => item.evidenceNovelty).filter(value => value !== null)),
        brierScore: mean(calibrated.map(item => (item.confidence - (item.correct ? 1 : 0)) ** 2)),
        expectedCalibrationError: expectedCalibrationError(calibrated),
        details: scores,
    };
}

async function scoreIntents(path, cases) {
    if (!path) return null;
    const predictions = await readJsonl(path);
    const byCase = new Map(cases.map(item => [item.id, item]));
    const fields = ['repo', 'author', 'dateFrom', 'dateTo', 'riskLevel', 'changeType', 'verdict'];
    const details = [];
    for (const prediction of predictions) {
        const evalCase = byCase.get(prediction.caseId);
        if (!evalCase) continue;
        const expected = evalCase.expectedIntent || {};
        const intent = prediction.intent || prediction;
        const fieldScores = {};
        for (const field of fields) {
            if (expected[field] === undefined) continue;
            fieldScores[field] = (intent[field] ?? null) === (expected[field] ?? null) ? 1 : 0;
        }
        const expectedIds = new Set((expected.commitIds || []).map(id => id.toLowerCase()));
        const predictedIds = new Set((intent.commitIds || []).map(id => id.toLowerCase()));
        const commitIdRecall = expectedIds.size ? [...expectedIds].filter(id => predictedIds.has(id)).length / expectedIds.size : null;
        details.push({ caseId: prediction.caseId, fieldScores, commitIdRecall });
    }
    const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    return {
        cases: details.length,
        fieldAccuracy: Object.fromEntries(fields.map(field => {
            const values = details.map(item => item.fieldScores[field]).filter(value => value !== undefined);
            return [field, mean(values)];
        })),
        commitIdRecall: mean(details.map(item => item.commitIdRecall).filter(value => value !== null)),
        details,
    };
}

function markdownReport(summary, comparison) {
    const lines = [
        '# Commit RAG Eval Report', '',
        `- Run: ${summary.runId}`,
        `- Dataset: ${summary.dataset.name} (${summary.dataset.cases} cases)`,
        `- Corpus: ${summary.dataset.corpusCommits} commits, SHA-256 \`${summary.dataset.corpusHash}\``,
        `- Index contract: \`${summary.index.contract.model}\`, ${summary.index.contract.dimensions} dimensions, template v${summary.index.contract.documentTemplateVersion}`,
        `- Index integrity: ${summary.index.passed ? 'PASS' : 'FAIL'}`, '',
        '## Retrieval', '',
        '| Channel | Recall@10 | Required Recall@10 | MRR@10 | nDCG@10 | Negative no-result | p95 ms |',
        '|---|---:|---:|---:|---:|---:|---:|',
    ];
    const pct = value => value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
    for (const [channel, metrics] of Object.entries(summary.retrieval || {})) {
        lines.push(`| ${channel} | ${pct(metrics.recallAt10)} | ${pct(metrics.requiredRecallAt10)} | ${metrics.mrrAt10?.toFixed(3) ?? 'n/a'} | ${metrics.ndcgAt10?.toFixed(3) ?? 'n/a'} | ${pct(metrics.noResultAccuracy)} | ${metrics.latencyMs.p95?.toFixed(1) ?? 'n/a'} |`);
    }
    if (summary.answers) {
        lines.push('', '## Answers', '',
            `- Citation validity: ${pct(summary.answers.citationValidity)}`,
            `- Evidence coverage: ${pct(summary.answers.evidenceCoverage)}`,
            `- Hallucinated citation rate: ${pct(summary.answers.hallucinatedCitationRate)}`,
            `- Brier score: ${summary.answers.brierScore?.toFixed(4) ?? 'n/a'}`,
            `- ECE: ${summary.answers.expectedCalibrationError?.toFixed(4) ?? 'n/a'}`,
            `- Retry rate: ${pct(summary.answers.retryRate)}`,
            `- Mean evidence novelty: ${pct(summary.answers.meanEvidenceNovelty)}`);
    }
    if (summary.intents) {
        lines.push('', '## Intent extraction', '',
            `- Cases: ${summary.intents.cases}`,
            `- Commit ID recall: ${pct(summary.intents.commitIdRecall)}`,
            `- Field accuracy: \`${JSON.stringify(summary.intents.fieldAccuracy)}\``);
    }
    if (summary.evidenceGate) {
        const gateMetrics = summary.evidenceGate.bySplit?.test || summary.evidenceGate;
        const behavior = gateMetrics.byExpectedBehavior || summary.evidenceGate.byExpectedBehavior;
        lines.push('', '## Evidence gate', '',
            `- Overall accuracy: ${pct(summary.evidenceGate.accuracy)}`,
            `- Frozen test accuracy: ${pct(gateMetrics.accuracy)}`,
            `- Positive SEARCH accuracy: ${pct(behavior.SEARCH?.accuracy)}`,
            `- Negative ABSTAIN accuracy: ${pct(behavior.ABSTAIN?.accuracy)}`,
            `- Ambiguous ASK_USER accuracy: ${pct(behavior.ASK_USER?.accuracy)}`);
    }
    if (comparison && Object.keys(comparison).length) {
        lines.push('', '## Baseline delta', '', 'Positive quality deltas are improvements; positive latency deltas are regressions.', '', '```json', JSON.stringify(comparison, null, 2), '```');
    }
    lines.push('', '## Index checks', '', '```json', JSON.stringify(summary.index.checks, null, 2), '```', '');
    return lines.join('\n');
}

function evaluateGates(summary, comparison) {
    const failures = [];
    if (!summary.index.passed) failures.push('index integrity failed');
    const hybrid = summary.retrieval?.hybrid?.bySplit?.test || summary.retrieval?.hybrid;
    if (hybrid && hybrid.requiredRecallAt10 < 0.85) failures.push(`hybrid required Recall@10 ${hybrid.requiredRecallAt10.toFixed(3)} < 0.85`);
    if (hybrid && hybrid.mrrAt10 < 0.75) failures.push(`hybrid MRR@10 ${hybrid.mrrAt10.toFixed(3)} < 0.75`);
    if (summary.answers?.hallucinatedCitationRate > 0) failures.push('hallucinated citation rate is above zero');
    if (summary.evidenceGate) {
        const gateMetrics = summary.evidenceGate.bySplit?.test || summary.evidenceGate;
        const behavior = gateMetrics.byExpectedBehavior || summary.evidenceGate.byExpectedBehavior;
        if ((behavior.SEARCH?.accuracy ?? 0) < 0.98) failures.push('evidence gate positive SEARCH accuracy is below 0.98');
        if ((behavior.ABSTAIN?.accuracy ?? 0) < 0.90) failures.push('evidence gate negative ABSTAIN accuracy is below 0.90');
        if ((behavior.ASK_USER?.accuracy ?? 0) < 0.80) failures.push('evidence gate clarification accuracy is below 0.80');
    }
    for (const [channel, deltas] of Object.entries(comparison || {})) {
        if ((deltas.requiredRecallAt10 ?? 0) < -0.001) failures.push(`${channel} required Recall@10 regressed`);
        if ((deltas.mrrAt10 ?? 0) < -0.001) failures.push(`${channel} MRR@10 regressed`);
    }
    return failures;
}

const args = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(await readFile(join(args.dataset, 'manifest.json'), 'utf8'));
const casesRaw = await readFile(join(args.dataset, 'cases.jsonl'), 'utf8');
const caseHash = createHash('sha256').update(casesRaw).digest('hex');
if (caseHash !== manifest.cases.sha256) throw new Error('Dataset cases hash does not match manifest; regenerate or review the dataset.');
const cases = casesRaw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const dataRoot = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(projectRoot, 'data');
const corpus = await loadDailyCorpus(join(dataRoot, 'daily'));
const index = inspectIndex(process.env.VECTORS_DB || join(dataRoot, 'vectors.db'), corpus, manifest);
const startedAt = new Date().toISOString();
const retrievalRun = args.mode === 'index' ? { caseResults: [], embedding: null } : await runRetrieval(cases, index, args);
const caseResults = retrievalRun.caseResults;
const retrieval = {};
for (const channel of ['direct', 'lexical', 'dense', 'hybrid']) {
    if (caseResults.some(item => item.channels[channel])) retrieval[channel] = aggregateCaseMetrics(caseResults, channel);
}
const evidenceGate = aggregateEvidenceGate(caseResults);
const answers = await scoreResponses(args.responses, cases, corpus);
const intents = await scoreIntents(args.intents, cases);
const summary = {
    runId: `eval-${startedAt.replace(/[:.]/g, '-')}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    mode: args.mode,
    dataset: { name: manifest.dataset, cases: cases.length, caseHash, corpusHash: corpus.corpusHash, corpusCommits: corpus.commits.length },
    index,
    embedding: retrievalRun.embedding,
    retrieval,
    evidenceGate,
    answers: answers ? { ...answers, details: undefined } : null,
    intents: intents ? { ...intents, details: undefined } : null,
};
const baseline = args.baseline ? JSON.parse(await readFile(args.baseline, 'utf8')) : null;
const comparison = baseline ? compareSummaries(baseline, summary) : null;
summary.gateFailures = evaluateGates(summary, comparison);

await mkdir(args.output, { recursive: true });
await writeFile(join(args.output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(join(args.output, 'case-results.jsonl'), `${caseResults.map(item => JSON.stringify(item)).join('\n')}\n`);
if (answers) await writeFile(join(args.output, 'answer-results.jsonl'), `${answers.details.map(item => JSON.stringify(item)).join('\n')}\n`);
if (intents) await writeFile(join(args.output, 'intent-results.jsonl'), `${intents.details.map(item => JSON.stringify(item)).join('\n')}\n`);
await writeFile(join(args.output, 'report.md'), markdownReport(summary, comparison));
if (args.writeBaseline) {
    await mkdir(dirname(args.writeBaseline), { recursive: true });
    await writeFile(args.writeBaseline, `${JSON.stringify(summary, null, 2)}\n`);
}
console.log(JSON.stringify({ output: args.output, indexPassed: index.passed, retrieval, gateFailures: summary.gateFailures }, null, 2));
if (args.gate && summary.gateFailures.length) process.exitCode = 1;
