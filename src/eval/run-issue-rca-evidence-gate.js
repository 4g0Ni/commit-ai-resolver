#!/usr/bin/env node

/**
 * Run the Issue RCA v2 retrieval gate in shadow mode over an LTR report.
 *
 * The 461-case pilot contains grounded positive relationships but no adequate
 * OOD/ambiguous negative set for causal-gate calibration. This runner therefore
 * measures routing behavior and score overlap only. It never converts gold
 * labels into synthetic causal-verification input.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
    deriveIssueRcaWindow,
    evaluateIssueRcaEvidence,
    ISSUE_RCA_EVIDENCE_POLICY,
} from '../services/issue-rca-evidence-gate.js';
import {
    ISSUE_RCA_RELATIONSHIP_POLICY,
    verifyIssueRcaClosingPrRelationship,
} from '../services/issue-rca-relationship-verifier.js';

function parseArgs(argv) {
    const args = { verificationDepth: 20, verificationMode: 'none' };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--dataset') args.dataset = argv[++index];
        else if (arg === '--ltr-report') args.ltrReport = argv[++index];
        else if (arg === '--output') args.output = argv[++index];
        else if (arg === '--verification-depth') args.verificationDepth = Number.parseInt(argv[++index], 10);
        else if (arg === '--verification-mode') args.verificationMode = argv[++index];
        else throw new Error(`Unknown argument: ${arg}`);
    }
    for (const required of ['dataset', 'ltrReport', 'output']) {
        if (!args[required]) throw new Error(`Missing --${required.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`)}`);
    }
    if (!Number.isInteger(args.verificationDepth) || args.verificationDepth < 1) {
        throw new Error('--verification-depth must be a positive integer');
    }
    if (!['none', 'closing-pr-provenance'].includes(args.verificationMode)) {
        throw new Error('--verification-mode must be none or closing-pr-provenance');
    }
    return args;
}

async function readJsonl(path) {
    return (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function identity(item) {
    return `${item.repo || ''}:${item.commitId || item.id || ''}`.toLowerCase();
}

function topScore(row) {
    const value = row.ranking[0]?.score;
    return Number.isFinite(Number(value)) ? Number(value) : null;
}

function summarize(rows) {
    const supported = rows.filter(row => row.supportedAtVerificationDepth);
    const unsupported = rows.filter(row => !row.supportedAtVerificationDepth);
    const verifying = rows.filter(row => row.gate.verdict === 'VERIFY');
    const searching = rows.filter(row => row.gate.verdict === 'SEARCH');
    const abstaining = rows.filter(row => row.gate.verdict === 'ABSTAIN');
    return {
        cases: rows.length,
        verdicts: Object.fromEntries(['VERIFY', 'SEARCH', 'ABSTAIN', 'ASK_USER']
            .map(verdict => [verdict, rows.filter(row => row.gate.verdict === verdict).length])),
        supportedAtVerificationDepth: supported.length,
        unsupportedAtVerificationDepth: unsupported.length,
        verifyCoverage: rows.length ? verifying.length / rows.length : null,
        supportedVerifyRecall: supported.length
            ? supported.filter(row => row.gate.verdict === 'VERIFY').length / supported.length
            : null,
        unsupportedVerifyRate: unsupported.length
            ? unsupported.filter(row => row.gate.verdict === 'VERIFY').length / unsupported.length
            : null,
        verifyPrecisionProxy: verifying.length
            ? verifying.filter(row => row.supportedAtVerificationDepth).length / verifying.length
            : null,
        supportedSearchRecall: supported.length
            ? supported.filter(row => row.gate.verdict === 'SEARCH').length / supported.length
            : null,
        unsupportedAbstainRate: unsupported.length
            ? unsupported.filter(row => row.gate.verdict === 'ABSTAIN').length / unsupported.length
            : null,
        behaviorAccuracyProxy: rows.length
            ? rows.filter(row => row.supportedAtVerificationDepth
                ? row.gate.verdict === 'SEARCH'
                : row.gate.verdict === 'ABSTAIN').length / rows.length
            : null,
        unsafeSearchBeforeCausalVerification: rows.filter(row => row.retrievalGate.verdict === 'SEARCH').length,
        finalSearches: searching.length,
        finalAbstentions: abstaining.length,
    };
}

function scoreThresholdDiagnostic(rows, thresholds) {
    return thresholds.map(threshold => {
        const supported = rows.filter(row => row.supportedAtVerificationDepth);
        const unsupported = rows.filter(row => !row.supportedAtVerificationDepth);
        const passes = rows.filter(row => (topScore(row) ?? Number.NEGATIVE_INFINITY) >= threshold);
        return {
            threshold,
            supportedRecall: supported.length
                ? supported.filter(row => (topScore(row) ?? Number.NEGATIVE_INFINITY) >= threshold).length / supported.length
                : null,
            unsupportedPassRate: unsupported.length
                ? unsupported.filter(row => (topScore(row) ?? Number.NEGATIVE_INFINITY) >= threshold).length / unsupported.length
                : null,
            precisionProxy: passes.length
                ? passes.filter(row => row.supportedAtVerificationDepth).length / passes.length
                : null,
            passedCases: passes.length,
        };
    });
}

function markdown(summary) {
    const percent = value => value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
    const lines = [
        '# Issue RCA Evidence Gate v2 shadow report',
        '',
        `- Policy: \`${summary.evaluationPolicy}\``,
        `- Gate: \`${summary.gate.version}\``,
        `- Verification depth: Top ${summary.verificationDepth}`,
        `- Verification mode: \`${summary.verificationMode}\``,
        `- Calibration status: \`${summary.calibrationStatus}\`; this run is not release-gate eligible.`,
        '',
        '| Split | Cases | VERIFY | SEARCH | ABSTAIN | Supported@depth | Unsupported@depth | Behavior proxy | Unsafe pre-verification SEARCH |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
        ...Object.entries(summary.bySplit).map(([split, value]) =>
            `| ${split} | ${value.cases} | ${value.verdicts.VERIFY} | ${value.verdicts.SEARCH} | ${value.verdicts.ABSTAIN} | ${value.supportedAtVerificationDepth} | ${value.unsupportedAtVerificationDepth} | ${percent(value.behaviorAccuracyProxy)} | ${value.unsafeSearchBeforeCausalVerification} |`),
        '',
        'A case is supported when its labeled fix is present inside the verification depth. This is only a retrieval-support proxy, not an independent measurement of causal quality.',
        '',
        summary.verificationMode === 'closing-pr-provenance'
            ? 'The relationship verifier uses the same GitHub closing-PR relation from which this pilot was mined. Its behavior proxy is label-circular and proves wiring only; it is not an independent quality result.'
            : 'A high LTR score is not sufficient evidence. The threshold diagnostic records score overlap between supported and unsupported retrieval cases; gold labels are never passed into the gate as verification evidence.',
        '',
    ];
    return `${lines.join('\n')}\n`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const datasetPath = resolve(args.dataset, 'cases.jsonl');
    const reportPath = resolve(args.ltrReport, 'case-results.jsonl');
    const cases = await readJsonl(datasetPath);
    const reports = new Map((await readJsonl(reportPath)).map(row => [row.id, row]));
    const rows = cases.map(evalCase => {
        const report = reports.get(evalCase.id);
        if (!report) throw new Error(`Missing LTR report for ${evalCase.id}`);
        const ranking = report.learnedReranker || [];
        const gold = new Set((evalCase.relevantCommits || []).map(identity));
        const goldRanks = ranking
            .filter(candidate => gold.has(identity(candidate)))
            .map(candidate => Number(candidate.rank));
        const goldRank = goldRanks.length ? Math.min(...goldRanks) : null;
        const issue = evalCase.provenance?.issue || {};
        const retrievalWindow = deriveIssueRcaWindow(issue);
        const retrievalGate = evaluateIssueRcaEvidence({
            query: evalCase.query,
            issue,
            retrievalWindow,
            results: ranking,
        });
        const verification = args.verificationMode === 'closing-pr-provenance'
            ? verifyIssueRcaClosingPrRelationship({
                provenance: evalCase.provenance,
                results: ranking,
                limit: args.verificationDepth,
            })
            : null;
        const gate = verification
            ? evaluateIssueRcaEvidence({
                query: evalCase.query,
                issue,
                retrievalWindow,
                results: ranking,
                verification,
            })
            : retrievalGate;
        return {
            id: evalCase.id,
            split: evalCase.split,
            ranking,
            poolSize: report.poolSize,
            goldRank,
            supportedAtVerificationDepth: goldRank !== null && goldRank <= args.verificationDepth,
            failureType: goldRank === null ? 'candidate-miss' : goldRank > args.verificationDepth ? 'ranking-miss' : null,
            retrievalGate,
            verification,
            gate,
        };
    });

    const thresholds = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.97, 0.975];
    const summary = {
        schemaVersion: 1,
        evaluationPolicy: 'model-prescreened, non-gold, release-gate-ineligible',
        verificationDepth: args.verificationDepth,
        verificationMode: args.verificationMode,
        gate: ISSUE_RCA_EVIDENCE_POLICY,
        relationshipVerifier: ISSUE_RCA_RELATIONSHIP_POLICY,
        calibrationStatus: args.verificationMode === 'closing-pr-provenance'
            ? 'provenance-oracle-diagnostic-not-independent'
            : 'shadow-only-not-calibrated',
        finalCausalGateCalibrated: false,
        labelDefinition: `retrieval support means a labeled fix appears in LTR Top ${args.verificationDepth}`,
        caveats: [
            'The pilot contains grounded positive Issue-to-fix relationships, not a sufficient OOD/ambiguous negative set.',
            'LTR scores are ranking scores and are not calibrated probabilities.',
            'This runner does not use gold labels as causal-verification input.',
            ...(args.verificationMode === 'closing-pr-provenance'
                ? ['Closing-PR verification is label-circular because the pilot labels were mined from that same relationship.']
                : []),
        ],
        all: summarize(rows),
        bySplit: Object.fromEntries(['dev', 'test'].map(split => [split, summarize(rows.filter(row => row.split === split))])),
        scoreThresholdDiagnostic: Object.fromEntries(['dev', 'test'].map(split => [
            split,
            scoreThresholdDiagnostic(rows.filter(row => row.split === split), thresholds),
        ])),
    };

    await mkdir(resolve(args.output), { recursive: true });
    await writeFile(resolve(args.output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    await writeFile(resolve(args.output, 'report.md'), markdown(summary));
    await writeFile(resolve(args.output, 'case-results.jsonl'), `${rows.map(row => JSON.stringify({
        id: row.id,
        split: row.split,
        poolSize: row.poolSize,
        goldRank: row.goldRank,
        supportedAtVerificationDepth: row.supportedAtVerificationDepth,
        failureType: row.failureType,
        topScore: topScore(row),
        retrievalGate: row.retrievalGate,
        verification: row.verification,
        gate: row.gate,
    })).join('\n')}\n`);
    console.log(JSON.stringify({
        gate: summary.gate.version,
        calibrationStatus: summary.calibrationStatus,
        test: summary.bySplit.test,
    }, null, 2));
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
