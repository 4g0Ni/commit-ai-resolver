# Commit RAG evaluation harness

This harness evaluates the offline public commit corpus without relying on the former private repositories. It separates index integrity, retrieval channels, rank fusion, grounded-answer scoring, calibration, latency, and baseline regression checks.

Full design rationale:

- [中文设计文档](./eval-design.README.zh-CN.md)
- [English design document](./eval-design.README.en.md)

## Dataset policy

`datasets/public-react-v3` is generated deterministically from the enriched React corpus with seed `20260820`. Positive commit IDs and metadata filters are derived from the corpus; OOD and ambiguous queries are fixed human-authored labels. No LLM-generated answer is accepted as a gold label. The manifest freezes the corpus and case SHA-256 hashes, so an eval stops when the local corpus silently changes. The earlier `public-react-v1` and `public-react-v2` artifacts remain frozen for historical comparison.

Cases are stratified into `dev` and frozen `test` splits. Thresholds are tuned on dev; release gates read the test split.

The 75-case suite contains:

- 12 exact SHA lookups
- 18 paraphrased commit-title queries
- 10 author/date filtered queries
- 10 risk/date filtered queries
- 5 repository/date filtered queries
- 5 negative queries that should not produce lexical or exact matches
- 10 human-authored, natural-language out-of-domain queries
- 5 underspecified queries that should request clarification

Generated semantic-title cases are useful regression evidence, but they are not a substitute for human-reviewed incident/RCA labels. Add reviewed cases as a new dataset version rather than editing an existing frozen dataset.

## GitHub-grounded RCA workflow

`mine:github-rca` collects review candidates only when a GitHub Issue has an explicit closing PR whose merge commit exists in the enriched corpus. Candidates remain outside frozen datasets until a human approves all four rubric fields in `reviews.jsonl`. `build:rca-dataset` requires at least 30 approved rows by default, and the eval runner enforces Issue/PR/reviewer/merge-commit provenance as an L0 hard gate.

See [the P0–P3 execution record](../../docs/github-grounded-rca-eval-plan-2026-08-27.md) for commands and the review rubric.

### Non-gold RCA pilot

The full set of 461 machine-verifiable candidates can be built as `datasets/public-react-rca-pilot-v1` for pipeline shakeout before human review:

```powershell
npm run build:rca-pilot
$env:DATA_DIR = (Resolve-Path ..\data\enriched\public-react-v3-20260827).Path
$env:VECTORS_DB = Join-Path $env:DATA_DIR 'vectors.db'
node eval\run-eval.js --dataset eval\datasets\public-react-rca-pilot-v1 --mode all --device cuda --output eval\reports\public-react-rca-pilot-v1
npm run analyze:rca-pilot
```

Every pilot case and its manifest are explicitly labeled `model-prescreened`, `gold=false`, and `releaseGateEligible=false`. The eval runner rejects `--gate` for this dataset. Pilot metrics may guide retrieval diagnostics and human-review prioritization, but cannot be promoted to a release baseline or used to claim production quality.

The completed local run produced Lexical/Dense/Hybrid Recall@10 of 0.3850/0.6941/0.6584 and MRR@10 of 0.2683/0.4841/0.4309. Equal-weight RRF rescued 9 dense misses with lexical evidence but pushed 27 dense top-10 hits out of the hybrid top 10. See `eval/reports/public-react-rca-pilot-v1/pilot-analysis.md` for quality, query-length, changed-file, gold-count, and component slices.

For the byte-identical 60-case v2/v3 comparison, run `npm run analyze:eval-delta`. Its report separates real rank movement from the 15 regenerated cases and records searchable-document length changes and per-category effects.

## Commands

The existing npm shortcuts continue to target the historical v2/default `data` root. Run v3 explicitly from `src`:

```powershell
$v3 = (Resolve-Path ..\data\enriched\public-react-v3-20260827).Path
node eval\generate-cases.js --data-dir $v3 --dataset-name public-react-v3
$env:DATA_DIR = $v3
$env:VECTORS_DB = Join-Path $v3 'vectors.db'
npm run test:eval
node eval\run-eval.js --dataset eval\datasets\public-react-v3 --mode index
node eval\run-eval.js --dataset eval\datasets\public-react-v3 --mode lexical
node eval\run-eval.js --dataset eval\datasets\public-react-v3 --mode all --device cuda
```

Create a reviewed baseline deliberately:

```powershell
node eval/run-eval.js --dataset eval/datasets/public-react-v3 --mode all --write-baseline eval/baselines/public-react-qwen06b-v3.json
```

Compare and enforce gates:

```powershell
node eval/run-eval.js --dataset eval/datasets/public-react-v3 --mode all --baseline eval/baselines/public-react-qwen06b-v3.json --gate
```

Run the frozen test split through a live local API and automatically score its Intent, answer grounding, retry trace, latency, Brier score, and ECE:

```powershell
npm run eval:agent -- --base-url http://127.0.0.1:4399 --split test --concurrency 2 --repeat 3
```

Use `--dry-run` to verify selection without calling the API and `--resume` to continue an interrupted run. Eval requests ask the API for detailed traces and are intentionally excluded from product usage telemetry.

`eval:full` uses the same local Qwen query instruction, normalization, model, and dimensions as the index builder. By default it runs Python through the `hello-agents` Conda environment. Override with `--conda-env`, `--device cpu`, or the `EVAL_PYTHON` environment variable.

## Answer and agent scoring

Intent predictions can be scored separately with `--intents predictions.jsonl`; each row contains `caseId` and an `intent` object. This reports field-level accuracy and commit-ID recall.

Pass a JSONL response file with `--responses`. Each row must contain at least `caseId` and `reply`; `confidence`, `iterations`, and `iterationLog` are optional:

```json
{"caseId":"semantic-title-001","reply":"... abc12345 ...","confidence":0.8,"iterations":2}
```

Small format examples are available in `fixtures/smoke-intents.jsonl` and `fixtures/smoke-responses.jsonl`.

The deterministic scorer reports citation validity, required-evidence coverage, hallucinated commit rate, accuracy, mean iterations, retry/stale-retry rates, evidence novelty, Brier score, and ECE. The product evaluator is intentionally not used as the external judge. Subjective RCA quality still requires a separately reviewed rubric or judge dataset.

## Outputs

Every run writes:

- `summary.json`: aggregate metrics, index contract, gates, and run metadata
- `case-results.jsonl`: ranks, scores, retrieval channels, and RRF contributions
- `answer-results.jsonl`: grounding details when responses are supplied
- `report.md`: human-readable summary

Reports are generated artifacts and are not used as truth. Baselines should only be updated after reviewing category-level failures.

The pull-request workflow runs deterministic metric and hybrid-store smoke tests without private data or a model download. The corpus-backed Qwen baseline remains a local/nightly gate because `data/` and the 1.2 GB model are intentionally not committed.
