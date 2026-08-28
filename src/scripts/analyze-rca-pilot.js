/** Analyze a completed model-prescreened RCA pilot retrieval run. */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

function parseArgs(argv) {
    const options = {
        dataset: join(projectRoot, 'src', 'eval', 'datasets', 'public-react-rca-pilot-v1'),
        report: join(projectRoot, 'src', 'eval', 'reports', 'public-react-rca-pilot-v1'),
        output: null,
    };
    for (let index = 0; index < argv.length; index++) {
        const key = argv[index];
        if (key === '--dataset') options.dataset = resolve(argv[++index]);
        else if (key === '--report') options.report = resolve(argv[++index]);
        else if (key === '--output') options.output = resolve(argv[++index]);
        else if (key === '--help') {
            console.log('node scripts/analyze-rca-pilot.js [--dataset directory] [--report directory] [--output directory]');
            process.exit(0);
        } else throw new Error(`Unknown argument: ${key}`);
    }
    options.output ||= options.report;
    return options;
}

async function readJsonl(path) {
    return (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function mean(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function rank(channel) {
    return channel?.metrics?.mrr ? Math.round(1 / channel.metrics.mrr) : null;
}

function summarize(rows) {
    const channels = {};
    for (const channel of ['lexical', 'dense', 'hybrid']) {
        const values = rows.map(item => item.result.channels[channel]).filter(Boolean);
        channels[channel] = {
            cases: values.length,
            recallAt10: mean(values.map(item => item.metrics.recallAtK)),
            requiredRecallAt10: mean(values.map(item => item.metrics.requiredRecallAtK)),
            mrrAt10: mean(values.map(item => item.metrics.mrr)),
            ndcgAt10: mean(values.map(item => item.metrics.ndcg)),
            hitRateAt10: mean(values.map(item => item.metrics.hitAtK ? 1 : 0)),
            rank1Rate: mean(values.map(item => item.metrics.mrr === 1 ? 1 : 0)),
        };
    }
    return {
        cases: rows.length,
        pilotProfile: {
            averageQualityScore: mean(rows.map(item => item.case.pilot.qualityScore).filter(Number.isFinite)),
            averageQueryLength: mean(rows.map(item => item.case.pilot.queryLength).filter(Number.isFinite)),
            averageChangedFileCount: mean(rows.map(item => item.case.pilot.changedFileCount).filter(Number.isFinite)),
        },
        channels,
    };
}

function group(rows, classifier) {
    const groups = new Map();
    for (const row of rows) {
        const key = classifier(row);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => [key, summarize(values)]));
}

function compactCase(row) {
    return {
        id: row.case.id,
        issue: row.case.provenance.issue.url,
        title: row.case.provenance.issue.title,
        qualityScore: row.case.pilot.qualityScore,
        primaryArea: row.case.pilot.primaryArea,
        queryLength: row.case.pilot.queryLength,
        changedFileCount: row.case.pilot.changedFileCount,
        goldCommitCount: row.case.pilot.goldCommitCount,
        lexicalRank: rank(row.result.channels.lexical),
        denseRank: rank(row.result.channels.dense),
        hybridRank: rank(row.result.channels.hybrid),
    };
}

function format(value) {
    return value == null ? 'n/a' : value.toFixed(4);
}

function sliceTable(title, groups) {
    const lines = [`## ${title}`, '', '| Slice | N | Avg query chars | Avg files | Lexical R@10 | Dense R@10 | Hybrid R@10 | Lexical MRR | Dense MRR | Hybrid MRR |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
    for (const [name, groupSummary] of Object.entries(groups)) {
        const { lexical, dense, hybrid } = groupSummary.channels;
        lines.push(`| ${name.replaceAll('|', '\\|')} | ${groupSummary.cases} | ${groupSummary.pilotProfile.averageQueryLength.toFixed(1)} | ${groupSummary.pilotProfile.averageChangedFileCount.toFixed(1)} | ${format(lexical.recallAt10)} | ${format(dense.recallAt10)} | ${format(hybrid.recallAt10)} | ${format(lexical.mrrAt10)} | ${format(dense.mrrAt10)} | ${format(hybrid.mrrAt10)} |`);
    }
    return lines;
}

function markdown(analysis) {
    const overall = analysis.overall.channels;
    const lines = [
        '# Model-prescreened RCA pilot analysis', '',
        '> 模型预审、非 gold、不可用于 release gate。指标仅用于 pipeline shakeout、检索诊断和人工复审排序。', '',
        `- Cases: ${analysis.cases}`,
        `- Label: ${analysis.evaluationPolicy.displayLabel}`, '',
        '| Channel | Recall@10 | MRR@10 | nDCG@10 | Hit@10 | Rank-1 |',
        '|---|---:|---:|---:|---:|---:|',
        ...['lexical', 'dense', 'hybrid'].map(channel => {
            const metrics = overall[channel];
            return `| ${channel} | ${format(metrics.recallAt10)} | ${format(metrics.mrrAt10)} | ${format(metrics.ndcgAt10)} | ${format(metrics.hitRateAt10)} | ${format(metrics.rank1Rate)} |`;
        }), '',
        '## Fusion effects', '',
        `- Hybrid improves over dense: ${analysis.fusion.hybridImprovesDense}`,
        `- Hybrid unchanged from dense: ${analysis.fusion.hybridEqualsDense}`,
        `- Hybrid worsens dense: ${analysis.fusion.hybridWorsensDense}`,
        `- Lexical rescues a dense top-10 miss into hybrid top 10: ${analysis.fusion.lexicalRescues}`,
        `- Fusion pushes a dense top-10 hit out of hybrid top 10: ${analysis.fusion.denseHitsLostByHybrid}`, '',
        ...sliceTable('Quality score', analysis.slices.quality), '',
        ...sliceTable('Query length', analysis.slices.queryLength), '',
        ...sliceTable('Changed files', analysis.slices.changedFiles), '',
        ...sliceTable('Gold commit count', analysis.slices.goldCommitCount), '',
        ...sliceTable('Primary area', analysis.slices.primaryArea), '',
        '## Largest dense-to-hybrid losses', '',
        '| Case | Quality | Area | Query chars | Lexical rank | Dense rank | Hybrid rank |',
        '|---|---:|---|---:|---:|---:|---:|',
        ...analysis.examples.denseToHybridLosses.map(item => `| [${item.id}](${item.issue}) | ${item.qualityScore} | ${item.primaryArea} | ${item.queryLength} | ${item.lexicalRank ?? 'miss'} | ${item.denseRank ?? 'miss'} | ${item.hybridRank ?? 'miss'} |`), '',
        '## Lexical rescues', '',
        '| Case | Quality | Area | Query chars | Lexical rank | Dense rank | Hybrid rank |',
        '|---|---:|---|---:|---:|---:|---:|',
        ...analysis.examples.lexicalRescues.map(item => `| [${item.id}](${item.issue}) | ${item.qualityScore} | ${item.primaryArea} | ${item.queryLength} | ${item.lexicalRank ?? 'miss'} | ${item.denseRank ?? 'miss'} | ${item.hybridRank ?? 'miss'} |`), '',
    ];
    return lines.join('\n');
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const [manifest, cases, results] = await Promise.all([
        readFile(join(options.dataset, 'manifest.json'), 'utf8').then(JSON.parse),
        readJsonl(join(options.dataset, 'cases.jsonl')),
        readJsonl(join(options.report, 'case-results.jsonl')),
    ]);
    if (manifest.evaluationPolicy?.releaseGateEligible !== false || manifest.evaluationPolicy?.gold !== false) {
        throw new Error('Analysis is restricted to an explicitly non-gold, release-gate-ineligible pilot dataset');
    }
    const resultById = new Map(results.map(item => [item.id, item]));
    const rows = cases.map(evalCase => ({ case: evalCase, result: resultById.get(evalCase.id) }));
    if (rows.some(item => !item.result)) throw new Error('Report does not contain every dataset case');
    const denseRank = row => rank(row.result.channels.dense) || Number.POSITIVE_INFINITY;
    const hybridRank = row => rank(row.result.channels.hybrid) || Number.POSITIVE_INFINITY;
    const lexicalRank = row => rank(row.result.channels.lexical) || Number.POSITIVE_INFINITY;
    const denseHitsLost = rows.filter(row => denseRank(row) <= 10 && hybridRank(row) > 10);
    const lexicalRescues = rows.filter(row => denseRank(row) > 10 && lexicalRank(row) <= 10 && hybridRank(row) <= 10);
    const analysis = {
        schemaVersion: 1,
        dataset: manifest.dataset,
        cases: rows.length,
        evaluationPolicy: manifest.evaluationPolicy,
        overall: summarize(rows),
        fusion: {
            hybridImprovesDense: rows.filter(row => hybridRank(row) < denseRank(row)).length,
            hybridEqualsDense: rows.filter(row => hybridRank(row) === denseRank(row)).length,
            hybridWorsensDense: rows.filter(row => hybridRank(row) > denseRank(row)).length,
            lexicalRescues: lexicalRescues.length,
            denseHitsLostByHybrid: denseHitsLost.length,
        },
        slices: {
            quality: group(rows, row => row.case.pilot.qualityScore >= 10 ? 'high (10-11)' : row.case.pilot.qualityScore >= 8 ? 'medium (8-9)' : 'low (1-7)'),
            queryLength: group(rows, row => row.case.pilot.queryLength <= 500 ? 'short (<=500)' : row.case.pilot.queryLength <= 1200 ? 'medium (501-1200)' : 'long (>1200)'),
            changedFiles: group(rows, row => row.case.pilot.changedFileCount <= 1 ? 'focused (0-1)' : row.case.pilot.changedFileCount <= 5 ? 'small (2-5)' : 'broad (6+)'),
            goldCommitCount: group(rows, row => row.case.pilot.goldCommitCount === 1 ? 'single' : 'multiple'),
            primaryArea: group(rows, row => row.case.pilot.primaryArea),
        },
        examples: {
            denseToHybridLosses: denseHitsLost.sort((left, right) => denseRank(left) - denseRank(right)).slice(0, 15).map(compactCase),
            lexicalRescues: lexicalRescues.sort((left, right) => lexicalRank(left) - lexicalRank(right)).slice(0, 15).map(compactCase),
        },
    };
    await mkdir(options.output, { recursive: true });
    await writeFile(join(options.output, 'pilot-analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`);
    await writeFile(join(options.output, 'pilot-analysis.md'), `${markdown(analysis)}\n`);
    console.log(JSON.stringify({ output: options.output, overall: analysis.overall, fusion: analysis.fusion }, null, 2));
}

main().catch(error => {
    console.error(`RCA pilot analysis failed: ${error.message}`);
    process.exitCode = 1;
});
