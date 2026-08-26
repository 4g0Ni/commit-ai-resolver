# Commit AI Resolver Eval Harness: Full Design

> 中文版本：[eval-design.README.zh-CN.md](./eval-design.README.zh-CN.md)

## 1. Context and problem statement

Commit AI Resolver is an agentic RAG system for code-change retrieval and regression investigation. Its runtime path is not a single vector search:

```text
User question
  → Intent Extractor (entities, dates, filters, query rewrites)
  → Direct SHA / Dense / FTS5 / Secondary Query / Bug Title
  → Weighted Reciprocal Rank Fusion
  → Answer Synthesizer
  → Answer Evaluator (PASS / RETRY / PARTIAL)
  → Final answer and evidence list
```

The former quality suite depended on private repositories, authors, dates, and commit ground truth from a previous employer. Those sources are no longer accessible. Keeping only the old question text would not preserve an evaluation because the expected evidence could no longer be verified.

The first purpose of this harness is therefore not to manufacture a large number of LLM-judge scores. It is to establish a reproducible, explainable offline loop that can identify where a regression occurred.

## 2. Design goals

The harness must answer:

- Are the offline JSON corpus, SQLite metadata, FTS index, and vector index consistent?
- Does intent extraction preserve repository, author, date, risk, and SHA constraints?
- In which retrieval channel was a required commit lost?
- Does RRF improve ranking over Dense-only or FTS-only retrieval?
- Do final answers cite commits that exist and were actually retrieved?
- Does the system abstain when no evidence exists?
- Does RETRY introduce new evidence and improve quality?
- Is reported confidence calibrated to observed correctness?
- Did an embedding model, query rewrite, RRF parameter, or prompt change regress quality?

The design emphasizes five properties:

1. **Reproducible**: corpus, cases, model contract, and parameters are frozen.
2. **Layered**: intent, retrieval, fusion, answer, and agent loop are scored separately.
3. **Evidence-first**: evidence correctness precedes prose quality.
4. **Deterministic-first**: anything verifiable by rules is not delegated to an LLM judge.
5. **Regression-oriented**: every run can be compared by metric and category with a reviewed baseline.

## 3. Non-goals

The current version does not attempt to:

- Automatically prove that one commit is the unique root cause of a production incident.
- Treat model-generated questions or answers as unreviewed gold truth.
- Collapse retrieval quality, answer quality, and latency into one score.
- Download a 1.2 GB model and uncommitted `data/` in every GitHub pull request.
- Use the product's own Answer Evaluator as an independent judge.

Incident/RCA causality labels still require human review or verifiable external evidence such as issues, fixes, reverts, tests, and releases.

## 4. Evaluation surface

The system is divided into six layers:

| Layer | Subject | Typical failure |
|---|---|---|
| L0 | Corpus and index | Missing rows, duplicates, stale index, dimension mismatch |
| L1 | Intent Extractor | Lost entities, wrong dates, unnecessary clarification |
| L2 | Retrieval channels | Missing evidence, filter leakage |
| L3 | RRF/fusion | Noise promoted, relevant result demoted |
| L4 | Answer/grounding | Hallucinated SHA, missing evidence, causal overclaim |
| L5 | Agent loop/calibration | Useless retry, wrong termination, uncalibrated confidence |

Full API E2E tests remain useful as the outermost layer. Core scorers call modules directly or consume structured traces so a failure can be attributed to a particular stage.

## 5. Replacement validation dataset

### 5.1 Public corpus

`public-react-v2` uses the complete local public `facebook/react` commit corpus. The earlier `public-react-v1` dataset remains frozen as a historical snapshot:

- 27,646 commits
- 3,803 daily JSON files
- Date range: 2013-05-28 through 2026-08-09
- One repository: `facebook/react`
- Corpus SHA-256: `9fbdfdaa438d1a9389c147e5d8adb4e0d79b0b6be2b0bb5d5777ef88f5675deb`

Daily JSON is the source of truth. SQLite metadata, FTS5, and sqlite-vec are rebuildable derived artifacts.

### 5.2 Why deterministic derivation

Without the former private annotations, the most defensible initial labels are directly verifiable relationships:

- Which commit corresponds to a full SHA.
- Which commits an author made on a given date.
- Which commits remain after repository, date, and risk filters.
- Whether a deliberately nonexistent identifier has an exact or lexical match.

These labels do not require an LLM to guess the answer, which makes them suitable for CI and regression gates.

### 5.3 Case mix

The generator uses fixed seed `20260820` to create 60 cases:

| Category | Count | Purpose |
|---|---:|---|
| `exact_sha` | 12 | Full/short SHA direct lookup |
| `semantic_title` | 18 | Semantic and lexical recall after title rewriting |
| `author_date` | 10 | Author/repository/date filters |
| `risk_date` | 10 | Risk/repository/date filters |
| `repo_date` | 5 | Date boundaries and repository filtering |
| `negative` | 5 | No-result behavior for nonexistent identifiers |

`semantic_title` applies a limited deterministic rewrite, such as `fix → resolve` and `add → introduce`. It introduces a small semantic gap but may retain substantial source wording. It must not be interpreted as a representative user distribution or a hard RCA benchmark.

### 5.4 Gold schema

Each case stores:

```json
{
  "id": "author-date-001",
  "category": "author_date",
  "query": "What did an author change on a date?",
  "expectedBehavior": "answer",
  "expectedIntent": {
    "author": "...",
    "repo": "facebook/react",
    "dateFrom": "YYYY-MM-DD",
    "dateTo": "YYYY-MM-DD",
    "commitIds": [],
    "verdict": "GOOD"
  },
  "filters": {},
  "relevantCommits": [
    {
      "repo": "facebook/react",
      "id": "12345678",
      "commitId": "full-sha",
      "relevance": 3,
      "required": true
    }
  ]
}
```

The scorer supports graded relevance and optional evidence. Automatically generated targets currently use `relevance: 3` and `required: true`. A future human-reviewed RCA set can assign 1/2/3 relevance and distinguish required evidence from supporting evidence.

### 5.5 Freezing and versioning

The manifest records:

- Generator path and seed
- Corpus file count, commit count, repositories, date range, and SHA-256
- Case count, category distribution, and cases JSONL SHA-256
- Label-generation policy

The runner recomputes hashes before evaluation. A silent change to either corpus or cases stops the run instead of comparing scores from different inputs.

Once a dataset has a baseline, it should not be edited in place. A change in corpus, sampling, or label policy creates a new version such as `public-react-v2`.

## 6. L0: corpus and index integrity

Index evaluation is a fully deterministic gate that checks:

- Manifest corpus hash matches local daily JSON.
- Corpus count matches the manifest.
- `commit_metadata` count matches the corpus.
- FTS row count matches metadata.
- Vector row count matches metadata.
- `repo + shortId` contains no duplicate keys.
- No corpus rows are missing from the index.
- No stale index rows are absent from the corpus.
- Actual vector byte length matches the index dimension contract.

Every invariant must pass. High retrieval scores cannot compensate for an incomplete index or a model-contract mismatch.

## 7. L1: intent extraction

Intent predictions are supplied with `--intents predictions.jsonl`:

```json
{"caseId":"sha-001","intent":{"commitIds":["..."],"verdict":"GOOD"}}
```

The current deterministic scorer measures:

- Exact repository match
- Exact author match
- Exact `dateFrom`/`dateTo`
- Exact `riskLevel`/`changeType`
- Exact verdict
- Commit-ID recall

The intent layer does not score whether rewrite prose sounds good. The material question is whether constraints were retained and downstream retrieval improved.

Future reviewed cases should add:

- `ASK_USER` precision and recall for ambiguity
- Unnecessary clarification rate
- Incident release-buffer date accuracy
- Repository aliases, relative dates, and conversational references
- Downstream retrieval delta from each rewrite

## 8. L2: retrieval channels

The harness evaluates these channels independently:

- **Direct**: exact commit-ID lookup.
- **Lexical**: SQLite FTS5 for identifiers, paths, error codes, and exact wording.
- **Dense**: Qwen query embeddings with sqlite-vec cosine search.
- **Hybrid**: Dense and Lexical RRF, with Direct matches deduplicated and prepended.

The production path also supports a secondary dense query and a work-item title channel. The current offline set has neither LLM rewrites nor work items, so the baseline runner does not fabricate these channels. They are evaluated through production traces and future E2E cases.

### 8.1 Metrics

Positive cases use:

- **Recall@10**: retrieved gold evidence divided by all gold evidence.
- **Required Recall@10**: retrieved required evidence divided by all required evidence.
- **Precision@10**: relevant items among the top ten returned results.
- **MRR@10**: reciprocal rank of the first relevant result.
- **nDCG@10**: position-discounted ranking quality with graded relevance.
- **Hit Rate@10**: fraction of cases with at least one relevant result.

Negative cases use:

- **No-result Accuracy**: fraction of abstention cases returning no result.

Cases without gold evidence are excluded from Recall and MRR macro averages.

### 8.2 Metadata filtering

Author/date/risk/repository cases verify the structured filter set. For selective candidate sets, the vector store filters in SQL first and computes exact cosine over the remaining candidates. This prevents global KNN candidates from crowding out a small requested slice.

Any result violating the requested repository, author, date, or risk condition is filter leakage. Its target is zero.

## 9. L3: RRF and channel attribution

Weighted Reciprocal Rank Fusion is:

```text
RRF(d) = Σ_channel weight(channel) / (k + rank_channel(d))
```

Ranks begin at one. Current production defaults are:

- `k = 20`
- dense-primary weight = 1.0
- lexical-fts5 weight = 1.0
- dense-secondary weight = 0.7
- dense-bug-title weight = 1.5

The offline baseline fuses only dense-primary and lexical-fts5. Direct SHA matches are deduplicated and placed first.

Per-case output includes:

- Original rank in each channel
- RRF contribution from each channel
- Fused rank and RRF score
- Cosine score
- Retrieval-channel list

This makes rank movement explainable instead of exposing only a final top ten.

Recommended experiments are:

1. FTS-only
2. Dense-only
3. Dense + FTS RRF
4. Add secondary query
5. Add work-item title
6. `k = 10 / 20 / 40`
7. Vary channel weights
8. Compare query-rewrite strategies

Weights must be selected on a development split. A frozen test split is used only for final confirmation.

## 10. Embedding evaluation

The current index contract is:

- Model: `Qwen/Qwen3-Embedding-0.6B`
- Dimensions: 1024
- Document template version: 2
- Query instruction tailored to commits, regressions, configuration changes, and incidents
- Normalized query and document embeddings
- Asymmetric query/document preprocessing

The harness reads the contract from SQLite `vector_store_meta` and configures the vector store before loading it. Queries use the same local model as the index builder, preventing a silent model-A/index-model-B mismatch.

Every embedding experiment must record:

- Exact model identifier and version
- Dimensions
- Document-template version
- Query instruction
- Normalization behavior
- Corpus and case hashes
- CPU/GPU environment
- Batch size
- Build time, index size, and query latency

Model comparisons must be sliced by identifier, semantic, metadata-filter, and negative cases instead of relying only on macro Recall.

## 11. Query-rewrite evaluation

Query rewriting can fail through:

- **Constraint loss**: removing author, date, repository, risk, or an exact error term.
- **Semantic drift**: injecting a component or causal hypothesis absent from the question.

Each case should eventually retain:

- Original query
- Primary search query
- Secondary search query
- Extracted filters
- Ranked IDs from each query
- Fused ranked IDs

The main rewrite score is downstream retrieval delta:

- Did Recall/MRR improve?
- Did required evidence increase?
- Did filter leakage appear?
- Did a secondary query contribute novel evidence?

An LLM's subjective rating of rewrite prose is not sufficient.

## 12. L4: answer grounding

Answer predictions use `--responses responses.jsonl`:

```json
{
  "caseId": "semantic-title-001",
  "reply": "The likely change is abc12345 ...",
  "confidence": 0.8,
  "iterations": 2,
  "iterationLog": []
}
```

The deterministic scorer currently checks:

- Whether cited SHAs exist in the frozen corpus.
- Whether at least one gold commit is cited.
- Required-evidence coverage.
- Hallucinated commit/citation rate.
- Whether a negative case avoids citing a commit.

Future rule scorers can verify author, date, repository, and risk claims against commit metadata.

### 12.1 Why the product evaluator is not the final judge

The product Answer Evaluator shares context, prompt assumptions, and often a model family with generation. Its fast path also consumes synthesizer-reported confidence. Treating PASS as ground truth would create a circular self-evaluation.

The preferred order is:

1. Rule-check citations and metadata facts.
2. Compare required evidence with human gold.
3. Use an independent judge only for actionability, clarity, and causal calibration.
4. Human-review important release cases and monitor judge agreement.

For RCA, “relevant candidate” and “proven root cause” are different labels. Without a diff, issue, revert, or test proving causality, the answer must use calibrated language such as “possibly related” or “investigate first.”

## 13. L5: agent loop and retry value

The orchestrator trace now records:

- Per-iteration filters
- Ranked results
- Embedding/search timing
- Retrieval channels
- Evaluator verdict
- Retry strategy
- Stale-retry events

The answer scorer derives:

- Mean iterations
- Retry rate
- Stale-retry rate
- Evidence novelty between adjacent result sets

Evidence novelty uses Jaccard distance:

```text
novelty(A, B) = 1 - |A ∩ B| / |A ∪ B|
```

Equal result counts do not imply a stale retry because two equally sized sets can contain entirely different evidence. Production logic now compares `repo:id` sets.

With reviewed answer gold, the harness should also measure:

- Retry success rate
- Retry harm rate
- Unnecessary retry rate
- Termination correctness for answer, clarification, PARTIAL, and abstention

## 14. Confidence calibration

Average confidence is not treated as accuracy. For responses containing confidence, the harness computes:

- **Brier Score**: squared error between probability and binary correctness; lower is better.
- **ECE**: weighted confidence-versus-accuracy gap across buckets; lower is better.
- A future selective accuracy/coverage curve.

This supports operational questions such as: if only answers with confidence at least 0.8 are returned, what accuracy is achieved and how much traffic is rejected?

## 15. Negative cases and abstention

Dense KNN always returns nearest neighbors even when no good evidence exists. A candidate list is not proof of evidence. The current baseline makes the gap explicit:

- FTS negative no-result accuracy = 100%
- Dense negative no-result accuracy = 0%
- Hybrid negative no-result accuracy = 0%

The solution is not simply to set `topK` to zero. A development set should calibrate:

- Top cosine threshold
- Top-1/top-2 margin
- Lexical support
- Cross-channel agreement
- Answer grounding coverage
- Calibrated confidence and abstention threshold

Until that calibration set is mature, negative performance remains diagnostic rather than a hard release gate, avoiding overfitting to five synthetic identifiers.

## 16. Performance and cost

The runner records:

- Total local query-embedding batch time
- Amortized embedding time per query
- Lexical search latency
- Dense search latency
- Fusion time
- Hybrid end-to-end retrieval latency
- Mean and p95 latency

Query embeddings are generated as a batch and startup time is amortized, so this supports offline experiment comparisons but is not equivalent to single-request cold-start latency. Production evaluation should additionally capture:

- Warm single-query embedding latency
- Embedding cache hit rate
- Intent, synthesis, and evaluator stage latency
- Tokens and model-call count
- Concurrent throughput and p99

Quality and performance are reported separately rather than being allowed to cancel each other inside one aggregate score.

## 17. Baselines, comparisons, and gates

A baseline is a deliberately written, reviewed `summary.json`; it is never updated automatically. In a candidate comparison, positive quality deltas are improvements while positive latency deltas are regressions.

Current default gates are:

- Index integrity passes.
- Hybrid required Recall@10 is at least 0.85.
- Hybrid MRR@10 is at least 0.75.
- Answer hallucinated-citation rate is zero when response predictions are supplied.
- Required Recall@10 and MRR@10 do not regress relative to baseline.

Recommended execution tiers:

| Tier | Content | Frequency |
|---|---|---|
| PR smoke | Metric unit tests and temporary SQLite hybrid tests | Every relevant PR |
| Local retrieval | Frozen corpus with FTS/Dense/RRF | Retrieval changes |
| Nightly full | Intent, retrieval, answer, and calibration | Model-enabled environment |
| Release | Frozen test, baseline gate, and human sample | Before release |
| Feedback replay | Reviewed thumbs-down and bad cases | Periodically |

GitHub pull requests do not contain `data/` or the local model, so the workflow runs deterministic smoke tests only. The full Qwen baseline belongs in a local or nightly runner with a pinned corpus and model cache.

## 18. Current baseline and interpretation

Current `public-react-qwen06b-v2` baseline:

| Channel | Recall@10 | MRR@10 | nDCG@10 | Negative no-result | p95 |
|---|---:|---:|---:|---:|---:|
| Direct | 100.0% | 1.000 | 1.000 | n/a | 0 ms |
| Lexical | 43.6% | 0.391 | 0.393 | 33.3% | about 30 ms |
| Dense | 78.2% | 0.710 | 0.726 | 0.0% | about 318 ms |
| Hybrid | 100.0% | 0.940 | 0.953 | 0.0% | about 334 ms |

Interpretation caveats:

- Hybrid's 100% Recall is influenced by metadata-filter and Direct SHA cases. It does not imply 100% real RCA accuracy.
- `semantic_title` retains meaningful overlap with source titles and is a medium-to-easy semantic task.
- Low Precision@10 is expected for a single-target case that deliberately returns ten candidates; MRR/nDCG and context budget must also be considered.
- Offline embedding latency includes amortized model startup.

## 19. Defects discovered by the harness

Building and running the evaluation exposed concrete defects:

1. `lookupByCommitIds()` queried only the eight-character `id`, so a full SHA silently fell back to vector retrieval.
2. Full and short SHA collision semantics were untested; full SHA is now exact while short SHA uses a prefix and may return all matching repositories.
3. Stale retry previously compared result counts; it now compares `repo:id` sets.
4. Answer Evaluator contained a hard-coded `iteration >= 3` that did not consistently follow `maxIterations`; the rule and prompt now use the parameter.
5. Older semantic tests printed a warning instead of failing when no exact evidence was found, making them unsuitable as a regression gate.

This is the main value of a layered harness: it finds deterministic product bugs in addition to producing scores.

## 20. Threats to validity and next phase

### Current limitations

- Only one public repository, limiting cross-repository and alias evaluation.
- Sparse changed-file data in the imported corpus, limiting path and error-code cases.
- Automatically rewritten titles are not independent human queries.
- Only five synthetic negative cases.
- No reviewed incident, multi-hop, causal, or conversational cases yet.
- Full product Intent/Answer evaluation requires model-produced prediction files; the current baseline is primarily index and retrieval.

### Recommended roadmap

1. Build 30–50 reviewed RCA cases from public issues, fix PRs, reverts, and releases.
2. Add two or three repositories for cross-repository features and short-SHA boundaries.
3. Add file-path, symbol, error-code, and configuration cases.
4. Split the present suite into development and test; tune RRF and thresholds only on development.
5. Calibrate abstention and add a negative release gate.
6. Produce real Intent and Answer predictions in a nightly full-pipeline run.
7. Convert reviewed thumbs-down feedback into a new dataset version rather than treating raw feedback as gold.

## 21. Files and commands

Main files:

```text
src/eval/
├── generate-cases.js                 # Deterministic case generator
├── run-eval.js                       # Index/Retrieval/Intent/Answer runner
├── embed-queries.py                  # Local Qwen query embeddings
├── lib/corpus.js                     # Corpus loading, hashing, stable sampling
├── lib/metrics.js                    # Ranking, calibration, baseline metrics
├── datasets/public-react-v2/         # Active frozen cases and manifest
├── baselines/                        # Reviewed baselines
├── fixtures/                         # Intent/Answer format examples
└── reports/                           # Generated output, never ground truth
```

Run from `src`:

```powershell
npm run eval:generate
npm run test:eval
npm run eval:index
npm run eval:lexical
npm run eval:full -- --device cuda
```

Write a baseline:

```powershell
node eval/run-eval.js --mode all `
  --write-baseline eval/baselines/public-react-qwen06b-v2.json
```

Compare and enforce gates:

```powershell
node eval/run-eval.js --mode all `
  --baseline eval/baselines/public-react-qwen06b-v2.json `
  --gate
```

Score Intent and Answer predictions:

```powershell
node eval/run-eval.js --mode lexical `
  --intents path/to/intents.jsonl `
  --responses path/to/responses.jsonl
```

Each run writes `summary.json`, `case-results.jsonl`, optional intent/answer details, and `report.md`. A baseline should be updated only after category-level changes have been reviewed and accepted.

