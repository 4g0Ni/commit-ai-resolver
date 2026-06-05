/**
 * A/B harness: compare OLD vs NEW commit summarization and audit the results.
 *
 *   node src/scripts/compare-impl.js --commit db0cb9ae... --repo AdsAppsMT
 *   node src/scripts/compare-impl.js --top 10            # top N per repo, all repos
 *   node src/scripts/compare-impl.js --top 10 --out report.md
 *
 * OLD = real summarizeCommit (whole-file minify+truncate+createPatch).
 * NEW = same flow but diff built via buildSmartDiff (adaptive hunk+symbol).
 * Both call the SAME prompt + SAME LLM. An LLM judge then audits each summary
 * against the real (smart) diff for faithfulness / hallucination.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { REPOSITORIES } from '../config/repositories.js';
import {
    fetchLatestCommits,
    fetchCommitChanges,
    fetchCommitById,
} from '../services/ado-git-client.js';
import {
    summarizeCommit,                 // OLD path (real)
    COMMIT_SUMMARY_PROMPT,
} from '../services/commit-summarizer.js';
import { classifyChanges, buildSkippedFilesSummary, MAX_FILES_FOR_DIFF, MAX_DIFF_SIZE } from '../services/diff-filter.js';
import { buildSmartDiff } from '../services/diff-builder.js';
import { llmHelper, llmHelperMini } from '../services/llm-helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOMAIN_DIR = join(__dirname, '..', '..', 'docs', 'domain');

function parseArgs(argv) {
    const o = { commit: null, repo: null, top: 0, out: null, concurrency: 1, delayMs: 0 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--commit') o.commit = argv[++i];
        else if (a === '--repo') o.repo = argv[++i];
        else if (a === '--top') o.top = parseInt(argv[++i], 10);
        else if (a === '--out') o.out = argv[++i];
        else if (a === '--concurrency') o.concurrency = Math.max(1, parseInt(argv[++i], 10) || 1);
        else if (a === '--delay') o.delayMs = Math.max(0, parseInt(argv[++i], 10) || 0);
    }
    return o;
}

async function withRetry(fn, tries = 6) {
    let last;
    for (let i = 0; i < tries; i++) {
        try { return await fn(); } catch (e) { last = e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
    }
    throw last;
}

async function loadDomainKnowledge(repoName) {
    try { return await readFile(join(DOMAIN_DIR, `${repoName}.md`), 'utf-8'); }
    catch { return ''; }
}

/** NEW path: mirrors summarizeCommit but builds the diff via buildSmartDiff. */
async function summarizeCommitNew(repoConfig, commit) {
    const { changes } = await withRetry(() => fetchCommitChanges(repoConfig, commit.commitId));
    const { needsDiff, autoSummary, ignored } = classifyChanges(changes, repoConfig.name);
    const skippedNote = buildSkippedFilesSummary(autoSummary, ignored);

    if (needsDiff.length === 0) {
        const reasons = [...new Set(autoSummary.map(f => f.reason))];
        const commitMsg = commit.message.replace(/^Merged PR \d+:\s*/i, '').trim();
        const autoTitle = commitMsg.length > 10 && commitMsg.length <= 80
            ? commitMsg : `${reasons.join(', ')} (${autoSummary.length + ignored.length} files)`;
        return {
            llmSummary: {
                title: autoTitle,
                summary: `Auto-classified: ${reasons.join(', ')}.`,
                riskLevel: 'LOW', affectedAreas: reasons.slice(0, 3), flags: [],
                changeType: reasons.some(r => r.includes('config')) ? 'config' : 'code',
                configChanges: [], breakingChange: false, _autoClassified: true,
            },
            diffText: '(auto-classified, no diff)',
            diffBytes: 0,
        };
    }

    let diffText;
    let diffMeta = null;
    if (needsDiff.length > MAX_FILES_FOR_DIFF) {
        diffText = [
            `Commit touches ${changes.length} files (${needsDiff.length} code files).`,
            'File list (diffs omitted due to size):',
            ...needsDiff.map(f => `  ${f.changeType}: ${f.path}`),
        ].join('\n');
    } else {
        const { diffs, meta } = await withRetry(() => buildSmartDiff(repoConfig, commit.commitId, needsDiff, {
            context: 20, budget: MAX_DIFF_SIZE,
        }));
        diffMeta = meta;
        diffText = diffs.join('\n---\n');
    }
    if (skippedNote) diffText += `\n\n--- SKIPPED FILES ---\n${skippedNote}`;
    if (diffText.length > MAX_DIFF_SIZE) diffText = diffText.substring(0, MAX_DIFF_SIZE) + '\n... (diff truncated)';

    const userMessage = [
        `Repository: ${repoConfig.name}`,
        `Commit: ${commit.commitId}`,
        `Author: ${commit.author} <${commit.authorEmail}>`,
        `Date: ${commit.date}`,
        `Message: ${commit.message}`,
        `Files changed: ${changes.length} total (${needsDiff.length} analyzed, ${autoSummary.length} auto-skipped, ${ignored.length} ignored)`,
        '', '--- DIFF START ---', diffText, '--- DIFF END ---',
    ].join('\n');

    const domain = await loadDomainKnowledge(repoConfig.name);
    const systemPrompt = domain ? `${COMMIT_SUMMARY_PROMPT}\n\nDOMAIN KNOWLEDGE FOR ${repoConfig.name}:\n${domain}` : COMMIT_SUMMARY_PROMPT;
    const response = await withRetry(() => llmHelper(systemPrompt, [{ role: 'user', content: userMessage }]));

    let summary;
    try { summary = JSON.parse(response); }
    catch { summary = { title: commit.title, summary: response, riskLevel: 'MEDIUM', affectedAreas: [], flags: [], changeType: 'code', configChanges: [], breakingChange: false }; }
    return { llmSummary: summary, diffText, diffBytes: diffText.length, diffMeta };
}

const AUDIT_PROMPT = `You are auditing two AI-generated commit summaries against the GROUND-TRUTH diff.
The ground-truth diff below is accurate (hunk-based, untruncated). Judge each summary ONLY against it.

Return strict JSON:
{
  "oldAccurate": true|false,
  "newAccurate": true|false,
  "oldHallucinations": ["specific claims in OLD not supported by the diff"],
  "newHallucinations": ["specific claims in NEW not supported by the diff"],
  "oldMissedKeyChange": "the single most important real change OLD failed to mention, or null",
  "newMissedKeyChange": "same for NEW, or null",
  "titleVerdict": "OLD | NEW | TIE — which title better describes the real change",
  "configVerdict": "OLD | NEW | TIE — which configChanges list better matches the diff",
  "winner": "OLD | NEW | TIE",
  "reason": "1-2 sentences"
}`;

async function auditPair(groundTruthDiff, oldSummary, newSummary, commit) {
    const msg = [
        `Commit message: ${commit.message}`,
        '', '=== GROUND-TRUTH DIFF (accurate) ===', groundTruthDiff.slice(0, 60000),
        '', '=== OLD SUMMARY ===', JSON.stringify(oldSummary, null, 2),
        '', '=== NEW SUMMARY ===', JSON.stringify(newSummary, null, 2),
    ].join('\n');
    const resp = await withRetry(() => llmHelperMini(AUDIT_PROMPT, [{ role: 'user', content: msg }]));
    try { return JSON.parse(resp.replace(/```json|```/g, '').trim()); }
    catch { return { winner: 'PARSE_ERROR', raw: resp.slice(0, 500) }; }
}

async function processCommit(repoConfig, commit) {
    const [oldRes, newRes] = await Promise.all([
        withRetry(() => summarizeCommit(repoConfig, commit)),
        summarizeCommitNew(repoConfig, commit),
    ]);
    const oldSummary = oldRes.llmSummary;
    const newSummary = newRes.llmSummary;
    const audit = await auditPair(newRes.diffText || '', oldSummary, newSummary, commit);
    return { repo: repoConfig.name, shortId: commit.shortId, commitId: commit.commitId, message: commit.title, oldSummary, newSummary, newDiffBytes: newRes.diffBytes, diffMeta: newRes.diffMeta, audit };
}

function fmtSummary(s) {
    return [
        `  title: ${s.title}`,
        `  changeType: ${s.changeType} | risk: ${s.riskLevel} | configChanges: ${(s.configChanges || []).length} | flags: ${(s.flags || []).join(', ') || '—'}`,
        `  summary: ${s.summary}`,
        (s.configChanges && s.configChanges.length)
            ? `  configKeys: ${s.configChanges.map(c => `${c.key}(${c.action})`).join(', ')}` : null,
    ].filter(Boolean).join('\n');
}

function printResult(r) {
    console.log(`\n${'='.repeat(90)}`);
    console.log(`${r.repo}  ${r.shortId}  ${r.message}`);
    console.log(`NEW diff bytes: ${r.newDiffBytes}`);
    console.log(`\n--- OLD ---\n${fmtSummary(r.oldSummary)}`);
    console.log(`\n--- NEW ---\n${fmtSummary(r.newSummary)}`);
    console.log(`\n--- AUDIT ---`);
    console.log(`  winner: ${r.audit.winner} | title: ${r.audit.titleVerdict} | config: ${r.audit.configVerdict}`);
    console.log(`  oldAccurate: ${r.audit.oldAccurate} | newAccurate: ${r.audit.newAccurate}`);
    if (r.audit.oldHallucinations?.length) console.log(`  OLD hallucinations: ${r.audit.oldHallucinations.join(' | ')}`);
    if (r.audit.newHallucinations?.length) console.log(`  NEW hallucinations: ${r.audit.newHallucinations.join(' | ')}`);
    if (r.audit.oldMissedKeyChange) console.log(`  OLD missed: ${r.audit.oldMissedKeyChange}`);
    if (r.audit.reason) console.log(`  reason: ${r.audit.reason}`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const results = [];

    if (args.commit) {
        const repoName = args.repo || 'AdsAppsMT';
        const repoConfig = REPOSITORIES[repoName];
        const info = await withRetry(() => fetchCommitById(repoConfig, args.commit));
        const commit = {
            commitId: info.commitId, shortId: info.shortId, author: info.author,
            authorEmail: info.authorEmail, date: info.date, message: info.message, title: info.title,
        };
        console.log(`Single-commit A/B: ${repoName} ${commit.shortId}`);
        const r = await processCommit(repoConfig, commit);
        printResult(r);
        results.push(r);
    } else {
        const top = args.top || 10;
        const repos = args.repo ? [args.repo] : Object.keys(REPOSITORIES);
        const CONCURRENCY = args.concurrency;
        for (const repoName of repos) {
            const repoConfig = REPOSITORIES[repoName];
            let commits = [];
            try { commits = await withRetry(() => fetchLatestCommits(repoConfig, top)); }
            catch (e) { console.warn(`  ⚠ ${repoName}: failed to fetch commits — ${e.message}`); continue; }
            console.log(`\n### ${repoName}: ${commits.length} commits (concurrency=${CONCURRENCY})`);
            for (let i = 0; i < commits.length; i += CONCURRENCY) {
                const batch = commits.slice(i, i + CONCURRENCY);
                const settled = await Promise.allSettled(batch.map(c => processCommit(repoConfig, c)));
                for (let j = 0; j < settled.length; j++) {
                    if (settled[j].status === 'fulfilled') {
                        printResult(settled[j].value);
                        results.push(settled[j].value);
                    } else {
                        console.warn(`  ⚠ ${repoName} ${batch[j].shortId}: ${settled[j].reason?.message || settled[j].reason}`);
                    }
                }
                if (args.out && results.length) {
                    await flushReport(results, args.out).catch(() => {});
                }
                if (args.delayMs && i + CONCURRENCY < commits.length) {
                    await new Promise(r => setTimeout(r, args.delayMs));
                }
            }
        }
    }

    // Aggregate
    const agg = computeAgg(results);
    const { tally, oldHalluc, newHalluc, oldInacc, newInacc, avgNewBytes } = agg;
    console.log(`\n${'#'.repeat(90)}`);
    console.log(`AGGREGATE over ${results.length} commits`);
    console.log(`  winner: NEW=${tally.NEW}  OLD=${tally.OLD}  TIE=${tally.TIE}  other=${tally.OTHER}`);
    console.log(`  commits with hallucinations: OLD=${oldHalluc}  NEW=${newHalluc}`);
    console.log(`  commits judged inaccurate:   OLD=${oldInacc}  NEW=${newInacc}`);
    console.log(`  avg NEW diff bytes: ${avgNewBytes}`);

    if (args.out) {
        await flushReport(results, args.out);
        console.log(`\nReport written: ${args.out}`);
    }
}

function computeAgg(results) {
    const tally = { OLD: 0, NEW: 0, TIE: 0, OTHER: 0 };
    let oldHalluc = 0, newHalluc = 0, oldInacc = 0, newInacc = 0;
    for (const r of results) {
        const w = r.audit.winner;
        if (tally[w] === undefined) tally.OTHER++; else tally[w]++;
        if (r.audit.oldHallucinations?.length) oldHalluc++;
        if (r.audit.newHallucinations?.length) newHalluc++;
        if (r.audit.oldAccurate === false) oldInacc++;
        if (r.audit.newAccurate === false) newInacc++;
    }
    const avgNewBytes = Math.round(results.reduce((s, r) => s + (r.newDiffBytes || 0), 0) / Math.max(results.length, 1));
    return { tally, oldHalluc, newHalluc, oldInacc, newInacc, avgNewBytes };
}

async function flushReport(results, outPath) {
    const md = buildMarkdown(results, computeAgg(results));
    await mkdir(dirname(outPath), { recursive: true }).catch(() => {});
    await writeFile(outPath, md);
}

function buildMarkdown(results, agg) {
    const lines = [];
    lines.push(`# OLD vs NEW commit summarization — audit report`);
    lines.push('');
    lines.push(`Commits audited: **${results.length}**`);
    lines.push(`Winner: NEW=${agg.tally.NEW} OLD=${agg.tally.OLD} TIE=${agg.tally.TIE} other=${agg.tally.OTHER}`);
    lines.push(`Hallucinations: OLD=${agg.oldHalluc} NEW=${agg.newHalluc} · Inaccurate: OLD=${agg.oldInacc} NEW=${agg.newInacc}`);
    lines.push(`Avg NEW diff bytes: ${agg.avgNewBytes}`);
    lines.push('');
    lines.push(`| repo | commit | winner | title | config | OLD acc | NEW acc | message |`);
    lines.push(`|------|--------|--------|-------|--------|---------|---------|---------|`);
    for (const r of results) {
        const a = r.audit;
        lines.push(`| ${r.repo} | ${r.shortId} | ${a.winner} | ${a.titleVerdict || ''} | ${a.configVerdict || ''} | ${a.oldAccurate} | ${a.newAccurate} | ${(r.message || '').replace(/\|/g, '/').slice(0, 60)} |`);
    }
    lines.push('');
    for (const r of results) {
        lines.push(`## ${r.repo} ${r.shortId} — winner: ${r.audit.winner}`);
        lines.push(`**Message:** ${r.message}`);
        lines.push(`**NEW diff bytes:** ${r.newDiffBytes}`);
        lines.push(`### OLD`);
        lines.push('```');
        lines.push(fmtSummary(r.oldSummary));
        lines.push('```');
        lines.push(`### NEW`);
        lines.push('```');
        lines.push(fmtSummary(r.newSummary));
        lines.push('```');
        if (r.audit.oldHallucinations?.length) lines.push(`**OLD hallucinations:** ${r.audit.oldHallucinations.join(' · ')}`);
        if (r.audit.newHallucinations?.length) lines.push(`**NEW hallucinations:** ${r.audit.newHallucinations.join(' · ')}`);
        if (r.audit.oldMissedKeyChange) lines.push(`**OLD missed:** ${r.audit.oldMissedKeyChange}`);
        if (r.audit.reason) lines.push(`**Reason:** ${r.audit.reason}`);
        lines.push('');
    }
    return lines.join('\n');
}

main().catch(e => { console.error(e); process.exit(1); });
