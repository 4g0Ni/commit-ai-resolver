# Plan: Config Detection Validation + Diff-Filter Unit Tests

## Context

We recently narrowed the config change detection rules in `commit-summarizer.js` and `diff-filter.js` — excluding Kubernetes/Helm files, agent/AI workflows, and Dependabot bumps from being classified as `config`/`mixed`. We also fixed config key extraction to use short flag names instead of XPath paths. Now we need to:
1. Measure the impact at scale against the existing 36-day dataset
2. Add unit tests for `diff-filter.js` to prevent regressions

---

## Task 1: Validation Script — `src/scripts/validate-config-detection.js`

### What it does
Reads all 36 JSON files from `data/daily/`, finds all `config`/`mixed` commits, and applies heuristic false-positive detection to produce a report.

### False positive detection rules
Since the stored JSON doesn't include the file `changes` array, detection works from summary text (title, message, configChanges keys/details):

| Rule | Scope | Pattern |
|------|-------|---------|
| Infrastructure | all repos | helm, k8s, kubernetes, ingress, replica, AFD, values.yaml, image digest/tag |
| Agent/AI | AdsAppsMT | agent workflow, pipeline-config, project-config, instruction.md, skill |
| Dependabot | all repos | dependabot, automated bump patterns |
| Build/deploy | all repos | AKS packaging, serviceConfig.ini, build pipeline YAML |
| XPath keys | all repos | configChanges keys starting with `/` or containing `[@` (quality issue, not FP) |

### Output
Markdown report to stdout with:
- Total config/mixed count, suspected FP count, by-repo breakdown table
- Per-category FP breakdown
- List of suspected FP commits (shortId, repo, date, title, reason)
- Summary section formatted for `docs/SEARCH-QUALITY.md`

### Run command
```bash
cd src && node scripts/validate-config-detection.js
```

---

## Task 2: Unit Tests — `src/tests/test-diff-filter.js`

### Approach
Follow existing project convention: `node:assert`-style manual assertions with pass/fail counters, run via `node tests/test-diff-filter.js`. No test runner added.

### Test suites (11 suites, ~50 assertions)

1. **Empty input** — empty array, unknown repo
2. **IGNORE patterns** — .snap, .Designer.cs, binary assets (.png, .svg, .woff2)
3. **AUTO_SUMMARY global** — lock files, .generated.*, .min.js, dist/, .map, .resx, .csproj, .xsd
4. **Per-repo: CampaignUI** — /loc/, .resjson, .cscfg, .csdef, Web.config (auto-skipped here)
5. **Per-repo: AdsAppsMT** — Generated, .dgml, Datamart, adf-prod/trigger, .script, /agent/ (NEW)
6. **Per-repo: AdsAppUI** — /loc/, .resjson, .cshtml; `.cscfg`/`Web.config` NOT auto-skipped (goes to LLM)
7. **Priority** — ignore beats auto-summary (e.g., .generated.snap → ignored)
8. **needsDiff fallthrough** — .tsx, .cs, README.md, Dynamic.config for MT → needsDiff
9. **shouldSkipLLM** — all auto/ignored → true; any needsDiff → false; empty → true
10. **buildSkippedFilesSummary** — grouping by reason, 3-file truncation, empty inputs
11. **Exported constants** — MAX_FILES_FOR_DIFF=50, MAX_DIFF_SIZE=200000, repoFilters keys

### Run command
```bash
cd src && node tests/test-diff-filter.js
```

---

## Execution Order

1. **Task 2 first** (unit tests) — pure logic, no external dependencies, validates current code
2. **Task 1 second** (validation script) — reads data files, produces report
3. Update `docs/SEARCH-QUALITY.md` with validation results

---

## Files to create/modify

| File | Action |
|------|--------|
| `src/tests/test-diff-filter.js` | CREATE — ~200 lines |
| `src/scripts/validate-config-detection.js` | CREATE — ~180 lines |
| `docs/SEARCH-QUALITY.md` | EDIT — add validation results section |

## Verification

1. `node tests/test-diff-filter.js` — all assertions pass (exit code 0)
2. `node scripts/validate-config-detection.js` — produces report, no crashes
3. Review report for unexpected results, spot-check a few flagged FPs
4. Append summary to SEARCH-QUALITY.md
