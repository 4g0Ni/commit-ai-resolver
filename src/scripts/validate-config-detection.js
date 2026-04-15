/**
 * Validate config detection accuracy across the full dataset.
 * Reads all data/daily/*.json files and identifies suspected false positives
 * where commits were classified as config/mixed but appear to be infrastructure,
 * agent/AI workflows, Dependabot bumps, or build artifacts.
 *
 * Usage: node scripts/validate-config-detection.js [--json]
 */

import { readFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data', 'daily');
const jsonOutput = process.argv.includes('--json');

// ---------------------------------------------------------------------------
// False positive detection patterns
// ---------------------------------------------------------------------------

const FP_INFRA = /\b(helm|k8s|kubernetes|ingress|replicas?|afd|azure\s*front\s*door)\b|values\.yaml|helm-.*\.yaml|image.{0,20}(digest|tag\b)|serviceconfig\.ini|config[-.]?flattener/i;
const FP_AGENT = /\bagent\b.{0,30}\b(workflow|config|skill|pipeline|instruction)\b|\bproject-config\.json\b|\binstruction\.md\b|\bskill[- ]defin/i;
const FP_DEPENDABOT = /\bdependabot\b|\bbump\b.{0,30}(version|package|image|digest)/i;
const FP_BUILD = /\baks\b.{0,20}\b(packag|artifact|build)\b/i;
const FP_XPATH_KEY = /^\/|@\[|\[@name|FlightSet\[/;

function getSearchText(commit) {
    const parts = [
        commit.summary?.title || '',
        commit.message || '',
        commit.title || '',
    ];
    for (const cc of (commit.summary?.configChanges || [])) {
        parts.push(cc.key || '', cc.detail || '', cc.from || '', cc.to || '');
    }
    return parts.join(' ');
}

function detectFalsePositive(commit, repoName) {
    const text = getSearchText(commit);
    const reasons = [];

    if (FP_INFRA.test(text)) reasons.push('infrastructure (helm/k8s/AKS/AFD)');
    if (FP_AGENT.test(text)) reasons.push('agent/AI workflow');
    if (FP_DEPENDABOT.test(text)) reasons.push('Dependabot/version bump');
    if (FP_BUILD.test(text)) reasons.push('AKS build/packaging artifact');

    // Check for XPath-style config keys (quality issue)
    const xpathKeys = (commit.summary?.configChanges || [])
        .filter(cc => FP_XPATH_KEY.test(cc.key || ''));

    return {
        isFP: reasons.length > 0,
        reasons,
        hasXPathKeys: xpathKeys.length > 0,
        xpathKeys: xpathKeys.map(cc => cc.key),
    };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const files = (await readdir(DATA_DIR))
        .filter(f => f.endsWith('.json') && f !== 'index.json')
        .sort();

    let totalCommits = 0;
    let codeCount = 0;
    let configCount = 0;
    let mixedCount = 0;
    const fpList = [];
    const xpathList = [];
    const byRepo = {};
    const byCategory = {};

    for (const file of files) {
        const data = JSON.parse(await readFile(join(DATA_DIR, file), 'utf8'));
        for (const [repoName, repoData] of Object.entries(data.repositories || {})) {
            if (!byRepo[repoName]) {
                byRepo[repoName] = { total: 0, code: 0, config: 0, mixed: 0, fp: 0, xpathKeys: 0 };
            }
            for (const commit of (repoData.commits || [])) {
                totalCommits++;
                byRepo[repoName].total++;
                const ct = commit.summary?.changeType || 'code';

                if (ct === 'code') {
                    codeCount++;
                    byRepo[repoName].code++;
                    continue;
                }
                if (ct === 'config') { configCount++; byRepo[repoName].config++; }
                if (ct === 'mixed') { mixedCount++; byRepo[repoName].mixed++; }

                const result = detectFalsePositive(commit, repoName);

                if (result.isFP) {
                    byRepo[repoName].fp++;
                    for (const reason of result.reasons) {
                        byCategory[reason] = (byCategory[reason] || 0) + 1;
                    }
                    fpList.push({
                        shortId: commit.shortId,
                        repo: repoName,
                        date: data.date,
                        changeType: ct,
                        title: commit.summary?.title || commit.message?.slice(0, 80),
                        reasons: result.reasons,
                    });
                }

                if (result.hasXPathKeys) {
                    byRepo[repoName].xpathKeys++;
                    xpathList.push({
                        shortId: commit.shortId,
                        repo: repoName,
                        date: data.date,
                        keys: result.xpathKeys,
                    });
                }
            }
        }
    }

    const configMixed = configCount + mixedCount;

    if (jsonOutput) {
        console.log(JSON.stringify({
            totalCommits, codeCount, configCount, mixedCount, configMixed,
            falsePositives: fpList.length,
            fpRate: configMixed > 0 ? (fpList.length / configMixed * 100).toFixed(1) + '%' : 'N/A',
            byRepo, byCategory, fpList, xpathList,
        }, null, 2));
        return;
    }

    // Markdown report
    console.log('## Config Detection Validation Report\n');
    console.log(`**Dataset**: ${files[0].replace('.json', '')} to ${files[files.length - 1].replace('.json', '')} (${files.length} days, ${totalCommits} commits)\n`);

    console.log('### Summary\n');
    console.log('| Metric | Count | % |');
    console.log('|--------|------:|---:|');
    console.log(`| Total commits | ${totalCommits} | 100% |`);
    console.log(`| changeType: code | ${codeCount} | ${(codeCount / totalCommits * 100).toFixed(1)}% |`);
    console.log(`| changeType: config | ${configCount} | ${(configCount / totalCommits * 100).toFixed(1)}% |`);
    console.log(`| changeType: mixed | ${mixedCount} | ${(mixedCount / totalCommits * 100).toFixed(1)}% |`);
    console.log(`| **Suspected false positives** | **${fpList.length}** | **${configMixed > 0 ? (fpList.length / configMixed * 100).toFixed(1) : 0}% of config/mixed** |`);
    console.log(`| XPath-style key issues | ${xpathList.length} | quality issue |`);

    console.log('\n### False Positives by Category\n');
    console.log('| Category | Count |');
    console.log('|----------|------:|');
    for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
        console.log(`| ${cat} | ${count} |`);
    }

    console.log('\n### By Repository\n');
    console.log('| Repo | Config | Mixed | Total C/M | Suspected FP | FP Rate | XPath Keys |');
    console.log('|------|-------:|------:|----------:|-------------:|--------:|-----------:|');
    for (const [repo, s] of Object.entries(byRepo).sort((a, b) => (b[1].config + b[1].mixed) - (a[1].config + a[1].mixed))) {
        const cm = s.config + s.mixed;
        if (cm === 0) continue;
        console.log(`| ${repo} | ${s.config} | ${s.mixed} | ${cm} | ${s.fp} | ${cm > 0 ? (s.fp / cm * 100).toFixed(0) : 0}% | ${s.xpathKeys} |`);
    }

    if (fpList.length > 0) {
        console.log('\n### Suspected False Positive Commits\n');
        console.log('| Date | Repo | ID | Type | Title | Reason |');
        console.log('|------|------|----|------|-------|--------|');
        for (const fp of fpList) {
            console.log(`| ${fp.date} | ${fp.repo} | ${fp.shortId} | ${fp.changeType} | ${fp.title?.slice(0, 60)} | ${fp.reasons.join(', ')} |`);
        }
    }

    if (xpathList.length > 0) {
        console.log('\n### XPath-Style Config Keys (Quality Issue)\n');
        console.log('| Date | Repo | ID | Keys |');
        console.log('|------|------|----|------|');
        for (const x of xpathList) {
            console.log(`| ${x.date} | ${x.repo} | ${x.shortId} | ${x.keys.join('; ').slice(0, 80)} |`);
        }
    }

    console.log(`\n---\n*Report generated ${new Date().toISOString().slice(0, 10)}. Detection is heuristic — based on summary text, not actual file lists.*`);
}

main().catch(err => { console.error(err); process.exit(1); });
