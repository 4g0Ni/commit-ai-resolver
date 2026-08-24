# System Prompt 工作总结（2026-08-24）

## 总览

今天完成了 Commit AI Resolver 的一轮 System Prompt 与 Agent Prompt 基础设施升级，覆盖安全隔离、结构化输出、Prompt 精简、评测体系、版本管理、A/B 实验、自动回滚、SQLite 遥测和 Metrics UI。

对应 Git 提交：

- Commit：`8679219f9d74634d03a51b33cfb7459b58fc4f86`
- Commit message：`system prompt`
- 提交时间：2026-08-24 17:09:44 +08:00
- 涉及文件：26 个
- 新增文件：14 个
- 修改文件：12 个
- 新增代码：2,336 行
- 删除代码：1,016 行
- 净增加：1,320 行
- 总变更行数：3,352 行

## P0：Prompt 安全性与输出可靠性

### 1. 隔离不可信上下文

- 将用户 query、对话 history、work item、commit metadata、commit summary、源代码和 diff 统一视为不可信数据。
- 不再把动态业务数据直接拼接进 System Prompt。
- System Prompt 仅保留任务定义、安全边界和输出契约。
- 新增共享的 `UNTRUSTED_DATA_NOTICE`，防止 commit message、diff 或工单描述中的 Prompt Injection 被模型当成指令执行。

主要文件：

- `api/agents/prompt-utils.js`
- `api/agents/intent-extractor.js`
- `api/agents/answer-synthesizer.js`
- `api/agents/answer-evaluator.js`
- `api/agents/diff-investigator.js`

### 2. 统一 Structured Output

- Intent Extractor 使用严格 JSON Schema。
- Answer Evaluator 使用严格 JSON Schema。
- Answer Synthesizer 使用严格 JSON Schema。
- Diff Investigator 使用严格 JSON Schema。
- 对不支持 `response_format: json_schema` 的 OpenAI 兼容服务进行一次自动降级，并缓存 provider 能力，避免后续重复失败。
- 增加稳健的 JSON 对象解析，能够处理代码围栏、额外文本以及字符串内部的大括号。

### 3. 流式输出安全

- 流式 Synthesizer 不再把原始 JSON 输出给前端。
- 增量解析 JSON 中的 `answer` 字符串，只把用户可读答案发送给 UI。
- 对不支持 Structured Output 的流式 provider 保留 delimiter fallback。
- 流式与非流式路径共用同一套 metadata 校验逻辑。

### 4. 防止模型虚构证据

- Reject 不在检索结果中的 commit ID。
- Commit 链接必须使用检索证据中的真实 URL，模型提供的错误链接会被规范化。
- Diff Investigator 只能选择实际传入的 suspect commit。
- 根据结果数量和检索渠道，对 `confidence` 和 `searchCoverage` 施加确定性上限。
- 修复最后一次迭代仍返回 RETRY 的问题，最后一轮会确定性返回 PARTIAL。

## P1：Prompt 质量、上下文效率与评测

### 1. Commit Summary Prompt 精简

- 将原来约 12,000 字符的 Commit Summary Prompt 拆分并精简到约 3,425 字符。
- 保留风险等级、config/pilot、测试文件、构建脚本、package.json、设计文档和仓库特定规则。
- Prompt 独立到 `src/prompts/commit-summary-prompt.js`。
- 当前版本为 `commit-summary-v2`。

### 2. 领域知识按需注入

- 不再把整个 `docs/domain/<repo>.md` 注入每次请求。
- 根据 changed files 和 commit message 对 Markdown 章节进行 token overlap 排序。
- 最多选择 5 个相关章节。
- 注入字符预算限制为 6,000 字符。
- 缺少领域文档时安全返回空上下文。

主要文件：`src/services/domain-knowledge.js`。

### 3. Prompt 版本化

今天使用或建立的稳定版本包括：

| Agent | Stable version | Candidate version |
|---|---|---|
| Intent Extractor | `intent-v3` | `intent-v3-candidate1` |
| Answer Synthesizer | `synthesizer-v4` | `synthesizer-v4-candidate1` |
| Answer Evaluator | `evaluator-v2` | `evaluator-v2-candidate1` |
| Diff Investigator | `diff-investigator-v3` | `diff-investigator-v3-candidate1` |
| Commit Summary | `commit-summary-v2` | `commit-summary-v2-candidate1` |
| Full-context fallback | `fallback-v1` | `fallback-v1` |

### 4. 第一版 Golden Eval

- 新增 10 个 Golden Eval 案例。
- 覆盖中文查询、作者、上周日期解析、仓库别名、risk filter、commit SHA、模糊问题、追问上下文、work item 和 Prompt Injection。
- 固定 reference date，避免相对日期测试随运行日期漂移。
- 新增最低通过率和最大允许回退幅度。
- 默认最低通过率为 80%，最大允许回退为 5%。
- 新增真实模型执行脚本，可输出逐案例 JSON 报告。

相关文件：

- `src/evals/prompt-golden.json`
- `src/evals/prompt-golden-baseline.json`
- `api/scripts/run-prompt-golden.js`

## P2：Prompt 运维、实验与可观测性

### 1. 统一 Prompt Registry

- 新增 `src/prompts/prompt-registry.js`。
- 所有 Agent 的 stable/candidate 版本集中管理。
- Agent 文件不再各自硬编码独立版本字符串。
- Registry 可以返回当前版本、候选流量、回滚状态和回滚原因。

### 2. A/B 实验分流

- 使用 query/correlation ID 做确定性 hash 分桶。
- 同一个请求种子始终进入相同 variant，便于复现。
- 每个 Agent 可以独立配置 candidate 百分比。
- Candidate Prompt 包含可实际影响输出策略的实验规则，而不只是更改版本号。

配置示例：

```powershell
$env:PROMPT_EXPERIMENTS='{"answer-synthesizer":10,"intent-extractor":5}'
```

### 3. Kill switch 与自动回滚

- `PROMPT_EXPERIMENT_KILL_SWITCH=1`：立即强制所有 Agent 使用 stable Prompt。
- Candidate 连续模型错误、解析错误或负反馈达到阈值后自动回滚。
- 默认阈值为 3，可通过 `PROMPT_AUTO_ROLLBACK_FAILURES` 调整。
- 回滚状态写入 SQLite `prompt_experiment_state`，服务重启后仍然有效。
- 如需清除持久化回滚状态，可启动一次 `PROMPT_EXPERIMENT_RESET_ROLLBACKS=1`。

### 4. 逐 Agent Prompt 遥测

SQLite 新增 `prompt_events` 表，记录：

- query ID 与 iteration
- Agent 名称
- Prompt version 与 variant
- Structured Output 是否成功
- 是否发生 provider fallback
- 是否发生 parse error
- 被拒绝的候选 ID 数量
- Agent elapsed time
- prompt tokens
- completion tokens
- total tokens
- 用户正负反馈关联

同时保留 query 级别的 `prompt_versions` 和 `prompt_metrics` JSON，兼容已有 Metrics 结构。

### 5. Metrics UI

Metrics 面板新增：

- Structured Schema Calls
- Structured Output Fallback Rate
- Parse Errors
- Rejected Candidate IDs
- Prompt Tokens / Completion Tokens
- 每个 Agent 的版本、variant、调用次数和平均耗时
- 当前 candidate 流量
- Kill switch / 自动回滚状态与原因

主要文件：`ui/src/components/UsageMetrics.jsx`。

### 6. CI Prompt Quality Gate

新增 `.github/workflows/prompt-quality.yml`：

- Prompt 相关文件变化时自动运行离线门禁。
- 校验 Prompt Registry、Golden 数据集、Agent Prompt 行为和 SQLite 遥测。
- 支持通过 `workflow_dispatch` 手动运行 Live Golden Eval。
- 配置 `OPENAI_API_KEY` 后比较真实模型结果与基线阈值。
- 上传 `prompt-eval-result.json` artifact，便于对比 Prompt 版本。

## 删除和收敛的重复逻辑

- 删除 `api/server.js` 中旧的重复 Intent Extraction Prompt。
- 删除 server 和 orchestrator 中重复的 full-context System Prompt。
- Streaming 与 non-streaming Synthesizer 共享 Prompt 和 normalization。
- Commit Summary Prompt 从 service 文件中迁移到专用 prompt module。
- A/B compare script 与生产 summarizer 共用领域知识选择逻辑。

## 测试与验证

今天相关测试共通过 185 项：

| 测试 | 通过数 |
|---|---:|
| Prompt Registry | 6 |
| Golden Eval schema/baseline | 49 |
| Prompt Metrics SQLite | 4 |
| Agent Prompt 安全与结构化输出 | 20 |
| Domain Knowledge | 5 |
| Commit Summarizer | 65 |
| Hybrid Search | 11 |
| Commit Paths | 25 |
| **合计** | **185** |

其他验证：

- `git diff --check` 通过。
- `UsageMetrics.jsx` 单文件 ESLint 通过。
- UI production build 通过，共转换 212 个模块。
- API 启动成功。
- `GET /api/days` 返回 HTTP 200。
- `GET /api/metrics/usage` 返回 HTTP 200，并包含 Prompt Registry 与 Prompt Breakdown。

## 当前仍需外部条件完成的事项

### 1. 真实模型基线

当前环境没有配置 `OPENAI_API_KEY` 或 `OPENAI_BASE_URL`，因此尚未生成真实模型参考通过率。基线文件目前只有 80% 的最低门槛和 5% 的最大回退预算。

配置模型后执行：

```powershell
npm run eval:prompts --prefix api -- --output prompt-eval-result.json
```

确认结果后，可显式更新参考基线：

```powershell
npm run eval:prompts --prefix api -- --update-baseline
```

### 2. 人工标注数据集

当前 Golden Eval 是工程种子案例，还需要 DRI 或真实用户确认预期结果，并逐步加入线上失败问题、低评分回答和典型事故调查案例。

### 3. 既有 UI lint 问题

本次修改的 Metrics 组件 ESLint 已通过，但 UI 全量 lint 仍会报告已有的 `api.js`、`ChatBox.jsx`、`DateRangePicker.jsx` 和 `Timeline.jsx` 问题；这些问题不属于本次 System Prompt 修改。

## 最终结果

今天的工作不只是修改 Prompt 文本，而是把 Commit AI Resolver 的 Prompt 系统从“分散的字符串和宽松解析”升级为一套具备以下能力的工程化系统：

1. 不可信数据隔离与 Prompt Injection 防护。
2. 严格结构化输出和 provider 兼容降级。
3. 确定性证据校验与置信度约束。
4. Prompt 集中版本管理。
5. Golden Eval 与 CI 回归门禁。
6. Stable/candidate 实验分流。
7. Kill switch、负反馈检测和持久化自动回滚。
8. 逐 Agent token、延迟、错误与版本可观测性。
9. Metrics UI 中的 Prompt 运维视图。

从代码量计算，本次共完成 3,352 行变更；从功能拆分计算，完成了 9 个主要能力方向、20 余项具体 Prompt/Agent 改造，并建立了 185 项相关自动验证。
