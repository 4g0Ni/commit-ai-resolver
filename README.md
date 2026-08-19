# Commit AI Resolver — 产品规格说明

## 1. 概述

**Commit AI Resolver** 是一个由 LLM 驱动的每日变更跟踪与回归诊断系统。它会自动收集、总结并索引多个仓库中的每日代码变更和配置差异，然后通过带有交互式 LLM 聊天界面的 React 仪表板呈现这些信息，使工程师能够快速分析生产事故与近期部署之间的关联。

### 实现状态

| 组件 | 状态 | 说明 |
|---|---|---|
| ADO Git 集成（提交、差异、标签） | ✅ 已完成 | 支持 3 种标签策略 |
| LLM 提交摘要 | ✅ 已完成 | 可配置的 OpenAI 兼容模型、10 路并行、重试、差异过滤 |
| 配置/试点变更检测 | ✅ 已完成 | `changeType` + `configChanges` 字段 |
| React 仪表板 | ✅ 已完成 | 深色/浅色主题、图表、筛选器、指标、使用情况仪表板 |
| LLM 聊天界面 | ✅ 已完成 | Markdown 渲染、上下文感知 |
| 向量搜索 (RAG) | ✅ 已完成 | SQLite/sqlite-vec、可配置嵌入、基于 LLM 的查询意图提取、多查询 RRF 融合 |
| 工作项集成 | ✅ 已完成 | 粘贴 ADO 工作项 URL → 获取 bug → 提取截图 → 锚定搜索日期 |
| 每日数据生成（带缓存） | ✅ 已完成 | 增量执行、跳过已缓存的提交、`--from`/`--to` 日期范围 |
| 本地运行环境 | ✅ 已完成 | 匿名 localhost API + UI；外部提供商集成为可选项 |
| C2C Cosmos DB 试点跟踪器 | 🚫 已移除（ROI 较低） | DB 级试点渐进发布跟踪 — 已取消范围 |
| 可查询存储 | ✅ 已完成 | 每日 JSON 文件 + SQLite 向量存储（按作者/仓库/日期进行 SQL 筛选） |

### 范围内的仓库

| 仓库 | 领域 | 标签策略 | 状态 |
|---|---|---|---|
| AdsAppsCampaignUI | 广告系列管理 UI | 按日期排序 | ✅ 活跃 |
| AdsAppsMT | 中间层服务 | 滚动式 | ✅ 活跃 |
| AdsAppUI | Ads Apps UI 外壳 | 版本化 | ✅ 活跃 |
| AnB | Ads & Billing 平台 | 版本化 | ✅ 活跃 |
| AdsAppsDB | 数据库/数据层 | 版本化 | ✅ 活跃 |

---

## 2. 目标

1. **自动化每日变更报告** — 为所有跟踪仓库中的每个代码提交和配置变更生成按日摘要。
2. **试点标志与动态配置跟踪** — 检测可能改变生产环境或 SI 行为的功能标志和动态配置的新增、修改与移除。
3. **由 LLM 驱动的根因分析** — 允许工程师描述事故（延迟回归、页面崩溃、错误激增），并让模型将其与近期变更关联起来，以提出可能的原因。
4. **降低 MTTR** — 缩短 DRI 值班人员和性能调查工程师手动审查提交与配置差异所花费的时间。

---

## 3. 数据收集 — 两大支柱

### 3.1 支柱 1：试点标志与动态配置变更

#### 跟踪内容

- **功能试点标志** — 任何新增、移除或渐进发布百分比/环发生变化的标志。
- **动态配置** — 控制 UI 和 MT 层运行时行为的键值配置项。

#### 当前实现（代码级检测）

LLM 会分析每个提交的差异以检测配置变更。摘要器将每个提交分类为：
- `code` — 纯代码变更
- `config` — 仅包含试点标志、功能门控、实验定义、渐进发布百分比或配置文件的变更
- `mixed` — 同时包含代码和配置变更

对于 `config` 和 `mixed` 提交，`configChanges` 数组会记录每个标志/配置键、对应操作（新增/修改/移除）及简要说明。配置键使用**短标志名称**（例如 `NewGoogleLoginGSI`），而不是 XPath 路径。

**属于配置变更的内容：**
- 试点标志的新增、移除或渐进发布百分比变更
- 功能门控/实验定义变更
- `Dynamic.config`、`DynamicConfig*.json`、`sharedfeatures.config`、`appsettings*.json` 的值变更
- `.cscfg` / `.csdef` / `Web.config` 中的试点/灰度设置（仅限 AdsAppUI）

**不属于配置变更的内容：**
- Kubernetes / Helm 基础设施（`helm-*.yaml`、`values.yaml`、AKS 打包）
- Agent / AI 工作流文件（`agent/*.json`、`agent/*.md`）
- Dependabot 依赖版本升级
- 构建/部署脚本和 CI 流水线配置

#### 差异过滤（降噪）

在将差异发送给 LLM 之前，`src/services/diff-filter.js` 会对文件进行分类：

| 类别 | 操作 | 示例 |
|---|---|---|
| **已忽略** | 完全丢弃 | `.snap`、`.png`、`.woff2`、`.Designer.cs` |
| **自动摘要** | LOW 风险，不调用 LLM | 锁文件、`.min.js`、`.resx`、`.xlf`、`/dist/`、`.map` |
| **需要差异** | 将完整差异发送给 LLM | 其他所有内容 |

CampaignUI（本地化、部署配置）、MT（生成的代码、Agent/AI 工作流、Datamart、SCOPE 脚本）和 AdsAppUI（本地化、Razor 视图）均有各自的仓库级自定义规则。文件数超过 50 个的提交只生成文件列表摘要。

#### 规划中：C2C Cosmos DB 试点渐进发布跟踪器

- 从复制到 Cosmos DB 的 C2C 广告系列数据库中读取试点渐进发布数据。
- 针对每个试点 ID，采集：
  - **客户级**试点变更数量（新增/移除/修改）
  - **帐户级**试点变更数量
  - 当前渐进发布**百分比**及其相较上一个快照的差值
  - 试点 ID 和显示名称
  - 快照时间戳
- 将今天的 Cosmos 快照与昨天的快照进行比较，以检测：
  - 新试点开始放量（0% → N%）
  - 试点放量至 100%（全面发布）
  - 试点缩量或终止（N% → 0%）
  - 增量放量变更（例如 10% → 50%）
- 此数据源可捕获**发生在代码部署之外的运行时试点变更**，例如通过实验门户对试点进行放量而没有任何 PR。

#### 重要性

标志切换和配置变更可以在**没有任何代码部署**的情况下改变生产环境行为。它们经常是延迟回归和意外错误的根本原因。C2C/Cosmos 数据源尤其关键，因为 DB 级试点放量（客户/帐户粒度）在代码差异中不可见，却可能悄然改变大比例流量的行为。

---

### 3.2 支柱 2：每个发布版本的代码提交变更

#### 当前实现

通过 ADO REST API v7.1 的 `fetchCommitsBetweenDates` 端点，按日获取合并到 `master` 的所有提交。

#### 逐提交处理流水线

对于每个提交，系统会：

1. 通过 `fetchCommitChanges` **获取变更文件列表**（成本较低的 ADO API 调用）。
2. 使用 `diff-filter.js` **对文件分类** — 已忽略/自动摘要/需要差异。
3. 对所有文件都可自动分类的提交**完全跳过 LLM**（立即判定为 LOW 风险）。
4. **仅获取相关文件的差异** — 跳过锁文件、资产和生成的代码。
5. **LLM 摘要**（10 路并行，采用指数退避重试 3 次）— 生成：
   - 简洁标题（单行）
   - 详细摘要段落
   - 风险评估：`LOW` / `MEDIUM` / `HIGH`
   - 变更类型：`code` / `config` / `mixed`
   - 配置变更数组（键、操作、详情）
   - 受影响区域和功能标志
6. **采集元数据：** SHA、作者、日期、消息、URL
7. **缓存结果** — 除非指定 `--force`，否则会复用 JSON 文件中已有的提交摘要

---

## 4. 每日报告

每日报告以 JSON 文件形式存储在 `data/daily/YYYY-MM-DD.json` 中，由 `src/scripts/generate-sample-data.js` 生成。

### JSON 结构

```json
{
  "date": "2026-04-02",
  "repositories": {
    "AdsAppsCampaignUI": {
      "repo": "AdsAppsCampaignUI",
      "commits": [
        {
          "commitId": "...",
          "shortId": "8c4b796e",
          "author": "...",
          "date": "...",
          "url": "...",
          "summary": {
            "title": "...",
            "summary": "...",
            "riskLevel": "MEDIUM",
            "affectedAreas": ["Scope Bar", "Campaign Dropdown"],
            "flags": ["IsRenameHotelToLodgingEnabled"],
            "changeType": "code",
            "configChanges": []
          }
        }
      ],
      "stats": { "total": 65, "high": 2, "medium": 35, "low": 28, "configChanges": 5 }
    },
    "AdsAppsMT": { "..." : "..." },
    "AdsAppUI": { "..." : "..." },
    "AnB": { "..." : "..." },
    "AdsAppsDB": { "..." : "..." }
  },
  "summary": {
    "totalCommits": 98,
    "totalHigh": 8,
    "totalMedium": 56,
    "totalLow": 34,
    "totalConfigChanges": 30,
    "reposIncluded": ["AdsAppsCampaignUI", "AdsAppsMT", "AdsAppUI", "AnB", "AdsAppsDB"]
  }
}
```

### 仪表板可视化

React 仪表板按以下形式呈现每日报告：

- **堆叠柱状图** — 每天一根柱，分段按风险级别着色，可点击
- **垂直指标侧边栏** — 使用彩色边框显示汇总计数
- **提交详情视图** — 按仓库分区，包含完整提交卡片、配置徽章和标志标签
- **日期范围选择器** — 筛选 7/14/30 天时间窗口
- **仓库筛选器** — 单独开启或关闭各仓库
- **使用情况指标仪表板** — 查询量、DAU/WAU/MAU、置信度分布、反馈率、延迟百分位数、留存与采用指标

---

## 5. 使用场景

### 5.1 使用场景 1：延迟回归调查

**角色：** 性能工程师 / DRI

**场景：** 从大约 4 天前开始，某个页面的加载延迟从 3 s 激增至 14 s。

**工作流：**

1. 用户打开 LLM 聊天界面。
2. 用户提供：
  - 受影响的页面/场景名称
  - 回归发生的时间段（例如“约从 3 月 27 日开始”）
  - 指标详情（例如 P50 延迟从 3 s → 14 s）
3. 系统：
  - 查找所述时间段的每日报告，并**额外增加 2 天缓冲期**（发布版本最长可能需要 2 天才能到达生产环境）。
  - 按文件路径、组件名称、标志名称筛选与受影响页面相关的变更。
  - 按相关性和风险级别对候选变更进行排序。
4. LLM 返回：
  - 带链接的可疑变更（提交和/或标志切换）排序列表。
  - 对每个可疑项说明其可能相关的原因（代码路径重叠、时间匹配、风险级别）。
  - 建议的后续步骤（回退标志、cherry-pick 回退提交、进行更深入的性能分析）。

### 5.2 使用场景 2：DRI 值班 — Beta Prod 错误/页面崩溃

**角色：** DRI 值班工程师

**场景：** 手动测试人员报告 beta-prod 上出现页面崩溃或错误（新发布的代码尚未切换到完整生产环境）。

**工作流：**

1. 用户打开 LLM 聊天界面。
2. 用户提供：
  - 错误消息或崩溃特征
  - 受影响的页面/功能区域
  - Beta-prod 环及观察到问题的大致时间
3. 系统：
  - 识别今天（或最近）的发布版本及其包含的提交。
  - 在提交摘要中搜索涉及受影响区域的变更。
  - 交叉核对任何可能启用新代码路径的近期试点标志变更。
4. LLM 返回：
  - 最可能的根因提交及其 PR 链接。
  - 对 cherry-pick 紧迫性的评估（是否造成阻塞？影响范围有多大？）。
  - 验证步骤（例如“在 SI 中禁用标志 X 并复现”）。

### 5.3 使用场景 3：每日变更审查（主动）

**角色：** 团队负责人/工程经理

**场景：** 快速准备每日站会 — 了解昨天发布了哪些内容。

**工作流：**

1. 用户询问：“昨天所有仓库发布了哪些内容？”
2. 系统返回每日报告摘要，并突出显示高风险项。

### 5.4 使用场景 4：事故复盘支持

**角色：** 事故响应团队

**场景：** 为事故复盘构建时间线 — 需要准确识别导致中断的变更及其到达生产环境的时间。

**工作流：**

1. 用户提供事故时间窗口。
2. 系统按时间顺序返回该窗口内所有部署和配置变更的时间线，并附上 LLM 对相关性的分析注释。

---

## 6. 系统架构 — 工作分解

> **父任务：** [10544035 — Commit AI Resolver](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544035)

### 6.1 数据收集层

| 工作项 | 说明 | ADO |
|---|---|---|
| Git 集成 | 连接到各仓库的 Azure DevOps API。获取发布标签之间的提交。参考：[DRIAgent ADO 处理程序](https://msasg.visualstudio.com/Bing_Ads/_git/B2BCrawler/pullrequest/5444356?path=/projects/DRIAgent/src/app/ado-handlers.js&_a=files) | [10544142](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544142) |
| 发布标签解析器 | 为每个仓库确定今天和昨天的发布标签。将提交映射到发布窗口。 | [10544144](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544144) |
| 差异获取器 | 获取每个提交的完整差异。应用噪声过滤器（锁文件、代理文件、可配置 glob）。 | [10544145](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544145) |
| 标志/配置差异器 | 识别每个仓库中的标志和动态配置定义文件。计算结构化差异（新增/变更/移除）。 | [10544146](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544146) |
| C2C Cosmos DB 试点渐进发布跟踪器 | 从复制到 Cosmos DB 的 C2C 广告系列数据库中读取试点渐进发布数据。比较每日快照以检测放量变更。 | [10544147](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544147) |

### 6.2 数据处理流水线

| 工作项 | 说明 | ADO |
|---|---|---|
| LLM 摘要 | 对每个经过滤的提交差异调用 LLM，以生成标题、摘要和风险标签。 | [10544150](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544150) |
| 标志变更注释器 | 为每个标志/配置差异生成便于阅读的变更说明和影响评估。 | [10544151](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544151) |
| 去重 | 处理合并提交、回退后重新合并以及 cherry-pick，避免重复计数。 | [10544152](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544152) |
| 噪声过滤引擎 | 通过可配置规则跳过或压缩已知噪声文件（锁文件、生成的代码等）。 | [10544153](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544153) |
| 批处理与速率限制 | 管理 LLM API 令牌预算。批量处理小型差异，对大型差异进行分块。 | [10544154](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544154) |

### 6.3 数据存储与摄取

#### 存储策略：可查询 DB（推荐）与 JSON 文件对比

| 方案 | 优点 | 缺点 |
|---|---|---|
| **JSON 文件 (Blob Storage)** | 生成简单；易于进行版本控制和差异比较；无需设置 DB | 无法实时筛选；查询单个仓库也必须加载一整天的数据；不适合跨天查询 |
| **DB 表 (Azure SQL / CosmosDB)** | 实时筛选查询（按仓库、变更类型、日期范围、作者、风险级别）；高效支持聊天 RAG 层；可通过索引扩展 | 需要设计架构并进行 DB 运维 |
| **混合方案：DB + JSON 归档** | DB 用于实时查询；JSON 快照用于备份、共享和 LLM 上下文注入 | 需要维护两个写入目标 |

**建议：** 使用**可查询 DB 作为主存储**，并可选择按日导出 JSON 用于归档/共享。核心使用场景（例如“仅显示 AdsAppsCampaignUI 本周的试点配置变更”）需要执行筛选查询，而平面文件无法高效支持此类查询。

#### 建议的 DB 表

| 表 | 关键列 | 用途 |
|---|---|---|
| `daily_commits` | `date`, `repo`, `commit_sha`, `pr_id`, `author`, `title`, `summary`, `risk_level`, `files_changed`, `pr_link`, `merge_timestamp` | 代码提交摘要 |
| `pilot_flag_changes` | `date`, `repo`, `flag_key`, `old_value`, `new_value`, `source` (code / cosmos), `commit_sha`, `pr_link`, `author` | 代码级标志差异 |
| `pilot_ramp_changes` | `date`, `pilot_id`, `pilot_name`, `customer_count_delta`, `account_count_delta`, `old_percentage`, `new_percentage`, `snapshot_timestamp` | C2C/Cosmos DB 级试点渐进发布变更 |
| `dynamic_config_changes` | `date`, `repo`, `config_key`, `old_value`, `new_value`, `commit_sha`, `pr_link`, `author` | 动态配置差异 |
| `daily_reports` | `date`, `repo`, `report_json`, `summary_md` | 每个仓库每日的完整组装报告（用于 LLM 上下文注入和导出） |

#### 查询示例

```sql
-- Pilot config changes from AdsAppsCampaignUI only
SELECT * FROM pilot_flag_changes
WHERE repo = 'AdsAppsCampaignUI' AND date = '2026-03-30';

-- All high-risk commits across repos for a date range
SELECT * FROM daily_commits
WHERE risk_level = 'HIGH' AND date BETWEEN '2026-03-25' AND '2026-03-31';

-- Pilot ramps that changed by more than 10% (DB-level)
SELECT * FROM pilot_ramp_changes
WHERE ABS(new_percentage - old_percentage) > 10 AND date = '2026-03-30';
```

#### 工作项

| 工作项 | 说明 | ADO |
|---|---|---|
| DB 架构设计 | 定义表、索引（日期 + 仓库复合索引）和列类型。 | [10544158](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544158) |
| 存储预配 | 设置具有适当吞吐量和保留策略的 Azure SQL 或 CosmosDB。 | [10544159](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544159) |
| 摄取流水线 | 编排：收集 → 处理 → 写入 DB。每日定时执行（例如 Azure Functions 定时器触发器或 ADO 流水线）。 | [10544160](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544160) |
| JSON 导出（可选） | 每晚将当日数据作为 JSON 快照导出到 Blob Storage 进行归档。 | [10544162](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544162) |
| 回填工具 | 能够重新运行历史日期，以便在架构变更或 LLM 提示词改进后重建 DB 行。 | [10544163](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544163) |
| 查询 API | 构建位于 DB 之上的 REST 或 GraphQL API 层，为仪表板和聊天 RAG 层提供服务。 | [10544165](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544165) |

### 6.4 数据可视化

| 工作项 | 说明 | ADO |
|---|---|---|
| 日期图表/时间线 UI | 显示每日变更数量、风险指示器和下钻详情的日历或时间线视图。 | [10544188](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544188) |
| 每日报告详情视图 | 按日呈现 Markdown 或 HTML 页面，包含完整的提交摘要和标志差异。 | [10544194](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544194) |
| 筛选与搜索 | 按仓库、作者、风险级别、日期范围和关键字筛选。 | [10544198](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544198) |
| 仪表板指标 | 汇总视图：每日提交趋势、标志变更频率、高风险变更热力图。使用情况指标仪表板包含 DAU/WAU/MAU、反馈率、延迟百分位数、留存和采用指标。 | [10544202](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544202) |

### 6.5 LLM 聊天集成

| 工作项 | 说明 | ADO |
|---|---|---|
| 聊天界面 | 基于 Web 的聊天 UI，供工程师描述事故并提出问题。支持粘贴 ADO 工作项 URL 以自动获取 bug 上下文。 | [10544301](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544301) |
| 检索层 (RAG) | 根据用户查询，按日期范围、仓库、页面/组件关键字检索相关的每日报告片段。自动应用 2 天发布缓冲期。工作项搜索采用多查询 RRF 融合。 | [10544206](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544206) |
| 提示词工程 | 通过系统提示词指示模型将用户描述的症状与检索到的变更数据关联起来，并生成带链接的可疑项排序列表。 | [10544208](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544208) |
| 上下文窗口管理 | 在令牌限制内处理大型报告窗口（多天 × 多个仓库）— 按需摘要或分页。 | [10544209](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544209) |
| 响应格式化 | 结构化输出：可疑项排序、链接、风险评估、建议的后续步骤。 | [10544210](https://msasg.visualstudio.com/Bing_Ads/_workitems/edit/10544210) |

### 6.6 向量搜索与嵌入 (RAG)

#### 架构

聊天界面使用**检索增强生成 (RAG)** 流水线，避免将所有提交摘要都塞入 LLM 上下文窗口。每日 JSON 记录仍是可审计的事实来源；SQLite 元数据、FTS5 和 `sqlite-vec` 是可重建的词法索引与稠密索引。查询先组合精确/元数据查找、FTS5 词法检索和余弦相似度，再进行加权 RRF 融合。

```
User Query
    │
    ├──── LLM Intent Extraction ──┐
    │     (extract author, repo,  │
    │      date range, rewritten  │
    │      search query + secondary│
    │      query via LLM)          │
    ▼                             ▼
┌─────────────────┐     ┌───────────────────┐
│  Embed Queries   │────▶│ SQLite hybrid    │
│  (configurable)  │     │ FTS5 + cosine    │
│   3-large)      │     │   pre-filters)    │
└─────────────────┘     └───────────────────┘
                                │
            Up to 3 parallel searches:
            1. Primary query (weight 1)
            2. FTS5 lexical query (weight 1)
            3. Secondary query (weight 0.7)
            4. Bug title verbatim (weight 1.5)
                                │
                                ▼
                        ┌───────────────────┐
                        │  RRF Fusion       │
                        │  Merge & re-rank  │
                        └───────────────────┘
                                │
                                ▼
                        ┌───────────────────┐
                        │  Build Context    │
                        │  (top 30-50       │
                        │   commits)        │
                        └───────────────────┘
                                │
                                ▼
                        ┌───────────────────┐
                        │  LLM Chat         │
                        │  (GPT-5.4)        │
                        │  + bug screenshots│
                        │  (multimodal)     │
                        └───────────────────┘
```

#### 基于 LLM 的查询意图提取

聊天 API 使用轻量级 LLM 预处理调用，从自然语言查询中提取结构化筛选条件。这取代了之前较为脆弱的正则表达式方案（例如，"changes" 会错误匹配作者 "Chang"）。

LLM 提取包含以下字段的 JSON 对象：
- `author` — 如果查询针对特定人员的提交，则为人员姓名
- `repo` — 如果提到仓库，则为准确的仓库名称（可识别 "campaignui"、"cmui"、"uiserver"、"anb"、"ccdb"、"ccmt"、"client center db"、"client center mt"、"cmdb"、"campaign db"、"db"、"adsappsdb" 等别名）
- `dateFrom` / `dateTo` — 如果提到时间，则为日期范围（可解析 "last week"、"yesterday" 等相对日期）
- `searchQuery` — 针对嵌入相似度搜索优化的改写版本（已移除筛选词）
- `secondarySearchQuery` — 侧重修复机制的第二个不同语义查询（仅用于工作项查询）。它使用与主查询不同的术语，弥合 bug 描述与修复提交之间的语义差距。
- `riskLevel` — 明确请求时按风险级别（HIGH、MEDIUM、LOW）筛选
- `changeType` — 明确请求时按变更类型（code、config、mixed）筛选
- `keywords` — 用于文本匹配的后备关键字（3-6 个词）
- `confidence` — 自评的提取质量（0-1）
- `verdict` — 自我验证结果：`GOOD`（继续）或 `ASK_USER`（请求澄清）。用于取代独立的 Extraction Analyzer Agent。

候选项检索以排名优先：默认的 `VECTOR_MIN_SCORE=0` 可避免在不同嵌入模型间沿用未经校准的余弦阈值。非零截断值为可选配置，应基于所选模型的固定检索集进行校准。

**次要查询通过 `broadSearchOpts` 绕过元数据筛选器**（riskLevel、changeType），以扩大检索范围，避免过滤掉元数据分类不同的相关提交。

#### 组件

| 组件 | 文件 | 说明 |
|---|---|---|
| 嵌入客户端 | `src/services/embedding-client.js` | OpenAI 兼容的托管/本地客户端，具有共享的模型、维度、查询指令和批处理契约 |
| 向量存储 | `src/services/vector-store.js` | SQLite 元数据 + FTS5 + `sqlite-vec` (`data/vectors.db`)。选择性元数据筛选器在精确余弦排名前运行；较大的候选集使用分区 KNN |
| 工作项检测器 | `src/services/workitem-detector.js` | 从用户消息的 URL 模式中检测 ADO 工作项 ID |
| ADO Git 客户端 | `src/services/ado-git-client.js` | Azure DevOps REST API 客户端。获取提交、差异和工作项。从工作项 HTML 字段（Description、ReproSteps）中提取并获取图像 |
| 嵌入生成器 | `src/scripts/generate-embeddings.js` | 读取每日 JSON 文件，构建带版本的可搜索文本，生成可配置的嵌入批次，并以增量方式 upsert 稠密索引和 FTS5 索引 |
| 聊天 API (RAG) | `api/server.js` | 意图提取 → 稠密检索 + FTS5 检索 → 加权 RRF 融合 → 有界的合成/评估循环。对于历史离线语料库，相对日期锚定到已索引的最近一天 |

#### 嵌入模型

- **默认模型：** `text-embedding-3-large`（3072 维）
- **离线模型：** 任何 OpenAI 兼容端点，包括 Qwen3/BGE 部署；需配置实际输出维度
- **索引契约：** 模型、维度、文档模板版本和上次更新时间记录在 `vector_store_meta` 中
- **端点：** `OPENAI_BASE_URL`，未设置时使用 OpenAI API
- **身份验证：** 可选的服务器端 `OPENAI_API_KEY`；不使用浏览器令牌

#### 每个提交的文本表示

每个提交都作为语义文档文本进行嵌入，其中包含：
- 仓库名称
- LLM 生成的标题和摘要
- 受影响区域、功能标志、配置变更
- 精简的文件路径和清理后的提交主题

日期、作者、风险级别和变更类型保留在元数据中，并作为结构化筛选器应用。

#### 用法

```bash
# Generate embeddings for all daily data (incremental)
cd src && node scripts/generate-embeddings.js

# Re-embed last 7 days
node scripts/generate-embeddings.js --days 7

# Re-embed a specific date range
node scripts/generate-embeddings.js --from 2026-03-25 --to 2026-03-31 --force

# Force re-embed everything
node scripts/generate-embeddings.js --force
```

#### 回退行为

聊天 API 可平稳降级：
1. **向量存储可用 + 找到结果** → RAG 路径（语义最相关的前 20 个提交）
2. **向量存储可用但没有结果** → 回退到填充完整上下文
3. **没有向量存储** → 填充完整上下文（原始行为）

---

## 7. 流水线流程

```
┌─────────────┐     ┌──────────────┐     ┌────────────────┐
│  Scheduled   │────▶│  Data        │────▶│  LLM           │
│  Trigger     │     │  Collection  │     │  Summarization  │
│  (daily)     │     │  (Git + ADO) │     │  Pipeline       │
└─────────────┘     └──────────────┘     └────────────────┘
                                                 │
                                                 ▼
                    ┌──────────────┐     ┌────────────────┐
                    │  Storage     │◀────│  Report        │
                    │  (DB/Blob)   │     │  Assembly      │
                    └──────────────┘     └────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
     ┌──────────────┐ ┌─────────┐ ┌──────────┐
     │  Date Chart  │ │  Chat   │ │  API     │
     │  Dashboard   │ │  (RAG)  │ │  Access  │
     └──────────────┘ └─────────┘ └──────────┘
```

---

## 8. 待做的关键设计决策

| 决策 | 待评估选项 |
|---|---|
| LLM 提供商 | Azure OpenAI (GPT-4o) / GitHub Models / 自托管 |
| 存储 | CosmosDB / Azure SQL / Blob Storage + 搜索索引 |
| 编排 | Azure Functions（定时器）/ ADO Pipeline / GitHub Actions |
| 聊天框架 | Copilot SDK / 自定义 RAG 应用 / Teams 机器人 |
| 可视化 | 自定义 React 应用 / Power BI / Grafana |
| 发布标签策略 | Git 标签 / ADO 发布定义 / 各仓库的构建编号 |
| 噪声过滤器配置 | 仓库级 `.commitairc` 文件 / 中央配置 |
| 身份验证与访问控制 | 仅限本地的匿名访问 / 外部网关 | ✅ 仅限本地的匿名访问；公开暴露前需要外部身份验证 |

---

## 9. 非功能需求

- **延迟：** 所有仓库的每日流水线必须在 30 分钟内完成。
- **新鲜度：** 前一天变更的报告应在当地时间上午 9 点前可用。
- **准确性：** LLM 摘要必须以实际差异内容为依据，不得臆造变更。
- **可扩展性：** 支持在不变更流水线的情况下添加新仓库（配置驱动）。
- **成本：** 优化 LLM 令牌使用量，在发送给 LLM 之前过滤噪声，并缓存重复模式。
- **可靠性：** 流水线失败时应发出警报并自动重试。部分失败（一个仓库不可用）不应阻塞其他仓库。

---

## 10. 成功指标

| 指标 | 目标 |
|---|---|
| 识别可疑提交的平均时间（通过聊天） | < 5 分钟（相比手动操作的 30–60 分钟） |
| 每日报告覆盖率 | 覆盖全部 5 个仓库中 100% 的提交 |
| 可疑项排名中的误报率 | 前 3 条建议中 < 30% |
| DRI 采用率 | 3 个月内有 80% 的值班事故使用此工具 |
| 流水线可靠性 | 每日完成率 > 99% |
| 用户参与度（DAU/MAU 比率） | 通过使用情况指标仪表板跟踪（用户身份来自 Entra ID） |
| 正向反馈率 | 通过使用情况指标仪表板跟踪 |
| 用户留存率 | 通过使用情况指标仪表板跟踪 |

---

## 11. 智能体搜索流程（多步骤查询流水线）

### 11.1 动机

当前搜索流程使用带多查询搜索的智能体循环：提取意图 → 多查询嵌入 → 使用 RRF 融合的向量搜索 → LLM 回答 → 评估 → 按需重试。它可以处理：

- 模糊或有歧义的查询（“上周有东西坏了”）— 请求澄清
- 工作项 URL 输入 — 获取 bug 上下文、锚定日期并运行 3 个并行搜索
- 带自我验证的意图提取 — 无需独立的分析器 Agent
- 通过迭代优化评估回答质量

### 11.2 架构概览

```
                          ┌─────────────────────────────────┐
                          │         User Query               │
                          │   (or ADO work item URL)          │
                          └────────────┬────────────────────┘
                                       │
                            (if URL detected, fetch work item
                             + extract screenshots from HTML)
                                       │
                          ┌────────────▼────────────────────┐
                          │   Agent 1: Intent Extractor      │
                          │   (extract filters + search      │
                          │    query + secondary query        │
                          │    + self-validation)             │
                          └──────┬───────────┬──────────────┘
                                 │           │
                        ┌────────▼──┐   ┌────▼──────────────┐
                        │  GOOD     │   │  ASK_USER          │
                        │           │   │  → return           │
                        │           │   │  clarification      │
                        │           │   │  question to user   │
                        └────┬──────┘   └───────────────────┘
                             │
                          ┌──▼──────────────────────────────┐
                          │   Multi-Query RAG Search          │
                          │   1. Primary query (weight 1)     │
                          │   2. FTS5 lexical query (weight 1)│
                          │   3. Secondary query (weight 0.7) │
                          │   4. Bug title search (weight 1.5)│
                          │   → Reciprocal Rank Fusion (RRF)  │
                          └────────────┬────────────────────┘
                                       │
                          ┌────────────▼────────────────────┐
                          │   Agent 2: Answer Synthesizer    │
                          │   (analyze results, rank          │
                          │    suspects, generate answer      │
                          │    with commit links + ratings)    │
                          │   (multimodal: bug screenshots)   │
                          └────────────┬────────────────────┘
                                       │
                          ┌────────────▼────────────────────┐
                          │   Agent 3: Answer Evaluator      │
                          │   (rate confidence, check         │
                          │    grounding, validate links)     │
                          └──────┬───────────┬──────────────┘
                                 │           │
                        ┌────────▼──┐   ┌────▼──────────────┐
                        │  PASS     │   │  RETRY             │
                        │  → return │   │  → refine query    │
                        │  to user  │   │    (add keywords,  │
                        │           │   │     broaden dates)  │
                        └───────────┘   └───────┬───────────┘
                                                │ (loop back to
                                                │  Intent Extractor
                                                │  with feedback)
                                                │
                                        max 3 iterations
```

### 11.3 Agent 定义

#### Agent 1：意图提取器（带自我验证）

**输入：** 原始用户查询 + 对话历史 +（可选）Evaluator 对上一次尝试的反馈 +（可选）工作项上下文。

**输出：** 结构化 JSON：
```json
{
  "author": "Beina Zhang" | null,
  "repo": "AdsAppsCampaignUI" | null,
  "dateFrom": "2026-03-25" | null,
  "dateTo": "2026-03-31" | null,
  "searchQuery": "store page crash error in campaign editor",
  "secondarySearchQuery": "grid template rendering no-data view filter reset",
  "riskLevel": "HIGH" | null,
  "changeType": "config" | null,
  "keywords": ["crash", "store page", "campaign editor"],
  "confidence": 0.85,
  "ambiguities": [],
  "verdict": "GOOD" | "ASK_USER",
  "clarificationQuestion": null
}
```

**关键能力：**
- 为工作项查询添加 `secondarySearchQuery` — 使用与主查询不同的术语，弥合 bug 描述与修复提交之间的语义差距
- 通过 `verdict` 字段自我验证提取质量 — 取代独立的 Extraction Analyzer Agent（节省一次 LLM 往返，约 8-12s）
- 添加 `riskLevel` 和 `changeType` 字段以进行结构化筛选
- 接受 Evaluator 的反馈，在重试时重新构造查询
- 提供工作项时，根据 bug 标题、描述和复现步骤构造高度针对性的查询

#### Agent 2：回答合成器

**输入：** RAG 搜索结果（带元数据的 top-K 提交）+ 原始查询 + 提取的意图 +（可选）作为多模态内容的 bug 截图。

**输出：**
```json
{
  "answer": "Based on the commits from March 27–29, the most likely cause...",
  "confidence": 0.78,
  "suggestedActions": ["revert flag X", "check perf traces for commit abc123"],
  "searchCoverage": "partial",
  "suspectCount": 5
}
```

**职责：**
- 按与用户查询的相关性对可疑提交进行排序
- 为每个可疑项提供直接提交链接（ADO URL）
- 根据结果与查询的匹配程度评估置信度
- 在搜索覆盖范围不足时标记（结果太少、相似度得分较差）
- **多模态：** 如果有 bug 截图，将其作为图像内容块与文本查询一同传入，使 LLM 能够关联视觉症状与代码变更
- 根据客观指标限制置信度 — 如果结果不超过 2 个且平均得分 < 0.3，则置信度上限为 0.5

#### Agent 3：回答评估器

**输入：** Answer Synthesizer 的输出 + 原始查询 + 搜索元数据（结果数、得分分布）。

**输出：**
```json
{
  "verdict": "PASS" | "RETRY" | "PARTIAL",
  "qualityScore": 0.82,
  "issues": [],
  "retryStrategy": {
    "action": "broaden_search" | "add_keywords" | "expand_dates" | "try_different_repo",
    "newKeywords": ["performance", "latency", "P50"],
    "expandedDateFrom": "2026-03-20",
    "reasoning": "Initial search only found 3 results with low scores..."
  }
}
```

**评估标准：**
- **依据检查：** 所有引用的提交是否确实存在于搜索结果中？（防止幻觉）
- **相关性得分：** 所引用可疑项的平均相关性（阈值：> 0.5）
- **回答完整性：** 回答是否涵盖用户查询的所有方面？
- **置信度阈值：** 当置信度 ≥ 0.65 且结果数 ≥ 3 时，快速路径判定为 PASS
- **结果覆盖范围：** 如果搜索返回的结果少于 5 个或所有得分均 < 0.3，建议扩大范围
- **日期扩展：** 重试时，可以建议扩大日期范围，并应用到下一次迭代的 RAG 搜索

### 11.4 迭代循环

智能体流程以循环方式运行，每个用户查询**最多迭代 3 次**：

```
Iteration 1: Extract (+ self-validate) → Multi-Query Search → Synthesize → Evaluate
Iteration 2: (if eval = RETRY) Refine query → Search → Synthesize → Evaluate
Iteration 3: (if eval = RETRY) Broaden filters → Search → Synthesize → Evaluate
             Force return best answer so far
```

**迭代预算跟踪：**

| 迭代 | 重点 | 典型操作 |
|---|---|---|
| 1 | 初始尝试 | 使用提取的意图和多查询 RRF 运行完整流水线 |
| 2 | 查询优化 | 根据结果分析添加关键字、调整日期范围、应用评估器的日期覆盖值 |
| 3 | 尽力而为 | 返回各次迭代中累积的最高置信度回答；如果置信度仍然较低，则附加免责声明 |

**提前退出条件：**
- Answer Evaluator 返回 `PASS`（qualityScore ≥ 0.65 且结果数 ≥ 3）→ 立即返回
- Intent Extractor 返回 `ASK_USER` → 暂停循环，向用户发送澄清问题，并在用户响应后恢复
- Answer Evaluator 返回 `PARTIAL` → 返回回答并附加“结果可能不完整”的免责声明
- 3 次迭代全部用尽 → 返回最佳回答并附加置信度免责声明

### 11.5 澄清协议 (ASK_USER)

当 Intent Extractor 的自我验证判定查询过于模糊、无法继续时：

1. 流水线暂停，并通过聊天界面向用户返回一个**澄清问题**
2. UI 将其呈现为系统消息（区别于最终回答）
3. 用户响应并提供额外上下文
4. 流水线从 Intent Extractor 恢复，并在原始查询后附加用户的澄清内容
5. 此过程计为循环的一次迭代

**示例：**
```
User: "something is broken"
System: "Could you clarify: Which page or feature is affected? When did you first notice the issue? Are you seeing errors, crashes, or performance degradation?"
User: "the campaign editor page is crashing since yesterday"
→ Pipeline resumes with enriched context
```

### 11.6 消息队列 / Agent 协调

这些 Agent **并非**传统的消息队列系统。它们实现为**单个请求处理程序中的顺序 LLM 调用**，由编排器函数进行协调。这使架构保持简单，并避免了分布式消息代理的复杂性。

```javascript
// Pseudocode for the orchestrator
async function agenticSearch(userQuery, history, workItemContext, maxIterations = 3) {
    let bestAnswer = null;
    let context = { query: userQuery, history, feedback: null, workItemContext };

    // If work item provided, anchor dates to bug creation
    if (workItemContext?.createdDate) {
        context.dateOverrides = { dateFrom: bugDate - 2days, dateTo: bugDate };
    }

    for (let i = 0; i < maxIterations; i++) {
        // Agent 1: Extract intent (with self-validation)
        const intent = await intentExtractor(context);

        if (intent.verdict === 'ASK_USER') {
            return { type: 'clarification', question: intent.clarificationQuestion };
        }

        // Multi-query RAG search with RRF fusion
        const primaryResults = await ragSearch(intent.searchQuery, searchOpts);
        const allLists = [{ results: primaryResults, weight: 1 }];

        if (intent.secondarySearchQuery) {
            const secondaryResults = await ragSearch(intent.secondarySearchQuery, broadSearchOpts);
            allLists.push({ results: secondaryResults, weight: 1 });
        }
        if (workItemContext?.title) {
            const titleResults = await ragSearch(workItemContext.title, broadSearchOpts);
            allLists.push({ results: titleResults, weight: 5 });
        }

        const results = fuseResults(allLists); // Reciprocal Rank Fusion

        // Agent 2: Synthesize answer (with bug screenshots if available)
        const answer = await answerSynthesizer(results, intent, context);

        // Agent 3: Evaluate answer
        const evaluation = await answerEvaluator(answer, context, results);

        if (evaluation.qualityScore > (bestAnswer?.qualityScore || 0)) {
            bestAnswer = { ...answer, qualityScore: evaluation.qualityScore };
        }

        if (evaluation.verdict === 'PASS') {
            return { type: 'answer', ...bestAnswer };
        }

        // Apply evaluator feedback (date expansion, new keywords) for next iteration
        context.feedback = evaluation.retryStrategy;
        if (evaluation.retryStrategy.expandedDateFrom) {
            context.dateOverrides = { dateFrom: evaluation.retryStrategy.expandedDateFrom };
        }
    }

    // Max iterations reached — return best effort
    return { type: 'answer', ...bestAnswer, disclaimer: 'Low confidence — results may be incomplete.' };
}
```

**为什么不使用消息队列？**
- 整个流程都**限定在请求范围内** — 它在单个 HTTP 请求中开始并结束
- 延迟至关重要（用户正在等待）— 增加代理开销会适得其反
- Agent 共享状态（累积的上下文、之前的结果），使用进程内调用很容易实现，但使用队列会很复杂
- 如果将来需要异步处理（例如后台深度分析），可以并行添加作业队列，而无需替换同步编排器

### 11.7 延迟预算

每次迭代都会增加 LLM 调用。各 Agent 的目标延迟如下：

| Agent | 目标延迟 | LLM 调用次数 |
|---|---|---|
| Intent Extractor（+ 自我验证） | 500ms | 1（轻量级、低温度） |
| RAG Search（混合 + RRF） | 取决于工作负载 | 0（本地嵌入 + SQLite FTS5/sqlite-vec） |
| Answer Synthesizer | 2000ms | 1（完整分析、较高令牌输出、可选多模态） |
| Answer Evaluator | 500ms | 1（轻量级评估） |

**每次迭代预算：** 约 3.3 秒（相比使用独立 Analyzer 时的约 3.8s 有所下降）
**最坏情况（3 次迭代）：** 约 10 秒
**典型情况（1 次迭代）：** 约 3-4 秒 + 网络延迟
**观测到的平均值：** 约 34 秒（主要由 LLM API 延迟决定，而非本地计算）

为将聊天响应时间保持在可接受范围内：
- 对轻量级 Agent（Extractor、Evaluator）使用 `gpt-5.4`（速度快）
- 仅为 Synthesizer 预留较高的令牌预算（最多 2048 个令牌、10 个结果）
- 嵌入 LRU 缓存（100 个条目）可避免对重复查询重新嵌入
- 将最终回答流式传输到 UI（生成时显示部分响应）
- 在 UI 中显示迭代进度（“正在优化搜索... 第 2/3 次尝试”）

### 11.8 工作项

| 工作项 | 说明 | 状态 |
|---|---|---|
| Agent 编排器 | 带 Agent 协调、预算跟踪和提前退出逻辑的迭代循环 | ✅ 已完成 |
| Intent Extractor v2 | 置信度评分、关键字、歧义检测、自我验证、次要搜索查询、工作项上下文 | ✅ 已完成 |
| ~~Extraction Analyzer Agent~~ | ~~评估意图提取质量~~ | 已移除 — 作为自我验证合并到 Intent Extractor 中 |
| Answer Synthesizer Agent | 对可疑项排序，生成带提交链接、置信度和多模态支持的结构化回答 | ✅ 已完成 |
| Answer Evaluator Agent | 评估回答质量、依据和置信度；决定通过/重试/部分返回 | ✅ 已完成 |
| 工作项集成 | 检测 ADO URL、获取 bug 上下文、提取图像、锚定搜索日期 | ✅ 已完成 |
| 多查询 RRF 搜索 | 使用 Reciprocal Rank Fusion 融合主查询、次要查询和标题查询 | ✅ 已完成 |
| Bug 截图支持 | 从工作项 HTML 中提取图像，经过身份验证后获取，并作为多模态内容传入 | ✅ 已完成 |
| 澄清 UI | 聊天 UI 支持系统澄清问题（与回答区分） | ✅ 已完成 |
| 迭代进度 UI | 在聊天界面中显示迭代次数 | ✅ 已完成 — UI 在响应元数据中显示“搜索已优化 N 次” |
| 流式传输支持 | 将最终回答流式传输到 UI，以改善感知延迟 | ✅ 已完成 — SSE (`event: status` / `token` / `complete`) 端到端支持 |

---

## 12. 部署

### 本地运行环境

受支持的免身份验证运行环境为本地环境。API 绑定到 `127.0.0.1:4399`，Vite 在 `https://localhost:5173` 上提供 UI，UI 将 `/api` 和 `/mcp` 代理到后端。

不要将 API 或 MCP 端点直接暴露到公共接口。它们没有应用级访问控制，可能泄露提交摘要、查询历史、反馈和差异数据。

以前的 Azure 预配和 Kudu 管理脚本已被移除，因为它们依赖企业 Azure 身份、Managed Identity/RBAC 和 Azure CLI 持有者令牌。`deploy/prepare-api.ps1` 仅作为打包实用工具保留；它本身不会部署任何内容。

### 数据管理（重置/刷新/重建）

系统提供用于管理运行时数据的本地工具。

#### CLI 脚本 (`scripts/reset-and-refresh.js`)

```bash
# Reset all data + backfill 90 days
node scripts/reset-and-refresh.js

# Reset + backfill custom window
node scripts/reset-and-refresh.js --days 60

# Only reset (no backfill)
node scripts/reset-and-refresh.js --reset-only

# Backfill missing commits only (skip existing, preserve data)
node scripts/reset-and-refresh.js --refresh-only --days 90

# Rebuild vector embeddings from existing daily JSON (no ADO fetch)
node scripts/reset-and-refresh.js --rebuild-embeddings
```

**重置时清除的内容：**
- 每日 JSON 文件 (`data/daily/*.json`)
- SQLite 向量存储 (`data/vectors.db`)
- SQLite 数据库（`data/feedback.db` — 聊天查询、反馈）
- 刷新检查点 (`data/refresh-checkpoint.json`)
- 差异缓存 (`data/diffs/`)

**仅刷新模式**按日获取提交并执行提交级去重 — 保留现有摘要，仅获取和总结新提交。

**重建嵌入模式**读取所有现有的每日 JSON 文件并重新生成向量嵌入，而不从 ADO 重新获取数据。适用于 `data/vectors.db` 损坏或被删除后的场景。

### 应用设置

| 设置 | 值 | 用途 |
|---|---|---|
| `PORT` | `4399` | Express 服务器端口 |
| `HOST` | `127.0.0.1` | 绑定地址；除非添加外部身份验证层，否则保持为本地地址 |
| `OPENAI_API_KEY` | （可选） | 启用聊天、摘要和嵌入 |
| `OPENAI_BASE_URL` | （可选） | OpenAI 兼容/自托管端点 |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-large` | 托管或本地嵌入模型名称 |
| `OPENAI_EMBEDDING_DIMENSIONS` | 推断值/默认值 3072 | 实际向量维度；更改后需要重建索引 |
| `EMBEDDING_QUERY_INSTRUCTION` | 感知模型 | 可选的非对称查询指令；Qwen3 使用默认的提交检索指令 |
| `VECTOR_MIN_SCORE` | `0` | 可选的按模型校准的稠密检索截断值；默认检索依赖排名和 RRF |
| `RRF_K` | `20` | 用于短候选列表的排名融合平滑常量 |
| `RRF_SECONDARY_WEIGHT` | `0.7` | 次要语义查询权重 |
| `RRF_BUG_TITLE_WEIGHT` | `1.5` | 工作项标题权重 |
| `ADO_PAT` / `ADO_BEARER_TOKEN` | （可选） | 启用实时 ADO 请求 |
| `ENABLE_SCHEDULED_REFRESH` | `0` | 设为 `1` 以选择启用实时后台刷新 |

#### MCP 工具

`/mcp` 端点向已连接的 Agent 公开以下工具：

| 工具 | 用途 |
|---|---|
| `search_commits` | 对提交摘要进行稠密检索 + FTS5 混合搜索。筛选器：repo、author、date range、riskLevel、changeType。 |
| `get_commit` | 按短 SHA 查找一个或多个提交。 |
| `get_daily_summary` | 返回指定日期的所有提交，按仓库分组，并包含风险/破坏性变更/配置统计信息。 |
| `list_available_dates` | 列出有数据的日期，可选择使用 from/to 限定范围。 |
| `list_commits_by_filter` | 仅按元数据（repo、date range、changeType）列出提交 — 不需要查询字符串。适用于需要获取窗口内所有提交，而不是仅获取最相关提交的场景。 |
| `get_commit_diff` | 获取单个提交的文件级差异。返回前应用噪声过滤器（锁文件、生成的代码、本地化、构建产物）。`includePatch:false` 可以较低成本仅返回文件列表。 |

资源：`commit://stats` — 向量存储统计信息（已索引提交总数、跟踪的仓库、日期范围）。

#### MCP 访问

**Connect MCP** 按钮提供一次性安装程序 (`/install/setup-commit-resolver.ps1`)。请参阅 [USERGUIDE.md → 从 MCP 客户端连接](USERGUIDE.md#connecting-from-mcp-clients)。

`/mcp` 端点采用匿名访问，供本地使用。OAuth 发现、注册、授权和令牌代理路由均已移除。使用 `node api/server.js` 启动服务器；不需要 `--no-auth` 标志或 Microsoft 登录。

服务器默认绑定到 `127.0.0.1`。在反向代理中添加身份验证或恢复应用级访问控制之前，请勿将其直接暴露到公共网络。

在没有客户端的情况下验证端点：
```bash
curl http://127.0.0.1:4399/api/days
# → HTTP 200, no Authorization header required
```

---

## 13. 开放问题

仍待解决：

1. **运行时配置/实验服务** — 哪个平台负责驱动发生在代码部署之外的运行时试点放量？这是确定 C2C Cosmos DB 试点跟踪器范围所必需的（§3.1、§6.1）。
2. **LLM QPS / 429 处理** — 不同提供商的限制各异；每日摘要在高并发下可能遇到 429。待解决：针对所选提供商调整并发度和退避策略。

### 已解决

| # | 问题 | 解决方案 |
|---|---|---|
| 1 | 发布标签结构 | 按仓库配置，在 `src/config/repositories.js` 中固化了 3 种策略：`dateSorted` (CampaignUI)、`rolling` (MT: STAGING ↔ LKG)、`versioned` (AppUI/AnB/DB) |
| 2 | 试点标志位置 | 代码侧位置已在 §3.1 中列举（`Dynamic.config`、`DynamicConfigValues.cs`、`sharedfeatures.config`、`appsettings*.json`、`.cscfg`/`.csdef`/`Web.config`）。运行时放量推迟到 C2C 跟踪器处理 |
| 4 | 聊天界面 | 独立 React 应用 + 面向 GitHub Copilot CLI / Claude Code / VS Code 客户端的本地 MCP 端点。不使用 Teams 机器人 |
| 5 | 访问控制 | 无应用级登录；默认绑定到 localhost，在没有外部身份验证层的情况下不得公开暴露 |
| 6 | 遥测集成 | 查询和反馈指标保留在本地 SQLite 中，并通过 `/api/metrics/usage` 公开；远程 Aria 遥测已移除 |

