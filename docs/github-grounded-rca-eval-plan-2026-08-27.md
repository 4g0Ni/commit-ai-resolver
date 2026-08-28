# GitHub-grounded React RCA Eval：P0–P3 执行记录

## 目标

把公开 React Commit corpus 从“标题级检索样本”升级为两类可复现评测：

1. 路径、组件和完整提交说明增强的工程回归集。
2. 由真实 GitHub Issue、明确 closing PR 和 corpus 内 fix commit 支撑的 RCA holdout。

任何 GitHub 自动关联结果都只能是候选。只有人工确认问题忠实度、修复关系、gold commit 完整性和 query 可用性后，才能进入 frozen RCA dataset。

## P0：Corpus 和索引增强（完成）

- 从本地 `react/react` Git 对象库批量读取完整 commit message。
- 使用 rename-aware、root-aware、merge first-parent diff 生成 `changedFiles`。
- 使用 React 路径规则生成 `affectedAreas`。
- 缺失 SHA 通过 targeted Git fetch 固定到 `refs/enrichment/*`。
- 输出独立 `DATA_DIR`，不覆盖 v2。
- 为 27,646 条 enriched 文本重建 Qwen 1024 维索引。

当前本地输出：`data/enriched/public-react-v3-20260827`。

## P1：版本化 Eval 和 v3 baseline（完成）

`generate-cases.js` 支持 `--data-dir`、`--dataset-name`、`--output` 和 `--seed`。当前 `public-react-v3` manifest 固定：

- Corpus：27,646 commits
- Corpus SHA-256：`4c11acc1307f9c3f074f60b537323b3fe8da7ea751c2e17a9cd4e6c6772f6844`
- Cases：75
- Case SHA-256： `8c7e3ff302cba15c743428e62e034839c4f70f4eac30149db95eef7a2430fe61`

同 60-case 的 v2/v3 对照显示：

| Channel | 指标 | v2 | v3 | Delta |
|---|---|---:|---:|---:|
| Lexical | Required Recall@10 | 0.4625 | 0.5167 | +0.0542 |
| Lexical | MRR@10 | 0.3875 | 0.4313 | +0.0438 |
| Dense | Required Recall@10 | 0.7000 | 0.6750 | -0.0250 |
| Dense | MRR@10 | 0.6008 | 0.5692 | -0.0317 |
| Hybrid | Required Recall@10 | 1.0000 | 1.0000 | 0 |
| Hybrid | MRR@10 | 0.9175 | 0.9031 | -0.0144 |

这说明路径和正文显著帮助 lexical，但长文档对标题改写型 dense case 有轻微稀释。Document template 的进一步调整只能在真实 RCA dev split 上进行，不能用 frozen test 调参。

## P2：Issue → Closing PR → Fix Commit 采集（完成）

采集器查询 GitHub GraphQL 的 `Issue.closedByPullRequestsReferences`，并要求：

- Issue 非空模板；
- closing PR 已 merged 且包含解决说明；
- PR merge commit 存在于 v3 corpus；
- GitHub canonical repo `react/react` 与 corpus repo `facebook/react` 的 alias 被显式记录；
- 原始 Issue、PR 和 Commit URL 全部保留；
- GraphQL pages 本地缓存，可离线重建候选。

当前采集结果：

- 检查 1,000 个 linked closed issues；
- 找到 461 个 provenance-valid candidates；
- 输出 50 个质量分不低于 8 的多领域 review candidates；
- 选择领域覆盖 DOM、Fiber、Compiler、DevTools、RSC、Scheduler、Hooks ESLint 等。

运行：

```powershell
cd src
npm run mine:github-rca -- `
  --data-dir ..\data\enriched\public-react-v3-20260827 `
  --limit 50 `
  --max-pages 20
```

使用现有缓存重建：

```powershell
npm run mine:github-rca -- `
  --data-dir ..\data\enriched\public-react-v3-20260827 `
  --limit 50 `
  --max-pages 20 `
  --offline
```

本地审查材料：

- `data/eval/grounded-react-rca/review-packet.md`
- `data/eval/grounded-react-rca/review-template.jsonl`
- `data/eval/grounded-react-rca/candidates.jsonl`

## P3：人工 RCA Holdout 和 Harness Gate（基础设施完成，人工审批待完成）

先复制 review template：

```powershell
Copy-Item `
  ..\data\eval\grounded-react-rca\review-template.jsonl `
  ..\data\eval\grounded-react-rca\reviews.jsonl
```

每个批准项必须包含：

```json
{
  "id": "facebook-react-issue-123",
  "decision": "approve",
  "reviewer": "reviewer name",
  "reviewedAt": "2026-08-27T10:00:00Z",
  "problemFaithful": true,
  "fixRelationshipValid": true,
  "goldCommitsComplete": true,
  "queryUsable": true,
  "queryOverride": "",
  "goldCommitIds": ["full SHA"],
  "split": "",
  "notes": ""
}
```

审查含义：

- `problemFaithful`：候选 query 没有删掉决定问题性质的前提，也没有加入 Issue 不存在的因果。
- `fixRelationshipValid`：closing PR 的确解决该 Issue，而非仅做文档、跟踪或部分相关工作。
- `goldCommitsComplete`：所有必需 fix commit 都已列入；多 PR 关闭时没有漏掉必要证据。
- `queryUsable`：问题可作为真实 RCA/变更检索输入，不依赖图片、失效附件或未提供的私有上下文。

冻结至少 30 条 approved cases：

```powershell
npm run build:rca-dataset -- `
  --data-dir ..\data\enriched\public-react-v3-20260827 `
  --minimum-approved 30
```

构建器拒绝 pending/rejected review，并验证 reviewer、时间、四项 rubric、Issue/PR URL、closing relationship、gold SHA 和 corpus 一致性。Eval runner 还会在 L0 再次执行 provenance hard gate。

冻结后运行：

```powershell
$env:DATA_DIR = (Resolve-Path ..\data\enriched\public-react-v3-20260827).Path
$env:VECTORS_DB = Join-Path $env:DATA_DIR 'vectors.db'
node eval\run-eval.js `
  --dataset eval\datasets\public-react-rca-v1 `
  --mode all `
  --device cuda
```

RCA dev split 用于 document template、RRF 和 evidence threshold 调整；frozen test 只用于最终确认和 release gate。

## P2.5：461-case model-prescreened pilot（完成）

全部 461 条 provenance-valid candidates 已生成独立 pilot，标签固定为“模型预审、非 gold、不可用于 release gate”。该集合只用于 pipeline shakeout、检索诊断、badcase 分析和人工复审排序，不能替代 P3 的 human-reviewed holdout。

```powershell
cd src
npm run build:rca-pilot
$env:DATA_DIR = (Resolve-Path ..\data\enriched\public-react-v3-20260827).Path
$env:VECTORS_DB = Join-Path $env:DATA_DIR 'vectors.db'
node eval\run-eval.js `
  --dataset eval\datasets\public-react-rca-pilot-v1 `
  --mode all `
  --device cuda `
  --output eval\reports\public-react-rca-pilot-v1
npm run analyze:rca-pilot
```

case 与 manifest 同时保存：

- `labelStatus: model-prescreened`
- `gold: false`
- `releaseGateEligible: false`
- GitHub Issue、closing PR、merge commit 与 corpus commit provenance

runner 在读取 manifest 后立即拒绝 pilot 与 `--gate` 联用。完整运行结果：

| Channel | Recall@10 | MRR@10 | nDCG@10 |
|---|---:|---:|---:|
| Lexical | 0.3850 | 0.2683 | 0.2955 |
| Dense | 0.6941 | 0.4841 | 0.5338 |
| Hybrid | 0.6584 | 0.4309 | 0.4842 |

当前等权 RRF 在 pilot 上有明显负作用：63 条优于 Dense、266 条不变、132 条变差；Lexical 救回 9 条 Dense top-10 miss，但把 27 条 Dense top-10 hit 挤出 Hybrid top 10。长 query（>1200 字符）的 Dense Recall@10 为 0.6534，低于 501–1200 字符组的 0.7279。

## v2 → v3 同 case 指标变化解释

`npm run analyze:eval-delta` 只比较 60 条 byte-identical cases，其中 40 条是 positive retrieval cases。searchable document 平均长度从 176.2 增至 597.9 字符；共同 gold documents 从 184.1 增至 713.7 字符。

- Lexical Recall@10 的 0.4625 → 0.5167 由 3 条 `author_date` case 新进 top 10 驱动，没有 case 掉出 top 10。该组 query 只有作者/日期和泛化的 “change”，因此收益主要是 metadata filter 后更长正文增加了泛词匹配机会，不应外推为语义检索全面改善。
- 18 条 `semantic_title` 的 Lexical Recall@10 仍为 1.0，但 MRR 从 0.8056 降至 0.7731。新增正文、area 和 path 同时增加 target evidence 与 distractor overlap，目标仍在 top 10，但顺序发生竞争。
- Dense 的下降全部出现在 `semantic_title`：Recall@10 1.0 → 0.9444，MRR 0.7796 → 0.7093。单向量现在需要压缩更长的正文和 path，embedding 方向不再主要由标题决定。
- Hybrid Recall@10 维持 1.0，因为 exact SHA 由 direct lookup 保证，author/date 由 metadata filter 保证，semantic title 的 Dense/FTS 互补仍能保住 top 10。MRR 下降来自 RRF 内部相对次序变化，而不是新增 miss。

代表例 `semantic-title-001` 的 gold document 从 240 增至 1691 字符：Lexical rank 1 → 6、Dense rank 5 → miss、Hybrid rank 1 → 8。标题没有变化，变化来自长 commit body、React Compiler area 和 20 个文件的压缩路径信息加入同一个 document vector/FTS 文本。这证明 enriched 字段有用，但“全部拼入一个 dense vector”不是最稳妥的 document design。
