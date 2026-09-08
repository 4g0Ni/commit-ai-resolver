# 刘启仁（Qiren Liu）

**AI Agent / 后端软件工程师**  
电话：13382183295｜邮箱：lqr_ld@163.com

## 个人概述

4 年微软 Microsoft Advertising 软件工程经验，工作主线覆盖 **AI Agent 与广告后端系统**。设计并实现面向多仓库历史变更与回归调查的 evidence-first 多 Agent 系统，由 LLM Supervisor 动态委派检索、Diff 调查和证据审查，外围 Harness 负责权限、预算、证据授权、校验与回退；同时负责图片资产治理、Deal 同步及异步推荐视频等后端链路，并具备大型 Campaign UI 的端到端交付经验。

## 核心技能

- **AI / Agent：** Multi-Agent Orchestration、OpenAI Agents SDK、Agent Harness、Agentic RAG、混合检索、本地 LTR、Evidence Grounding、Agent Eval、MCP、SSE
- **后端：** C#、Python、Cosmos
- **前端：** JavaScript、React、Fluent UI
- **存储与工程化：** sqlite-vec、Azure Blob/Table、Kubernetes、Kusto/KQL、Azure DevOps CI/CD

## 教育背景

- **电子科技大学｜硕士，网络工程学院**｜2019.09 – 2022.06
- **电子科技大学｜本科，信息与通信工程学院**｜2015.09 – 2019.06

## 工作经历

### Microsoft｜软件工程师，Microsoft Advertising / Microsoft AI
**2022.08 – 2026.08**

#### AI Agent 核心项目：Commit AI Resolver｜历史变更检索与回归调查 Agent

**JavaScript / OpenAI Agents SDK / SQLite FTS5 / sqlite-vec / Local LTR / MCP**

- 先以普通函数落地固定 **Intent → Retrieval → Evidence Gate → Synthesis → Evaluation** workflow；Gate 在生成前决定 SEARCH / ABSTAIN / ASK_USER，Evaluator 最多驱动 3 轮有界重检索，并以 result-set fingerprint 阻断重复结果，形成可回归 baseline。
- 在此基础上以 OpenAI Agents SDK 的 manager/agents-as-tools 模式重构为 **Incident Commander、Retrieval、Diff Investigator、Evidence Critic** 四类 Agent；相较固定顺序，Supervisor 可依据查询、工具 Observation 与剩余预算，动态选择只检索、读取 Top-N Diff、调用独立 Critic、澄清或停止，Specialist 以独立 prompt、tool allowlist 与结构化输出隔离职责和权限；旧 workflow 保留为 feature-flag baseline 与故障回退。
- 构建内部多仓库版本与外部公开复现版本：以 daily JSON 为可审计 source of truth，以 SQLite metadata/FTS5 与 sqlite-vec 为可重建派生索引；公开版本对 27,646 条 React Commit 补齐 changed files、affected areas 与完整 message，并将 embedding 模型、1024 维度、query instruction、文档模板与索引版本纳入一致性契约。
- 将检索拆成通用查询与 Issue-grounded RCA 两条路径：通用查询保留 **Direct SHA + FTS5 + Dense + Multi-query + weighted RRF**；RCA 路径仅使用 Issue 生命周期 metadata 做 `createdAt - 7d → closedAt + 30d` SQL pre-filter，再合并 raw/compact × Dense/Lexical 四路 Top-100 候选，并以 35 个可解释特征的本地 LTR 重排。
- 在生成前加入确定性 Evidence Gate，输出 SEARCH / ABSTAIN / ASK_USER；随 RCA 检索升级完成 Gate v2 设计，区分用户显式过滤与系统推导时间窗，新增四路共识、LTR top-1/margin、候选分布和 Diff 证据，避免生命周期日期被误当成用户强约束而自动放行。v1 已在通用链路运行，v2 待用 hard negative/OOD 数据校准后接入。
- 在 SDK 外实现 request-local **Agent Harness**：工具白名单、Candidate Ledger、Agent/Tool/Diff/时间预算、调用去重与超时、引用/输出校验、bounded trajectory 和 legacy fallback；通过 Streamable HTTP 暴露 6 个 MCP 工具。
- 建立 75-case 版本化工程回归 Harness，并基于真实 GitHub Issue → closing PR → fix commit 构建、全量评测 461 条 RCA gold cases（模型预审版）；通过 Issue 生命周期时间窗与 dev-trained 本地 LTR，将 grouped 134-case held-out test 的 Recall@20 从 70.90% 提升至 94.78%，并保留逐 case trace、人工复核与 release-gate 边界。

#### 广告 UI 项目

- 在大型 Microsoft Advertising Campaign UI 中累计完成 490+ 次生产合并，通过系统性性能优化将关键页面 P95 降低 **40%–72%**，并交付图片素材质量预测、第三方监测、Media Deal、广告推荐、A11y/i18n 与线上 DRI。

#### 广告后端项目

**C#/.NET / WCF / SOAP / Bulk API / Task Engine / SQL Server / Azure Queue / Cosmos/ADLS**

##### 图片资产生命周期治理

- 端到端设计并落地孤立图片资产的识别、清理与恢复链路，通过数据层多账户清理/激活存储过程和中间层 Kubernetes CronJob 完成批量治理。
- 建设 WCF 邮件通知服务与邮件模板，为受影响账户提供通知，并通过错误处理、失败告警和多环境配置保障任务稳定运行。
- 补充广告扩展与 Smart Page 的图片校验及功能测试，处理误报问题，并将 OSManagementDAM 相关能力迁移至中间层统一维护。

##### 程序化 Deal 同步与投放治理

- 从 0 主导 Xandr Deal 到 MS Deal 的自动同步，完成 API 分页拉取、模型映射与校验、SOAP/Bulk/WCF 多入口一致性、定向约束、分市场灰度 GA 及旧版本安全下线。

##### 视频推荐与创意生成任务链路

- 每日按配置批量捞取指定数量的广告，读取存储在 Cosmos/ADLS 中的数据库映射数据并为其生成推荐视频，同时通过 Azure Queue 限流、黑白名单、批量降级与部分成功机制保障外部生成 API 的稳定调用。
