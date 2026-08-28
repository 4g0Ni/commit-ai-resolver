/** Compare ranking changes for byte-identical cases across two versioned eval datasets. */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

function parseArgs(argv) {
    const options = {
        beforeDataset: join(projectRoot, 'src', 'eval', 'datasets', 'public-react-v2'),
        afterDataset: join(projectRoot, 'src', 'eval', 'datasets', 'public-react-v3'),
        beforeReport: join(projectRoot, 'src', 'eval', 'reports', 'eval-2026-08-26T09-17-39-740Z'),
        afterReport: join(projectRoot, 'src', 'eval', 'reports', 'public-react-v3-candidate'),
        beforeDb: join(projectRoot, 'data', 'vectors.db'),
        afterDb: join(projectRoot, 'data', 'enriched', 'public-react-v3-20260827', 'vectors.db'),
        output: join(projectRoot, 'src', 'eval', 'reports', 'public-react-v3-candidate'),
    };
    for (let index = 0; index < argv.length; index++) {
        const key = argv[index];
        if (key === '--before-dataset') options.beforeDataset = resolve(argv[++index]);
        else if (key === '--after-dataset') options.afterDataset = resolve(argv[++index]);
        else if (key === '--before-report') options.beforeReport = resolve(argv[++index]);
        else if (key === '--after-report') options.afterReport = resolve(argv[++index]);
        else if (key === '--before-db') options.beforeDb = resolve(argv[++index]);
        else if (key === '--after-db') options.afterDb = resolve(argv[++index]);
        else if (key === '--output') options.output = resolve(argv[++index]);
        else throw new Error(`Unknown argument: ${key}`);
    }
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

function summarize(rows, channel) {
    const values = rows
        .map(row => row[channel])
        .filter(item => item.before?.metrics?.recallAtK !== null && item.after?.metrics?.recallAtK !== null);
    const metrics = side => ({
        cases: values.length,
        recallAt10: mean(values.map(item => item[side].metrics.recallAtK)),
        mrrAt10: mean(values.map(item => item[side].metrics.mrr)),
        ndcgAt10: mean(values.map(item => item[side].metrics.ndcg)),
    });
    const before = metrics('before');
    const after = metrics('after');
    return {
        before,
        after,
        delta: {
            recallAt10: after.recallAt10 - before.recallAt10,
            mrrAt10: after.mrrAt10 - before.mrrAt10,
            ndcgAt10: after.ndcgAt10 - before.ndcgAt10,
        },
        rankMovement: {
            improved: values.filter(item => (rank(item.after) || Infinity) < (rank(item.before) || Infinity)).length,
            unchanged: values.filter(item => (rank(item.after) || Infinity) === (rank(item.before) || Infinity)).length,
            worsened: values.filter(item => (rank(item.after) || Infinity) > (rank(item.before) || Infinity)).length,
            gainedTop10: values.filter(item => !rank(item.before) && rank(item.after)).length,
            lostTop10: values.filter(item => rank(item.before) && !rank(item.after)).length,
        },
    };
}

function databaseTextStats(path, goldKeys) {
    const db = new Database(path, { readonly: true });
    const corpus = db.prepare('SELECT COUNT(*) AS documents, AVG(LENGTH(text)) AS averageChars, MIN(LENGTH(text)) AS minChars, MAX(LENGTH(text)) AS maxChars FROM commit_metadata').get();
    const lookup = db.prepare('SELECT text FROM commit_metadata WHERE repo = ? AND id = ?');
    const goldChars = goldKeys.map(key => lookup.get(key.repo, key.id)?.text?.length).filter(Number.isFinite);
    const textByKey = new Map(goldKeys.map(key => [`${key.repo}:${key.id}`, lookup.get(key.repo, key.id)?.text || '']));
    db.close();
    return { corpus, commonGoldAverageChars: mean(goldChars), textByKey };
}

function format(value) {
    return value == null ? 'n/a' : value.toFixed(4);
}

function markdown(analysis) {
    const lines = [
        '# Public React v2 to v3 identical-case ranking analysis', '',
        `- Byte-identical cases: ${analysis.identicalCases}`,
        `- Positive cases used for retrieval metrics: ${analysis.positiveCases}`,
        `- Corpus searchable text average chars: ${analysis.documentText.before.corpus.averageChars.toFixed(1)} -> ${analysis.documentText.after.corpus.averageChars.toFixed(1)}`,
        `- Common gold searchable text average chars: ${analysis.documentText.before.commonGoldAverageChars.toFixed(1)} -> ${analysis.documentText.after.commonGoldAverageChars.toFixed(1)}`, '',
        '| Channel | Recall@10 before | after | delta | MRR before | after | delta | Improved | Same | Worsened | Gained top10 | Lost top10 |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ];
    for (const channel of ['lexical', 'dense', 'hybrid']) {
        const item = analysis.channels[channel];
        lines.push(`| ${channel} | ${format(item.before.recallAt10)} | ${format(item.after.recallAt10)} | ${format(item.delta.recallAt10)} | ${format(item.before.mrrAt10)} | ${format(item.after.mrrAt10)} | ${format(item.delta.mrrAt10)} | ${item.rankMovement.improved} | ${item.rankMovement.unchanged} | ${item.rankMovement.worsened} | ${item.rankMovement.gainedTop10} | ${item.rankMovement.lostTop10} |`);
    }
    lines.push('', '## By category', '');
    for (const [category, categorySummary] of Object.entries(analysis.byCategory)) {
        lines.push(`### ${category}`, '', '| Channel | N | Recall before | after | MRR before | after | Improved / same / worsened |', '|---|---:|---:|---:|---:|---:|---:|');
        for (const channel of ['lexical', 'dense', 'hybrid']) {
            const item = categorySummary[channel];
            lines.push(`| ${channel} | ${item.before.cases} | ${format(item.before.recallAt10)} | ${format(item.after.recallAt10)} | ${format(item.before.mrrAt10)} | ${format(item.after.mrrAt10)} | ${item.rankMovement.improved} / ${item.rankMovement.unchanged} / ${item.rankMovement.worsened} |`);
        }
        lines.push('');
    }
    for (const channel of ['lexical', 'dense', 'hybrid']) {
        lines.push(`## ${channel} largest movements`, '', '| Case | Category | Gold | Before rank | After rank | Added searchable text |', '|---|---|---|---:|---:|---|');
        for (const item of analysis.examples[channel]) {
            lines.push(`| ${item.id} | ${item.category} | ${item.goldCommitId.slice(0, 8)} | ${item.beforeRank ?? 'miss'} | ${item.afterRank ?? 'miss'} | ${item.addedText.replaceAll('|', '\\|')} |`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const [beforeCases, afterCases, beforeResults, afterResults] = await Promise.all([
        readJsonl(join(options.beforeDataset, 'cases.jsonl')),
        readJsonl(join(options.afterDataset, 'cases.jsonl')),
        readJsonl(join(options.beforeReport, 'case-results.jsonl')),
        readJsonl(join(options.afterReport, 'case-results.jsonl')),
    ]);
    const beforeCaseById = new Map(beforeCases.map(item => [item.id, item]));
    const beforeResultById = new Map(beforeResults.map(item => [item.id, item]));
    const afterResultById = new Map(afterResults.map(item => [item.id, item]));
    const identical = afterCases.filter(item => JSON.stringify(item) === JSON.stringify(beforeCaseById.get(item.id)));
    const rows = identical.map(evalCase => {
        const before = beforeResultById.get(evalCase.id);
        const after = afterResultById.get(evalCase.id);
        if (!before || !after) throw new Error(`Missing case result: ${evalCase.id}`);
        return {
            case: evalCase,
            lexical: { before: before.channels.lexical, after: after.channels.lexical },
            dense: { before: before.channels.dense, after: after.channels.dense },
            hybrid: { before: before.channels.hybrid, after: after.channels.hybrid },
        };
    });
    const goldKeys = [...new Map(identical.flatMap(item => item.relevantCommits || []).map(item => [`${item.repo}:${item.id}`, { repo: item.repo, id: item.id }])).values()];
    const beforeText = databaseTextStats(options.beforeDb, goldKeys);
    const afterText = databaseTextStats(options.afterDb, goldKeys);
    const categories = [...new Set(rows.map(row => row.case.category))].sort();
    const positiveRows = rows.filter(row => row.case.relevantCommits?.length);
    const examples = {};
    for (const channel of ['lexical', 'dense', 'hybrid']) {
        examples[channel] = positiveRows
            .map(row => {
                const gold = row.case.relevantCommits[0];
                const key = `${gold.repo}:${gold.id}`;
                const beforeRank = rank(row[channel].before);
                const afterRank = rank(row[channel].after);
                const beforeDocument = beforeText.textByKey.get(key) || '';
                const afterDocument = afterText.textByKey.get(key) || '';
                const addedLines = afterDocument.split('\n').filter(line => !beforeDocument.split('\n').includes(line)).join(' / ');
                return {
                    id: row.case.id,
                    category: row.case.category,
                    query: row.case.query,
                    goldCommitId: gold.commitId,
                    beforeRank,
                    afterRank,
                    movement: (beforeRank || 11) - (afterRank || 11),
                    addedText: addedLines.slice(0, 180),
                };
            })
            .filter(item => item.beforeRank !== item.afterRank)
            .sort((left, right) => Math.abs(right.movement) - Math.abs(left.movement) || right.movement - left.movement)
            .slice(0, 20);
    }
    const analysis = {
        schemaVersion: 1,
        identicalCases: rows.length,
        positiveCases: positiveRows.length,
        changedCasesExcluded: afterCases.length - rows.length,
        documentText: {
            before: { corpus: beforeText.corpus, commonGoldAverageChars: beforeText.commonGoldAverageChars },
            after: { corpus: afterText.corpus, commonGoldAverageChars: afterText.commonGoldAverageChars },
        },
        channels: Object.fromEntries(['lexical', 'dense', 'hybrid'].map(channel => [channel, summarize(rows, channel)])),
        byCategory: Object.fromEntries(categories.map(category => [category, Object.fromEntries(['lexical', 'dense', 'hybrid'].map(channel => [channel, summarize(rows.filter(row => row.case.category === category), channel)]))])),
        examples,
    };
    await writeFile(join(options.output, 'v2-v3-identical-case-analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`);
    await writeFile(join(options.output, 'v2-v3-identical-case-analysis.md'), `${markdown(analysis)}\n`);
    console.log(JSON.stringify({ identicalCases: analysis.identicalCases, positiveCases: analysis.positiveCases, documentText: analysis.documentText, channels: analysis.channels }, null, 2));
}

main().catch(error => {
    console.error(`Versioned eval delta analysis failed: ${error.message}`);
    process.exitCode = 1;
});
