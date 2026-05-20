/**
 * Commit summarizer — Uses LLM to generate summaries and risk assessments for commits.
 */

import { llmHelper } from './llm-helper.js';
import { fetchCommitDiff, fetchCommitChanges, fetchFileContent, fetchFileContentBatch } from './ado-git-client.js';
import { classifyChanges, buildSkippedFilesSummary, MAX_FILES_FOR_DIFF, MAX_DIFF_SIZE } from './diff-filter.js';
import { createPatch } from 'diff';
import { writeFile, mkdir } from 'fs/promises';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIFFS_DIR = join(process.env.DATA_DIR || join(__dirname, '..', '..', 'data'), 'diffs');
const DOMAIN_DIR = join(__dirname, '..', '..', 'docs', 'domain');

// Cache domain knowledge per repo (loaded once per process)
const domainKnowledgeCache = new Map();

/**
 * Load domain knowledge doc for a repository.
 * @param {string} repoName
 * @returns {string} Domain knowledge text, or empty string if not found
 */
function loadDomainKnowledge(repoName) {
    if (domainKnowledgeCache.has(repoName)) return domainKnowledgeCache.get(repoName);
    try {
        const content = readFileSync(join(DOMAIN_DIR, `${repoName}.md`), 'utf-8');
        domainKnowledgeCache.set(repoName, content);
        return content;
    } catch {
        domainKnowledgeCache.set(repoName, '');
        return '';
    }
}

/** Save the full LLM input for a commit to disk for inspection. */
async function saveLlmInput(repoName, commitId, systemPrompt, userMessage) {
    try {
        const repoDir = join(DIFFS_DIR, repoName);
        await mkdir(repoDir, { recursive: true });
        const content = `=== SYSTEM PROMPT ===\n${systemPrompt}\n\n=== USER MESSAGE ===\n${userMessage}`;
        await writeFile(join(repoDir, `${commitId.substring(0, 8)}.txt`), content);
    } catch { /* non-critical, don't fail summarization */ }
}

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

const COMMIT_SUMMARY_PROMPT = `You are a senior software engineer analyzing code changes in a Microsoft Advertising codebase.
Your job is to summarize each commit's changes for an on-call DRI investigating production incidents.

For each commit diff provided, produce a JSON response with EXACTLY these fields:

{
  "title": "Concise one-line summary, max 80 chars. Be specific about WHAT changed, not just where.",
  "summary": "2-3 sentences max. Focus on behavioral impact: what changed, what it affects, and any risk. Skip obvious context.",
  "riskLevel": "LOW | MEDIUM | HIGH",
  "affectedAreas": ["Max 3-4 areas. Use the most specific component name, not generic paths."],
  "flags": ["Only ACTUAL flag/pilot names found literally in the diff. Never guess or invent flag names."],
  "changeType": "code | config | mixed",
  "configChanges": [{"key": "config key name", "action": "added|modified|removed", "from": "previous value if modified", "to": "new value", "detail": "behavioral impact"}],
  "breakingChange": false
}

FIELD RULES:
- "title": Max 80 chars. Start with a verb. Expand key acronyms. Bad: "Updates to campaign grid component". Good: "Add bulk edit drawer to campaign grid". Bad: "Add PMax support". Good: "Add Performance Max (PMax) Xbox campaign subtype".
- "summary": Max 3 sentences. MUST include: (1) WHAT behavior changed, (2) WHO is affected (advertisers, agencies, internal teams, specific geo users — never omit this), (3) potential failure mode for MEDIUM+ risk. Skip listing files.
- "riskLevel": See criteria below. When in doubt between MEDIUM and LOW, prefer LOW. When in doubt between MEDIUM and HIGH, prefer MEDIUM.
- "affectedAreas": Max 4 items. Use feature names (e.g. "Campaign Grid", "Budget API"), not file paths.
- "flags": ONLY include flag/pilot names that appear LITERALLY as string constants in the diff. If no flags exist, use empty array []. NEVER output "TBD", "unknown", or guessed names.
- "changeType": "config" = ONLY config/pilot/flag files changed. "mixed" = both code + config. "code" = everything else.
- "configChanges": Required when changeType is "config" or "mixed". Each entry: key (the SHORT flag/setting name — e.g., "NewGoogleLoginGSI" not "/Configuration/Flights/FlightSet[@name='NewGoogleLoginGSI']/Flight/@allocation"), action (added|modified|removed), from (old value if modified, omit if added), to (new value, omit if removed), detail (what this change does to production behavior). When multiple XML elements reference the same flag (feature declaration, flight set, ap-config override), emit ONE row with the flag name as key, not separate rows with XPath keys.
- "breakingChange": true if the commit removes public APIs, changes function signatures used by other packages, alters DB schemas, removes feature gates without replacement, or changes shared contracts/interfaces. false otherwise.

RISK LEVEL CRITERIA:
- LOW: Tests only, documentation, comments, localization strings, version bumps, dependency updates, build/CI config, adding new code behind a feature flag (not yet enabled)
- MEDIUM: Business logic in a single feature, new API parameters, UI behavior changes scoped to one page, pilot ramp changes < 50%
- HIGH: Shared utility/infrastructure changes, auth/authz changes, DB schema, pilot ramp ≥ 50% or to 100%, removal of feature gates, error handling in critical paths, breaking contract changes

IMPORTANT:
- Be factual — ONLY describe what you see in the diff
- If the diff is a lock file or auto-generated code, say so briefly and mark LOW
- Do NOT speculate about intent or future plans
- Do NOT invent flag names that don't appear in the code

SUMMARY QUALITY RULES:
- TITLE: Always expand acronyms in the title. Bad: "Add PMax Xbox subtype". Good: "Add Performance Max (PMax) Xbox campaign subtype support".
- WHO: Every MEDIUM+ summary MUST name who is affected: "advertisers", "internal DRI team", "agency users", "India billing users", "Shopping campaign advertisers", etc. Be specific — "users" alone is too vague.
- SCOPE: For config/pilot changes, ALWAYS state rollout scope: "5% rollout in prod", "SI only", "behind EnableFoo flag", "GA'd to 100%". Never leave scope ambiguous.
- FAILURE: For MEDIUM+ risk, include a concrete failure scenario: "could cause the inline budget suggestion table to disappear" not just "could break things".
- ACRONYMS: Always explain domain acronyms on first use in the summary (e.g., "OMS (Order Management System)", "PMax (Performance Max)", "UET (Universal Event Tracking)", "FDP (Fast Data Pipeline)").
- FEATURES: Use user-facing feature names, not file paths or component names. "Campaign Grid budget editing" not "FluentCampaignsPage budget repo".
- FLAGS: Briefly state what each flag gates (e.g., "EnablePMaxGoals — gates PMax goal-based bidding"). If a flag is being removed/GA'd, say "ships to all users".
- BREAKING: Specify what callers or contracts are affected and the blast radius.

CONFIG/PILOT CHANGE EXTRACTION:
- "config" changeType means PRODUCTION FEATURE FLAGS and PILOT SETTINGS that control user-facing behavior. It does NOT mean any YAML/JSON/XML file.
- For config files (DynamicConfig, sharedfeatures.config, appsettings, .cscfg):
  - Extract EVERY feature flag/pilot key that was added, modified, or removed
  - For modified keys: include "from" (old value) and "to" (new value) — e.g., from "0" to "50", from "false" to "true"
  - For pilot/feature ramp changes: state the percentage change and who it affects
  - changeType MUST be "config" or "mixed" for these files
- Config changes that increase rollout (0→50%, false→true, adding new flag) = higher risk
- Config changes that decrease rollout (50%→0%, true→false, removing flag) = note as rollback
- Deployment scripts (PowerShell, bash) that programmatically modify Web.config or other config files at deploy time ALSO count as config changes. If a script updates keys like CampaignResourcesContainer, NewWebUIResourceContainer, etc., include them in configChanges with action "modified" and detail explaining the deployment-time behavior change. Use "set at deploy time" for from/to when values are dynamic.

WHAT IS NOT A CONFIG CHANGE (do NOT use changeType "config" or "mixed" for these):
- Kubernetes/Helm infrastructure: AFD custom domains, ingress rules, replica counts, resource limits, image digests/tags, pod specs, service definitions, Helm chart values. These are INFRASTRUCTURE, not feature flags. Use changeType "code".
- Agent/AI workflow files: project-config.json, pipeline-config.json, instruction.md, skill definitions, agentic workflow prompts. These are DEVELOPER TOOLING, not production config. Use changeType "code".
- AKS packaging artifacts: serviceConfig.ini, build dependencies, package folder layouts, config flattener file lists. These are BUILD/DEPLOY scaffolding, not feature flags. Use changeType "code".
- Dependabot or automated dependency bumps (image digests, package versions). Use changeType "code".

TEST FILE HANDLING (audit-derived, 2026-05-15):
- Files matching /test/, /tests/, /jest/, /selenium/, /cloud-test/, .test.{js,ts,jsx,tsx}, .spec.{js,ts}, *-tests.{js,ts}, *-test-* are TEST CODE.
- For commits where the ONLY changed files are tests: riskLevel "LOW" unless the test reveals a behavior change in shared/production code. Lead the summary with "Test coverage for X" or "Adds E2E suite for Y" — do NOT describe test code as if it were production logic.
- In affectedAreas, name the production area being tested ("Campaign Grid", not "campaign-grid-tests.js"). Never put the test framework or filename in affectedAreas.
- For mixed test+production commits: focus the summary on the production change. Mention tests only if they materially expand coverage of a risky area (auth, billing, pilot-gated paths).
- Test mocks, fixtures, and selenium page objects are still test code — same rules apply.

BUILD SCRIPT HANDLING:
- gulpfile.js, .buildxl.pipeline.config.js, build-and-deploy.{ps1,sh}, build.cake, and similar build orchestration files affect WHAT gets built and tested, but not the runtime product. Use changeType "code", riskLevel typically LOW.
- Risk MEDIUM only if the change enables/disables major test suites in CI, alters deploy targets/environments, or removes packages from the build pipeline.
- ALWAYS state in the summary which packages/areas the build change scopes — e.g., "excludes adsappsbae from BuildXL pipeline" not just "updates pipeline config".

PACKAGE.JSON CHANGES:
- A package.json with ONLY "version", "dependencies", "devDependencies", or "peerDependencies" changes is a dependency bump. Use riskLevel LOW, summary "Bumps <pkg> from X.Y.Z to A.B.C in <package-name>". Do not invent feature impact.
- A package.json with changes to "scripts", "main", "exports", or "files" is a real packaging/runtime change — keep risk MEDIUM and describe the consumer impact (which scripts run differently, which exports moved).

DESIGN-DOC FILES (.design-docs/, knowledge-docs/, knowledge.md):
- These are planning/reference artifacts. Use changeType "code", riskLevel LOW.
- Title prefix: "Design doc:" or "Plan:" — never describe them as feature work or imply the documented feature has shipped.
- Do NOT include the documented feature in affectedAreas unless production code in the same commit also touches it.

CONFIG KEY NAMING:
- Use the SHORT flag/setting name, not XPath or XML path. Example: use "NewGoogleLoginGSI" not "/Configuration/Features/NewGoogleLoginGSI/@value" or "FlightSet[@name='NewGoogleLoginGSI']".
- When a commit adds or removes a feature flag that has multiple XML elements (feature declaration + flight set + ap-config override), emit ONE configChange row with the flag name as key, not separate rows per XML element.
- For sharedfeatures.config: the key is the Feature name attribute (e.g., "NewGoogleLoginGSI", "AdsCopilotProtocolMigration").
- For Dynamic.config: the key is the setting name attribute.
- For .cscfg: the key is the Setting name attribute.

REPO-SPECIFIC CONFIG DETECTION RULES:
- AdsAppUI: Config/pilot files are .cscfg, .csdef, Web.config, appsettings*.json, sharedfeatures.config, AllowedFeature.cs, PermissionProvider.cs, IPermissionProvider.cs. These control pilot flags and feature rollout for the UI. NOT config: serviceConfig.ini, build packaging scripts, AKS deployment artifacts.
- AdsAppsMT: Config/pilot files are ONLY Dynamic.config, *Dynamic.config, DynamicConfigValues.cs. These control backend feature flags. NOT config: helm-*.yaml, values.yaml, Kubernetes manifests, Dockerfiles, agent/*.json, agent/*.md — these are infrastructure/tooling, not feature flags. Use changeType "code" for Helm/k8s/agent changes.
- AdsAppsCampaignUI: Do NOT classify changes as "config" or "mixed" changeType. This repo does NOT contain pilot/config controls — pilots are managed in AdsAppUI server-side. Always use changeType "code" for this repo.
- AnB: Config/pilot files are appsettings*.json, Web.config, *.cscfg. NOT config: build scripts, pipeline YAML. Use changeType "code" for build/deploy changes.
- AdsAppsDB: Do NOT classify changes as "config" or "mixed" changeType. This is a database repo — stored procedures, migrations, and schema changes are all "code". Always use changeType "code" for this repo.

ENVIRONMENT-SPECIFIC CONFIG EXTRACTION:
- When .cscfg filenames contain environment info (e.g., "ServiceConfiguration.EastUS.SI.cscfg", "ServiceConfiguration.WestUS.Prod.cscfg"), include the environment in each configChange's "detail" field — e.g., "Enabled in EastUS SI environment".
- When multiple environments are changed for the same key, emit one configChange row PER environment (not one combined row).
- For Dynamic.config XML files: these may be minified on a single line. Look for XML attribute changes like enabled="true/false", value="...", rollout="...". Extract the full key name and per-environment overrides.
- Common environment naming: SI = System Integration (staging), Prod = Production. Filename patterns: EastUS.SI, WestUS.Prod, EastUS2.Prod, NorthEurope.SI, etc.

Respond with valid JSON only, no markdown fencing.`;

/**
 * Summarize a single commit using LLM, with diff filtering.
 *
 * 1. Fetch changed files list first (cheap API call)
 * 2. Classify files: needsDiff / autoSummary / ignored
 * 3. If all files are auto/ignored, produce summary without LLM
 * 4. Otherwise fetch diffs only for files that need it, send to LLM
 *
 * @param {object} repoConfig - Repository config
 * @param {object} commit - Formatted commit object from fetchLatestCommits
 * @returns {Promise<object>} Commit with LLM summary attached
 */
async function summarizeCommit(repoConfig, commit) {
    const t0 = Date.now();
    try {
        // Step 1: Get changed files list (cheap)
        const t1 = Date.now();
        const { changes } = await fetchCommitChanges(repoConfig, commit.commitId);
        const changesMs = Date.now() - t1;

        // Step 2: Classify
        const { needsDiff, autoSummary, ignored } = classifyChanges(changes, repoConfig.name);
        const skippedNote = buildSkippedFilesSummary(autoSummary, ignored);

        // Step 3: If nothing needs LLM, auto-summarize
        if (needsDiff.length === 0) {
            const reasons = [...new Set(autoSummary.map(f => f.reason))];
            // Use commit message for context instead of generic "lock file update (2 files)"
            const commitMsg = commit.message.replace(/^Merged PR \d+:\s*/i, '').trim();
            const autoTitle = commitMsg.length > 10 && commitMsg.length <= 80
                ? commitMsg
                : `${reasons.join(', ')} (${autoSummary.length + ignored.length} files)`;
            const filePaths = autoSummary.map(f => f.path).slice(0, 5).join(', ');
            return {
                ...commit,
                llmSummary: {
                    title: autoTitle,
                    summary: `Auto-classified: ${reasons.join(', ')}. ${autoSummary.length} file(s) updated: ${filePaths}${autoSummary.length > 5 ? '...' : ''}.`,
                    riskLevel: 'LOW',
                    affectedAreas: reasons.length <= 3 ? reasons : reasons.slice(0, 3),
                    flags: [],
                    changeType: repoConfig.name === 'AdsAppsCampaignUI' ? 'code'
                        : reasons.some(r => r.includes('config')) ? 'config' : 'code',
                    configChanges: [],
                    breakingChange: false,
                    _autoClassified: true,
                },
            };
        }

        // Step 4: If too many files, send just file names, not diffs
        let diffText;
        if (needsDiff.length > MAX_FILES_FOR_DIFF) {
            diffText = [
                `Commit touches ${changes.length} files (${needsDiff.length} code files, ${autoSummary.length} auto-skipped, ${ignored.length} ignored).`,
                'File list (diffs omitted due to size):',
                ...needsDiff.map(f => `  ${f.changeType}: ${f.path}`),
            ].join('\n');
        } else {
            // Fetch diffs only for files that need it
            const tDiff = Date.now();
            const diffs = await fetchFilteredDiffs(repoConfig, commit.commitId, needsDiff);
            const diffMs = Date.now() - tDiff;
            if (diffMs > 5000) {
                console.warn(`      ⏱ ${commit.shortId} diff fetch (${(diffMs/1000).toFixed(1)}s) ${needsDiff.length} files`);
            }
            diffText = diffs.join('\n---\n');
        }

        // Append skipped files note
        if (skippedNote) {
            diffText += `\n\n--- SKIPPED FILES ---\n${skippedNote}`;
        }

        // Truncate
        if (diffText.length > MAX_DIFF_SIZE) {
            diffText = diffText.substring(0, MAX_DIFF_SIZE) + '\n... (diff truncated)';
        }

        const userMessage = [
            `Repository: ${repoConfig.name}`,
            `Commit: ${commit.commitId}`,
            `Author: ${commit.author} <${commit.authorEmail}>`,
            `Date: ${commit.date}`,
            `Message: ${commit.message}`,
            `Files changed: ${changes.length} total (${needsDiff.length} analyzed, ${autoSummary.length} auto-skipped, ${ignored.length} ignored)`,
            '',
            '--- DIFF START ---',
            diffText,
            '--- DIFF END ---',
        ].join('\n');

        // Save LLM input for inspection
        const domainContext = loadDomainKnowledge(repoConfig.name);
        const systemPrompt = domainContext
            ? `${COMMIT_SUMMARY_PROMPT}\n\nDOMAIN KNOWLEDGE FOR ${repoConfig.name}:\n${domainContext}`
            : COMMIT_SUMMARY_PROMPT;
        await saveLlmInput(repoConfig.name, commit.commitId, systemPrompt, userMessage);

        const tLlm = Date.now();
        const response = await llmHelper(systemPrompt, [
            { role: 'user', content: userMessage },
        ]);
        const llmMs = Date.now() - tLlm;
        const totalMs = Date.now() - t0;
        if (totalMs > 15000) {
            console.warn(`      ⏱ ${commit.shortId} total=${(totalMs/1000).toFixed(1)}s changes=${changesMs}ms diff=${diffText.length > 0 ? (tLlm - t0 - changesMs) + 'ms' : 'skip'} llm=${(llmMs/1000).toFixed(1)}s`);
        }

        let summary;
        try {
            summary = JSON.parse(response);
        } catch {
            summary = {
                title: commit.title,
                summary: response,
                riskLevel: 'MEDIUM',
                affectedAreas: [],
                flags: [],
                changeType: 'code',
                configChanges: [],
                breakingChange: false,
            };
        }

        return { ...commit, llmSummary: summary };
    } catch (err) {
        return {
            ...commit,
            llmSummary: {
                title: commit.title,
                summary: `Error generating summary: ${err.message}`,
                riskLevel: 'MEDIUM',
                affectedAreas: [],
                flags: [],
                changeType: 'code',
                configChanges: [],
                breakingChange: false,
                _error: true,
            },
        };
    }
}

/** XML config file patterns that may be minified. */
const XML_CONFIG_PATTERNS = [
    /Web\.config$/i,
    /\.cscfg$/i,
    /\.csdef$/i,
    /Dynamic\.config$/i,
    /sharedfeatures\.config$/i,
    /\.config$/i,
];

/**
 * If a file is minified XML (any line > 10KB), split on "><" to get
 * one element per line so the diff is granular for LLM extraction.
 */
function prettifyMinifiedXml(content, path) {
    if (!content) return content;
    if (!XML_CONFIG_PATTERNS.some(p => p.test(path))) return content;
    // Check if any single line exceeds 10KB — indicates minified XML
    const lines = content.split('\n');
    const hasLongLine = lines.some(l => l.length > 10000);
    if (!hasLongLine) return content;
    // Split on >< and > < boundaries, preserving the brackets
    return content.replace(/>\s*</g, '>\n<');
}

/** Patterns for config/pilot files that should be prioritized in diff ordering. */
const CONFIG_FILE_PATTERNS = [
    /\.cscfg$/i,
    /\.csdef$/i,
    /Web\.config$/i,
    /Dynamic\.config$/i,
    /DynamicConfigValues\.cs$/i,
    /appsettings.*\.json$/i,
    /sharedfeatures\.config$/i,
    /AllowedFeature\.cs$/i,
    /PermissionProvider\.cs$/i,
    /IPermissionProvider\.cs$/i,
    // NOTE: helm-*.yaml and values.yaml are NOT config files — they are k8s infrastructure
];

function isConfigFile(path) {
    return CONFIG_FILE_PATTERNS.some(p => p.test(path));
}

/**
 * Fetch diffs only for specific files (not the full commit).
 * Uses batch API to fetch all file contents in 2 calls instead of 2N.
 * Config/pilot files are prioritized first in the diff ordering so they
 * survive truncation at MAX_DIFF_SIZE.
 */
async function fetchFilteredDiffs(repoConfig, commitId, filteredChanges) {
    // Sort config/pilot files first so they survive MAX_DIFF_SIZE truncation
    filteredChanges = [...filteredChanges].sort((a, b) => {
        const aConfig = isConfigFile(a.path) ? 0 : 1;
        const bConfig = isConfigFile(b.path) ? 0 : 1;
        return aConfig - bConfig;
    });

    // We need the parent to produce diffs
    const { fetchCommitById } = await import('./ado-git-client.js');
    const commitInfo = await fetchCommitById(repoConfig, commitId);
    const parentCommitId = commitInfo.parents?.[0];

    // Collect paths needed for current and parent versions
    const currentPaths = filteredChanges
        .filter(c => c.changeType !== 'delete')
        .map(c => c.path);
    const parentPaths = parentCommitId
        ? filteredChanges.filter(c => c.changeType !== 'add').map(c => c.path)
        : [];

    // Batch fetch: 2 API calls instead of 2N individual calls
    const [currentContents, parentContents] = await Promise.all([
        currentPaths.length > 0
            ? fetchFileContentBatch(repoConfig, currentPaths, commitId)
            : new Map(),
        parentPaths.length > 0
            ? fetchFileContentBatch(repoConfig, parentPaths, parentCommitId)
            : new Map(),
    ]);

    // Build diffs from fetched contents
    const diffs = filteredChanges.map(change => {
        let currentContent = currentContents.get(change.path) ?? null;
        let parentContent = parentContents.get(change.path) ?? null;

        // Prettify minified XML config files for better diff granularity
        currentContent = prettifyMinifiedXml(currentContent, change.path);
        parentContent = prettifyMinifiedXml(parentContent, change.path);

        if (change.changeType === 'edit' && parentContent && currentContent) {
            const patch = createPatch(change.path, parentContent, currentContent, 'Parent', 'Current');
            return `${change.path} Modified:\n${patch}`;
        } else if (change.changeType === 'add') {
            return `Added: ${change.path}\n${currentContent ?? ''}`;
        } else if (change.changeType === 'delete') {
            return `Deleted: ${change.path}`;
        }
        return `${change.changeType}: ${change.path}`;
    });

    return diffs;
}

/**
 * Summarize an array of commits. Processes in parallel batches for speed.
 *
 * @param {object} repoConfig - Repository config
 * @param {Array} commits - Array of formatted commit objects
 * @param {function} onProgress - Optional callback(index, total, commit) for progress
 * @param {number} concurrency - Max parallel LLM calls (default 25)
 * @returns {Promise<Array>} Commits with llmSummary attached
 */
async function summarizeCommits(repoConfig, commits, onProgress, concurrency = 25) {
    const results = new Array(commits.length);
    let completed = 0;
    const PER_COMMIT_TIMEOUT = 180000; // 3 minutes max per commit

    // Process in batches of `concurrency`
    for (let batchStart = 0; batchStart < commits.length; batchStart += concurrency) {
        const batch = commits.slice(batchStart, batchStart + concurrency);
        const batchPromises = batch.map((commit, idx) => {
            const globalIdx = batchStart + idx;
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Commit ${commit.shortId} timed out after ${PER_COMMIT_TIMEOUT / 1000}s`)), PER_COMMIT_TIMEOUT)
            );
            return Promise.race([summarizeCommit(repoConfig, commit), timeoutPromise])
                .catch(err => ({
                    ...commit,
                    llmSummary: {
                        title: commit.title,
                        summary: `Timed out: ${err.message}`,
                        riskLevel: 'MEDIUM',
                        affectedAreas: [],
                        flags: [],
                        changeType: 'code',
                        configChanges: [],
                        breakingChange: false,
                        _error: true,
                    },
                }))
                .then(result => {
                    completed++;
                    if (onProgress) onProgress(completed, commits.length, commit);
                    results[globalIdx] = result;
                });
        });
        await Promise.all(batchPromises);
    }

    return results;
}

export { summarizeCommit, summarizeCommits, fetchFilteredDiffs, COMMIT_SUMMARY_PROMPT, isConfigFile, prettifyMinifiedXml, CONFIG_FILE_PATTERNS };
