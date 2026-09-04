# Commit AI Resolver Eval Harness：完整设计说明

> English version: [eval-design.README.en.md](./eval-design.README.en.md)

> **2026-09-04 当前资产口径：** Eval portfolio 共有 **536 个逻辑 case**：`public-react-v3` 的 75 条工程回归 case，以及 `public-react-rca-pilot-v1` 的 461 条 Issue-grounded RCA pilot。`public-react-rca-pilot-v1-time-window-7d-30d` 是同一批 461 条的时间窗口派生视图，不重复计数。RCA pilot 已具备 Issue → closing PR → corpus commit 的机器可验证 provenance，但仍是模型预审、非 gold、不可用于 release gate。完整逐条目录见 [`docs/eval-case-catalog-2026-09-04.md`](../../docs/eval-case-catalog-2026-09-04.md)。

## 1. 背景与问题定义

Commit AI Resolver 是一个面向代码变更检索和回归排查的 Agentic RAG 系统。当前链路不是单一向量搜索，而是：

```text
用户问题
  → Intent Extractor（实体、日期、过滤条件、查询改写）
  → Direct SHA / Dense / FTS5 / Secondary Query / Bug Title
  → Weighted Reciprocal Rank Fusion
  → Answer Synthesizer
  → Answer Evaluator（PASS / RETRY / PARTIAL）
  → 最终回答与证据列表
```

旧版本的质量文档依赖前公司的内部仓库、作者、日期和 commit ground truth。离职后这些数据已经无法访问，因此旧 case 即使保留问题文本，也无法再验证答案是否正确。继续使用它们会产生两个问题：

1. 评测无法复现，失败时无法确认是系统退化还是语料已经消失。
2. 只能评价回答“看起来合理”，无法评价检索证据是否真实存在。

因此本 harness 的第一目标不是立刻制造大量 LLM judge 分数，而是先建立一套可复现、可解释、可定位故障的离线评测闭环。

## 2. 设计目标

Harness 需要回答以下问题：

- 离线 JSON、SQLite metadata、FTS 和 vector index 是否一致？
- Intent Extractor 是否正确保留 repo、author、日期、风险等级和 SHA？
- 正确 commit 是在哪个检索通道丢失的？
- RRF 相比 Dense-only 或 FTS-only 是否真正改善排序？
- 最终回答引用的 commit 是否存在、是否来自检索结果？
- 系统在没有证据时是否拒答，而不是把相似候选当作答案？
- RETRY 是否带来了新证据和质量提升？
- confidence 是否与实际正确率匹配？
- 新的 embedding model、query rewrite、RRF 参数或 prompt 是否导致回归？

设计上强调五个性质：

1. **Reproducible**：语料、case、模型契约和参数都可冻结。
2. **Layered**：Intent、Retrieval、Fusion、Answer、Agent Loop 分开评分。
3. **Evidence-first**：优先评价证据，再评价语言表达。
4. **Deterministic-first**：能用规则验证的内容，不交给 LLM judge。
5. **Regression-oriented**：结果必须能和 baseline 做逐指标、逐类别比较。

## 3. 非目标

当前版本不试图解决以下问题：

- 自动证明某个 commit 是生产事故的唯一根因。
- 用模型生成的问答直接充当未经审核的 gold truth。
- 用一个总分掩盖检索、回答和延迟之间的不同问题。
- 在 GitHub PR 环境下载 1.2 GB 模型和未提交的完整 `data/`。
- 将产品内部 Answer Evaluator 当作独立裁判。

真正的 Incident/RCA 因果标签仍需要人工审核，或者需要可以验证的 issue、fix commit、revert、release 等外部证据。

## 4. 评测对象与边界

Harness 将系统拆成六层：

| 层级 | 评测对象 | 主要失败模式 |
|---|---|---|
| L0 | Corpus 和 Index | 缺行、重复、过期索引、维度不一致 |
| L1 | Intent Extractor | 实体丢失、日期错误、不必要澄清 |
| L2 | Retrieval Channels | 正确 commit 未召回、过滤泄漏 |
| L3 | RRF/Fusion | 通道噪声抬高、正确结果降序 |
| L4 | Answer/Grounding | 幻觉 SHA、遗漏证据、过度因果表述 |
| L5 | Agent Loop/Calibration | 无效重试、错误停止、confidence 失真 |

完整 API E2E 仍然有价值，但它只作为最外层验证。核心 scorer 直接调用模块或读取结构化 trace，以便失败后定位到具体层级。

## 5. 新验证集的来源

### 5.1 当前公开语料

当前工程集 `public-react-v3` 基于 enriched 的本地公开 `facebook/react` commit corpus。`public-react-v1` 和 `public-react-v2` 保持冻结，作为历史快照：

- 27,646 commits
- 3,803 个 daily JSON 文件
- 时间范围：2013-05-28 至 2026-08-09
- 单仓库：`facebook/react`
- Corpus SHA-256：`4c11acc1307f9c3f074f60b537323b3fe8da7ea751c2e17a9cd4e6c6772f6844`

Daily JSON 是 source of truth，SQLite metadata、FTS5 和 sqlite-vec 都是可重建派生物。

### 5.2 为什么使用确定性派生

在没有旧公司标注的情况下，最可靠的初始标签来自可直接验证的数据关系：

- 完整 SHA 对应哪个 commit。
- 某作者在某一天提交了哪些 commit。
- 某日期、repo、riskLevel 过滤后应得到哪些 commit。
- 某个不存在的唯一标识符是否应该产生 lexical/exact match。

这些标签不需要 LLM 猜测，因此适合做 CI 和回归门禁。

### 5.3 Case 组成

工程集生成器使用固定 seed `20260820` 生成 75 条 case；另有独立的 461 条 RCA pilot：

| Category | 数量 | 目的 |
|---|---:|---|
| `exact_sha` | 12 | 验证完整/短 SHA direct lookup |
| `semantic_title` | 18 | 验证标题改写后的语义和词法召回 |
| `author_date` | 10 | 验证 author/repo/date 结构化过滤 |
| `risk_date` | 10 | 验证 risk/repo/date 结构化过滤 |
| `repo_date` | 5 | 验证日期边界和 repo 过滤 |
| `negative` | 5 | 验证不存在标识符的无结果行为 |
| `negative_natural` | 10 | 验证自然语言 OOD 和 Evidence Gate 拒答 |
| `ambiguous` | 5 | 验证 Intent/Evidence Gate 请求澄清 |
| `issue_rca_pilot` | 461 | 验证 Issue-grounded RCA candidate generation、时间窗和 reranking；非 gold |

`semantic_title` 使用有限的确定性词语替换，例如 `fix → resolve`、`add → introduce`。它能测试 query/document 间的轻度语义间隔，但仍可能保留较多原始词汇，因此不应被解释为真实用户分布或高难度 RCA 集。

### 5.4 Gold 数据模型

每条 case 保存：

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

Scorer 已支持 graded relevance 和 optional evidence。当前自动生成 case 的目标 commit 统一标为 `relevance: 3`、`required: true`；未来人工审核的 RCA 集可以加入 1/2/3 级相关性和非必要的辅助证据。

### 5.5 冻结与版本规则

Manifest 同时记录：

- generator 路径和 seed
- corpus 文件数、commit 数、repo、日期范围和 SHA-256
- case 数量、分类分布和 cases JSONL SHA-256
- 标签生成政策

Runner 在执行前重新计算 hash。只要 corpus 或 cases 被静默修改，就会停止，而不是在不同输入上继续比较分数。

现有版本一旦成为 baseline，不应直接编辑。标签政策、语料或采样方式发生变化时，应创建新的 dataset 版本。工程集和 RCA pilot 必须通过 `--dataset` 分开运行，不能混成一个总分。

## 6. L0：数据和索引完整性

Index eval 是完全确定性的第一道门禁，检查：

- Manifest corpus hash 与本地 daily JSON 是否一致。
- Corpus commit 数与 manifest 是否一致。
- `commit_metadata` 行数与 corpus 是否一致。
- FTS 行数与 metadata 是否一致。
- Vector 行数与 metadata 是否一致。
- `repo + shortId` 是否存在重复。
- 是否有 corpus 中存在、index 中缺失的行。
- 是否有 index 中存在、corpus 中已不存在的 stale row。
- 实际 vector byte length 是否与 index contract 的 dimensions 一致。

这些检查必须 100% 通过。检索指标再高，也不能补偿一个内容不完整或模型契约错误的索引。

## 7. L1：Intent Extractor 评测

Intent 预测通过 `--intents predictions.jsonl` 输入：

```json
{"caseId":"sha-001","intent":{"commitIds":["..."],"verdict":"GOOD"}}
```

当前确定性 scorer 评价：

- repo exact match
- author exact match
- dateFrom/dateTo exact match
- riskLevel/changeType exact match
- verdict exact match
- commit ID recall

Intent 层不直接评价 rewrite 文案是否“好听”。更重要的是 rewrite 是否保留约束、是否让后续 retrieval 找到证据。

未来人工 case 应补充：

- 模糊问题的 `ASK_USER` precision/recall
- 不必要澄清率
- incident release buffer 的日期正确率
- repo alias、相对时间和多轮指代
- query rewrite 的下游 retrieval delta

## 8. L2：检索通道评测

Harness 独立评测以下通道：

- **Direct**：commit ID 精确查找。
- **Lexical**：SQLite FTS5，用于标识符、路径、错误码和精确措辞。
- **Dense**：Qwen query embedding + sqlite-vec cosine search。
- **Hybrid**：Dense 和 Lexical 的 RRF，并将 Direct match 放在最前。

产品链路还包含 secondary dense query 和 work-item title channel。当前离线自动集没有 LLM rewrite 或 work item，因此 baseline runner 不伪造这两路；它们通过产品 trace 和未来 E2E case 评测。

### 8.1 指标

对正例计算：

- **Recall@10**：top 10 命中的 gold evidence / 全部 gold evidence。
- **Required Recall@10**：top 10 命中的 required evidence / 全部 required evidence。
- **Precision@10**：top 10 中相关结果占比。
- **MRR@10**：第一个相关结果排名的倒数。
- **nDCG@10**：考虑 graded relevance 和位置折损的排序质量。
- **Hit Rate@10**：至少命中一个相关结果的 case 比例。

对负例计算：

- **No-result Accuracy**：预期 abstain 的 case 是否返回零结果。

负例不进入 Recall/MRR 的宏平均，避免无 gold case 造成无意义的除零或虚高分数。

### 8.2 Metadata filter 的解释

author/date/risk/repo case 的目标是验证结构化过滤集合。对于候选数不超过阈值的过滤结果，vector store 会先 SQL 过滤，再对候选做精确 cosine 排序。这避免全局 KNN 候选挤掉小范围内的正确结果。

任何结果违反指定 repo、author、日期或 risk 条件，都应视为 filter leakage，目标值为 0。

## 9. L3：RRF 与通道归因

Weighted Reciprocal Rank Fusion 的形式是：

```text
RRF(d) = Σ_channel weight(channel) / (k + rank_channel(d))
```

rank 从 1 开始。当前产品默认参数：

- `k = 20`
- dense-primary weight = 1.0
- lexical-fts5 weight = 1.0
- dense-secondary weight = 0.7
- dense-bug-title weight = 1.5

离线 baseline 只融合 dense-primary 和 lexical-fts5，Direct SHA 在融合后去重并置顶。

每个 case 的 `topResults` 保存：

- 各通道原始 rank
- 每个通道的 RRF contribution
- 融合后 rank 和 RRF score
- cosine score
- retrieval channel 列表

这样可以解释一个候选为何上升或下降，而不是只看到最终 top 10。

建议的实验矩阵：

1. FTS-only
2. Dense-only
3. Dense + FTS RRF
4. 加 secondary query
5. 加 bug-title channel
6. `k = 10 / 20 / 40`
7. 调整 channel weights
8. 不同 query rewrite 策略

所有权重选择只能在 dev 集调参，frozen test 只用于最终确认。

## 10. Embedding 评测设计

当前索引契约：

- Model：`Qwen/Qwen3-Embedding-0.6B`
- Dimensions：1024
- Document template version：2
- Query instruction：面向代码 commit、回归、配置变更和生产事故检索
- Document 和 query 均归一化
- Query 与 document 使用非对称预处理

Harness 会从 SQLite `vector_store_meta` 读取契约，并在加载 vector store 前设置同样的模型和维度。查询使用与索引生成器一致的本地模型，防止“用 A 模型建库、用 B 模型查询”的静默错误。

比较 embedding model 时必须同时记录：

- 模型名称和精确版本
- dimensions
- document template version
- query instruction
- normalization
- corpus/case hash
- GPU/CPU 环境
- batch size
- index build time、index size、query latency

模型比较不能只看总体 Recall。至少要按 identifier、semantic、metadata-filter、negative 分类切片。

## 11. Query rewrite 评测

Query rewrite 是 Intent 和 Retrieval 之间的桥梁，容易发生两类问题：

- **Constraint loss**：丢失作者、日期、repo、risk 或具体错误词。
- **Semantic drift**：加入原问题没有的组件或因果假设。

建议为每个 case 同时保存：

- original query
- primary search query
- secondary search query
- extracted filters
- 每个 query 独立的 ranked IDs
- 融合后的 ranked IDs

评价 rewrite 时，以相对原始 query 的 Retrieval delta 为主：

- Recall/MRR 是否提升
- required evidence 是否增加
- filter leakage 是否出现
- secondary query 是否提供新证据

不应仅用另一个 LLM 对 rewrite 文本做主观评分。

## 12. L4：Answer Grounding

回答预测通过 `--responses responses.jsonl` 输入：

```json
{
  "caseId": "semantic-title-001",
  "reply": "The likely change is abc12345 ...",
  "confidence": 0.8,
  "iterations": 2,
  "iterationLog": []
}
```

确定性 scorer 当前检查：

- 回答中的 SHA 是否存在于冻结 corpus。
- 是否引用至少一个 gold commit。
- required evidence coverage。
- hallucinated commit/citation rate。
- negative case 是否在没有 evidence 时避免引用 commit。

未来可增加 metadata claim 验证，例如回答中的 author、date、repo、riskLevel 是否与 commit metadata 一致。

### 12.1 为什么产品 Evaluator 不能作为最终裁判

产品 Answer Evaluator 与生成链路共享 context、prompt 假设和模型家族，并且 fast path 会使用 synthesizer 自报 confidence。若直接把它的 PASS 当成 ground truth，会形成自评闭环。

正确的优先级是：

1. 规则验证 citation 和事实。
2. 用人工 gold 检查 required evidence。
3. 仅对 actionability、表达清晰度、因果校准等主观维度使用独立 judge。
4. 对重要 release case 做人工抽检和 judge agreement 检查。

对于 RCA，必须区分“相关候选”与“已证明根因”。没有 diff、issue、revert 或测试证据时，回答应使用“可能相关”“优先排查”，不能声称确定因果。

## 13. L5：Agent Loop 与重试价值

Orchestrator trace 现在记录：

- 每轮 filters
- ranked results
- embedding/search 时间
- retrieval channels
- evaluator verdict
- retry strategy
- stale retry 事件

Answer scorer 可计算：

- 平均 iterations
- retry rate
- stale retry rate
- 相邻两轮结果集合的 evidence novelty

Evidence novelty 使用相邻结果集合的 Jaccard 距离：

```text
novelty(A, B) = 1 - |A ∩ B| / |A ∪ B|
```

只有“结果数量相同”不能证明 stale，因为同样数量可能是完全不同的候选。产品代码已经改为比较 `repo:id` 集合。

后续有人工 answer gold 后，还应增加：

- Retry success rate：重试后答案质量上升的比例。
- Retry harm rate：重试后答案质量下降的比例。
- Unnecessary retry rate：第一轮已经合格仍然重试。
- Termination correctness：该停止、澄清或返回 PARTIAL 时是否正确。

## 14. 置信度校准

Harness 不把平均 confidence 当作准确率。对带 confidence 的回答计算：

- **Brier Score**：概率预测与 0/1 正确性的平方误差，越低越好。
- **ECE**：不同 confidence bucket 的平均 confidence 与实际准确率差异，越低越好。
- 后续可增加 selective accuracy/coverage 曲线。

这使系统可以回答：如果只返回 confidence ≥ 0.8 的答案，真实准确率是多少；为了达到目标准确率，需要拒答多少问题。

## 15. Negative 与 Abstention

Dense KNN 在没有相似证据时仍会返回最近邻，因此“返回候选”不等于“找到证据”。当前 baseline 清楚显示：

- FTS negative no-result accuracy = 100%
- Dense negative no-result accuracy = 0%
- Hybrid negative no-result accuracy = 0%

这不是简单地把 `topK` 设为 0 就能解决。需要在 dev 集上校准：

- cosine/top-score threshold
- top1-top2 margin
- lexical support
- 多通道 agreement
- answer grounding coverage
- calibrated confidence 和 abstention threshold

在阈值成熟前，negative 指标作为诊断项记录，但尚未加入硬门禁，以免基于 5 条合成负例过拟合。

## 16. 性能与成本

Runner 记录：

- 本地 query embedding batch 总时间
- amortized embedding time/query
- lexical search latency
- dense search latency
- fusion time
- hybrid end-to-end retrieval latency
- p50/mean/p95（当前报告主要展示 mean 和 p95）

当前 query embedding 是批量生成后摊销到每个 case，因此适合比较离线实验，不等价于单请求冷启动 latency。线上性能还需要记录：

- 模型常驻后的单 query latency
- embedding cache hit rate
- Intent/Synthesis/Evaluator 分阶段时间
- token 和模型调用次数
- 并发吞吐与 p99

质量和性能必须分栏报告，不能把响应时间塞进一个总质量分后互相抵消。

## 17. Baseline、对比和门禁

Baseline 是经过审核后有意写入的 `summary.json`，不会自动更新。Candidate 与 baseline 比较时，质量指标正 delta 表示改善，latency 正 delta 表示退化。

当前默认 gate：

- Index integrity 必须通过。
- Hybrid required Recall@10 ≥ 0.85。
- Hybrid MRR@10 ≥ 0.75。
- Answer hallucinated citation rate 必须为 0（提供 response 文件时）。
- 相对 baseline 的 required Recall@10 和 MRR@10 不得下降。

建议的 CI 分层：

| 层级 | 内容 | 频率 |
|---|---|---|
| PR smoke | metrics unit + 临时 SQLite hybrid tests | 每个相关 PR |
| Local retrieval | frozen corpus + FTS/Dense/RRF | 修改检索时 |
| Nightly full | Intent + Retrieval + Answer + calibration | 模型可用环境 |
| Release | frozen test + baseline gate + 人工抽检 | 发布前 |
| Feedback replay | 经审核的 thumbs-down/badcase | 周期性 |

GitHub PR 不包含 `data/` 和本地模型，因此 workflow 只运行确定性 smoke。完整 Qwen baseline 必须在本地或带固定语料和模型缓存的 nightly runner 中运行。

## 18. 当前基线及解释

当前 `public-react-qwen06b-v3` 工程回归基线：

| Channel | Recall@10 | MRR@10 | nDCG@10 | Negative no-result | p95 |
|---|---:|---:|---:|---:|---:|
| Direct | 100.0% | 1.000 | 1.000 | n/a | 0 ms |
| Lexical | 51.2% | 0.514 | 0.466 | 33.3% | 约 56 ms |
| Dense | 76.4% | 0.687 | 0.706 | 0.0% | 约 234 ms |
| Hybrid | 100.0% | 0.930 | 0.945 | 0.0% | 约 290 ms |

解释时应注意：

- Hybrid 的 100% Recall 受 metadata-filter case 和 Direct SHA case 影响，不能外推为真实 RCA 准确率 100%。
- `semantic_title` 与原 commit 标题仍有较高词汇重叠，属于中低难度语义检索。
- Precision@10 偏低并不必然表示失败：单 target case 返回 10 个候选时，理论 precision 就只有 0.1；应结合 MRR/nDCG 和生成上下文预算理解。
- 离线 embedding latency 包含模型启动时间的平均摊销。

## 19. Harness 实际发现的缺陷

本次建设过程中，eval 找到了并推动修复以下问题：

1. `lookupByCommitIds()` 原先只按 8 位 `id` 查询，完整 SHA 会静默退化到 vector search。
2. 完整 SHA 和短 SHA 的冲突语义没有被测试；现已分别做 exact/full 和 prefix/short 处理。
3. Stale retry 原先只比较结果数量；现改为比较 `repo:id` 集合。
4. Answer Evaluator 中最后一轮存在硬编码 `iteration >= 3`，与 `maxIterations` 参数和 prompt 规则不完全一致；现已统一。
5. 旧 semantic tests 在未命中时只打印 warning，不适合作为回归门禁。

这也是分层 harness 的核心价值：它不只给分，还能暴露确定性的产品 bug。

## 20. 有效性威胁与下一阶段

### 当前限制

- 只有一个公开 repo，无法充分评估跨 repo correlation 和 alias。
- 461 条 RCA 已覆盖真实 Issue 正文、closing PR 和 enriched changed files，但尚未逐条完成人工四项 rubric。
- 自动 `semantic_title` 不是独立人工 query。
- Negative case 数量较少且是合成标识符。
- 尚无可用于 release gate 的人工审核 RCA gold；461 条是模型预审 pilot，不等于人工因果标注。
- 产品 Intent/Answer 全链路需要配置实际 LLM 后输出预测文件，当前 baseline 主要覆盖 index/retrieval。

### 推荐路线

1. 对现有 461 条 RCA pilot 完成人工四项 rubric，产出独立、可门禁的 reviewed RCA dataset。
2. 增加至少 2–3 个 repo，覆盖跨 repo feature 和同短 SHA 边界。
3. 增加文件路径、symbol、错误码和配置文件 case。
4. 保持当前 75 条工程集的 52/23 split，以及 RCA 的 commit-grouped 327/134 split；RRF、时间窗和 threshold 只在 dev 调参。
5. 校准 abstention，加入 negative release gate。
6. 接入实际 Intent 和 Answer 预测，形成 nightly full-pipeline eval。
7. 将人工审核后的 thumbs-down 转成新版本 badcase，而不是直接把用户反馈当 gold。

## 21. 文件与运行方式

主要文件：

```text
src/eval/
├── generate-cases.js                 # 确定性验证集生成器
├── run-eval.js                       # Index/Retrieval/Intent/Answer runner
├── embed-queries.py                  # 本地 Qwen query embedding
├── lib/corpus.js                     # Corpus 加载、hash、稳定采样
├── lib/metrics.js                    # 排序、校准和 baseline 指标
├── datasets/public-react-v3/         # 75 条工程回归 cases
├── datasets/public-react-rca-pilot-v1/ # 461 条模型预审 RCA cases
├── baselines/                        # 审核后的 baseline
├── fixtures/                         # Intent/Answer 输入格式示例
└── reports/                           # 生成报告，不作为 ground truth
```

从 `src` 目录运行：

```powershell
npm run eval:generate
npm run test:eval
npm run eval:index
npm run eval:lexical
npm run eval:full -- --device cuda
```

生成 baseline：

```powershell
node eval/run-eval.js --mode all `
  --write-baseline eval/baselines/public-react-qwen06b-v2.json
```

执行对比和门禁：

```powershell
node eval/run-eval.js --mode all `
  --baseline eval/baselines/public-react-qwen06b-v2.json `
  --gate
```

评测 Intent 和 Answer 输出：

```powershell
node eval/run-eval.js --mode lexical `
  --intents path/to/intents.jsonl `
  --responses path/to/responses.jsonl
```

每次运行输出 `summary.json`、`case-results.jsonl`、可选的 intent/answer details 和 `report.md`。Baseline 只有在人审 category-level 变化合理后才应更新。

