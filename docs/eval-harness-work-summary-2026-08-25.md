# Eval Harness 工作总结（2026-08-25）

## 总览

本轮工作将 Commit AI Resolver 从依赖原公司内部 Commit 和人工 badcase 的评测方式，升级为一套基于公开语料、可复现、可分层诊断、可做 baseline 回归的 Eval Harness。

在此前 System Prompt 工作中，项目已经建立了 10-case Prompt Golden Eval；本轮进一步覆盖整个 Commit RAG 链路，包括语料与索引完整性、Intent、检索通道、RRF、Evidence Gate、回答引用、Agent 重试、置信度校准和 CI 门禁。

对应 Git 提交：

- Commit：`f3078eb568b4b2291772b0b7cc62ac95f870e34e`
- Commit message：`eval`
- 涉及文件：27 个
- 新增代码：3,798 行
- 删除代码：61 行
- 净增加：3,737 行
- 总变更行数：3,859 行

## P0：重建可复现的公开验证集

### 1. 公开语料与索引契约

使用公开的 `facebook/react` Commit 数据建立 `public-react-v1`：

- 10,000 条 Commit
- 1,741 个 daily JSON 文件
- 时间范围：2013-05-28 至 2019-02-20
- Daily JSON 作为 source of truth
- SQLite metadata、FTS5 和 sqlite-vec 作为可重建派生索引
- Embedding 模型：`Qwen/Qwen3-Embedding-0.6B`
- 向量维度：1024
- Document template version：2

Manifest 固定记录 generator、seed、corpus hash、case hash、文件数、Commit 数、仓库和日期范围。Runner 会在执行前重新计算 hash；只要语料或 case 被静默修改，就停止评测，避免在不同输入上比较指标。

主要文件：

- `src/eval/datasets/public-react-v1/manifest.json`
- `src/eval/datasets/public-react-v1/cases.jsonl`
- `src/eval/lib/corpus.js`
- `src/eval/generate-cases.js`

### 2. 75-case 分层验证集

当前验证集共 75 个 case：

| Category | 数量 | 评测目标 |
|---|---:|---|
| `exact_sha` | 12 | 完整/短 SHA 精确查询 |
| `semantic_title` | 18 | 标题改写后的语义与词法召回 |
| `author_date` | 10 | 作者、仓库和日期过滤 |
| `risk_date` | 10 | 风险等级、仓库和日期过滤 |
| `repo_date` | 5 | 仓库和日期边界 |
| `negative` | 5 | 不存在标识符的无结果行为 |
| `negative_natural` | 10 | 人工编写的自然语言 OOD 请求 |
| `ambiguous` | 5 | 信息不足时请求澄清 |

数据集分为：

- Dev：52 cases，用于阈值与参数分析
- Frozen test：23 cases，用于回归确认

正例 Commit ID 和结构化过滤标签从公开 corpus 确定性派生；自然语言 OOD 与 ambiguous case 使用固定人工标签；不把 LLM 生成答案当作未经审核的 ground truth。

## P1：分层 Eval Harness

### 1. 六层评测结构

Harness 将系统拆为六层：

| 层级 | 评测对象 | 主要失败模式 |
|---|---|---|
| L0 | Corpus 和 Index | 缺行、重复、stale row、维度不一致 |
| L1 | Intent Extractor | repo/author/date/risk/SHA 丢失或误提取 |
| L2 | Retrieval Channels | 正确 Commit 未召回、metadata filter 泄漏 |
| L3 | RRF/Fusion | 通道噪声抬高、正确结果排名下降 |
| L4 | Answer/Grounding | 幻觉 SHA、遗漏证据、引用无效 |
| L5 | Agent Loop/Calibration | 无效重试、错误停止、confidence 失真 |

设计原则包括：

1. **Reproducible**：冻结语料、case、模型契约和参数。
2. **Layered**：Intent、Retrieval、Fusion、Answer 和 Agent Loop 分开评分。
3. **Evidence-first**：先验证证据，再评价语言表达。
4. **Deterministic-first**：能用程序验证的内容不交给 LLM judge。
5. **Regression-oriented**：支持 baseline、逐指标和逐 case 对比。

### 2. L0 索引完整性门禁

每次运行首先检查：

- Manifest corpus hash 与本地语料是否一致
- Corpus Commit 数与 manifest 是否一致
- Metadata、FTS 和 vector 行数是否一致
- `repo + shortId` 是否重复
- 是否存在 missing row
- 是否存在 stale row
- 向量 byte length 是否符合 dimensions 契约

当前结果：

| 检查项 | 结果 |
|---|---:|
| Corpus | 10,000 |
| Metadata | 10,000 |
| FTS | 10,000 |
| Vector | 10,000 |
| Duplicate | 0 |
| Missing | 0 |
| Stale | 0 |
| Index integrity | 全部通过 |

### 3. L1 Intent 评分

Intent scorer 支持分别检查：

- repo exact match
- author exact match
- dateFrom/dateTo exact match
- riskLevel/changeType exact match
- verdict exact match
- Commit ID recall

Intent 层不单独评价 query rewrite 是否“表达得好”，而是检查约束是否被保留，以及 rewrite 是否改善后续检索。

### 4. L2/L3 检索通道与 RRF 消融

独立评测以下通道：

- Direct SHA lookup
- SQLite FTS5 lexical search
- Qwen dense cosine search
- Dense + FTS5 Weighted RRF
- Metadata pre-filter 后的精确 cosine 排序

主要指标：

- Recall@10
- Required Recall@10
- Precision@10
- MRR@10
- nDCG@10
- Hit Rate@10
- Negative No-result Accuracy
- Mean/P95 latency

每个 case 的结果会保存各通道原始排名、RRF contribution、融合后排名、cosine score 和 retrieval channel，便于解释候选为什么上升或下降。

当前 75-case baseline：

| Channel | Recall@10 | MRR@10 | nDCG@10 |
|---|---:|---:|---:|
| Lexical | 43.9% | 0.418 | 0.415 |
| Dense | 78.2% | 0.764 | 0.768 |
| Hybrid | 100.0% | 0.982 | 0.987 |

Frozen test 的 Hybrid 结果：

- Recall@10：100%
- MRR@10：1.0
- nDCG@10：1.0

Baseline 文件：`src/eval/baselines/public-react-qwen06b-v1.json`。

## P1：Evidence Gate 与拒答评测

### 1. 为什么增加 Evidence Gate

Dense KNN 即使面对完全无关的问题，也会返回数据库中相对最近的候选。“返回 Top-K”不等于“找到足够证据”。如果直接进入 Synthesizer，系统可能把弱相关 Commit 包装成确定答案。

因此在 Retriever 与 Synthesizer 之间增加 Evidence Gate，输出三种行为：

- `SEARCH`：证据足够，可以继续回答
- `ABSTAIN`：没有可靠证据，应拒答
- `ASK_USER`：请求信息不足，应要求澄清

Gate 使用以下确定性信号：

- Exact SHA 是否真实命中
- 用户是否显式提供结构化过滤条件
- Dense top score
- Lexical 与 Dense 是否提供多通道支持
- Query 是否包含有效约束、是否过于模糊

### 2. 当前 Gate 结果

75-case baseline 的行为分布：

- SEARCH：55
- ABSTAIN：15
- ASK_USER：5
- 总体行为准确率：100%
- Frozen test 行为准确率：100%

主要文件：

- `src/services/evidence-gate.js`
- `src/tests/test-evidence-gate.js`
- `src/tests/test-evidence-gate-orchestrator.js`

## P2：Answer Grounding 与 Agent Eval

### 1. 确定性 Answer Scorer

回答层优先使用客观规则，而不是让产品内部 Answer Evaluator 自己判自己。当前 scorer 检查：

- 回答中的 SHA 是否存在于冻结 corpus
- 引用是否来自检索结果
- 是否命中至少一个 gold Commit
- Required evidence coverage
- Hallucinated Commit/citation rate
- Negative case 是否错误引用 Commit

同时支持统计：

- Answer accuracy
- Mean iterations
- Retry rate
- Stale retry rate
- Evidence novelty
- Brier Score
- Expected Calibration Error（ECE）

Evidence novelty 使用相邻两轮结果集合的 Jaccard 距离，而不是只比较结果数量。

### 2. Agent Batch Runner

新增完整 Agent batch runner，支持：

- 按 dev/test split 运行
- 并发执行
- 多次重复采样
- 中断后 `--resume`
- `--dry-run` 验证 case 选择
- 逐 case Intent、回答和 iteration trace
- 引用、重试、停滞、延迟、Brier 与 ECE 自动评分
- Eval 请求不写入产品 usage telemetry，避免污染线上指标

运行示例：

```powershell
npm run eval:agent -- --base-url http://127.0.0.1:4399 --split test --concurrency 2 --repeat 3
```

Runner、scorer 和 mock 集成测试已完成。当前环境未配置可用 chat API，因此尚未生成真实 LLM 的全量答案基线，不能把基础设施完成表述为线上模型效果已经验证。

主要文件：

- `src/eval/run-agent-eval.js`
- `src/eval/lib/metrics.js`
- `src/tests/test-agent-eval-runner.js`
- `src/eval/fixtures/smoke-intents.jsonl`
- `src/eval/fixtures/smoke-responses.jsonl`

## P2：Baseline、报告与 CI 门禁

### 1. Baseline 管理

Baseline 只有在人工检查 category-level 变化后才能显式写入，不会自动接受 candidate 结果。

当前门禁包括：

- Index integrity 必须全部通过
- Hybrid Required Recall@10 ≥ 0.85
- Hybrid MRR@10 ≥ 0.75
- 提供 answer response 时，hallucinated citation rate 必须为 0
- 相对 baseline 的 Required Recall@10 和 MRR@10 不得下降

每次运行输出：

- `summary.json`：聚合指标、索引契约和 gate 结果
- `case-results.jsonl`：逐 case 排名、通道和 RRF contribution
- `answer-results.jsonl`：回答引用与 grounding 详情
- `report.md`：便于人工阅读的汇总报告

### 2. CI Eval Smoke

新增 `.github/workflows/eval-smoke.yml`，在相关文件变化时运行：

- Metrics 单元测试
- 临时 SQLite hybrid-store 测试
- Evidence Gate 测试
- Orchestrator 集成测试
- Agent runner 测试

GitHub PR 环境不会下载未提交的完整 corpus 和约 1.2 GB 本地模型，因此 PR 只运行确定性 smoke；完整 Qwen baseline 作为本地或 nightly gate。

## Eval 实际发现并推动修复的问题

### 1. Full SHA Direct Lookup 缺陷

`lookupByCommitIds()` 原先只按数据库中的 8 位短 `id` 查询。用户输入完整 SHA 时无法 direct lookup，会静默退化到 vector search。

修复后分别处理：

- 完整 SHA 精确匹配
- 7/8 位短 SHA prefix 匹配
- Full/short SHA 冲突与去重

### 2. 默认日期过滤被误当成用户约束

Orchestrator 注入的默认 30 天窗口曾被 Evidence Gate 当成用户显式过滤条件，导致库外或无关请求被错误放行。

修复后 Gate 只接收 Intent Extractor 从用户输入中显式提取的 repo、author、date、risk 等约束。

### 3. Stale Retry 判断不准确

旧逻辑只比较相邻两轮结果数量。相同数量的结果可能是完全不同的 Commit，因此无法判断重试是否获得新证据。

修复后使用 `repo:id` 集合比较，并记录 evidence novelty。

### 4. 最大迭代次数硬编码

Answer Evaluator 中曾存在固定的 `iteration >= 3` 判断，与 `maxIterations` 参数和 Prompt 规则不完全一致。现已统一使用运行时配置，并保证最后一轮不会继续返回无效 RETRY。

### 5. 旧 Semantic Test 不能作为硬门禁

旧测试未命中时只输出 warning，无法阻止回归。新 Harness 将失败写入逐 case 结果，并通过 baseline gate 返回非零退出码。

## 测试与运行方式

从 `src` 目录执行：

```powershell
npm run eval:generate
npm run test:eval
npm run eval:index
npm run eval:lexical
npm run eval:full -- --device cuda
```

生成经过审核的 baseline：

```powershell
node eval/run-eval.js --mode all `
  --write-baseline eval/baselines/public-react-qwen06b-v1.json
```

执行 baseline 对比和门禁：

```powershell
node eval/run-eval.js --mode all `
  --baseline eval/baselines/public-react-qwen06b-v1.json `
  --gate
```

Eval 测试入口当前包含：

- `src/tests/test-eval-metrics.js`
- `src/tests/test-evidence-gate.js`
- `src/tests/test-evidence-gate-orchestrator.js`
- `src/tests/test-agent-eval-runner.js`

## 当前边界

当前结果是工程回归基线，不能外推为真实 RCA 准确率或生产效果 100%。主要限制包括：

1. 当前公开语料只有一个仓库，无法充分验证跨仓库关联和 alias。
2. Frozen test 只有 23 个 case。
3. 部分 `semantic_title` 正例由 Commit 标题确定性改写，难度低于真实用户问题。
4. 缺少人工审核的 incident、multi-hop、causal 和 conversation case。
5. 尚未运行真实 LLM 的完整 Agent 多次采样。
6. 离线 embedding 延迟不等同于线上单请求冷启动和并发性能。
7. 尚未完成数十万级 exact scan 与 ANN/HNSW benchmark。

## 下一阶段

1. 从公开 issue、fix PR、revert 和 release 中建立 30–50 条人工 RCA holdout。
2. 增加 2–3 个公开仓库，覆盖跨仓库 feature 和同短 SHA 边界。
3. 增加文件路径、symbol、错误码和配置文件 case。
4. 接入真实 chat API，运行 frozen test 的 Agent 多次采样。
5. 评估引用忠实度、Retry success/harm、Brier/ECE、P95、token 和成本。
6. 将人工审核后的 badcase 建立为新数据集版本，而不是修改现有 frozen baseline。
7. 在数十万级语料上比较 exact scan 与 ANN/HNSW 的 Recall、P95 和内存占用。

## 最终结果

这轮工作不只是增加了一批测试，而是把 Commit AI Resolver 的评测方式从“依赖不可访问的内部 case 和主观回答判断”，升级为一套具备以下能力的工程化系统：

1. 基于公开语料的可复现验证集。
2. Corpus、case、embedding 与索引契约冻结。
3. Index、Intent、Retrieval、RRF、Answer 和 Agent Loop 分层诊断。
4. Direct、Lexical、Dense 与 Hybrid 的消融对比。
5. SEARCH / ABSTAIN / ASK_USER Evidence Gate。
6. 引用有效性、证据覆盖和幻觉 Commit 的确定性评分。
7. Retry、stale retry、evidence novelty、Brier 和 ECE 评测。
8. 支持并发、重复采样与断点续跑的 Agent batch runner。
9. Baseline 对比、逐 case 报告与 CI smoke gate。
10. 通过 Eval 真实发现并修复 Full SHA、默认日期过滤、stale retry 和最大迭代次数问题。

从代码量计算，本次共完成 3,859 行变更；从能力拆分计算，完成了公开数据集、六层 Eval、Evidence Gate、Answer Scorer、Agent Runner、Baseline/CI 以及产品缺陷修复等主要工作，使离线 Demo 具备了可持续回归和进一步扩展为真实 RCA 评测的基础。
