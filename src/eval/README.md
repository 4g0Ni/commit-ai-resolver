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
node eval\run-eval.js --dataset eval\datasets\public-react-rca-pilot-v1 --mode all --device cuda --query-mode raw --candidate-k 50 --rrf-k 5 --dense-weight 1 --lexical-weight 0.33 --output eval\reports\public-react-rca-pilot-v1-final
node scripts\analyze-rca-pilot.js --dataset eval\datasets\public-react-rca-pilot-v1 --report eval\reports\public-react-rca-pilot-v1-final
```

Every pilot case and its manifest are explicitly labeled `model-prescreened`, `gold=false`, and `releaseGateEligible=false`. The eval runner rejects `--gate` for this dataset. Cases are assigned to a stable 327/134 dev/test split by connected groups of shared gold commit IDs, so duplicate fixes cannot cross the split. Pilot metrics may guide retrieval diagnostics and human-review prioritization, but cannot be promoted to a release baseline or used to claim production quality.

The accepted deterministic run produces Lexical/Dense/Hybrid Recall@10 of 0.3959/0.6941/0.7093 and MRR@10 of 0.2600/0.4841/0.4894. Hybrid Recall@20/50 is 0.7495/0.8189. Dense-primary weighted RRF rescues 6 Dense misses and pushes zero Dense top-10 hits out of Hybrid top 10. The grouped held-out test Hybrid scores are Recall@10 0.6866, MRR@10 0.4633, and nDCG@10 0.5177. See `eval/reports/public-react-rca-pilot-v1-final/improvement-analysis.md` for the raw/compact/multi-query ablation and LLM reranker ceiling.

### Stage 1 candidate-pool experiment

The first Recall@20 experiment retrieves Top 100 independently from raw/compact Dense/Lexical channels, preserves the untruncated results, deduplicates them into an average 224.5-candidate test pool, and applies a local non-LLM reranker. Run both `run-eval.js` commands with `--candidate-k 100`, then reproduce the cheap reranker with:

```powershell
conda run -n hello-agents --no-capture-output python eval\learning-to-rank-pool-eval.py `
  --dataset eval\datasets\public-react-rca-pilot-v1 `
  --raw-report eval\reports\public-react-rca-pilot-v1-stage1-raw-k100 `
  --compact-report eval\reports\public-react-rca-pilot-v1-stage1-compact-k100 `
  --vectors-db ..\data\enriched\public-react-v3-20260827\vectors.db `
  --output eval\reports\public-react-rca-pilot-v1-stage1-ltr-k100 `
  --candidate-depth 100
```

On the grouped 134-case held-out test, candidate availability is 0.8582 and the selected dev-trained reranker reaches Recall@10/20/50 of 0.7090/0.7313/0.7985, MRR@10 0.5112, and nDCG@10 0.5588. Against the current Hybrid test run this is +0.0224 at each Recall cutoff and +0.0479/+0.0412 MRR/nDCG. TF-IDF statistics are fit on the fixed commit corpus and dev queries only; test queries are transform-only. The improvement is real but below the 0.85 Recall@20 target, so it remains an experiment and is not enabled in the default product path. See `eval/reports/public-react-rca-pilot-v1-stage1-ltr-k100/stage1-analysis.md`.

### LLM reranker experiment

The live LLM experiment reranks the existing Hybrid Top 50 without using gold fields. A single 50-key permutation was too slow on the configured provider, so the accepted protocol disables thinking, independently scores five batches of 10 candidates on a fixed 0-3 rubric, and deterministically preserves retrieval order for ties:

```powershell
cd ..\api
$env:OPENAI_STRUCTURED_OUTPUTS = '0'
npm run eval:commit-reranker -- --strategy batched-scores --split all `
  --candidates 50 --batch-size 10 --batch-concurrency 5 --concurrency 4 `
  --output ..\src\eval\reports\public-react-rca-pilot-v1-llm-reranker-batched10-k50
```

All 461 cases returned valid scores. On the grouped held-out test, Recall@10/20 moves from 0.6866/0.7090 to 0.7537/0.7612, MRR@10 from 0.4633 to 0.6155, and nDCG@10 from 0.5177 to 0.6492. The run uses 2.29M tokens on test and 7.96M across all cases; p95 per-case latency is 2.62s on test. Since LLM Recall@20 is already within two cases of the Hybrid Top-50 candidate ceiling, the next Recall improvement must come primarily from candidate generation. The reranker remains opt-in and this non-gold pilot remains ineligible for release gating. See `eval/reports/public-react-rca-pilot-v1-llm-reranker-batched10-k50/llm-reranker-analysis.md`.

### Issue lifecycle window + local LTR experiment

For Issue-grounded queries that include lifecycle metadata, the selected dev-only window is `createdAt - 7 days` through `closedAt + 30 days`. It is the smallest tested window whose relevant-commit temporal coverage reached at least 0.98 on dev. The window uses no PR or gold-commit timestamp to derive its boundaries, and it must not be applied to a generic text-only query that lacks Issue dates.

Within that SQL-prefiltered window, raw/compact Dense/Lexical Top 100 results are pooled and deduplicated. A local 35-feature LTR compares channel ranks and scores, cross-channel consensus, word/character TF-IDF, and query overlap with title, summary, changed files, and affected areas. Logistic regression, histogram gradient boosting, and ExtraTrees candidates are selected on a commit-grouped 229/98 split inside the 327-case dev set; `hist-depth3` wins, is refit on all dev cases, and then scores the 134-case test split. No LLM is used in this path.

On grouped held-out test, candidate availability is 0.9776 with an average pool of 153.45. The learned ranker reaches Recall@10/20/50 of **0.9254/0.9478/0.9701**, MRR@10 **0.6887**, and nDCG@10 **0.7462**. This is the current best offline Issue-grounded retrieval result, but it remains an opt-in experiment over a model-prescreened, non-gold, release-gate-ineligible dataset; it does not replace the default product path or establish production quality.

Reproduce the derived dataset and LTR report with:

```powershell
node scripts\build-rca-time-window-dataset.js --force

conda run -n hello-agents --no-capture-output python eval\learning-to-rank-pool-eval.py `
  --dataset eval\datasets\public-react-rca-pilot-v1-time-window-7d-30d `
  --raw-report eval\reports\public-react-rca-pilot-v1-stage1-time-window-raw-k100 `
  --compact-report eval\reports\public-react-rca-pilot-v1-stage1-time-window-compact-k100 `
  --vectors-db ..\data\enriched\public-react-v3-20260827\vectors.db `
  --output eval\reports\public-react-rca-pilot-v1-stage1-time-window-ltr-k100 `
  --candidate-depth 100
```

The full diagnosis, rejected experiments, leakage boundaries, flow diagrams, and failure analysis are documented in [`../../docs/issue-time-window-local-ltr-design-2026-09-03.md`](../../docs/issue-time-window-local-ltr-design-2026-09-03.md).

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

- `summary.json`: aggregate Top-10 and candidate Recall@20/50/100/200 metrics, index contract, retrieval configuration, gates, and run metadata
- `case-results.jsonl`: ranks, scores, retrieval channels, and RRF contributions
- `answer-results.jsonl`: grounding details when responses are supplied
- `report.md`: human-readable summary

Reports are generated artifacts and are not used as truth. Baselines should only be updated after reviewing category-level failures.

The pull-request workflow runs deterministic metric and hybrid-store smoke tests without private data or a model download. The corpus-backed Qwen baseline remains a local/nightly gate because `data/` and the 1.2 GB model are intentionally not committed.
