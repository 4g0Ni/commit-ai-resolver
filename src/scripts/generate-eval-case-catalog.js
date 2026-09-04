/** Generate a complete Markdown catalog for every active eval case. */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

function parseArgs(argv) {
    const options = {
        engineering: join(projectRoot, 'src', 'eval', 'datasets', 'public-react-v3'),
        rca: join(projectRoot, 'src', 'eval', 'datasets', 'public-react-rca-pilot-v1'),
        timeWindow: join(projectRoot, 'src', 'eval', 'datasets', 'public-react-rca-pilot-v1-time-window-7d-30d'),
        output: join(projectRoot, 'docs', 'eval-case-catalog-2026-09-04.md'),
    };
    for (let index = 0; index < argv.length; index++) {
        if (argv[index] === '--engineering') options.engineering = resolve(argv[++index]);
        else if (argv[index] === '--rca') options.rca = resolve(argv[++index]);
        else if (argv[index] === '--time-window') options.timeWindow = resolve(argv[++index]);
        else if (argv[index] === '--output') options.output = resolve(argv[++index]);
    }
    return options;
}

async function loadDataset(directory) {
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    const cases = (await readFile(join(directory, 'cases.jsonl'), 'utf8'))
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line));
    if (cases.length !== manifest.cases.count) {
        throw new Error(`${manifest.dataset}: manifest=${manifest.cases.count}, cases=${cases.length}`);
    }
    return { manifest, cases };
}

function groupBy(items, keyFn) {
    const result = new Map();
    for (const item of items) {
        const key = keyFn(item);
        if (!result.has(key)) result.set(key, []);
        result.get(key).push(item);
    }
    return result;
}

function escapeCell(value, maximum = 180) {
    const compact = String(value ?? '').replace(/\s+/g, ' ').trim();
    const shortened = compact.length > maximum ? `${compact.slice(0, maximum - 1)}…` : compact;
    return shortened.replace(/\|/g, '\\|');
}

function shortIds(evalCase) {
    return (evalCase.relevantCommits || []).map(item => item.id || item.commitId?.slice(0, 8)).filter(Boolean).join(', ');
}

function primaryArea(evalCase) {
    return evalCase.pilot?.primaryArea
        || (evalCase.tags || []).find(tag => tag.startsWith('area:'))?.slice(5)
        || 'Unclassified';
}

function engineeringPurpose(category) {
    return {
        exact_sha: 'Intent commitIds → Direct SHA lookup → Hybrid prepend → Evidence Gate SEARCH → citation grounding',
        semantic_title: 'Query view → FTS5/Dense candidate generation → RRF → Recall/MRR/nDCG → answer evidence',
        author_date: 'Intent author/repo/date → SQL metadata prefilter → filtered candidate completeness',
        risk_date: 'Intent risk/repo/date → JSON metadata filter → filtered Dense ordering and leakage checks',
        repo_date: 'Intent repo/date → inclusive date bounds → all-commit completeness',
        negative: 'Unknown identifier → Direct/FTS miss → Evidence Gate ABSTAIN → no hallucinated citation',
        negative_natural: 'Natural-language OOD → Dense false-positive resistance → Evidence Gate ABSTAIN',
        ambiguous: 'Intent specificity → ASK_USER → no unsupported answer',
    }[category] || 'General eval coverage';
}

function rcaStepDescription() {
    return [
        'L0 provenance: GitHub Issue → explicit closing PR → merge/fix commit present in the frozen corpus.',
        'Query preparation: raw, compact, and optional multi-view issue queries.',
        'Candidate generation: Dense and FTS5 retrieval, weighted RRF, Recall@10/20/50/100.',
        'Issue lifecycle filtering: createdAt − 7 days through closedAt + 30 days in the derived dataset.',
        'Candidate reranking: local LTR, TF-IDF/field features, cross-encoder and optional LLM reranker experiments.',
        'Agent evaluation when predictions are supplied: Intent GOOD, grounded commit citation, retry trace, confidence and latency.',
        'Policy boundary: model-prescreened and machine-verifiable provenance, but non-gold and not release-gate eligible until human review.',
    ];
}

const options = parseArgs(process.argv.slice(2));
const engineering = await loadDataset(options.engineering);
const rca = await loadDataset(options.rca);
const timeWindow = await loadDataset(options.timeWindow);
const windowById = new Map(timeWindow.cases.map(item => [item.id, item]));
const missingWindows = rca.cases.filter(item => !windowById.has(item.id));
const extraWindows = timeWindow.cases.filter(item => !rca.cases.some(source => source.id === item.id));
if (missingWindows.length || extraWindows.length) {
    throw new Error(`RCA/time-window identity mismatch: missing=${missingWindows.length}, extra=${extraWindows.length}`);
}

const logicalTotal = engineering.cases.length + rca.cases.length;
const areas = [...groupBy(rca.cases, primaryArea)].sort(([left], [right]) => left.localeCompare(right));
const qualityScores = [...groupBy(rca.cases, item => String(item.pilot?.qualityScore ?? 'unknown'))]
    .sort(([left], [right]) => Number(left) - Number(right));
const rcaSplits = Object.fromEntries([...groupBy(rca.cases, item => item.split || 'unspecified')].map(([key, value]) => [key, value.length]));
const lines = [
    '# Commit AI Resolver：完整 Eval Case 目录',
    '',
    '> 本文件由 `src/scripts/generate-eval-case-catalog.js` 从当前 manifest 和 cases 自动生成。不要手工维护 case 行。',
    '',
    '## 1. 当前 Eval 资产总览',
    '',
    `当前共有 **${logicalTotal} 个逻辑 case**：${engineering.cases.length} 条工程回归 case，加 ${rca.cases.length} 条 Issue-grounded RCA pilot case。`,
    '',
    `时间窗口数据集 \`${timeWindow.manifest.dataset}\` 是同一批 ${timeWindow.cases.length} 条 RCA case 的派生视图，不重复计入逻辑总数。`,
    '',
    '| Dataset | Cases | Dev | Test | Gold/门禁状态 | 主要用途 |',
    '|---|---:|---:|---:|---|---|',
    `| \`${engineering.manifest.dataset}\` | ${engineering.cases.length} | ${engineering.manifest.cases.bySplit?.dev ?? 'n/a'} | ${engineering.manifest.cases.bySplit?.test ?? 'n/a'} | 工程确定性标签；可用于对应 gate | 基础检索、过滤、拒答、澄清 |`,
    `| \`${rca.manifest.dataset}\` | ${rca.cases.length} | ${rcaSplits.dev ?? 0} | ${rcaSplits.test ?? 0} | 模型预审、非 gold、不可用于 release gate | RCA 检索诊断、reranker、人工复核排序 |`,
    `| \`${timeWindow.manifest.dataset}\` | ${timeWindow.cases.length} | ${timeWindow.manifest.cases.bySplit?.dev ?? 'n/a'} | ${timeWindow.manifest.cases.bySplit?.test ?? 'n/a'} | 同一 RCA pilot 的派生视图 | Issue 生命周期时间窗 + local LTR |`,
    '',
    '## 2. Case 类型对应的系统步骤',
    '',
    '| Case 类型 | 数量 | 主要测试步骤 |',
    '|---|---:|---|',
];

for (const [category, count] of Object.entries(engineering.manifest.cases.byCategory || {})) {
    lines.push(`| \`${category}\` | ${count} | ${engineeringPurpose(category)} |`);
}
lines.push(`| \`issue_rca_pilot\` | ${rca.cases.length} | Provenance → issue query preprocessing → candidate generation → RRF → time window → reranking → optional Agent/Answer grounding |`);
lines.push('', '### RCA 461 条共同覆盖的步骤', '');
for (const step of rcaStepDescription()) lines.push(`- ${step}`);

lines.push('', '## 3. 75 条工程回归 Case：完整清单', '');
for (const [category, categoryCases] of groupBy(engineering.cases, item => item.category)) {
    lines.push(`### ${category}（${categoryCases.length}）`, '', `测试步骤：${engineeringPurpose(category)}`, '', '| Split | Case ID | Query | Gold commits | Expected |', '|---|---|---|---|---|');
    for (const evalCase of categoryCases) {
        lines.push(`| ${evalCase.split || ''} | \`${evalCase.id}\` | ${escapeCell(evalCase.query)} | ${shortIds(evalCase) || '—'} | ${evalCase.expectedBehavior} |`);
    }
    lines.push('');
}

lines.push('## 4. 461 条 RCA Pilot：分类统计', '', `Split：dev ${rcaSplits.dev ?? 0}，test ${rcaSplits.test ?? 0}。共享 relevant commit 的连通组不会跨 split。`, '', '### 按主要 React area', '', '| Area | Cases |', '|---|---:|');
for (const [area, areaCases] of areas) lines.push(`| ${escapeCell(area)} | ${areaCases.length} |`);
lines.push('', '### 按模型预审质量分', '', '| Quality score | Cases |', '|---:|---:|');
for (const [score, scoreCases] of qualityScores) lines.push(`| ${score} | ${scoreCases.length} |`);

lines.push('', '## 5. 461 条 RCA Pilot：逐条完整清单', '', '字段说明：`Gold` 是 closing PR 对应、且存在于冻结 corpus 的 merge/fix commit；它是机器可验证 provenance，不代表已经完成因果关系和 gold 完整性的人工审批。', '');
for (const [area, areaCases] of areas) {
    lines.push(`### ${area}（${areaCases.length}）`, '', '| Split | Case / Issue | Issue title | Gold | Closing PR | Score | Files | Query chars | Lifecycle window |', '|---|---|---|---|---|---:|---:|---:|---|');
    for (const evalCase of areaCases.sort((left, right) => Number(left.provenance?.issue?.number || 0) - Number(right.provenance?.issue?.number || 0))) {
        const issue = evalCase.provenance?.issue || {};
        const prs = (evalCase.provenance?.pullRequests || []).map(item => `#${item.number}`).join(', ');
        const windowCase = windowById.get(evalCase.id);
        const from = windowCase?.filters?.dateFrom || '—';
        const to = windowCase?.filters?.dateTo || '—';
        lines.push(`| ${evalCase.split || ''} | \`${evalCase.id}\` / #${issue.number || '?'} | ${escapeCell(issue.title || evalCase.query)} | ${shortIds(evalCase) || '—'} | ${prs || '—'} | ${evalCase.pilot?.qualityScore ?? '—'} | ${evalCase.pilot?.changedFileCount ?? '—'} | ${evalCase.pilot?.queryLength ?? String(evalCase.query || '').length} | ${from} → ${to} |`);
    }
    lines.push('');
}

lines.push(
    '## 6. 解释边界',
    '',
    `- ${engineering.cases.length} 条工程回归 case 与 ${rca.cases.length} 条 RCA pilot 是两套不同用途的数据集，运行时通过 \`--dataset\` 明确选择，不会自动合并。`,
    `- 原始 RCA pilot 和 time-window RCA 各有 ${rca.cases.length} 行，但它们是同一组 case；不能声称有 ${rca.cases.length * 2} 条独立 RCA case。`,
    '- 461 条已经具备 Issue → closing PR → corpus commit 的机器可验证链路，但仍是 model-prescreened、non-gold、release-gate-ineligible。',
    '- 327/134 的 dev/test split 可用于诊断 held-out 排名表现，但不能将 test 指标表述为生产准确率或人工 gold 准确率。',
    '- 完整问题正文保存在 RCA `cases.jsonl`；本目录使用 Issue title 保持可读性，Case ID 可精确回查原始行。',
    '',
    '## 7. 重新生成',
    '',
    '从 `src` 目录运行：',
    '',
    '```powershell',
    'npm run catalog:eval-cases',
    '```',
    '',
);

await mkdir(dirname(options.output), { recursive: true });
await writeFile(options.output, `${lines.join('\n')}\n`);
console.log(JSON.stringify({
    output: options.output,
    logicalCases: logicalTotal,
    engineeringCases: engineering.cases.length,
    rcaCases: rca.cases.length,
    timeWindowCases: timeWindow.cases.length,
    rcaAreas: Object.fromEntries(areas.map(([area, values]) => [area, values.length])),
}, null, 2));

