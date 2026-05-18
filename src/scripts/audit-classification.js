/**
 * Audit script — walks last 7 days of commits across onboarded repos and
 * proposes refinements to diff-filter.js rules and the COMMIT_SUMMARY_PROMPT.
 *
 * Read-only: never modifies source. Writes report + JSON + patch under
 * data/audit/<runDate>/.
 *
 * Usage:
 *   node src/scripts/audit-classification.js
 *   node src/scripts/audit-classification.js --days 14
 *   node src/scripts/audit-classification.js --from 2026-05-08 --to 2026-05-14
 *   node src/scripts/audit-classification.js --repo AdsAppsCampaignUI
 */

import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { REPOSITORIES } from '../config/repositories.js';
import {
    fetchCommitsBetweenDates,
    fetchCommitChanges,
    fetchFileContent,
} from '../services/ado-git-client.js';
import { classifyChanges, MAX_FILES_FOR_DIFF, MAX_DIFF_SIZE } from '../services/diff-filter.js';
import { isConfigFile } from '../services/commit-summarizer.js';
import { llmHelperMini } from '../services/llm-helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DATA_DIR = process.env.DATA_DIR || join(REPO_ROOT, 'data');
const DIFFS_DIR = join(DATA_DIR, 'diffs');
const AUDIT_ROOT = join(DATA_DIR, 'audit');
const DIFF_FILTER_PATH = join(REPO_ROOT, 'src', 'services', 'diff-filter.js');

const COMMIT_POOL = 5;
const FILE_POOL = 3;
const SAMPLE_NORMAL = 25;
const SAMPLE_LARGE = 10;
const LARGE_THRESHOLD_FILES = 200;
const FN_FP_CAP_PER_REPO = 20;
const ESTIMATED_BYTES_PER_FILE = 2500;
const INCONCLUSIVE_CAP_PER_REPO = 200;
const SNIPPET_LINES = 30;
const LLM_BATCH_DEFAULT = 20;
const LLM_MAX_FILES_DEFAULT = 500;
const LLM_POOL = 3;
const RULE_MIN_OCCURRENCES = 3;
const RULE_MIN_DISTINCT_COMMITS = 2;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const out = {
        days: 7, from: null, to: null, repo: null,
        llmVerify: false,
        llmBatch: LLM_BATCH_DEFAULT,
        llmMaxFiles: LLM_MAX_FILES_DEFAULT,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--days') out.days = parseInt(argv[++i], 10);
        else if (a === '--from') out.from = argv[++i];
        else if (a === '--to') out.to = argv[++i];
        else if (a === '--repo') out.repo = argv[++i];
        else if (a === '--llm-verify') out.llmVerify = true;
        else if (a === '--llm-batch') out.llmBatch = parseInt(argv[++i], 10);
        else if (a === '--llm-max-files') out.llmMaxFiles = parseInt(argv[++i], 10);
    }
    if (!out.to) out.to = new Date().toISOString().slice(0, 10);
    if (!out.from) {
        const d = new Date(out.to);
        d.setUTCDate(d.getUTCDate() - out.days);
        out.from = d.toISOString().slice(0, 10);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Concurrency primitive
// ---------------------------------------------------------------------------

async function pool(items, concurrency, worker) {
    const results = [];
    let i = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (i < items.length) {
            const idx = i++;
            try { results[idx] = await worker(items[idx], idx); }
            catch (e) { results[idx] = { __error: e }; }
        }
    });
    await Promise.all(runners);
    return results;
}

// ---------------------------------------------------------------------------
// Cached diff parser
// ---------------------------------------------------------------------------

const FILE_HEADER_RE = /^(.+?)\s+(Modified|Added|Deleted):\s*$/;

/**
 * Slice a cached diff archive into per-file diff text.
 * The archive starts with `=== SYSTEM PROMPT ===` then `=== USER MESSAGE ===`,
 * followed by per-file blocks separated by lines of just `---`. Each block
 * begins with `<path> Modified|Added|Deleted:` then `Index: <path>` then the
 * unified diff body.
 */
function parseFileSlices(text) {
    const result = new Map();
    const userMsgIdx = text.indexOf('=== USER MESSAGE ===');
    if (userMsgIdx < 0) return result;
    const body = text.slice(userMsgIdx);
    const blocks = body.split(/\n---\n/);
    for (const block of blocks) {
        const lines = block.split('\n');
        let pathLineIdx = -1;
        for (let i = 0; i < Math.min(lines.length, 5); i++) {
            const m = lines[i].match(FILE_HEADER_RE);
            if (m) { pathLineIdx = i; break; }
        }
        if (pathLineIdx < 0) continue;
        const path = lines[pathLineIdx].match(FILE_HEADER_RE)[1].trim();
        const diff = lines.slice(pathLineIdx + 1).join('\n');
        result.set(path, diff);
    }
    return result;
}

async function readCachedDiff(repoName, shortId) {
    const p = join(DIFFS_DIR, repoName, `${shortId}.txt`);
    try { return await readFile(p, 'utf8'); }
    catch { return null; }
}

// ---------------------------------------------------------------------------
// Ceremony-vs-real heuristics (8 signals)
// ---------------------------------------------------------------------------

const AI_WORKFLOW_RE = /(\.skill\.md$|\.prompt\.md$|\.cursorrules$|CLAUDE\.md$|\.github\/copilot|\/agent\/|\/\.cursor\/|\.agent\.md$)/i;
const PROJECT_SETUP_RE = /(Directory\.Packages\.props$|global\.json$|\.editorconfig$|nuget\.config$)/i;
const PILOT_TOKEN_RE = /(<Pilot|FeatureFlag|IsEnabled\b|<Setting\s+name=|\/Configuration\/|AllowedFeature|PermissionProvider)/;
const GENERATED_MARKER_RE = /(auto[-\s]?generated|DO NOT EDIT|<auto-generated)/i;
const FRONTMATTER_KEY_RE = /^(agent|skill|name|description|tools|model|allowed-tools):/m;
const LOGIC_TOKENS_RE = /\bif\s*\(|\bswitch\b|\?\?|\?\.|\breturn\s/g;
const CEREMONY_MSG_RE = /\b(bump|update lock|regenerate|agent config|skill update|dependabot)\b/i;
const REAL_MSG_RE = /\b(pilot|flag|rollout|incident|hotfix)\b/i;
const PKG_VERSION_LINE_RE = /^[+-]\s*"(version|dependencies|devDependencies|peerDependencies)"/;
const VERSION_BUMP_DIFF_RE = /^[+-]\s*"[^"]+"\s*:\s*"[~^]?\d+\.\d+/;

function getExt(path) {
    const m = path.match(/\.([a-zA-Z0-9]+)$/);
    return m ? m[1].toLowerCase() : '';
}

function getTopDir(path) {
    const clean = path.replace(/^\/+/, '');
    const parts = clean.split('/');
    return parts.length > 1 ? parts[0] + '/' : '(root)';
}

function snippetFromContent(content) {
    if (!content) return '';
    const lines = content.split('\n').slice(0, SNIPPET_LINES);
    let snippet = lines.join('\n');
    if (snippet.length > 2400) snippet = snippet.slice(0, 2400) + '\n…[truncated]';
    return snippet;
}

function scoreCeremony(file, content, message) {
    const signals = [];
    let ceremony = 0;
    let real = 0;

    const path = file.path;
    const ext = getExt(path);

    // 4. AI workflow paths (path-only, no content needed)
    if (AI_WORKFLOW_RE.test(path)) { ceremony += 2; signals.push('ai-workflow-path'); }

    // 5. Project-setup files
    if (PROJECT_SETUP_RE.test(path)) {
        ceremony += 1;
        signals.push('project-setup-path');
        if (content && content.split('\n').filter(l => l.startsWith('+') || l.startsWith('-'))
            .every(l => VERSION_BUMP_DIFF_RE.test(l) || /^[+-]\s*$/.test(l) || /^[+-]{3}\s/.test(l))) {
            ceremony += 2;
            signals.push('version-bump-only');
        }
    }

    // 8. Commit-message keyword override
    if (CEREMONY_MSG_RE.test(message)) { ceremony += 1; signals.push('msg-ceremony'); }
    if (REAL_MSG_RE.test(message)) { real += 1; signals.push('msg-real'); }

    if (content) {
        const head = content.split('\n').slice(0, 20).join('\n');

        // 1. Frontmatter-only Markdown
        if (ext === 'md') {
            const body = content.replace(/^---[\s\S]*?\n---\n/, '');
            const nonBlank = body.split('\n').filter(l => l.trim()).length;
            const fmHits = (content.match(FRONTMATTER_KEY_RE) || []).length;
            if (nonBlank < 5) { ceremony += 2; signals.push('md-near-empty'); }
            else if (fmHits >= 2 && nonBlank < 30) { ceremony += 2; signals.push('md-frontmatter-heavy'); }
        }

        // 2. Lock/version-only JSON diff (only meaningful for cached diffs starting with +/-)
        if (path.endsWith('package.json')) {
            const diffLines = content.split('\n').filter(l => l.startsWith('+') || l.startsWith('-'));
            const hasOnlyVersionLines = diffLines.length > 0 &&
                diffLines.every(l => PKG_VERSION_LINE_RE.test(l) || VERSION_BUMP_DIFF_RE.test(l)
                    || /^[+-]\s*[{}\[\],]?\s*$/.test(l) || /^[+-]{3}\s/.test(l));
            if (hasOnlyVersionLines) { ceremony += 2; signals.push('pkg-version-only'); }
        }

        // 3. Generated-marker content
        if (GENERATED_MARKER_RE.test(head)) { ceremony += 2; signals.push('generated-marker'); }

        // 6. Pilot/flag tokens (overrides ceremony)
        if (PILOT_TOKEN_RE.test(content)) { real += 2; signals.push('pilot-token'); }
        if (isConfigFile(path)) { real += 2; signals.push('config-file-path'); }

        // 7. Conditional-logic density
        const logicHits = (content.match(LOGIC_TOKENS_RE) || []).length;
        const lineCount = Math.max(content.split('\n').length, 1);
        if (logicHits / lineCount > 0.05) { real += 1; signals.push('logic-density'); }
    }

    let verdict = 'inconclusive';
    if (ceremony >= 3 && real === 0) verdict = 'ceremony';
    else if (real >= 2) verdict = 'real';

    return { ceremony, real, signals, verdict };
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

function stratifiedSample(changes, max) {
    const byKey = new Map();
    for (const c of changes) {
        const key = `${getTopDir(c.path)}|${getExt(c.path)}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(c);
    }
    const buckets = [...byKey.values()];
    const out = [];
    let i = 0;
    while (out.length < max && buckets.some(b => b.length)) {
        const b = buckets[i % buckets.length];
        if (b.length) out.push(b.shift());
        i++;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Per-commit audit
// ---------------------------------------------------------------------------

async function auditCommit(repo, commit, repoStats) {
    const { changes } = await fetchCommitChanges(repo, commit.commitId);
    repoStats.commitFileCounts.push(changes.length);

    const verdict = classifyChanges(changes, repo.name);
    for (const c of changes) {
        const ext = getExt(c.path);
        const dir = getTopDir(c.path);
        repoStats.exts.set(ext, (repoStats.exts.get(ext) || 0) + 1);
        repoStats.dirs.set(dir, (repoStats.dirs.get(dir) || 0) + 1);
    }

    const isLarge = changes.length > LARGE_THRESHOLD_FILES;
    if (isLarge) {
        repoStats.megaCommits.push({
            sha: commit.shortId,
            url: commit.url,
            fileCount: changes.length,
            dominantDirs: [...repoStats.dirs.entries()]
                .filter(([d]) => changes.some(c => getTopDir(c.path) === d))
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([d]) => d),
        });
    }

    const sampleSet = isLarge
        ? stratifiedSample([...changes], SAMPLE_LARGE)
        : changes.slice(0, SAMPLE_NORMAL);

    const cached = await readCachedDiff(repo.name, commit.commitId.slice(0, 8));
    const fileSlices = cached ? parseFileSlices(cached) : null;
    repoStats.diffSizes.push(cached ? cached.length : changes.length * ESTIMATED_BYTES_PER_FILE);

    const verdictByPath = new Map();
    for (const f of verdict.needsDiff) verdictByPath.set(f.path, 'needsDiff');
    for (const f of verdict.autoSummary) verdictByPath.set(f.path, 'autoSummary');
    for (const f of verdict.ignored) verdictByPath.set(f.path, 'ignored');

    await pool(sampleSet, FILE_POOL, async (f) => {
        let content = fileSlices?.get(f.path) || null;
        if (!content) {
            try { content = await fetchFileContent(repo, f.path, commit.commitId); }
            catch { content = null; }
        }
        const sig = scoreCeremony(f, content, commit.message || '');
        const cur = verdictByPath.get(f.path);

        if (cur === 'needsDiff' && sig.verdict === 'ceremony') {
            repoStats.falseNegatives.push({
                sha: commit.shortId, url: commit.url, path: f.path, signals: sig.signals,
            });
            const ext = getExt(f.path);
            const dir = getTopDir(f.path);
            const patternKey = AI_WORKFLOW_RE.test(f.path) ? 'ai-workflow'
                : PROJECT_SETUP_RE.test(f.path) ? 'project-setup'
                : ext ? `ext:${ext}` : `dir:${dir}`;
            const cand = repoStats.patternCandidates.get(patternKey)
                || { occurrences: 0, sampleShas: new Set(), samplePaths: new Set(), kind: 'autoSummary' };
            cand.occurrences++;
            cand.sampleShas.add(commit.shortId);
            cand.samplePaths.add(f.path);
            repoStats.patternCandidates.set(patternKey, cand);
        }
        if ((cur === 'autoSummary' || cur === 'ignored') && sig.verdict === 'real') {
            repoStats.falsePositives.push({
                sha: commit.shortId, url: commit.url, path: f.path,
                currentBucket: cur, signals: sig.signals,
            });
        }
        if (sig.verdict === 'inconclusive' && repoStats.inconclusive.length < INCONCLUSIVE_CAP_PER_REPO) {
            repoStats.inconclusive.push({
                sha: commit.shortId,
                url: commit.url,
                message: (commit.message || '').slice(0, 200),
                path: f.path,
                currentBucket: cur || 'unknown',
                signals: sig.signals,
                snippet: snippetFromContent(content),
            });
        }
    });
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function percentiles(arr) {
    if (!arr.length) return { p50: 0, p95: 0, p99: 0, max: 0 };
    const s = [...arr].sort((a, b) => a - b);
    const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
    return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] };
}

function topN(map, n) {
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function buildRepoStatsBucket() {
    return {
        commitCount: 0,
        errorCount: 0,
        commitFileCounts: [],
        diffSizes: [],
        exts: new Map(),
        dirs: new Map(),
        falseNegatives: [],
        falsePositives: [],
        megaCommits: [],
        patternCandidates: new Map(),
        inconclusive: [],
    };
}

function summarizeRepo(stats) {
    const candidates = [...stats.patternCandidates.entries()].map(([key, v]) => ({
        key,
        occurrences: v.occurrences,
        kind: v.kind,
        sampleShas: [...v.sampleShas].slice(0, 5),
        samplePaths: [...v.samplePaths].slice(0, 5),
    })).sort((a, b) => b.occurrences - a.occurrences);

    return {
        commitCount: stats.commitCount,
        errorCount: stats.errorCount,
        fileCountDistribution: percentiles(stats.commitFileCounts),
        diffSizeDistribution: percentiles(stats.diffSizes),
        topExtensions: topN(stats.exts, 15),
        topDirs: topN(stats.dirs, 15),
        falseNegatives: stats.falseNegatives.slice(0, FN_FP_CAP_PER_REPO),
        falseNegativeTotal: stats.falseNegatives.length,
        falsePositives: stats.falsePositives.slice(0, FN_FP_CAP_PER_REPO),
        falsePositiveTotal: stats.falsePositives.length,
        megaCommits: stats.megaCommits.slice(0, 10),
        newPatternCandidates: candidates.slice(0, 15),
        inconclusiveTotal: stats.inconclusive.length,
        // raw inconclusive list is kept on stats only (not in JSON output) — used by LLM phase
    };
}

// ---------------------------------------------------------------------------
// LLM tie-breaker (--llm-verify)
// ---------------------------------------------------------------------------

const LLM_SYSTEM_PROMPT = `You are auditing one Microsoft Advertising commit's file changes to decide whether each file represents a behavior-affecting change ("real") or boilerplate / generated / docs-only / pinning ("ceremony").

Definitions:
- "real": The change alters runtime behavior, business logic, pilot/flag rollout state, schema, or production configuration. Examples: edited if-branches, new pilot key, new SQL procedure body, new feature flag, new permission rule.
- "ceremony": The change is repository housekeeping with no behavior impact. Examples: lock/version bumps, formatting, generated *.g.cs, AI tooling markdown (.skill.md / .agent.md / CLAUDE.md), project-setup pinning (global.json, .editorconfig), pure docs.

For each file, return a single verdict + a one-line reason (≤120 chars). If genuinely unclear, prefer "real" — false-real is safer than missing a flag.

Respond ONLY with a JSON array, no prose, no markdown fence:
[{"path":"<exact path>","verdict":"real"|"ceremony","reason":"<≤120 chars>"}]`;

function buildLlmUserMessage(repoName, batch) {
    const lines = [`Repo: ${repoName}`, `Files (N=${batch.length}):`, ''];
    batch.forEach((item, idx) => {
        lines.push(`${idx + 1}. path: ${item.path}`);
        lines.push(`   currentBucket: ${item.currentBucket}`);
        lines.push(`   signals: [${item.signals.join(', ')}]`);
        lines.push(`   commitMessage: ${item.message.replace(/\s+/g, ' ').slice(0, 140)}`);
        lines.push(`   firstLines:`);
        lines.push('   ```');
        for (const ln of (item.snippet || '(no content fetched)').split('\n')) {
            lines.push(`   ${ln}`);
        }
        lines.push('   ```');
        lines.push('');
    });
    return lines.join('\n');
}

function parseLlmJsonReply(reply) {
    if (!reply) return [];
    let txt = reply.trim();
    // Strip ``` fences if the model added them despite instructions.
    txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
    const start = txt.indexOf('[');
    const end = txt.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    try {
        const arr = JSON.parse(txt.slice(start, end + 1));
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

function stratifiedSampleByRepo(allItems, cap) {
    if (allItems.length <= cap) return allItems;
    const byRepo = new Map();
    for (const it of allItems) {
        if (!byRepo.has(it.repo)) byRepo.set(it.repo, []);
        byRepo.get(it.repo).push(it);
    }
    const buckets = [...byRepo.values()];
    const out = [];
    let i = 0;
    while (out.length < cap && buckets.some(b => b.length)) {
        const b = buckets[i % buckets.length];
        if (b.length) out.push(b.shift());
        i++;
    }
    return out;
}

/**
 * Verify inconclusive files via gpt-5.4-mini, in batches.
 * Returns {verdicts, batchErrors} — verdicts is one row per file with LLM verdict merged in.
 */
async function verifyInconclusive(items, batchSize) {
    const verdicts = [];
    const batchErrors = [];
    const byRepoBatches = [];

    // Group by repo first so each batch shares the same repo header.
    const byRepo = new Map();
    for (const it of items) {
        if (!byRepo.has(it.repo)) byRepo.set(it.repo, []);
        byRepo.get(it.repo).push(it);
    }
    for (const [repoName, list] of byRepo.entries()) {
        for (const b of chunk(list, batchSize)) {
            byRepoBatches.push({ repoName, batch: b });
        }
    }

    console.log(`  [llm-verify] ${items.length} files in ${byRepoBatches.length} batches…`);

    let done = 0;
    await pool(byRepoBatches, LLM_POOL, async ({ repoName, batch }) => {
        const userMsg = buildLlmUserMessage(repoName, batch);
        try {
            const reply = await llmHelperMini(LLM_SYSTEM_PROMPT, [
                { role: 'user', content: userMsg },
            ], { temperature: 0.1, max_completion_tokens: 4000 });
            const parsed = parseLlmJsonReply(reply);
            const byPath = new Map(parsed.map(p => [p.path, p]));
            for (const item of batch) {
                const p = byPath.get(item.path);
                if (!p) continue; // model dropped this file; skip
                if (p.verdict !== 'real' && p.verdict !== 'ceremony') continue;
                verdicts.push({
                    repo: item.repo,
                    sha: item.sha,
                    url: item.url,
                    path: item.path,
                    currentBucket: item.currentBucket,
                    signals: item.signals,
                    llmVerdict: p.verdict,
                    llmReason: (p.reason || '').slice(0, 200),
                });
            }
        } catch (e) {
            batchErrors.push({ repo: repoName, size: batch.length, msg: e.message });
            console.warn(`  [llm-verify] batch failed (${repoName}, ${batch.length} files): ${e.message}`);
        }
        done++;
        if (done % 5 === 0 || done === byRepoBatches.length) {
            console.log(`  [llm-verify] …${done}/${byRepoBatches.length} batches`);
        }
    });

    return { verdicts, batchErrors };
}

// ---------------------------------------------------------------------------
// LLM-derived rule mining
// ---------------------------------------------------------------------------

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Pick the most specific regex covering all paths in `samplePaths` without
 * overmatching: extension + common dir prefix when ≥3 paths share it,
 * extension-only otherwise.
 */
function derivePattern(samplePaths, ext) {
    if (!ext) {
        // No common extension — fall back to a path substring containing the
        // most common directory name.
        const dirs = samplePaths.map(getTopDir);
        const uniq = [...new Set(dirs)];
        if (uniq.length === 1 && uniq[0] !== '(root)') {
            return new RegExp(`/${escapeRegex(uniq[0].replace(/\/$/, ''))}/`, 'i');
        }
        return null;
    }
    const extRe = `\\.${escapeRegex(ext)}$`;
    // If all sample paths share a non-root top dir, anchor to it for safety.
    const dirs = samplePaths.map(getTopDir);
    const uniq = [...new Set(dirs)];
    if (uniq.length === 1 && uniq[0] !== '(root)') {
        const dirToken = escapeRegex(uniq[0].replace(/\/$/, ''));
        return new RegExp(`/${dirToken}/.*${extRe}`, 'i');
    }
    return new RegExp(extRe, 'i');
}

function mineLlmRules(verdicts) {
    const ceremonyByGroup = new Map();
    const realByGroup = new Map();

    for (const v of verdicts) {
        const ext = getExt(v.path);
        const dir = getTopDir(v.path);
        const isAi = AI_WORKFLOW_RE.test(v.path);
        const isProj = PROJECT_SETUP_RE.test(v.path);
        const groupKey = isAi ? `${v.repo}|ai-workflow`
            : isProj ? `${v.repo}|project-setup`
            : `${v.repo}|${ext || 'noext'}|${dir}`;

        const target = v.llmVerdict === 'ceremony' ? ceremonyByGroup : realByGroup;
        const entry = target.get(groupKey) || {
            repo: v.repo, ext, dir, isAi, isProj,
            count: 0,
            distinctShas: new Set(),
            samples: [],
            samplePaths: new Set(),
            sampleReasons: [],
        };
        entry.count++;
        entry.distinctShas.add(v.sha);
        entry.samplePaths.add(v.path);
        if (entry.samples.length < 5) entry.samples.push(v);
        if (entry.sampleReasons.length < 3 && v.llmReason) entry.sampleReasons.push(v.llmReason);
        target.set(groupKey, entry);
    }

    const filterAndShape = (map, kind) => [...map.values()]
        .filter(g => g.count >= RULE_MIN_OCCURRENCES && g.distinctShas.size >= RULE_MIN_DISTINCT_COMMITS)
        .map(g => ({
            kind,
            repo: g.repo,
            count: g.count,
            distinctCommits: g.distinctShas.size,
            ext: g.ext,
            dir: g.dir,
            isAi: g.isAi,
            isProj: g.isProj,
            pattern: derivePattern([...g.samplePaths], g.ext),
            samplePaths: [...g.samplePaths].slice(0, 5),
            sampleReasons: g.sampleReasons,
            sampleSha: g.samples[0]?.sha,
        }))
        .sort((a, b) => b.count - a.count);

    return {
        ceremonyCandidates: filterAndShape(ceremonyByGroup, 'ceremony'),
        realCandidates: filterAndShape(realByGroup, 'real'),
    };
}

// ---------------------------------------------------------------------------
// Output: report
// ---------------------------------------------------------------------------

function renderReport({ window, runDate, repos, errorList, runtimeMs, llm }) {
    const lines = [];
    lines.push(`# Commit Classification Audit — ${runDate}`);
    lines.push('');
    lines.push(`**Window:** ${window.from} → ${window.to} (${window.days} days)`);
    lines.push(`**Runtime:** ${(runtimeMs / 1000).toFixed(1)}s`);
    lines.push(`**Repos audited:** ${Object.keys(repos).join(', ')}`);
    lines.push(`**Per-commit errors:** ${errorList.length}`);
    if (llm) {
        lines.push(`**LLM-verify:** enabled — ${llm.verdicts.length} files verified, ${llm.batchErrors.length} batch errors`);
    }
    lines.push('');

    for (const [repoName, r] of Object.entries(repos)) {
        lines.push(`## ${repoName}`);
        lines.push('');
        lines.push(`- Commits: **${r.commitCount}** (errors: ${r.errorCount})`);
        lines.push(`- File-count per commit: p50=${r.fileCountDistribution.p50}, p95=${r.fileCountDistribution.p95}, p99=${r.fileCountDistribution.p99}, max=${r.fileCountDistribution.max}`);
        lines.push(`- Est. diff size (bytes): p50=${r.diffSizeDistribution.p50}, p95=${r.diffSizeDistribution.p95}, p99=${r.diffSizeDistribution.p99}, max=${r.diffSizeDistribution.max}`);
        if (typeof r.inconclusiveTotal === 'number') {
            lines.push(`- Inconclusive (rule-based undecided): ${r.inconclusiveTotal}`);
        }
        lines.push('');

        lines.push('### Top extensions');
        lines.push('| ext | count |');
        lines.push('|---|---:|');
        for (const [k, v] of r.topExtensions) lines.push(`| ${k || '(none)'} | ${v} |`);
        lines.push('');

        lines.push('### Top top-level directories');
        lines.push('| dir | count |');
        lines.push('|---|---:|');
        for (const [k, v] of r.topDirs) lines.push(`| ${k} | ${v} |`);
        lines.push('');

        if (r.falseNegativeTotal) {
            lines.push(`### Suspected false negatives (sent to LLM but look like ceremony) — ${r.falseNegativeTotal} total, showing ${r.falseNegatives.length}`);
            lines.push('| sha | path | signals |');
            lines.push('|---|---|---|');
            for (const fn of r.falseNegatives) {
                lines.push(`| [${fn.sha}](${fn.url}) | \`${fn.path}\` | ${fn.signals.join(', ')} |`);
            }
            lines.push('');
        }

        if (r.falsePositiveTotal) {
            lines.push(`### Suspected false positives (auto-skipped but contain real changes) — ${r.falsePositiveTotal} total, showing ${r.falsePositives.length}`);
            lines.push('| sha | path | bucket | signals |');
            lines.push('|---|---|---|---|');
            for (const fp of r.falsePositives) {
                lines.push(`| [${fp.sha}](${fp.url}) | \`${fp.path}\` | ${fp.currentBucket} | ${fp.signals.join(', ')} |`);
            }
            lines.push('');
        }

        if (r.megaCommits.length) {
            lines.push('### Mega-commits (>200 files)');
            lines.push('| sha | files | dominant dirs |');
            lines.push('|---|---:|---|');
            for (const m of r.megaCommits) {
                lines.push(`| [${m.sha}](${m.url}) | ${m.fileCount} | ${m.dominantDirs.join(', ')} |`);
            }
            lines.push('');
        }

        if (r.newPatternCandidates.length) {
            lines.push('### New pattern candidates');
            lines.push('| key | occurrences | sample paths |');
            lines.push('|---|---:|---|');
            for (const c of r.newPatternCandidates) {
                lines.push(`| \`${c.key}\` | ${c.occurrences} | ${c.samplePaths.map(p => `\`${p}\``).join('<br>')} |`);
            }
            lines.push('');
        }
    }

    lines.push('## Suggested rule additions');
    lines.push('');
    lines.push('Paste these into the matching arrays in `src/services/diff-filter.js`. See `proposed-diff-filter.patch` for a ready-to-apply unified diff.');
    lines.push('');
    lines.push('```js');
    lines.push('// AUTO_SUMMARY_PATTERNS additions (universal)');
    lines.push("{ pattern: /\\.skill\\.md$/i, reason: 'AI skill definition (no behavior change)' },");
    lines.push("{ pattern: /\\.prompt\\.md$/i, reason: 'AI prompt definition' },");
    lines.push("{ pattern: /\\.agent\\.md$/i, reason: 'AI agent definition' },");
    lines.push("{ pattern: /CLAUDE\\.md$/i, reason: 'Claude Code project instructions' },");
    lines.push("{ pattern: /\\.cursorrules$/i, reason: 'Cursor AI rules' },");
    lines.push("{ pattern: /\\.github\\/copilot/i, reason: 'GitHub Copilot config' },");
    lines.push("{ pattern: /global\\.json$/i, reason: '.NET SDK pin' },");
    lines.push("{ pattern: /\\.editorconfig$/i, reason: 'editor config' },");
    lines.push("{ pattern: /nuget\\.config$/i, reason: 'NuGet feed config' },");
    lines.push('```');
    lines.push('');

    if (llm) {
        const ceremonyCount = llm.verdicts.filter(v => v.llmVerdict === 'ceremony').length;
        const realCount = llm.verdicts.filter(v => v.llmVerdict === 'real').length;
        lines.push('## LLM-verified inconclusive');
        lines.push('');
        lines.push(`Sent **${llm.verdicts.length}** files to gpt-5.4-mini after rule-based classification was undecided. ` +
            `Verdicts: **${ceremonyCount} ceremony**, **${realCount} real**. ` +
            `Batch errors: ${llm.batchErrors.length}.`);
        lines.push('');

        if (llm.mined.ceremonyCandidates.length) {
            lines.push('### Mined ceremony patterns (≥3 occurrences across ≥2 commits)');
            lines.push('Auto-applied to `proposed-diff-filter.patch` under the `LLM-mined` delimiter.');
            lines.push('');
            lines.push('| pattern | repo | count | commits | sample reason |');
            lines.push('|---|---|---:|---:|---|');
            for (const c of llm.mined.ceremonyCandidates.slice(0, 25)) {
                const pat = c.pattern ? `\`${c.pattern.toString()}\`` : `_(no safe pattern derived)_`;
                const reason = (c.sampleReasons[0] || '').replace(/\|/g, '\\|');
                lines.push(`| ${pat} | ${c.repo} | ${c.count} | ${c.distinctCommits} | ${reason} |`);
            }
            lines.push('');
        } else {
            lines.push('### Mined ceremony patterns');
            lines.push('_None met the ≥3 occurrences / ≥2 distinct commits threshold._');
            lines.push('');
        }

        if (llm.mined.realCandidates.length) {
            lines.push('### Currently auto-skipped but LLM flagged as real (rules to narrow)');
            lines.push('These suggest existing `autoSummary`/`ignored` rules are too broad. **Review manually** — not auto-patched.');
            lines.push('');
            lines.push('| repo | ext / dir | count | commits | sample reason |');
            lines.push('|---|---|---:|---:|---|');
            for (const c of llm.mined.realCandidates.slice(0, 25)) {
                const where = c.isAi ? 'ai-workflow path' : c.isProj ? 'project-setup path' : `${c.ext || '(no ext)'} in ${c.dir}`;
                const reason = (c.sampleReasons[0] || '').replace(/\|/g, '\\|');
                lines.push(`| ${c.repo} | ${where} | ${c.count} | ${c.distinctCommits} | ${reason} |`);
            }
            lines.push('');
        }

        if (llm.verdicts.length) {
            const sampleReal = llm.verdicts.filter(v => v.llmVerdict === 'real').slice(0, 10);
            const sampleCer = llm.verdicts.filter(v => v.llmVerdict === 'ceremony').slice(0, 10);
            if (sampleReal.length) {
                lines.push('### Sample LLM verdicts: "real"');
                lines.push('| repo | sha | path | reason |');
                lines.push('|---|---|---|---|');
                for (const v of sampleReal) {
                    lines.push(`| ${v.repo} | [${v.sha}](${v.url}) | \`${v.path}\` | ${v.llmReason.replace(/\|/g, '\\|')} |`);
                }
                lines.push('');
            }
            if (sampleCer.length) {
                lines.push('### Sample LLM verdicts: "ceremony"');
                lines.push('| repo | sha | path | reason |');
                lines.push('|---|---|---|---|');
                for (const v of sampleCer) {
                    lines.push(`| ${v.repo} | [${v.sha}](${v.url}) | \`${v.path}\` | ${v.llmReason.replace(/\|/g, '\\|')} |`);
                }
                lines.push('');
            }
        }
    }

    lines.push('## Suggested prompt additions');
    lines.push('');
    lines.push('See `proposed-prompt.md` for the full bullet list to splice into `COMMIT_SUMMARY_PROMPT`.');
    lines.push('');

    lines.push('## Limit recommendation');
    lines.push('');
    lines.push('| Setting | Current | Observed p95 | Observed p99 | Suggestion |');
    lines.push('|---|---:|---:|---:|---|');
    const allFileCounts = Object.values(repos).flatMap(r => [r.fileCountDistribution.p95, r.fileCountDistribution.p99]);
    const allDiffSizes = Object.values(repos).flatMap(r => [r.diffSizeDistribution.p95, r.diffSizeDistribution.p99]);
    const fcP95 = Math.max(0, ...allFileCounts.filter((_, i) => i % 2 === 0));
    const fcP99 = Math.max(0, ...allFileCounts.filter((_, i) => i % 2 === 1));
    const dsP95 = Math.max(0, ...allDiffSizes.filter((_, i) => i % 2 === 0));
    const dsP99 = Math.max(0, ...allDiffSizes.filter((_, i) => i % 2 === 1));
    const fcSugg = fcP95 <= MAX_FILES_FOR_DIFF * 0.6 ? 'Hold (room to spare)'
        : fcP95 > MAX_FILES_FOR_DIFF ? `Raise to ${Math.ceil(fcP95 * 1.2)}` : 'Hold';
    const dsSugg = dsP95 <= MAX_DIFF_SIZE * 0.6 ? 'Hold (room to spare)'
        : dsP95 > MAX_DIFF_SIZE ? `Raise to ${Math.ceil(dsP95 * 1.2)}` : 'Hold';
    lines.push(`| MAX_FILES_FOR_DIFF | ${MAX_FILES_FOR_DIFF} | ${fcP95} | ${fcP99} | ${fcSugg} |`);
    lines.push(`| MAX_DIFF_SIZE | ${MAX_DIFF_SIZE} | ${dsP95} | ${dsP99} | ${dsSugg} |`);
    lines.push('');

    if (errorList.length) {
        lines.push('## Errors');
        lines.push('| repo | sha | message |');
        lines.push('|---|---|---|');
        for (const e of errorList.slice(0, 50)) {
            lines.push(`| ${e.repo} | ${e.sha} | ${e.msg.slice(0, 120)} |`);
        }
    }

    return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Output: prompt deltas
// ---------------------------------------------------------------------------

function renderPromptDeltas() {
    return `# Proposed Prompt Deltas

Splice these bullets into \`COMMIT_SUMMARY_PROMPT\` in \`src/services/commit-summarizer.js\`.

## Add to "WHAT IS NOT A CONFIG CHANGE" section

- AI skill / prompt / agent definitions (\`.skill.md\`, \`.prompt.md\`, \`.agent.md\`, \`CLAUDE.md\`, \`.cursorrules\`, \`.github/copilot/*\`). These are developer tooling that influences IDE/agent behavior, not production behavior. Use changeType "code" and risk LOW.
- .NET / build pinning files (\`global.json\`, \`Directory.Packages.props\`, \`.editorconfig\`, \`nuget.config\`) when only version values changed. Use changeType "code" and risk LOW.

## Strengthen "feature area" identification

- When the commit touches an \`agent/\`, \`/skills/\`, or \`/.cursor/\` directory, the affectedArea is "developer tooling" — not a user-facing feature. Mark such commits LOW unless they also touch shipping code.
- For commits that mix AI-tooling files with real code, exclude the tooling files from \`affectedAreas\`; report only the user-facing surface.

## Configs that MUST keep LLM attention (do not auto-skip even if path looks innocuous)

- Any file matching \`isConfigFile()\`: \`Dynamic.config\`, \`*Dynamic.config\`, \`sharedfeatures.config\`, \`appsettings*.json\`, \`*.cscfg\`, \`*.csdef\`, \`Web.config\` (AdsAppUI), \`AllowedFeature.cs\`, \`PermissionProvider*.cs\`.
- A file in \`autoSummary\` whose diff contains \`<Pilot\`, \`FeatureFlag\`, \`IsEnabled\`, \`<Setting name=\`, \`/Configuration/\`, or XPath fragments → escalate to "config" changeType regardless of extension.

## Large-commit handling

- If \`Files changed: N total\` with N > 200, emphasize the dominant directory in the title (e.g., "Bulk rename across \`Datamart/\`") and note "auto-summarized due to size" in the summary so the DRI knows the LLM didn't see per-file diffs.
`;
}

// ---------------------------------------------------------------------------
// Output: patch
// ---------------------------------------------------------------------------

function buildHunk({ filePath, anchorLine, anchorText, insertions, oldLineCount = 1 }) {
    const newLines = insertions.length;
    const header = `@@ -${anchorLine},${oldLineCount} +${anchorLine},${oldLineCount + newLines} @@`;
    const body = [
        ` ${anchorText}`,
        ...insertions.map(l => `+${l}`),
    ].join('\n');
    return `${header}\n${body}`;
}

async function buildPatch(minedCeremonyRules = [], runDate = '') {
    const src = await readFile(DIFF_FILTER_PATH, 'utf8');
    const lines = src.split('\n');

    const findClose = (startToken) => {
        const startIdx = lines.findIndex(l => l.includes(startToken));
        if (startIdx < 0) return -1;
        for (let i = startIdx + 1; i < lines.length; i++) {
            if (lines[i].trim() === '];') return i;
        }
        return -1;
    };

    const autoSummaryCloseIdx = findClose('const AUTO_SUMMARY_PATTERNS = [');
    if (autoSummaryCloseIdx < 0) {
        return '# could not locate AUTO_SUMMARY_PATTERNS closing bracket — patch generation skipped\n';
    }

    const additions = [
        "    // --- audit-classification.js suggestions: AI / developer tooling ---",
        "    { pattern: /\\.skill\\.md$/i, reason: 'AI skill definition (no behavior change)' },",
        "    { pattern: /\\.prompt\\.md$/i, reason: 'AI prompt definition' },",
        "    { pattern: /\\.agent\\.md$/i, reason: 'AI agent definition' },",
        "    { pattern: /CLAUDE\\.md$/i, reason: 'Claude Code project instructions' },",
        "    { pattern: /\\.cursorrules$/i, reason: 'Cursor AI rules' },",
        "    { pattern: /\\.github\\/copilot/i, reason: 'GitHub Copilot config' },",
        "    // --- audit-classification.js suggestions: project setup ---",
        "    { pattern: /global\\.json$/i, reason: '.NET SDK pin' },",
        "    { pattern: /\\.editorconfig$/i, reason: 'editor config' },",
        "    { pattern: /nuget\\.config$/i, reason: 'NuGet feed config' },",
    ];

    if (minedCeremonyRules.length) {
        additions.push(`    // --- LLM-mined suggestions (--llm-verify run on ${runDate}) ---`);
        const seenPatterns = new Set();
        for (const c of minedCeremonyRules) {
            if (!c.pattern) continue;
            const patStr = c.pattern.toString();
            if (seenPatterns.has(patStr)) continue;
            seenPatterns.add(patStr);
            const reason = (c.sampleReasons[0] || `LLM-flagged ceremony in ${c.repo}`)
                .replace(/'/g, "\\'").slice(0, 100);
            additions.push(`    { pattern: ${patStr}, reason: '${reason} [${c.repo}, ${c.count} files, ${c.distinctCommits} commits]' },`);
        }
    }

    // Anchor: the line BEFORE `];`. Emit context line, insertions, then `];`.
    const anchorIdx = autoSummaryCloseIdx - 1;
    const anchorLineNum = anchorIdx + 1;
    const anchorText = lines[anchorIdx];
    const closeText = lines[autoSummaryCloseIdx];

    const header = `@@ -${anchorLineNum},2 +${anchorLineNum},${2 + additions.length} @@`;
    const body = [
        ` ${anchorText}`,
        ...additions.map(l => `+${l}`),
        ` ${closeText}`,
    ].join('\n');

    return [
        '--- a/src/services/diff-filter.js',
        '+++ b/src/services/diff-filter.js',
        header,
        body,
        '',
    ].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const runDate = new Date().toISOString().slice(0, 10);
    const outDir = join(AUDIT_ROOT, runDate);
    await mkdir(outDir, { recursive: true });

    const fromDate = new Date(args.from + 'T00:00:00Z');
    const toDate = new Date(args.to + 'T23:59:59Z');

    const repoNames = args.repo
        ? [args.repo].filter(n => REPOSITORIES[n] || (() => { console.warn(`Unknown repo: ${n}`); return false; })())
        : Object.keys(REPOSITORIES);

    console.log(`audit-classification — window ${args.from} → ${args.to}, repos: ${repoNames.join(', ')}`);

    const t0 = Date.now();
    const repoResults = {};
    const errorList = [];
    const inconclusiveByRepo = new Map();

    for (const repoName of repoNames) {
        const repo = REPOSITORIES[repoName];
        const stats = buildRepoStatsBucket();
        console.log(`\n[${repoName}] fetching commits…`);

        let commits;
        try {
            commits = await fetchCommitsBetweenDates(repo, fromDate, toDate);
        } catch (e) {
            console.error(`[${repoName}] fetchCommitsBetweenDates failed: ${e.message}`);
            errorList.push({ repo: repoName, sha: '-', msg: `commit fetch: ${e.message}` });
            repoResults[repoName] = summarizeRepo(stats);
            continue;
        }
        stats.commitCount = commits.length;
        console.log(`[${repoName}] ${commits.length} commits, sampling…`);

        let progress = 0;
        await pool(commits, COMMIT_POOL, async (commit) => {
            try {
                await auditCommit(repo, commit, stats);
            } catch (e) {
                stats.errorCount++;
                errorList.push({ repo: repoName, sha: commit.shortId, msg: e.message });
            }
            progress++;
            if (progress % 25 === 0) console.log(`  …${progress}/${commits.length}`);
        });

        repoResults[repoName] = summarizeRepo(stats);
        inconclusiveByRepo.set(repoName, stats.inconclusive);
        console.log(`[${repoName}] done — ${stats.falseNegatives.length} FN, ${stats.falsePositives.length} FP, ${stats.megaCommits.length} mega, ${stats.inconclusive.length} inconclusive`);
    }

    let llm = null;
    if (args.llmVerify) {
        const allInconclusive = [];
        for (const [repoName, items] of inconclusiveByRepo.entries()) {
            for (const it of items) allInconclusive.push({ repo: repoName, ...it });
        }
        console.log(`\n[llm-verify] inconclusive total: ${allInconclusive.length}, cap: ${args.llmMaxFiles}`);
        const sampled = stratifiedSampleByRepo(allInconclusive, args.llmMaxFiles);
        if (sampled.length < allInconclusive.length) {
            console.log(`[llm-verify] sampled down to ${sampled.length} (stratified by repo)`);
        }
        if (sampled.length === 0) {
            console.log('[llm-verify] no inconclusive files to verify — skipping LLM phase');
            llm = { verdicts: [], batchErrors: [], mined: { ceremonyCandidates: [], realCandidates: [] } };
        } else {
            const { verdicts, batchErrors } = await verifyInconclusive(sampled, args.llmBatch);
            const mined = mineLlmRules(verdicts);
            console.log(`[llm-verify] done — ${verdicts.length} verdicts, ${mined.ceremonyCandidates.length} ceremony rule candidates, ${mined.realCandidates.length} narrowing candidates`);

            const jsonl = verdicts.map(v => JSON.stringify(v)).join('\n') + (verdicts.length ? '\n' : '');
            await writeFile(join(outDir, 'llm-verdicts.jsonl'), jsonl);

            llm = { verdicts, batchErrors, mined };
        }
    }

    const runtimeMs = Date.now() - t0;
    const window = { from: args.from, to: args.to, days: args.days };

    const auditData = {
        window, runDate, runtimeMs, repos: repoResults, errors: errorList,
        ...(llm ? { llm: { verifiedCount: llm.verdicts.length, batchErrors: llm.batchErrors, mined: llm.mined } } : {}),
    };
    await writeFile(join(outDir, 'audit-data.json'), JSON.stringify(auditData, null, 2));
    await writeFile(join(outDir, 'audit-report.md'), renderReport({ window, runDate, repos: repoResults, errorList, runtimeMs, llm }));
    await writeFile(join(outDir, 'proposed-prompt.md'), renderPromptDeltas());
    await writeFile(join(outDir, 'proposed-diff-filter.patch'), await buildPatch(llm?.mined.ceremonyCandidates ?? [], runDate));

    console.log(`\nDone in ${(runtimeMs / 1000).toFixed(1)}s. Output: ${outDir}`);
}

main().catch(err => { console.error(err); process.exit(1); });
