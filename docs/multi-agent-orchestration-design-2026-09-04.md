# Commit AI Resolver Multi-Agent Orchestration 详细设计

> 状态：Proposed
>
> 日期：2026-09-04
>
> 目标读者：项目开发者、评审者、面试官
>
> 实施原则：保留已经通过真实 RCA eval 验证的数据面，以可回滚方式替换控制面

---

## 文档导航

- 1–5：现状、目标、原则与框架决策
- 6–7：目标架构与四类 Agent 的责任边界
- 8–10：工具层、Run State、数据契约与控制循环
- 11–15：预算、API/SSE、可观测性、Prompt、安全与可靠性
- 16–17：Eval 和测试策略
- 18–19：文件级改造清单与 Phase 0–6 实施步骤
- 20–27：上线回滚、风险、备选方案、面试演示和完成标准

---

## 1. 摘要

Commit AI Resolver 当前已经包含多个由 LLM 驱动的处理阶段，但整体仍是固定 workflow：

1. Intent Extractor 提取搜索条件。
2. 代码固定执行 dense、lexical、secondary query 和 title query。
3. Evidence Gate 决定继续、澄清或拒答。
4. 可选 Reranker 重排候选。
5. Answer Synthesizer 生成回答。
6. Answer Evaluator 决定 PASS、PARTIAL 或 RETRY。
7. 固定 for 循环最多重复三次。

这套设计具有良好的可控性和 eval 表现，但 LLM 只负责填写结构化参数、生成内容和给出 retry 建议，并不拥有真正的流程控制权。特别是深度 diff 调查仍由单独的 API 和用户按钮触发，无法由模型根据当前证据自主决定是否执行。

本设计将系统改造成一个受约束的 Supervisor + Specialist Agents 架构：

- Incident Commander / Supervisor 负责理解任务并动态选择下一步。
- Retrieval Agent 负责制定和迭代候选检索策略。
- Diff Investigator Agent 负责选择需要读取的 diff、构建根因假设。
- Evidence Critic Agent 负责寻找反证、检查因果链和决定是否需要更多证据。
- 现有 vector search、FTS5、RRF、commit lookup、diff fetch、Evidence Gate 和所有 ID 校验仍然是确定性工具或 guardrail。
- Supervisor 可以根据问题类型选择不同的 Agent、调用顺序、并行度和重试路径。
- 每次执行的真实 trajectory 会被本地记录并进入 eval。

推荐使用 OpenAI Agents SDK 的 manager/agents-as-tools 模式作为第一版运行时。它的 Agent loop 允许模型通过 tool call 决定调用哪个 Specialist，同时仍能由应用代码设置最大 turn 数、工具权限、结构化输入输出和中止条件。

本改造的成功标准不是“代码里出现多个 Agent 类”，而是：

1. 对不同问题产生不同且合理的执行轨迹。
2. LLM 对 Agent 选择和下一步拥有真实决策权。
3. 确定性安全边界不可被 Agent 绕过。
4. 现有最终答案质量和检索指标不退化。
5. Agent 路由质量、恢复能力、成本和延迟可以独立评测。

### 1.1 当前实施状态（2026-09-04）

第一条可运行 vertical slice 已完成：

- 已接入 `@openai/agents` 0.17.0，使用 Chat Completions provider 兼容现有 endpoint。
- 已实现 Incident Commander、Retrieval、Diff Investigator 和 Evidence Critic 四个真实 SDK Agent。
- Specialist 以 agents-as-tools 暴露给 Supervisor，由模型通过 tool call 决定路径。
- 已实现独立 Agent Harness：request-local context、工具白名单、agent/tool/diff/wall-clock budget、去重、超时、candidate ledger、输出校验、本地 trajectory 和 legacy fallback。
- 已抽取共享 `commit-search-service.js` 与 `commit-diff-service.js`，新旧路径可共享数据面。
- `/api/chat` 的 JSON 与 SSE 均支持 feature flag 路由，默认仍为 `workflow`。
- 已有 deterministic SDK scripted tests，以及使用本地 OpenAI-compatible mock provider 的真实 HTTP/tool-call E2E。
- 已完成一次真实 DeepSeek + 本地 Qwen3 Embedding + GitHub public diff 的 gold RCA：Supervisor 自主调用 Retrieval、Diff Investigator 和 Evidence Critic，命中目标 commit，并由 Critic 将“精确修复机制、但未找到引入提交”的结论约束为 `PARTIAL`。
- 已增加 compatible-provider structured-output adapter：原生 OpenAI 使用 `json_schema`；DeepSeek 等端点使用 `json_object`、本地 JSON 解析和 Zod 二次校验。DeepSeek 的 required tool call 同时显式关闭 thinking mode。
- `commit-diff-service` 在 ADO 之外支持只读 GitHub REST commit diff；固定 API 域名、严格校验 repo/SHA、限制响应大小，并支持可选的服务端 `GITHUB_TOKEN`。
- eval/debug 响应公开 bounded trajectory、prompt metrics 和结构化 critic verdict；SSE 在 `x-eval-harness: 1` 时额外发送 `trace` 事件，默认客户端协议保持不变。

尚未完成的后续工作主要是 trajectory eval 数据集、shadow/A-B 报告、MCP 共享 service 迁移、multi-agent 真正的逐 token 流式输出，以及更多生产 provider 的系统化校准。

---

## 2. 背景与问题

### 2.1 当前系统的优点

现有实现中已经有大量应当保留的工程资产：

- api/agents/intent-extractor.js
  - 结构化提取 repo、author、日期、risk、change type、commit ID 和查询重写。
  - 已处理多轮历史、work item 和 query specificity。
- src/services/vector-store.js
  - 提供 dense、FTS5、metadata filter 和 commit ID lookup。
- src/services/rank-fusion.js
  - 提供多路检索的 Reciprocal Rank Fusion。
- api/agents/commit-reranker.js
  - 提供可选的 LLM final-stage reranking。
- src/services/evidence-gate.js
  - 在生成回答前执行确定性的 evidence sufficiency 判断。
- api/agents/answer-synthesizer.js
  - 生成带候选引用、置信度和 suggested actions 的回答。
- api/agents/answer-evaluator.js
  - 提供 PASS、RETRY、PARTIAL 判定。
- api/agents/diff-investigator.js
  - 已有基于真实 diff 的根因分析 prompt、输出 schema 和候选 ID 校验。
- api/mcp.js
  - 已经暴露 search_commits、get_commit、get_commit_diff、list_commits_by_filter 等 Agent 可用工具。
- src/eval/
  - 已有冻结数据集、retrieval metrics、grounded answer scoring、RCA pilot 和回归比较工具。
- api/db.js
  - 已能记录 iteration log、prompt events、tokens、latency 和用户反馈。

这些模块构成可靠的数据面和质量基础，不应在 multi-agent 改造中重写。

### 2.2 当前设计为什么仍是 workflow

当前 api/agents/orchestrator.js 使用固定 for 循环和固定阶段顺序。模型能够：

- 改写 search query；
- 输出 secondary query；
- 给出 rerank；
- 判断回答质量；
- 提供 retryStrategy。

但模型不能：

- 跳过不必要的阶段；
- 主动进入 diff investigation；
- 在多个 repo 间拆分调查任务；
- 同时委派多个专业 Agent；
- 根据新证据改变 Agent 调用顺序；
- 主动寻找反证；
- 在一个 Agent 完成后选择另一类 Specialist；
- 形成可被单独评价的动态 execution plan。

因此，当前更准确的描述是“包含多次 LLM 调用的迭代 workflow”，不是“LLM 决定执行路径的 multi-agent system”。

### 2.3 要解决的核心问题

改造必须同时解决三个目标之间的张力：

1. Agentic：让模型真实决定下一步，而不是只给固定 pipeline 填参数。
2. Reliable：不能因为引入自治控制就失去 Evidence Gate、引用校验和预算限制。
3. Evaluatable：不能只展示一次漂亮 demo，必须证明路由决策和最终质量可重复评测。

---

## 3. 目标与非目标

### 3.1 目标

- 支持由 Supervisor 动态调用一个或多个 Specialist Agent。
- 支持因问题类型不同而产生不同轨迹。
- 支持 RCA 查询自动进入 diff investigation，不再要求用户点击第二个按钮。
- 支持 Supervisor 在证据不足时重新检索、扩大日期、换查询词或请求澄清。
- 支持对多个候选或 repo 进行有上限的并行调查。
- 支持独立的反证检查和因果审查。
- 复用现有检索、排序、Evidence Gate、diff filter、prompt registry 和 eval。
- 保持现有 POST /api/chat 的 JSON 与 SSE 客户端兼容。
- 保留现有 workflow 作为 baseline 和运行时 fallback。
- 本地记录完整 trajectory，不默认向远程 telemetry 服务发送输入、diff 或输出。
- 对最终答案质量和 Agent trajectory 同时进行回归评测。

### 3.2 非目标

- 不让 Agent 修改、revert、merge 或部署代码。
- 不让 Agent 写入 Azure DevOps、GitHub 或生产系统。
- 不把 dense search、FTS5、RRF 分别包装成 Agent。
- 不在第一版引入长期后台任务、队列或跨进程恢复。
- 不在第一版删除现有 orchestrator。
- 不要求把 JavaScript 项目迁移为 TypeScript。
- 不把所有确定性判断替换为 LLM。
- 不使用 Agent 自评作为唯一 release gate。
- 不把 multi-agent 名称作为成功标准；没有动态路由质量提升就不默认上线。

---

## 4. 设计原则

### 4.1 Agent 和工具的边界

一个组件只有在同时具备独立目标、独立上下文、独立工具权限和多步推理责任时才应成为 Agent。

适合做 Agent：

- 制定检索策略并根据结果调整搜索方向。
- 选择需要分析的 diff 并构建因果假设。
- 独立寻找反证并挑战当前结论。

适合做工具：

- 执行向量搜索。
- 执行 FTS5 搜索。
- 根据 commit ID 查记录。
- 获取某个 commit 的 diff。
- 计算 RRF。
- 校验 Evidence Gate。
- 校验 commit ID、repo、日期和 URL。

### 4.2 模型控制策略，代码控制边界

LLM 可以决定：

- 选择哪个 Specialist。
- 给 Specialist 什么任务。
- 是否需要并行调查。
- 是否需要再次调用同一个 Specialist。
- 是否已经有足够证据生成回答。

应用代码必须控制：

- 哪些工具可用。
- 工具参数 schema。
- repo allowlist。
- 最大 turns、最大调用数、最大 diff 字节数。
- 超时、重试和取消。
- Evidence Gate。
- 引用和候选 ID 校验。
- 远程 telemetry 是否启用。
- 达到预算后的强制终止行为。

### 4.3 数据面和控制面分离

- 数据面：现有 search、RRF、rerank、diff fetch、evidence scoring。
- 控制面：Supervisor 选择 Specialist 和执行顺序。

第一阶段只应替换控制面，避免同时更改检索算法和 Agent 路由，导致 eval 结果无法归因。

### 4.4 最小上下文原则

- Supervisor 只接收候选摘要、Agent 结论和预算状态，不接收全部 diff。
- Retrieval Agent 不接收无关 diff。
- Investigator 只接收指定候选及有限历史。
- Critic 接收规范化 hypothesis ledger 和引用证据，而不是所有中间消息。
- 完整对象保存在服务端 run state，通过 ID 引用，避免在 Agent 间重复复制。

### 4.5 可降级和可回滚

任何新 Agent、SDK、provider、schema 或工具调用失败，都必须能够：

- 在当前 run 内返回受控错误给 Supervisor；或
- 终止 multi-agent run 并切换到现有 workflow；或
- 明确 abstain。

不允许因 Specialist 失败而生成无证据答案。

---

## 5. 框架决策

### 5.1 第一版选择：OpenAI Agents SDK

采用 manager/agents-as-tools，而不是让各 Agent 通过 handoff 永久接管用户会话。

原因：

- Supervisor 需要始终掌握最终答案和用户对话。
- Specialist 的输出应返回给 Supervisor，而不是直接回复用户。
- Agent loop 原生支持通过 tool call 动态选择下一步。
- Agent 可作为工具暴露给 Supervisor。
- 支持 streaming、tool events、agent lifecycle 和 deterministic test doubles。
- 当前项目已经是 Node ESM，并已依赖 Zod。
- 可以使用 Chat Completions provider，以适配现有 OpenAI-compatible endpoint。

官方参考：

- https://openai.github.io/openai-agents-js/guides/multi-agent/
- https://openai.github.io/openai-agents-js/guides/tools/
- https://openai.github.io/openai-agents-js/guides/streaming/
- https://openai.github.io/openai-agents-js/guides/testing/
- https://openai.github.io/openai-agents-js/guides/models/

### 5.2 Provider 兼容策略

当前 api/package.json 使用 openai ^6.33.0。Agents SDK 官方文档指出，如果向 SDK 直接提供自定义 OpenAI client，需要 openai 7.2 或更高版本。

第一版推荐：

1. 不向 Agents SDK 注入当前 openaiApiClient。
2. 在 agent-runtime.js 中创建独立 OpenAIProvider。
3. 使用现有 OPENAI_API_KEY、OPENAI_BASE_URL、OPENAI_MODEL 和 OPENAI_FAST_MODEL。
4. 设置 useResponses: false，继续走 Chat Completions。
5. 对目标 OpenAI-compatible provider 单独运行 tool calling、structured output 和 streaming contract test。
6. 等 multi-agent 行为稳定后，再单独评估 openai SDK 主版本升级。

实际兼容层按 endpoint 能力选择结构化输出模式：

- `json_schema`：用于支持原生 Structured Outputs 的 provider，由 SDK 直接执行 schema 约束。
- `json_object`：用于 DeepSeek 等只支持 JSON Object 的 provider；prompt 注入完整 JSON schema，返回后在本地执行容错 JSON 提取和 Zod 校验，因此 provider 能力降级不会降低应用侧数据契约。
- `AGENT_STRUCTURED_OUTPUT_MODE=auto|json_schema|json_object` 可显式覆盖自动判断，便于 provider contract test 和故障排查。
- DeepSeek thinking mode 不接受 `tool_choice=required`，因此 required specialist delegation 会携带 `thinking: { type: "disabled" }`。

这样可以把“Agent 架构改造”和“底层 OpenAI SDK 升级”拆成两个可归因变更。

### 5.3 为什么第一版不选 LangGraph

LangGraph 很适合：

- 持久化 state 和 checkpoint；
- 跨请求恢复；
- human-in-the-loop interrupt；
- 长时间运行；
- 显式图和复杂并行 fan-out。

但当前请求属于短生命周期、本地只读 RCA，会话状态已经由应用传入，第一版不需要 durable execution。使用 Agents SDK 能以更少的运行时代码证明“模型通过 tool call 决定 Agent 流程”。

如果后续出现以下需求，应重新评估 LangGraph：

- 一个调查需要持续几分钟以上并跨进程恢复；
- 需要人工审批后继续；
- 需要 time travel 或 replay checkpoint；
- 需要大规模动态 fan-out；
- 需要把 Supervisor 的每个决策显式建模为图节点。

参考：

- https://docs.langchain.com/oss/javascript/langgraph/graph-api
- https://docs.langchain.com/oss/javascript/langgraph/persistence

---

## 6. 目标架构

### 6.1 总体架构

~~~mermaid
flowchart TD
    Client["UI / REST / MCP Client"] --> API["POST /api/chat"]
    API --> Mode{"AGENT_ORCHESTRATION_MODE"}

    Mode -->|"workflow"| Legacy["现有 agenticSearch"]
    Mode -->|"multi_agent"| Runtime["Agent Runtime"]

    Runtime --> Supervisor["Incident Commander"]
    Supervisor -->|"call as tool"| Retrieval["Retrieval Agent"]
    Supervisor -->|"call as tool"| Investigator["Diff Investigator Agent"]
    Supervisor -->|"call as tool"| Critic["Evidence Critic Agent"]

    Retrieval --> SearchTools["Commit Search Tool Service"]
    Investigator --> DiffTools["Commit Diff Tool Service"]
    Critic --> EvidenceTools["Evidence Validation Tool Service"]

    SearchTools --> Vector["Vector Store / FTS5 / RRF"]
    DiffTools --> ADO["ADO read-only APIs / Diff Filter"]
    EvidenceTools --> Gate["Deterministic Evidence Gate"]

    Runtime --> Events["Local trajectory events"]
    Events --> SQLite["feedback.db"]
    Events --> SSE["Existing SSE status/token/complete"]

    Runtime -->|"runtime failure"| Legacy
~~~

### 6.2 动态流程

~~~mermaid
stateDiagram-v2
    [*] --> Supervisor
    Supervisor --> AskUser: 信息不足
    Supervisor --> Retrieval: 需要候选
    Supervisor --> Investigator: 已有明确 commit
    Supervisor --> Critic: 已有可审查假设
    Supervisor --> Final: 证据充分
    Supervisor --> Abstain: 无可靠证据或预算结束

    Retrieval --> Supervisor: CandidateSet
    Investigator --> Supervisor: HypothesisLedger
    Critic --> Supervisor: VerificationResult

    Supervisor --> Retrieval: 改写查询或扩大范围
    Supervisor --> Investigator: 调查新候选
    Supervisor --> Critic: 审查更新后的假设

    AskUser --> [*]
    Final --> [*]
    Abstain --> [*]
~~~

### 6.3 典型轨迹

#### 普通变更查询

~~~text
Supervisor
  -> Retrieval Agent
  -> deterministic evidence gate
  -> Supervisor final answer
~~~

#### 明确 commit 解释

~~~text
Supervisor
  -> Diff Investigator Agent(commit ID)
  -> Supervisor final answer
~~~

#### 事故 RCA

~~~text
Supervisor
  -> Retrieval Agent
  -> Diff Investigator Agent(top candidates)
  -> Evidence Critic Agent
  -> Supervisor final answer
~~~

#### 多 repo 事故

~~~text
Supervisor
  -> Retrieval Agent
  -> choose investigation tasks for repo A and repo B
  -> bounded parallel dispatch
       -> Diff Investigator(repo A)
       -> Diff Investigator(repo B)
  -> merge hypotheses
  -> Evidence Critic
  -> Supervisor final answer
~~~

#### 证据不足

~~~text
Supervisor
  -> Retrieval Agent
  -> Evidence Gate returns weak evidence
  -> Supervisor chooses:
       a. ask user
       b. retry with a concrete new query
       c. abstain
~~~

### 6.4 Agent Harness：SDK 外的运行时控制层

Agents SDK 提供 agent loop、tool calling、agents-as-tools 和结构化输出，但 SDK 本身不等于本项目的 Harness。Harness 是包围 SDK 的应用运行时，负责模型不能自行决定的安全与可运维边界。

~~~mermaid
flowchart LR
    LLM["LLM requests a tool"] --> Schema["SDK / Zod schema validation"]
    Schema --> Permission["Harness permission check"]
    Permission --> Budget["Agent / tool / diff / time budget"]
    Budget --> Ledger["Candidate-ledger authorization"]
    Ledger --> Dedupe["Duplicate-call cache"]
    Dedupe --> Timeout["Per-call timeout"]
    Timeout --> Execute["Execute shared service"]
    Execute --> Sanitize["Bound and sanitize output"]
    Sanitize --> Record["Local trajectory event"]
    Record --> LLMResult["Return result to calling Agent"]
~~~

#### 6.4.1 Harness 与 Agents SDK 的职责边界

| 能力 | Agents SDK | 项目 Harness |
|---|---|---|
| Agent loop / tool-call protocol | 提供 | 复用，不重写 |
| Manager / agents-as-tools | 提供 | 配置专家和调用权限 |
| Tool 参数 schema | 提供 Zod 校验 | 增加业务授权和 ledger 校验 |
| 最大 model turns | 提供 | 与 agent/tool/diff/time budget 联合执行 |
| Remote tracing | 默认可用 | 默认明确关闭 |
| 本地 trajectory | 不负责项目 schema | 记录并映射到现有 iterationLog / SQLite |
| Candidate grounding | 不理解业务 ID | 只有检索工具返回的候选才能读取 diff 或出现在引用中 |
| Legacy fallback | 不负责 | primary 失败后切换现有 workflow |
| Provider policy | 支持 provider | 强制 Chat Completions 兼容路径和本地配置 |

#### 6.4.2 代码结构

~~~text
api/agents/harness/
  agent-harness.js          # 顶层 run、deadline、Runner 边界
  run-context.js            # request-local state、CandidateLedger
  tool-registry.js          # least-privilege allowlist
  tool-middleware.js        # permission/budget/dedupe/timeout/validation
  budget-manager.js         # agent/tool/diff/wall-clock counters
  trajectory-recorder.js    # bounded local events + SSE adapter
  output-validator.js       # citation grounding、置信度上限、safe actions
  fallback-controller.js    # multi-agent -> legacy workflow
~~~

#### 6.4.3 权限矩阵

| Caller Agent | Allowed tools |
|---|---|
| `retrieval-agent` | `get_index_stats`, `search_commits`, `lookup_commits` |
| `diff-investigator-agent` | `get_evidence_snapshot`, `get_commit_diff` |
| `evidence-critic-agent` | `get_evidence_snapshot`, `search_counter_evidence` |
| `incident-commander` | `delegate_commit_retrieval`, `delegate_diff_investigation`, `delegate_evidence_critique` |

权限在注册表和每次执行时各检查一次。即使模型构造出合法 JSON，也不能让 Investigator 拉取 Candidate Ledger 之外的 commit diff。

#### 6.4.4 默认预算

| Budget | Default |
|---|---:|
| Supervisor max turns | 8 |
| Agent calls | 6 |
| Tool calls | 14 |
| Diff fetches | 3 |
| Wall-clock deadline | 75 秒 |

相同 tool + 相同参数的只读调用可以命中 request-local dedupe cache，不再次消耗底层服务调用。预算或权限错误以安全、结构化的 tool result 返回给模型，使 Supervisor 可以选择 partial、ask-user 或停止；顶层运行时异常则由 Fallback Controller 处理。

---

## 7. Agent 详细设计

### 7.1 Incident Commander / Supervisor

#### 职责

- 保持完整用户会话。
- 识别请求属于 summary、filter/list、commit explanation、incident RCA 或 follow-up。
- 决定调用哪个 Specialist。
- 把大任务拆成有限数量的子任务。
- 根据 Specialist 输出和预算决定继续、澄清、回答或 abstain。
- 生成最终对用户可见的答案。

#### 不负责

- 不直接执行 vector search。
- 不直接读取完整 diff。
- 不自行创造 commit、repo、作者、日期或 URL。
- 不绕过 Evidence Gate。
- 不直接决定某个未经验证的 commit 是根因。

#### 可用 Agent tools

- retrieve_candidates
- investigate_candidates
- challenge_hypothesis

#### 可用确定性 tools

建议只保留少量轻量工具：

- get_run_status
- get_evidence_gate_result
- request_clarification

Supervisor 不应获得原始 search 或 diff 工具，否则容易绕过 Specialist 的上下文隔离。

#### 输入

~~~js
{
  query,
  recentConversation,
  workItemSummary,
  priorReferencedCommitIds,
  availableRepos,
  currentDate,
  budgetSummary
}
~~~

#### 输出

最终输出仍适配现有 API：

~~~js
{
  type: "answer" | "clarification",
  reply: string,
  confidence: number,
  resultCount: number,
  suspects: [],
  suggestedActions: [],
  workItem: object | undefined
}
~~~

#### Prompt 规则

- 先判断用户需要列表、解释还是 RCA。
- 只有 Specialist 返回的数据可以成为 commit 事实。
- 普通列表查询通常只调用 Retrieval Agent。
- 涉及“为什么、根因、导致、回归、故障”的查询，在有候选后优先调用 Investigator。
- 高置信度根因结论必须经过 Critic，除非是用户明确指定 commit 且只要求解释其改动。
- 一次 Agent 调用必须有具体任务，不得使用“再看看”之类模糊委派。
- 如果上一个 Agent 已经返回相同结果，不得无修改地重复调用。
- 达到预算时，只能给出有 caveat 的部分答案或 abstain。
- 最终回答必须使用用户语言。

#### Model

- 使用 OPENAI_MODEL。
- temperature 保持低值。
- max turns 由 Runner 控制，不由 prompt 自报。

#### 失败处理

- Specialist schema 无效：允许同一 Specialist 一次受控重试。
- Specialist 超时：记录错误；Supervisor 可选择另一个路径或 abstain。
- Supervisor 输出无最终文本：multi-agent orchestrator 降级到 legacy workflow。

---

### 7.2 Retrieval Agent

#### 职责

- 将任务转换为一个或多个有差异的搜索计划。
- 选择 repo、author、日期、risk 和 change type filter。
- 决定何时使用 exact ID lookup。
- 根据搜索结果调整关键词或范围。
- 返回候选集合、搜索覆盖、检索依据和仍缺少的信息。

#### 不负责

- 不读取完整 diff。
- 不下根因结论。
- 不直接回答用户。
- 不把 nearest neighbor 当作有效证据。

#### 工具

- get_index_stats
- search_commits
- lookup_commits
- list_commits_by_filter
- get_commit_metadata

#### 输入

~~~js
{
  task: string,
  originalQuery: string,
  constraints: {
    repo,
    author,
    dateFrom,
    dateTo,
    riskLevel,
    changeType,
    commitIds
  },
  workItemSummary,
  priorAttemptSummary,
  maxSearchCalls
}
~~~

#### 输出 schema

~~~js
{
  queryType: "summary" | "lookup" | "incident",
  searchAttempts: [{
    query,
    filters,
    reason,
    resultKeys
  }],
  candidateKeys: ["repo:commitId"],
  evidenceGate: {
    verdict: "SEARCH" | "ASK_USER" | "ABSTAIN",
    score: number,
    reason: string
  },
  coverage: "sufficient" | "partial" | "none",
  missingInformation: [],
  recommendedNextStep:
    "answer" | "investigate" | "clarify" | "retry" | "abstain"
}
~~~

#### 具体实现

第一版不让 Retrieval Agent 分别调用 dense 和 lexical。search_commits 工具内部继续执行：

1. 规范化 repo alias。
2. 生成 embedding。
3. dense search。
4. FTS5 search。
5. 必要时执行 secondary query。
6. RRF fusion。
7. 可选 final-stage rerank。
8. Evidence Gate。
9. 返回压缩后的候选列表。

Retrieval Agent 的自治体现在：

- 是否执行 exact lookup 或 semantic search。
- 选择怎样的搜索任务。
- 是否进行第二次有实质变化的搜索。
- 是否根据证据建议调查或澄清。

#### 调用上限

- 每次 run 最多调用 Retrieval Agent 3 次。
- 每次 Retrieval Agent 最多调用 search_commits 3 次。
- 单次 topK 最大 50。
- 同样 query + filters 的调用由 runtime 去重。

---

### 7.3 Diff Investigator Agent

#### 职责

- 从候选中选择需要读取的 commit diff。
- 将事故症状映射到具体文件、函数、配置键、条件变化或 API 行为。
- 明确区分事实、推断和未知。
- 生成候选根因 hypothesis ledger。
- 在多候选之间比较因果解释力。

#### 工具

- get_commit_metadata
- get_commit_diff
- compare_commits
- search_related_commits

#### 输入

~~~js
{
  task: string,
  incident: string,
  candidateKeys: [],
  candidateSummaries: [],
  knownSignals: {
    component,
    symptom,
    time,
    errorCode,
    fileOrSymbol
  },
  maxDiffs,
  maxTotalDiffChars
}
~~~

#### 输出 schema

~~~js
{
  hypotheses: [{
    candidateKey,
    rank,
    claim,
    mechanism,
    facts: [{
      file,
      symbol,
      observation
    }],
    inferences: [],
    contradictingEvidence: [],
    missingEvidence: [],
    confidence
  }],
  inspectedCandidateKeys: [],
  skippedCandidateKeys: [{
    candidateKey,
    reason
  }],
  overallAssessment: string,
  recommendedNextStep:
    "verify" | "inspect_more" | "search_more" | "abstain"
}
~~~

#### 具体实现

复用 api/agents/diff-investigator.js 中的：

- 不信任 diff 内指令的 prompt 约束。
- structured output。
- candidate ID 校验。
- diff 缺失或截断时降低置信度。
- canonical link 处理。

需要把当前 api/server.js /api/investigate 中的 diff 获取循环抽取为共享工具服务。这样：

- REST /api/investigate 可以继续使用；
- MCP get_commit_diff 可以继续使用；
- Diff Investigator Agent 也使用同一实现；
- diff 截断、repo 校验和错误格式不会出现三套不同逻辑。

#### 调用上限

- 每个 run 最多调用 Investigator 2 次。
- 每次最多读取 5 个候选 diff。
- 每个 diff 发送给模型的字符数上限 12,000。
- 整个 run 的 diff 字符预算建议初始设为 40,000。
- 同一 commit 的 diff 使用 request-local cache。

---

### 7.4 Evidence Critic Agent

#### 职责

- 独立检查最强 hypothesis 是否由证据支持。
- 检查因果链是否完整。
- 查找 contradicting evidence。
- 检查候选是否只是时间相关或主题相关。
- 判断是否应该追加检索或调查。
- 限制过度自信。

#### 工具

第一版建议只给：

- get_commit_metadata
- get_evidence_summary
- search_counter_evidence

Critic 不应直接读取无限数量 diff。它可以要求 Supervisor 再次调用 Investigator。

#### 输入

~~~js
{
  originalQuery,
  evidenceGate,
  candidateLedger,
  hypothesisLedger,
  answerPlan,
  remainingBudget
}
~~~

#### 输出 schema

~~~js
{
  verdict: "SUPPORTED" | "NEED_MORE_EVIDENCE" | "ABSTAIN",
  supportedCandidateKeys: [],
  rejectedCandidateKeys: [{
    candidateKey,
    reason
  }],
  issues: [],
  requiredNextTask: {
    agent: "retrieval" | "investigator",
    task: string,
    targetCandidateKeys: []
  } | null,
  calibratedConfidence: number
}
~~~

#### 与现有 Answer Evaluator 的关系

现有 Answer Evaluator 评估已经生成的回答，且有 confidence 和 resultCount fast path。新 Critic 评估的是“生成回答之前的证据和假设”，角色不同。

迁移策略：

1. 第一版保留 Answer Evaluator 作为 legacy workflow 专用。
2. Multi-agent 模式使用 Critic 对 hypothesis 做前置验证。
3. 最终答案仍执行确定性的 candidate citation 校验。
4. 不在同一路径中默认同时运行 Critic 和现有 Answer Evaluator，避免重复成本。
5. eval 证明 Critic 价值不足时，可以只在 RCA 查询启用。

#### 调用条件

必须调用：

- Supervisor 准备输出具体 root cause candidate；
- 存在两个以上接近的根因候选；
- Investigator confidence 高但 diff 被截断；
- 存在 contradicting evidence。

可以跳过：

- 普通变更列表；
- 用户只要求解释明确指定 commit；
- Evidence Gate 已经要求 ASK_USER 或 ABSTAIN。

---

## 8. 工具层设计

### 8.1 先抽取共享 Tool Service

当前 api/mcp.js、api/server.js 和 api/agents/orchestrator.js 分别包含工具相关 orchestration。第一步必须将执行逻辑抽取到 src/services，MCP 和 Agent SDK 只保留 adapter。

建议新增：

~~~text
src/services/commit-search-service.js
src/services/commit-diff-service.js
src/services/commit-evidence-service.js
api/agents/tools/commit-tools.js
~~~

#### commit-search-service.js

职责：

- repo alias 规范化；
- 参数校验；
- embedding；
- dense + lexical；
- secondary query；
- RRF；
- exact lookup merge；
- 可选 rerank；
- 输出内部 CandidateSet。

它不依赖 Express、MCP 或 Agents SDK。

#### commit-diff-service.js

职责：

- repo allowlist；
- commit ID 规范化；
- fetch changes；
- diff filter；
- fetch diff；
- 截断和大小统计；
- request-local cache；
- 输出 DiffEvidence。

#### commit-evidence-service.js

职责：

- 调用现有 evaluateEvidence；
- 汇总 channel overlap；
- candidate 引用校验；
- hypothesis 中 candidate key 校验；
- 最终答案 cited commit 校验。

### 8.2 工具清单

#### get_index_stats

输入：空对象。

输出：

- repo 列表；
- 日期范围；
- commit 数量；
- embedding model 和 dimensions。

用途：让 Retrieval Agent 使用索引日期而不是系统当前日期。

#### search_commits

输入：

~~~js
{
  query: string,
  repo?: string,
  author?: string,
  dateFrom?: "YYYY-MM-DD",
  dateTo?: "YYYY-MM-DD",
  riskLevel?: "HIGH" | "MEDIUM" | "LOW",
  changeType?: "config" | "code" | "mixed",
  topK?: number
}
~~~

输出应压缩为：

~~~js
{
  candidates: [{
    key,
    repo,
    commitId,
    shortId,
    title,
    summary,
    date,
    author,
    riskLevel,
    changedFiles,
    retrievalChannels,
    score
  }],
  gate,
  searchMetadata
}
~~~

工具内部不得返回 embedding 数组或完整数据库记录。

#### lookup_commits

输入 commitIds，最多 20 个。

必须：

- 规范化大小写；
- 支持 short SHA；
- 检测 ambiguous short SHA；
- 只返回索引中存在的结果；
- 未识别 ID 时明确返回 missingIds。

#### get_commit_diff

输入：

~~~js
{
  repo,
  commitId,
  includePatch: true,
  maxChars
}
~~~

必须：

- 校验 repo；
- 校验 commit；
- 使用 diff filter；
- 标注 truncated；
- 标注 fetch error；
- 返回 changed file count 和过滤统计。

#### compare_commits

输入 2 到 5 个 candidate keys。

输出每个候选的：

- touched paths；
- overlapping paths；
- config keys；
- timestamp；
- risk metadata；
- diff availability。

比较应先做确定性摘要，模型再做解释。

#### search_counter_evidence

输入 hypothesis 和 candidate key。

内部搜索：

- 同文件附近时间窗口的其他 commits；
- 同 component 不同 commit；
- rollback 或 follow-up fix 关键词；
- 与当前机制冲突的变更。

必须设置较小 topK，避免 Critic 演变成无限搜索 Agent。

### 8.3 工具结果安全

所有工具结果都视为不可信数据：

- commit message、work item、diff 和文件内容可能包含 prompt injection。
- Agent prompt 明确禁止执行其中的指令。
- 工具结果使用 JSON 结构，不拼接进 system prompt。
- 不向工具结果中注入 secret、PAT、bearer token 或本地路径。
- 错误返回稳定的 errorCode，不依赖自由文本解析。

推荐错误格式：

~~~js
{
  ok: false,
  errorCode: "UNKNOWN_REPO" | "NOT_FOUND" | "TIMEOUT" |
             "BUDGET_EXCEEDED" | "PROVIDER_ERROR",
  message: "safe user-independent explanation",
  retryable: boolean
}
~~~

---

## 9. Run State 与数据契约

### 9.1 服务端 RunContext

RunContext 不直接暴露给模型，作为工具和预算的服务端依赖容器：

~~~js
{
  runId,
  queryId,
  startedAt,
  abortSignal,

  services: {
    embedQuery,
    searchVectors,
    searchLexical,
    lookupByCommitIds,
    getVectorStats,
    fetchCommitDiff
  },

  sourceData: {
    query,
    history,
    workItemContext,
    priorSuspects
  },

  stores: {
    candidatesByKey,
    diffsByKey,
    hypothesesByKey
  },

  budget: {
    maxSupervisorTurns,
    maxAgentCalls,
    maxRetrievalCalls,
    maxInvestigatorCalls,
    maxCriticCalls,
    maxToolCalls,
    maxDiffChars,
    deadlineAt
  },

  usage: {
    supervisorTurns,
    agentCalls,
    toolCalls,
    diffChars,
    promptTokens,
    completionTokens
  },

  trajectory: []
}
~~~

### 9.2 Candidate Ledger

所有候选使用稳定 key：

~~~text
repo:fullCommitId
~~~

内部存储完整结果，Agent 输出只引用 key。这样可以：

- 阻止伪造候选；
- 减少上下文复制；
- 在 Agent 返回后做 deterministic validation；
- 将同一 commit 在不同检索轮次的 channel evidence 合并。

Ledger 字段：

~~~js
{
  key,
  repo,
  commitId,
  shortId,
  title,
  summary,
  date,
  author,
  url,
  riskLevel,
  changedFiles,
  affectedAreas,
  retrievalEvidence: [{
    callId,
    channel,
    rank,
    score,
    query,
    filters
  }],
  directMatch,
  diffStatus
}
~~~

### 9.3 Hypothesis Ledger

~~~js
{
  candidateKey,
  createdByAgentCallId,
  claim,
  mechanism,
  facts,
  inferences,
  contradictingEvidence,
  missingEvidence,
  confidence,
  verificationStatus
}
~~~

只有 candidate ledger 中存在的 key 才能进入 hypothesis ledger。

### 9.4 Trajectory Event

建议统一替换目前较松散的 iteration log，但在 API 返回时仍可转换为旧格式：

~~~js
{
  eventId,
  runId,
  sequence,
  timestamp,
  kind:
    "agent_start" | "agent_end" |
    "tool_start" | "tool_end" |
    "route_decision" | "guardrail" |
    "fallback" | "final",
  agent,
  action,
  parentEventId,
  status: "running" | "done" | "error" | "blocked",
  inputSummary,
  outputSummary,
  elapsedMs,
  promptTokens,
  completionTokens,
  metadata
}
~~~

默认不记录：

- API key；
- PAT；
- bearer token；
- 完整 diff；
- 完整 prompt；
- 用户未要求保存的敏感输入。

---

## 10. 控制循环

### 10.1 高层伪代码

~~~js
async function runMultiAgentSearch(input, deps) {
  const context = createRunContext(input, deps);

  try {
    const stream = await runner.run(supervisorAgent, buildSupervisorInput(context), {
      context,
      stream: Boolean(input.onToken),
      maxTurns: context.budget.maxSupervisorTurns
    });

    for await (const event of stream) {
      recordLocalTrajectory(event, context);
      mapAgentEventToSse(event, input.onProgress, input.onToken);
      enforceBudget(context);
    }

    await stream.completed;

    const output = normalizeSupervisorOutput(stream.finalOutput, context);
    validateFinalCandidateReferences(output, context.stores.candidatesByKey);
    return toLegacyChatResponse(output, context);
  } catch (error) {
    recordFallback(error, context);

    if (canFallbackToLegacy(error, context)) {
      return runLegacyWorkflow(input, deps, context);
    }

    return buildSafeAbstention(error, context);
  }
}
~~~

### 10.2 Agent tool 调用

Supervisor 调用 retrieve_candidates 时：

1. Tool guard 检查 Retrieval 调用预算。
2. 构造最小 Retrieval input。
3. 运行 Retrieval Agent。
4. Retrieval Agent 调用 search tools。
5. 每个 search tool 把结果写入 Candidate Ledger。
6. 执行 Evidence Gate。
7. 验证 Retrieval output 中的 candidate keys。
8. 将压缩结果返回 Supervisor。

Supervisor 调用 investigate_candidates 时：

1. 校验 candidate keys 必须已存在。
2. 检查 diff budget。
3. 运行 Investigator。
4. diff tool 按需获取并缓存 diff。
5. 校验 hypothesis candidate keys 和 facts。
6. 将 hypothesis ledger 写入服务端 state。
7. 把压缩结果返回 Supervisor。

Supervisor 调用 challenge_hypothesis 时：

1. 检查是否有可验证 hypothesis。
2. 运行 Critic。
3. 校验 requiredNextTask 是否属于 allowlist。
4. 更新 verificationStatus。
5. 将 verdict 返回 Supervisor。

### 10.3 并行策略

不要让多个 Agent 直接并发写同一个可变 Map。

第一版采用：

1. Supervisor 输出一个有上限的 investigation task list。
2. Runtime 为每个 task 创建只读 state snapshot。
3. 使用 Promise.allSettled 并行运行最多两个 Investigator。
4. 每个结果先独立校验。
5. 主线程按 task index 确定性合并 ledger。
6. 任一任务失败不取消其他任务，除非请求 AbortSignal 被触发。

LLM 决定“需要调查哪些 repo/候选”，代码决定“最多并发两个、怎样安全合并”。

---

## 11. 预算与终止条件

建议第一版默认值：

~~~text
Supervisor turns              8
Total specialist calls        5
Retrieval Agent calls         3
Investigator Agent calls      2
Critic Agent calls            1
Total low-level tool calls    16
Diffs per investigation       5
Total diff chars              40,000
Request deadline              沿用 API timeout，并预留响应收尾时间
~~~

终止条件：

- Supervisor 生成合法 final output。
- Supervisor 请求 clarification。
- Evidence Gate 返回不可恢复的 ABSTAIN。
- Critic 返回 ABSTAIN 且没有新证据任务。
- 预算耗尽。
- deadline 到达。
- 客户端断开 SSE。
- provider 返回不可恢复错误。

预算耗尽时：

- 有已验证 hypothesis：返回 PARTIAL，并说明限制。
- 只有候选但未验证：返回候选列表，不声称根因。
- 没有有效证据：ABSTAIN。

禁止自动重新开始一个全新 run 来绕过预算。

---

## 12. API 与 SSE 兼容

### 12.1 POST /api/chat

请求格式保持不变：

~~~js
{
  message,
  history
}
~~~

响应继续提供：

- queryId
- reply
- searchMethod
- type
- confidence
- iterations
- suggestedActions
- resultCount
- suspects
- workItem

multi-agent 模式新增但保持可选：

~~~js
{
  orchestration: {
    mode: "multi_agent",
    agentCalls: 4,
    toolCalls: 8,
    terminalReason: "supported"
  }
}
~~~

只有 x-eval-harness: 1 或显式 debug 模式才返回完整 trajectory。

### 12.2 SSE 事件映射

保留现有 status、token、complete 三类事件，避免 UI 必须同步升级。

建议 status message：

~~~text
supervisor        Analyzing the investigation plan...
retrieval         Searching commit evidence...
investigator      Inspecting candidate diffs...
critic            Challenging the root-cause hypothesis...
retry             Gathering additional evidence...
fallback          Falling back to the validated workflow...
~~~

SDK 事件映射：

- agent_start -> status
- tool_start -> status，可隐藏低价值内部工具
- agent_end -> status
- raw final text delta -> token
- run completed -> complete

注意：

- Specialist 的中间自然语言不得通过 token 事件发给用户。
- 只有 Supervisor 的最终可见回答可以 streaming。
- 如果 Supervisor 尚未确定最终路径，不应提前流出可能被替换的答案。

### 12.3 /api/investigate

第一版保留该 endpoint，内部改为调用共享 commit-diff-service。

后续可选：

- UI 的 “Investigate these commits” 继续调用 /api/investigate；
- chat Supervisor 也可以自动触发相同 Investigator；
- 两条入口共享 prompt、tool 和校验；
- 不急于删除旧入口，因为它仍是很好的手动对照路径。

### 12.4 MCP

api/mcp.js 继续暴露原工具名，避免破坏外部调用者。

改造方式：

- registerTool 只做 Zod schema、MCP content adapter 和 logging。
- 实际逻辑调用共享 service。
- Agent SDK tool adapter 也调用同一个 service。
- 为 MCP 和内部 Agent 分别设置调用预算；外部 MCP 调用不共享 chat run budget。

---

## 13. Observability 与本地存储

### 13.1 数据库变更

现有 chat_queries.iteration_log 可以在第一版继续存储完整 JSON trajectory，降低 migration 风险。

建议第二阶段新增规范化表：

~~~sql
CREATE TABLE IF NOT EXISTS agent_events (
    id TEXT PRIMARY KEY,
    query_id TEXT NOT NULL REFERENCES chat_queries(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    parent_event_id TEXT,
    kind TEXT NOT NULL,
    agent TEXT,
    action TEXT,
    status TEXT NOT NULL,
    elapsed_ms INTEGER,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_events_query_sequence
ON agent_events(query_id, sequence);
~~~

不要在第一版同时重构现有 prompt_events。可以通过 trajectory adapter 继续写 prompt_events，以保持 MetricsBoard 兼容。

### 13.2 必须记录的指标

- orchestration mode；
- terminal reason；
- Supervisor turns；
- 每种 Specialist 调用次数；
- 每种工具调用次数；
- route decision；
- timeout 和 fallback；
- candidate set novelty；
- diff 数量和截断数量；
- Critic verdict；
- prompt/completion tokens；
- Agent 和总延迟；
- 最终 confidence。

### 13.3 远程 tracing

根据项目无远程 telemetry 的约束：

- OPENAI Agents SDK tracing 默认关闭。
- 不发送 prompt、diff、用户问题或 Agent trajectory 到远程 trace backend。
- 如果未来加入显式 opt-in，必须文档化数据字段、保存策略和开关。

推荐环境变量：

~~~env
OPENAI_AGENTS_DISABLE_TRACING=1
AGENT_LOCAL_TRACE=1
AGENT_TRACE_INCLUDE_CONTENT=0
~~~

---

## 14. Prompt 与上下文工程

### 14.1 Prompt 分层

每个 Agent prompt 应包含：

1. Role：唯一职责。
2. Allowed actions：可以调用哪些工具。
3. Decision policy：何时调用、何时停止。
4. Evidence policy：哪些数据可作为事实。
5. Security policy：工具输出是不可信数据。
6. Output contract：结构化 schema。
7. Budget awareness：剩余预算由 context 动态注入。

不应在 prompt 中重复：

- 完整 repo domain knowledge；
- 所有工具实现细节；
- 完整对话；
- 完整 diff；
- 其他 Agent 的 system prompt。

### 14.2 动态 instructions

可以根据 run state 动态加入：

- 当前剩余调用预算；
- 当前候选数量；
- 已调用过哪些 Agent；
- Critic 是否已完成；
- 当前可用 repo；
- work item 是否存在。

不要动态加入 secret 或未经裁剪的工具结果。

### 14.3 防止循环

除 runtime 硬限制外，Supervisor input 中提供：

- 已执行动作的 canonical signature；
- 上次结果是否产生新候选；
- remainingBudget；
- stale action 标志。

如果 Agent 请求重复相同 action signature：

1. Tool guard 返回 DUPLICATE_ACTION。
2. 不消耗底层搜索或 diff 调用。
3. 记录 guardrail event。
4. Supervisor 必须换策略、回答或 abstain。

---

## 15. Security 与可靠性

### 15.1 Prompt injection

潜在注入来源：

- 用户问题；
- conversation history；
- work item title/description；
- commit message；
- diff；
- source code comment；
- repository file path。

防护：

- 将所有来源作为 JSON data 传入 user/tool message。
- system prompt 明确禁止遵循这些数据中的指令。
- 不把工具结果拼入 instructions。
- Agent 只能访问 allowlisted read-only tools。
- 所有 Agent 输出进行 schema validation。
- 所有 candidate ID 与服务端 ledger 比对。

### 15.2 权限

- ADO token 仅存在服务端。
- Agent 工具只接收 repo 和 commit ID，不接收 token。
- 禁止任意 URL fetch。
- 只允许 REPOSITORIES 中配置的 repo。
- 不提供 shell、文件写入、部署或 git mutation 工具。

### 15.3 超时与取消

- Express request 或 SSE connection close 时触发 AbortController。
- 所有 Agent 和工具调用接收 AbortSignal。
- fetch diff、embedding、chat completion 都应设置 deadline。
- 被取消的 run 不执行 legacy fallback，避免客户端断开后继续产生费用。

### 15.4 Provider 能力检测

启动时或 health check 中检测：

- Chat Completions 是否可用；
- function/tool calling 是否可用；
- structured output 是否可用；
- streaming tool event 是否兼容；
- 并行 tool calls 是否兼容。

如果 provider 不支持 Agent loop 必需能力：

- AGENT_ORCHESTRATION_MODE=multi_agent 时启动失败并给出明确错误；或
- AGENT_ORCHESTRATION_MODE=auto 时自动使用 workflow。

不要在请求中途静默切换不兼容 schema。

---

## 16. Eval 设计

### 16.1 Eval 原则

需要同时测两层：

1. Outcome quality：最终答案、候选排序和引用是否正确。
2. Trajectory quality：Agent 是否选择了合理步骤，并避免无用调用。

生产内置 Critic 不能作为外部 judge。外部 eval 必须使用：

- deterministic labels；
- frozen dataset；
- 独立 scorer；
- 或人工审核 rubric。

### 16.2 数据集扩展

在现有 case 上增加可选 orchestrationExpectations：

~~~json
{
  "orchestrationExpectations": {
    "mustUse": ["retrieval"],
    "mayUse": ["critic"],
    "mustNotUse": ["investigator"],
    "partialOrder": [],
    "requiresVerification": false,
    "maxSpecialistCalls": 2,
    "expectedTerminal": ["answer"]
  }
}
~~~

RCA case 示例：

~~~json
{
  "orchestrationExpectations": {
    "mustUse": ["retrieval", "investigator", "critic"],
    "mustNotUse": [],
    "partialOrder": [
      ["retrieval", "investigator"],
      ["investigator", "critic"],
      ["critic", "final"]
    ],
    "requiresVerification": true,
    "maxSpecialistCalls": 5,
    "expectedTerminal": ["answer", "partial"]
  }
}
~~~

不要标注唯一完整序列，因为多个不同轨迹都可能正确。使用：

- must/may/mustNot；
- partial order；
- call budget；
- terminal behavior；
- required evidence。

### 16.3 新增 case 类型

至少覆盖：

1. 普通时间/作者/repo 变更列表，只需要 Retrieval。
2. 明确 commit ID 解释，可以直接 Investigator。
3. 模糊问题，应该 ASK_USER。
4. OOD 问题，应该 ABSTAIN。
5. 有一条强候选的 RCA。
6. 有多条相近候选的 RCA，必须 Critic。
7. 跨 repo RCA，需要有界并行。
8. 首次搜索弱、第二种查询找到 gold commit。
9. diff 缺失或截断，必须降低信心。
10. commit message 或 diff 中包含 prompt injection。
11. search tool timeout。
12. Investigator 返回 malformed schema。
13. Critic 要求追加证据。
14. 重复工具调用被 guard 拒绝。
15. 预算耗尽后安全终止。
16. SSE 客户端中断。

### 16.4 Trajectory 指标

#### 路由质量

- Specialist selection precision。
- Specialist selection recall。
- mustUse 满足率。
- mustNotUse 违规率。
- partial order 满足率。
- expected terminal accuracy。

#### 效率

- 平均 Specialist calls/query。
- 平均 tool calls/query。
- unnecessary Investigator rate。
- duplicate action rate。
- token/query。
- p50/p95 latency。

#### 恢复能力

- tool timeout recovery rate。
- malformed output recovery rate。
- fallback success rate。
- stale-loop termination rate。
- budget violation rate。

#### RCA 专项

- RCA 查询 Investigator coverage。
- 高置信根因 Critic coverage。
- hypothesis evidence coverage。
- unsupported causal claim rate。
- gold commit Recall@K 和 MRR。
- hallucinated commit rate。

### 16.5 Outcome 指标

继续沿用现有：

- behavior accuracy；
- clarification accuracy；
- unsafe search rate；
- Recall@K；
- MRR@K；
- nDCG；
- citation validity；
- required evidence coverage；
- hallucinated commit rate；
- Brier score；
- ECE；
- latency；
- tokens。

### 16.6 A/B 方法

对同一 frozen split 运行：

~~~text
A = AGENT_ORCHESTRATION_MODE=workflow
B = AGENT_ORCHESTRATION_MODE=multi_agent
~~~

必须固定：

- chat model；
- fast model；
- embedding model；
- corpus；
- dataset hash；
- prompt versions；
- concurrency；
- timeout；
- max allowed evidence window；
- run repeat 数。

每个 case 至少重复多次，以评估 routing consistency。报告：

- paired delta；
- bootstrap confidence interval；
- 按 query category 分桶；
- 按语言分桶；
- 按 trajectory 分桶；
- 成本与延迟分布。

### 16.7 初始 release gate

以下是第一版建议阈值，正式值应在 dev split 上校准后冻结：

- behavior accuracy 不低于 workflow baseline 1 个百分点以上。
- Recall@10 和 MRR@10 通过 non-inferiority gate。
- hallucinated commit rate 不高于 baseline。
- budget violation rate 为 0。
- mustNotUse 违规率低于 2%。
- RCA mandatory verification coverage 不低于 95%。
- 普通列表查询 unnecessary Investigator rate 低于 10%。
- tool failure case safe terminal rate 为 100%。
- p95 latency 和 tokens 增幅在明确批准的预算内。

如果最终质量不提升，只是增加了 Agent calls，不应默认启用 multi-agent。

---

## 17. 测试策略

### 17.1 单元测试

新增：

~~~text
src/tests/test-agent-budget.js
src/tests/test-agent-tool-validation.js
src/tests/test-agent-trajectory.js
src/tests/test-agent-ledger.js
src/tests/test-agent-event-adapter.js
src/tests/test-multi-agent-fallback.js
~~~

覆盖：

- budget 计数；
- 重复 action 拒绝；
- candidate key 校验；
- malformed schema；
- unknown repo；
- ambiguous short SHA；
- diff size；
- final citation 校验；
- event 顺序；
- terminal reason；
- legacy response compatibility。

### 17.2 Agent runtime deterministic tests

使用 Agents SDK 的 scripted model/test doubles：

- Supervisor 调 Retrieval 后 final。
- Supervisor 调 Retrieval、Investigator、Critic 后 final。
- Specialist tool 抛错后 Supervisor abstain。
- Supervisor 重复调用被 guard 拒绝。
- max turns 后强制终止。
- streaming 事件顺序。

这些测试验证运行时和工具循环，不验证真实模型是否会作出正确决策。

### 17.3 Prompt/decision eval

使用真实目标模型验证：

- 是否为不同 query 选择正确 Agent；
- 是否给 Specialist 足够明确的任务；
- 是否在证据不足时继续调查；
- 是否停止；
- 是否遵守语言和引用要求。

### 17.4 集成测试

- 启动 API server。
- 调用非 streaming /api/chat。
- 调用 SSE /api/chat。
- 调用 /api/investigate。
- 调用 MCP search_commits、get_commit_diff。
- 验证 multi_agent 与 workflow 两种模式。
- 验证 OPENAI_BASE_URL compatible provider。
- 验证无 vector store 时仍使用现有 full-context fallback。

### 17.5 UI 测试

- status 文案随 Agent 切换更新。
- token 只来自 Supervisor final。
- complete event 仍能恢复 suspects 和 suggestedActions。
- 客户端取消能终止后端 run。
- legacy workflow 和 multi-agent 的 UI 行为一致。
- 可选 trace panel 不显示完整 diff 或 secret。

---

## 18. 文件级改造清单

### 18.1 新增文件

#### src/services/commit-search-service.js

- 从 orchestrator 和 MCP 抽取统一搜索执行。
- 接受显式 dependencies。
- 返回 CandidateSet。
- 无 Express、MCP、Agents SDK 依赖。
- 增加单元测试。

#### src/services/commit-diff-service.js

- 从 /api/investigate 和 MCP 抽取 diff 获取。
- 统一 repo 校验、filter、截断、cache 和 error shape。
- 增加单元测试。

#### src/services/commit-evidence-service.js

- 包装 evaluateEvidence。
- candidate ledger 和 citation 校验。
- hypothesis validation。

#### api/agents/multi-agent-runtime.js

- 创建 OpenAIProvider、Runner 和四个 Agent。
- 设置 Chat Completions 模式并默认关闭远程 tracing。
- 注册 Specialist agents-as-tools。
- 将 SDK usage 和 Harness events 适配到现有 API response。

#### api/agents/harness/*

- `agent-harness.js`：顶层 run 和 deadline。
- `run-context.js`：request-local context、Candidate Ledger、Hypothesis Ledger。
- `tool-registry.js`：least-privilege 工具注册。
- `tool-middleware.js`：权限、预算、去重、超时、ledger validation 和输出裁剪。
- `budget-manager.js`：agent/tool/diff/time budget。
- `trajectory-recorder.js`：本地 trajectory 和 SSE progress adapter。
- `output-validator.js`：最终 schema、citation grounding 和置信度约束。
- `fallback-controller.js`：legacy workflow fallback。

#### api/agents/agent-schemas.js

- 集中定义 Supervisor、Retrieval、Investigator、Critic 输出 schema。
- 导出 normalization 和 validation helpers。

#### api/agents/supervisor-agent.js

- 定义 Incident Commander prompt。
- 注册 Specialist agents-as-tools。
- 定义最终 output schema。

#### api/agents/retrieval-agent.js

- 定义 Retrieval prompt 和 tools。
- 复用 Intent Extractor 的一部分 extraction 能力。
- 输出 CandidateSet references。

#### api/agents/evidence-critic-agent.js

- 定义 hypothesis review prompt。
- 输出 SUPPORTED、NEED_MORE_EVIDENCE 或 ABSTAIN。

#### api/agents/tools/commit-tools.js

- 将共享 services 适配为 Agents SDK function tools。
- 做 Zod input validation、budget、event 和 safe error mapping。

#### api/agents/multi-agent-orchestrator.js

- 提供与 agenticSearch 类似的依赖注入接口。
- 运行 Agent loop。
- 适配现有 API response。
- 执行 fallback。

#### src/eval/lib/trajectory-metrics.js

- 解析 trajectory。
- 计算 must/may/mustNot、partial order、call counts 和 terminal metrics。

#### src/eval/run-multi-agent-eval.js

- 双模式运行。
- 保存 raw trajectory。
- 生成 outcome + trajectory 报告。

### 18.2 修改文件

#### api/package.json

- 添加 @openai/agents。
- 保留 zod。
- 添加 multi-agent eval/test scripts。
- 不在同一个 PR 中无条件升级所有其他依赖。

#### api/server.js

- 读取 AGENT_ORCHESTRATION_MODE。
- 构造共享 service dependencies。
- workflow 与 multi_agent 路由。
- SSE close -> AbortController。
- 统一 logQuery。

#### api/mcp.js

- 保留工具名和 schema。
- handler 改为调用共享 services。
- 保持返回内容兼容。

#### api/agents/diff-investigator.js

- 将 prompt/core analysis 与 diff fetch 分离。
- 允许被 Agent wrapper 和 /api/investigate 复用。
- 保留当前输出兼容 adapter。

#### api/agents/orchestrator.js

- 保持 legacy baseline。
- 改为调用共享 search service。
- 不在 multi-agent 第一版删除现有逻辑。

#### api/db.js

- 第一版支持新的 trajectory event mapping。
- 第二阶段可新增 agent_events 表。
- 保持 prompt_events 和现有 metrics。

#### api/.env.example

新增：

~~~env
AGENT_ORCHESTRATION_MODE=workflow
AGENT_MAX_SUPERVISOR_TURNS=8
AGENT_MAX_SPECIALIST_CALLS=5
AGENT_MAX_TOOL_CALLS=16
AGENT_MAX_DIFF_CHARS=40000
AGENT_MAX_PARALLEL_INVESTIGATIONS=2
AGENT_MULTI_AGENT_FALLBACK=1
OPENAI_AGENTS_DISABLE_TRACING=1
~~~

#### ui/src/components/ChatBox.jsx

- 支持新的 status stage。
- 保持旧事件兼容。
- 可选展示当前 Agent 名称。

#### ui/src/api.js

- complete response 中读取可选 orchestration。
- 不要求所有后端都返回该字段。

#### src/eval/datasets/*

- 不修改已冻结 case 的语义标签。
- 新建 dataset version 或单独 trajectory annotation 文件。
- manifest 中加入 annotation hash。

---

## 19. 分阶段实施计划

### Phase 0：冻结基线

#### 任务

1. 记录当前 git commit、工作树状态和依赖 lockfile。
2. 选择 workflow baseline dataset。
3. 运行现有 retrieval、agent 和 RCA eval。
4. 保存：
   - dataset hash；
   - corpus hash；
   - model；
   - prompt versions；
   - environment thresholds；
   - raw responses；
   - latency 和 token summary。
5. 确定哪些现有指标是 release blocking。

#### 产物

- baseline report。
- baseline config snapshot。
- 可重复运行命令。

#### 完成标准

- 相同环境下能重复得到可解释的 baseline。
- 后续每个 PR 都能与该 baseline 比较。

---

### Phase 1：抽取共享工具服务，不改变行为

#### 任务

1. 从 api/mcp.js 抽取 search execution 到 commit-search-service。
2. 从 api/server.js /api/investigate 抽取 diff execution 到 commit-diff-service。
3. 将 Evidence Gate adapter 放入 commit-evidence-service。
4. 让 legacy orchestrator、MCP 和 /api/investigate 全部调用共享 service。
5. 保持原 API 和 MCP 输出 shape。
6. 增加 service 单元测试和 snapshot/contract tests。

#### 风险

- 抽取时改变排序顺序。
- score 或 metadata 字段丢失。
- MCP text content 改变。
- diff 截断阈值不一致。

#### 验证

- 所有现有 tests。
- workflow baseline 完全或近似等价。
- MCP E2E。
- /api/investigate E2E。

#### 完成标准

- 不安装 Agents SDK。
- 不改变默认执行路径。
- 结果排序、gate 和引用无回归。

---

### Phase 2：搭建 Agent Runtime 和只含 Retrieval 的最小闭环

#### 任务

1. 安装 @openai/agents。
2. 新增 agent-runtime.js。
3. 配置独立 OpenAIProvider：
   - baseURL；
   - apiKey；
   - useResponses: false。
4. 默认关闭远程 tracing。
5. 实现 RunContext、budget 和 trajectory。
6. 将 search service 包装为 Agent tools。
7. 实现 Retrieval Agent。
8. 实现最小 Supervisor：
   - clarification；
   - retrieve_candidates；
   - final；
   - abstain。
9. 实现 multi-agent-orchestrator API adapter。
10. 添加 AGENT_ORCHESTRATION_MODE，默认 workflow。

#### 验证

- scripted model unit tests。
- provider tool-calling integration test。
- structured output integration test。
- non-streaming /api/chat。
- workflow 与 multi_agent 简单查询 A/B。

#### 完成标准

- 模型真实通过 tool call 决定是否调用 Retrieval。
- 普通查询可以完成。
- vague/OOD 可以安全结束。
- 默认用户仍走 legacy workflow。

---

### Phase 3：接入 Diff Investigator

#### 任务

1. 将现有 investigator core 包装为 Agent。
2. 实现 get_commit_diff 和 compare_commits tools。
3. 接入 candidate ledger。
4. Supervisor prompt 增加 RCA 路由规则。
5. 支持明确 commit ID 直接调查。
6. 支持 Retrieval -> Investigator。
7. 实现 diff budget、cache、truncation 和 AbortSignal。
8. 保留 /api/investigate 兼容。

#### 验证

- exact commit explanation。
- single-candidate RCA。
- multiple-candidate RCA。
- unknown repo / missing diff。
- truncated diff confidence。
- prompt injection diff。

#### 完成标准

- RCA 查询无需用户第二次点击即可自动调查。
- 普通列表查询不会普遍触发 Investigator。
- 所有 hypothesis 都引用 ledger 中的候选。

---

### Phase 4：接入 Critic 和动态 retry

#### 任务

1. 实现 Evidence Critic Agent。
2. 定义必须调用 Critic 的策略。
3. 支持 Critic 返回 requiredNextTask。
4. Supervisor 可以根据 requiredNextTask：
   - 重新 Retrieval；
   - 再次 Investigator；
   - abstain。
5. 实现 duplicate action guard。
6. 实现 stale evidence detection。
7. 限制 Critic 只调用一次。

#### 验证

- 假设被支持。
- 假设被拒绝。
- Critic 要求查找反证。
- 第二次搜索产生新候选。
- 第二次搜索无新候选时停止。
- 达到预算时安全 PARTIAL/ABSTAIN。

#### 完成标准

- 至少存在由真实模型生成的多种动态轨迹。
- 根因回答在规定场景下经过 Critic。
- 不出现无界循环。

---

### Phase 5：并行调查与 UI trajectory

#### 任务

1. Supervisor 输出 bounded investigation plan。
2. runtime 最多并行两个 Investigator。
3. 使用 Promise.allSettled。
4. 确定性合并结果。
5. UI 增加简化 Agent timeline：
   - 正在搜索；
   - 正在检查 diff；
   - 正在验证结论。
6. debug/eval 模式提供完整 trajectory。
7. 客户端断开时取消所有并行任务。

#### 验证

- 两个 repo 并行。
- 一个任务失败、另一个成功。
- 结果顺序稳定。
- SSE event 顺序合法。
- UI 不泄漏 Specialist 中间文本。

#### 完成标准

- 并行仅发生在 Supervisor 明确规划的子任务。
- 并行带来可测的延迟收益。
- 不破坏 ledger 一致性。

---

### Phase 6：Trajectory eval 与 shadow rollout

#### 任务

1. 给 eval case 添加 orchestration annotation。
2. 实现 trajectory metrics。
3. 对 frozen dataset 跑 workflow/multi_agent paired eval。
4. 注入 tool failure 和 malformed outputs。
5. 分析质量、路由、成本和延迟。
6. 先在 eval 和显式 debug 请求启用。
7. 再做本地 shadow mode：
   - workflow 作为用户结果；
   - multi-agent 仅在明确允许的测试环境运行；
   - 不默认双倍消耗生产请求。
8. 达到 gate 后将默认切到 multi_agent。

#### 完成标准

- release gate 全部通过。
- 回滚只需环境变量。
- 文档和 demo 可以复现至少五种不同轨迹。

---

## 20. Rollout 与回滚

### 模式

~~~text
workflow     只运行现有 orchestrator
multi_agent 只运行新架构，允许受控 fallback
auto         provider 能力满足时 multi-agent，否则 workflow
~~~

不建议在普通用户请求中默认 shadow 双跑，因为会：

- 双倍增加费用；
- 增加 provider load；
- 可能将敏感输入发送两次；
- 干扰 latency 指标。

shadow 只用于离线 eval 或明确启用的本地测试。

### 回滚触发

- behavior accuracy 超过允许回归。
- hallucinated commit rate 上升。
- budget violation 非零。
- provider tool calling failure rate 超阈值。
- p95 latency 或 token 超预算。
- 用户反馈显著下降。

### 回滚动作

1. 设置 AGENT_ORCHESTRATION_MODE=workflow。
2. 保留新代码和 trace 供分析。
3. 不删除新 schema 或历史数据。
4. 根据 trajectory 定位是路由、工具、prompt 还是 provider 问题。

---

## 21. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Supervisor 过度调用 Agent | 成本和延迟上升 | 硬预算、duplicate guard、trajectory eval |
| 简单问题也读取 diff | 无收益且慢 | query type policy、unnecessary Investigator metric |
| Agent 形成循环 | 请求无法结束 | max turns、action signature、stale detection |
| Provider tool calling 不兼容 | runtime failure | startup capability test、auto/workflow fallback |
| Specialist 伪造 commit | 错误引用 | candidate ledger allowlist validation |
| diff prompt injection | 错误行为 | data/instruction 隔离、只读工具、schema |
| Critic 与 Investigator 同源偏差 | 错误互相强化 | 独立 prompt、只给证据摘要、外部 eval |
| 多 Agent 上下文重复 | token 激增 | 服务端 ledger、ID reference、最小上下文 |
| 并行写 state 冲突 | 不确定结果 | snapshot + deterministic merge |
| 远程 trace 泄漏内容 | 隐私风险 | 默认关闭，仅本地事件 |
| 同时改检索和 orchestration | 无法归因 | Phase 1 固定数据面、paired A/B |

---

## 22. 备选方案

### 22.1 保持当前 workflow，只增加 Planner

做法：

- 在固定 pipeline 前增加一次 LLM plan。
- Planner 从少数预定义路径中选一个。

优点：

- 改动小。
- 容易稳定。

缺点：

- Planner 只路由一次，无法根据新证据持续决策。
- 很难称为真正 multi-agent。
- 无法自然支持 Investigator -> Critic -> Retrieval 的动态回路。

适合作为过渡实验，不作为目标架构。

### 22.2 LangGraph custom workflow

优点：

- 状态、分支、循环、并行和 checkpoint 清晰。
- 更容易画出显式执行图。
- 适合 human-in-the-loop。

缺点：

- 第一版引入更重的 graph state 和 model adapter。
- 如果大多数 edge 仍由代码决定，面试官仍可能认为只是 graph workflow。

如果采用 LangGraph，应保证至少 Supervisor node 的输出通过 Command/Send 决定下一节点，而不是固定 conditional edge 只读取确定性标签。

### 22.3 多个 Agent 互相 handoff

优点：

- Agent 身份切换明显。

缺点：

- 用户对话所有权漂移。
- 最终输出风格和证据聚合更难控制。
- Specialist 可能直接面向用户暴露中间结论。

本项目更适合 manager/agents-as-tools。

---

## 23. 面试演示方案

演示不应只展示最终回答，而应展示三部分。

### 23.1 同一系统的不同轨迹

依次输入：

1. “Beina 上周在 CMUI 改了什么？”
   - 预期：Retrieval only。
2. “解释 commit abc1234 为什么风险高。”
   - 预期：direct lookup + Investigator。
3. “广告页面从昨天开始加载很慢，哪个改动最可能导致？”
   - 预期：Retrieval + Investigator + Critic。
4. “页面坏了。”
   - 预期：clarification，不浪费 diff 调用。
5. 一个索引外系统的问题。
   - 预期：ABSTAIN。

### 23.2 展示 guardrail

- Agent 请求重复搜索，被 duplicate guard 拒绝。
- Investigator 返回不存在的 commit ID，被 ledger validation 拒绝。
- 达到 diff budget 后只给部分结论。
- provider 失败时回退 legacy workflow。

### 23.3 展示 eval

- workflow vs multi-agent paired report。
- routing confusion matrix。
- outcome metrics。
- latency/token tradeoff。
- tool failure recovery。
- 一条失败 case 的完整 trajectory 分析。

面试核心表述：

> 我没有把多个 prompt 简单命名为 Agent。我的 Supervisor 通过真实 tool calls 决定调用哪些专业 Agent、以什么顺序调用、是否并行以及何时停止；同时，候选合法性、证据门槛、预算和权限仍由确定性代码控制。我们同时评估最终答案和执行轨迹，因此可以判断 agentic autonomy 是否真的带来质量收益。

---

## 24. Definition of Done

只有满足以下条件，multi-agent 改造才算完成：

- [x] 现有 workflow 仍可通过环境变量运行。
- [x] 搜索和 diff 逻辑被抽取为共享 services。
- [x] Supervisor 通过真实 model tool calls 调用 Specialist。
- [x] 至少有 Retrieval、Investigator、Critic 三个独立 Specialist。
- [x] 不同 query category 产生不同轨迹。
- [x] RCA 可以自动进入 diff investigation。
- [x] 所有 commit reference 通过 ledger validation。
- [x] Evidence Gate 不可绕过。
- [x] Agent/tool/diff/turn budgets 全部生效。
- [x] SSE 和非 streaming API 保持兼容。
- [x] MCP 工具保持兼容。
- [x] 客户端断开可以取消 run。
- [x] 远程 tracing 默认关闭。
- [x] trajectory 写入本地日志。
- [x] scripted runtime tests 通过。
- [x] API、MCP、SSE E2E 通过（本地 mock provider；ADO-only case 在公开 corpus 中跳过）。
- [ ] frozen outcome eval 通过 non-inferiority gate。
- [ ] trajectory eval 达到 release gate。
- [ ] failure injection case 全部安全终止。
- [x] 有明确的默认开关和一键回滚方式。
- [x] README 更新真实架构，不夸大能力。

---

## 25. 建议 PR 拆分

### PR 1：Shared Tool Services

- 只抽取 search、diff、evidence service。
- 不新增 Agent SDK。
- 目标是零行为变化。

### PR 2：Agent Runtime + Retrieval

- 新增 SDK、RunContext、budget、trajectory。
- 实现 Supervisor + Retrieval。
- 默认关闭。

### PR 3：Investigator Integration

- 自动 RCA 路由。
- candidate/hypothesis ledger。
- diff budget 和 cache。

### PR 4：Critic + Retry Policy

- 加入前置证据挑战。
- dynamic retry、duplicate guard、stale detection。

### PR 5：Streaming + UI Trace

- SSE event adapter。
- 可视化 Agent timeline。
- cancellation。

### PR 6：Trajectory Eval + Rollout

- annotation schema。
- trajectory scorer。
- paired A/B。
- release gate 和默认模式决策。

每个 PR 都必须：

1. 启动 node api/server.js。
2. 至少运行一条非 streaming chat。
3. 至少运行一条 SSE chat。
4. 运行相关 Node tests。
5. 若修改 UI，运行 npm run build 并进行浏览器验证。
6. 保存 eval delta，不能只报告“测试通过”。

---

## 26. 开放问题

以下问题应在 Phase 0 或 Phase 2 前明确：

1. multi-agent 第一版是否只对 incident/RCA query 启用，普通 summary 继续走 workflow？
2. 目标 OpenAI-compatible provider 是否完整支持 function calling 和并行 tool calls？
3. 是否允许 Agents SDK 使用独立 client，还是必须先升级 openai 依赖？
4. 是否把 work item fetch 作为 Supervisor tool，还是继续在进入 Agent runtime 前完成？
5. 是否需要将完整 trajectory 暴露给普通 UI，还是仅提供三到五个高层阶段？
6. Critic 是否使用与 Investigator 不同的模型，降低同源偏差？
7. 可接受的 token 和 p95 latency 增幅是多少？
8. 哪些 RCA case 已经达到人工 gold 标准，可以进入 release gate？
9. 是否需要在 multi-agent 模式中继续支持现有 answer-synthesizer prompt experiments？
10. 何时需要升级为 LangGraph 的持久化执行？

建议默认答案：

- 第一版对所有 query 可用，但 Supervisor 对普通 query 只调用 Retrieval。
- work item 继续预取，减少 Agent 工具权限。
- UI 默认只显示高层 trajectory，完整内容仅 eval/debug 可见。
- Critic 先使用 fast model，质量不足再评估独立质量模型。
- 保留现有 prompt registry，但为每个新 Agent 增加独立 version。

---

## 27. 下一步

批准本设计后，立即执行：

1. 完成 Phase 0 baseline snapshot。
2. 建立 PR 1 的共享 service 接口和 contract tests。
3. 在不改变默认行为的前提下让 MCP、legacy orchestrator 和 /api/investigate 复用同一服务。
4. 完成后再安装 Agent SDK，进入 PR 2。

不要从直接重写 orchestrator 开始。先消除工具逻辑重复，才能确保 multi-agent 和 legacy workflow 使用完全相同的数据面，并让后续 A/B 结果具有可解释性。
