# Commit AI Resolver：完整 Eval Case 目录

> 本文件由 `src/scripts/generate-eval-case-catalog.js` 从当前 manifest 和 cases 自动生成。不要手工维护 case 行。

## 1. 当前 Eval 资产总览

当前共有 **536 个逻辑 case**：75 条工程回归 case，加 461 条 Issue-grounded RCA pilot case。

时间窗口数据集 `public-react-rca-pilot-v1-time-window-7d-30d` 是同一批 461 条 RCA case 的派生视图，不重复计入逻辑总数。

| Dataset | Cases | Dev | Test | Gold/门禁状态 | 主要用途 |
|---|---:|---:|---:|---|---|
| `public-react-v3` | 75 | 52 | 23 | 工程确定性标签；可用于对应 gate | 基础检索、过滤、拒答、澄清 |
| `public-react-rca-pilot-v1` | 461 | 327 | 134 | 模型预审、非 gold、不可用于 release gate | RCA 检索诊断、reranker、人工复核排序 |
| `public-react-rca-pilot-v1-time-window-7d-30d` | 461 | 327 | 134 | 同一 RCA pilot 的派生视图 | Issue 生命周期时间窗 + local LTR |

## 2. Case 类型对应的系统步骤

| Case 类型 | 数量 | 主要测试步骤 |
|---|---:|---|
| `exact_sha` | 12 | Intent commitIds → Direct SHA lookup → Hybrid prepend → Evidence Gate SEARCH → citation grounding |
| `semantic_title` | 18 | Query view → FTS5/Dense candidate generation → RRF → Recall/MRR/nDCG → answer evidence |
| `author_date` | 10 | Intent author/repo/date → SQL metadata prefilter → filtered candidate completeness |
| `risk_date` | 10 | Intent risk/repo/date → JSON metadata filter → filtered Dense ordering and leakage checks |
| `repo_date` | 5 | Intent repo/date → inclusive date bounds → all-commit completeness |
| `negative` | 5 | Unknown identifier → Direct/FTS miss → Evidence Gate ABSTAIN → no hallucinated citation |
| `negative_natural` | 10 | Natural-language OOD → Dense false-positive resistance → Evidence Gate ABSTAIN |
| `ambiguous` | 5 | Intent specificity → ASK_USER → no unsupported answer |
| `issue_rca_pilot` | 461 | Provenance → issue query preprocessing → candidate generation → RRF → time window → reranking → optional Agent/Answer grounding |

### RCA 461 条共同覆盖的步骤

- L0 provenance: GitHub Issue → explicit closing PR → merge/fix commit present in the frozen corpus.
- Query preparation: raw, compact, and optional multi-view issue queries.
- Candidate generation: Dense and FTS5 retrieval, weighted RRF, Recall@10/20/50/100.
- Issue lifecycle filtering: createdAt − 7 days through closedAt + 30 days in the derived dataset.
- Candidate reranking: local LTR, TF-IDF/field features, cross-encoder and optional LLM reranker experiments.
- Agent evaluation when predictions are supplied: Intent GOOD, grounded commit citation, retry trace, confidence and latency.
- Policy boundary: model-prescreened and machine-verifiable provenance, but non-gold and not release-gate eligible until human review.

## 3. 75 条工程回归 Case：完整清单

### exact_sha（12）

测试步骤：Intent commitIds → Direct SHA lookup → Hybrid prepend → Evidence Gate SEARCH → citation grounding

| Split | Case ID | Query | Gold commits | Expected |
|---|---|---|---|---|
| test | `sha-001` | Explain commit 88313ffd57a5df2666520c9a528eafdf2914d5f2 | 88313ffd | answer |
| dev | `sha-002` | Explain commit 66108fa807ce729c7c00caf503e2421ced1d4bf4 | 66108fa8 | answer |
| dev | `sha-003` | Explain commit ee3ef3a0792c0ad777270739fe5ff126e3d57992 | ee3ef3a0 | answer |
| dev | `sha-004` | Explain commit 59d2420b05dad657d232fc5ba9d7b1e8cc9f2949 | 59d2420b | answer |
| test | `sha-005` | Explain commit 9f44251ebf60af8331aaff5ced5629675e04e4bd | 9f44251e | answer |
| dev | `sha-006` | Explain commit 31fb8eae45004035996d2f8a8665befd892a2378 | 31fb8eae | answer |
| dev | `sha-007` | Explain commit bd150ec658aff506b9bc4ef612a2c1b1bbf20f96 | bd150ec6 | answer |
| dev | `sha-008` | Explain commit c122bf0cd1e1e8c7b233e7fa52d26315b5d5265f | c122bf0c | answer |
| test | `sha-009` | Explain commit bfd0a53d3e249f556eb21632d480a21b7424a5c8 | bfd0a53d | answer |
| dev | `sha-010` | Explain commit 1c44b874fc63287c4ae159c5701d4f785429fffa | 1c44b874 | answer |
| dev | `sha-011` | Explain commit e7d2a558ad8e664df36a70b0a86a85f925d1418f | e7d2a558 | answer |
| dev | `sha-012` | Explain commit 7da5f83a280803f2fa7af5d3533a988bd6a83557 | 7da5f83a | answer |

### semantic_title（18）

测试步骤：Query view → FTS5/Dense candidate generation → RRF → Recall/MRR/nDCG → answer evidence

| Split | Case ID | Query | Gold commits | Expected |
|---|---|---|---|---|
| test | `semantic-title-001` | Find the commit that would [compiler] tests for different orders of createfrom/capture w/wo function expressions | f5b5f1af | answer |
| dev | `semantic-title-002` | Find the commit that would [static][fizz] carry forward bootstrap config to resume if postponing in the shell (#27672) | 6e10ef76 | answer |
| dev | `semantic-title-003` | Find the commit that would [eslint] introduce more hints to lint messages (#15046) | 197703ec | answer |
| dev | `semantic-title-004` | Find the commit that would enable scheduling profiler flag in react-dom/testing builds (#23142) | d5048247 | answer |
| test | `semantic-title-005` | Find the commit that would update create-react-app note for eslint-plugin-react-hooks (#16982) | 3ac81a57 | answer |
| dev | `semantic-title-006` | Find the commit that would eliminate adopt of prettier in babel-plugin-react-forget | 23a22622 | answer |
| dev | `semantic-title-007` | Find the commit that would [compiler] clean up retry pipeline: `fireretry` flag -> compilemode | 4e9bdc25 | answer |
| dev | `semantic-title-008` | Find the commit that would update gate pragma to detect global error events (#28591) | 29a6ca33 | answer |
| test | `semantic-title-009` | Find the commit that would mention forwardref() in <fn ref={...} /> errors and warnings (#14644) | baa6d40f | answer |
| dev | `semantic-title-010` | Find the commit that would [scheduler][www] put profiling feature behind flag (#16757) | 0a2215cc | answer |
| dev | `semantic-title-011` | Find the commit that would update base for update on "[compiler] adopt dependencies from source for usememo scopes" | 50339296 | answer |
| dev | `semantic-title-012` | Find the commit that would introduce method for forcing a lower framerate | 43c4e5f3 | answer |
| test | `semantic-title-013` | Find the commit that would codesandbox: upgrade to node.js 18 (#26330) | a1c7473d | answer |
| dev | `semantic-title-014` | Find the commit that would whoops i broke ci (updating snapshots) | 2845a788 | answer |
| dev | `semantic-title-015` | Find the commit that would skip assignment, just call updateoptions directly | e0262d50 | answer |
| dev | `semantic-title-016` | Find the commit that would [compiler][wip] allow suppressions within effects | 850177cb | answer |
| test | `semantic-title-017` | Find the commit that would [eslint] disallow passing effect event down when inlined as a prop (#34820) | e1120009 | answer |
| dev | `semantic-title-018` | Find the commit that would [fizz] split responsestate/resources into renderstate/resumablestate (#27268) | 5dbb6a2d | answer |

### author_date（10）

测试步骤：Intent author/repo/date → SQL metadata prefilter → filtered candidate completeness

| Split | Case ID | Query | Gold commits | Expected |
|---|---|---|---|---|
| test | `author-date-001` | What did sophiebits change on 2025-01-24? | 45883680, a88abd3f | answer |
| dev | `author-date-002` | What did Andrew Clark change on 2019-05-30? | 3b230225, 7aa35cea, 91635dd4 | answer |
| dev | `author-date-003` | What did Mofei Zhang change on 2024-12-02? | 138f7470, c07531f0 | answer |
| dev | `author-date-004` | What did Jorge Cabiedes Acosta change on 2025-05-02? | 7cce8620, ad63721b | answer |
| test | `author-date-005` | What did Joseph Savona change on 2025-10-02? | 57d5a597, 70b52bec | answer |
| dev | `author-date-006` | What did Brian Vaughn change on 2020-01-03? | 5d3d71b1, 7e2ab87a, f749045a | answer |
| dev | `author-date-007` | What did gnoff change on 2024-04-25? | 47c21619, 9e2d7147 | answer |
| dev | `author-date-008` | What did kassens change on 2023-01-13? | 269610e2, 4e0676d5 | answer |
| test | `author-date-009` | What did Dan Abramov change on 2020-04-02? | 31734540, 7dfdff42, e55855e7 | answer |
| dev | `author-date-010` | What did Jan Kassens change on 2023-01-10? | 0f4a8359, a48e54f2, c4913166 | answer |

### risk_date（10）

测试步骤：Intent risk/repo/date → JSON metadata filter → filtered Dense ordering and leakage checks

| Split | Case ID | Query | Gold commits | Expected |
|---|---|---|---|---|
| test | `risk-date-001` | Show MEDIUM risk changes on 2021-10-20 | 3677c019, 5ca4b043, c213030b, cdb8a1d1 | answer |
| dev | `risk-date-002` | Show LOW risk changes on 2023-12-19 | 0a8c177b, beb4a4d2, df9e4045, f2094eeb | answer |
| dev | `risk-date-003` | Show LOW risk changes on 2016-10-28 | 1efb7a4e, 68257738, b062596f, b691f744, bd3c90ac, c08469a7, ed11b353, f51abe0b | answer |
| dev | `risk-date-004` | Show LOW risk changes on 2023-10-13 | 1b4ba748, 762f3329, 785a98f0, bd95626f | answer |
| test | `risk-date-005` | Show LOW risk changes on 2023-05-20 | 1bffb4ba, 5112e9fb, 7bd330e0 | answer |
| dev | `risk-date-006` | Show MEDIUM risk changes on 2013-06-25 | 1c40dde7, 1d65f81b, 59212a53, a9b02433, c1886c65, d93761af, fb6381fb | answer |
| dev | `risk-date-007` | Show LOW risk changes on 2014-12-16 | 2eb6cf6d, 3c2fc644, 401d4dd1, 7468f092, a5327026, b02db228, e6e60c4f | answer |
| dev | `risk-date-008` | Show LOW risk changes on 2016-03-05 | 7e202435, d824d0d0 | answer |
| test | `risk-date-009` | Show LOW risk changes on 2015-09-27 | 208f20b7, 47de0a8c, 7938650c | answer |
| dev | `risk-date-010` | Show LOW risk changes on 2017-10-03 | 07dba67a, 4d60346f, 589c0a25, 5f93ee6f, 85b59d2f, c32b4cd2, f6a79d1f | answer |

### repo_date（5）

测试步骤：Intent repo/date → inclusive date bounds → all-commit completeness

| Split | Case ID | Query | Gold commits | Expected |
|---|---|---|---|---|
| test | `repo-date-001` | What changed in facebook/react on 2026-02-27? | 49394528, 4f1d6bae, 6f7a43fa, 843d69f0, 9a40bda6, 9b74cf58, cf87a238, e0cc7202 | answer |
| dev | `repo-date-002` | What changed in facebook/react on 2020-08-17? | 12876701, 1a41a196, 702fad4b, bcca5a6c, e4afb2fd | answer |
| dev | `repo-date-003` | What changed in facebook/react on 2015-07-20? | 6fc53e04, 97e0fe5d, b7f9cd4f, c13588ef, d13fafa5 | answer |
| dev | `repo-date-004` | What changed in facebook/react on 2020-02-06? | 256d78d1, 3f814e75, 901d76bc, df134d31 | answer |
| test | `repo-date-005` | What changed in facebook/react on 2018-11-08? | 051272f2, 3d8bda70, 7c560131, f9e9913f | answer |

### negative（5）

测试步骤：Unknown identifier → Direct/FTS miss → Evidence Gate ABSTAIN → no hallucinated citation

| Split | Case ID | Query | Gold commits | Expected |
|---|---|---|---|---|
| test | `negative-001` | zzzxqvnonexistenttoken20260820case1 | — | abstain |
| dev | `negative-002` | zzzxqvnonexistenttoken20260820case2 | — | abstain |
| dev | `negative-003` | zzzxqvnonexistenttoken20260820case3 | — | abstain |
| dev | `negative-004` | zzzxqvnonexistenttoken20260820case4 | — | abstain |
| test | `negative-005` | zzzxqvnonexistenttoken20260820case5 | — | abstain |

### negative_natural（10）

测试步骤：Natural-language OOD → Dense false-positive resistance → Evidence Gate ABSTAIN

| Split | Case ID | Query | Gold commits | Expected |
|---|---|---|---|---|
| test | `negative-natural-001` | Which commit added the Kubernetes ingress retry policy? | — | abstain |
| dev | `negative-natural-002` | Find the checkout payment webhook idempotency change | — | abstain |
| dev | `negative-natural-003` | Why did the PostgreSQL replica lag increase after deployment? | — | abstain |
| dev | `negative-natural-004` | Which commit fixed Android Bluetooth disconnects? | — | abstain |
| test | `negative-natural-005` | Show the OAuth refresh token rotation change | — | abstain |
| dev | `negative-natural-006` | Find the Terraform S3 bucket encryption update | — | abstain |
| dev | `negative-natural-007` | Which commit changed Kafka consumer offsets? | — | abstain |
| dev | `negative-natural-008` | Why did the image upload antivirus scan fail? | — | abstain |
| test | `negative-natural-009` | Find the iOS push notification entitlement update | — | abstain |
| dev | `negative-natural-010` | Which commit modified the Redis eviction policy? | — | abstain |

### ambiguous（5）

测试步骤：Intent specificity → ASK_USER → no unsupported answer

| Split | Case ID | Query | Gold commits | Expected |
|---|---|---|---|---|
| test | `ambiguous-001` | something broke | — | clarify |
| dev | `ambiguous-002` | it is slow | — | clarify |
| dev | `ambiguous-003` | the page looks wrong | — | clarify |
| dev | `ambiguous-004` | there is an error | — | clarify |
| test | `ambiguous-005` | what caused this? | — | clarify |

## 4. 461 条 RCA Pilot：分类统计

Split：dev 327，test 134。共享 relevant commit 的连通组不会跨 split。

### 按主要 React area

| Area | Cases |
|---|---:|
| Build / Tooling | 12 |
| Documentation | 5 |
| Fiber / Reconciler | 79 |
| Fixtures | 1 |
| Generated / Build Output | 1 |
| Historical / Other | 6 |
| React ART | 1 |
| React Compiler | 26 |
| React Core | 26 |
| React DevTools | 143 |
| React DOM | 99 |
| React Hooks ESLint | 31 |
| React Native Renderer | 1 |
| React Server Components / Flight | 7 |
| Scheduler | 6 |
| Shared React Infrastructure | 13 |
| Test Renderers | 4 |

### 按模型预审质量分

| Quality score | Cases |
|---:|---:|
| 1 | 11 |
| 2 | 12 |
| 3 | 15 |
| 4 | 49 |
| 5 | 6 |
| 6 | 65 |
| 7 | 16 |
| 8 | 96 |
| 9 | 48 |
| 10 | 6 |
| 11 | 137 |

## 5. 461 条 RCA Pilot：逐条完整清单

字段说明：`Gold` 是 closing PR 对应、且存在于冻结 corpus 的 merge/fix commit；它是机器可验证 provenance，不代表已经完成因果关系和 gold 完整性的人工审批。

### Build / Tooling（12）

| Split | Case / Issue | Issue title | Gold | Closing PR | Score | Files | Query chars | Lifecycle window |
|---|---|---|---|---|---:|---:|---:|---|
| test | `facebook-react-issue-6644` / #6644 | React does not support Node v6.0.0 | 9d201abb | #6645 | 3 | 1 | 183 | 2016-04-21T16:45:22.000Z → 2016-05-28T18:33:26.000Z |
| dev | `facebook-react-issue-10328` / #10328 | Some invariant messages aren't extracted | 73217a74 | #10348 | 4 | 2 | 449 | 2017-07-23T16:52:48.000Z → 2017-09-01T09:38:28.000Z |
| dev | `facebook-react-issue-11018` / #11018 | Old fiddles are broken after the new domain/website | 2fdb84d9 | #11030 | 5 | 3 | 210 | 2017-09-24T23:49:11.000Z → 2017-11-01T15:48:59.000Z |
| dev | `facebook-react-issue-11481` / #11481 | Release script follow-up | ac0e6705 | #11504 | 2 | 11 | 404 | 2017-10-31T15:06:27.000Z → 2017-12-09T16:29:52.000Z |
| dev | `facebook-react-issue-11657` / #11657 | Investigate CI failure (possible race condition) | 0c164bb4 | #11666 | 4 | 2 | 679 | 2017-11-18T03:17:17.000Z → 2017-12-26T18:03:31.000Z |
| dev | `facebook-react-issue-18231` / #18231 | Warning: Yarn 1.0 onwards, scripts don't require "--" for options to be forwarded | 9e5626cd | #18232 | 7 | 1 | 337 | 2020-02-27T20:09:13.000Z → 2020-04-09T15:37:03.000Z |
| dev | `facebook-react-issue-19591` / #19591 | Bug: 'use strict' at global level causes issues with scripts concatenation. | 49cd77d2 | #19614 | 11 | 1 | 1477 | 2020-08-05T08:50:57.000Z → 2020-09-14T13:42:50.000Z |
| dev | `facebook-react-issue-20186` / #20186 | Distribute source maps for easier debugging in Chrome's Performance tab | 2c8a139a | #26446 | 6 | 3 | 1468 | 2020-10-30T21:10:50.000Z → 2023-12-07T18:59:28.000Z |
| dev | `facebook-react-issue-21541` / #21541 | Create GitHub actions to auto verify DevTools issues have repro steps | a731a516 | #21542 | 6 | 1 | 844 | 2021-05-13T20:51:10.000Z → 2021-06-20T19:48:12.000Z |
| test | `facebook-react-issue-22323` / #22323 | Rollup build script --unsafe-partial flag is broken | f4ac680c | #22324 | 6 | 1 | 1443 | 2021-09-08T15:02:49.000Z → 2021-10-15T17:32:10.000Z |
| dev | `facebook-react-issue-22646` / #22646 | Add e2e tests for inline package | 9724e180 | #23019 | 2 | 2 | 497 | 2021-10-21T15:38:19.000Z → 2022-02-03T15:28:03.000Z |
| test | `facebook-react-issue-29854` / #29854 | [React 19] useSyncExternalStore shim might break | 50e89ec9 | #29868 | 7 | 4 | 621 | 2024-06-04T12:48:51.000Z → 2024-07-12T18:13:18.000Z |

### Documentation（5）

| Split | Case / Issue | Issue title | Gold | Closing PR | Score | Files | Query chars | Lifecycle window |
|---|---|---|---|---|---:|---:|---:|---|
| test | `facebook-react-issue-8318` / #8318 | getRootIDs is not defined in ReactComponentTreeHook.js | 93042c27 | #8380 | 4 | 1 | 642 | 2016-11-09T22:38:40.000Z → 2016-12-17T11:11:29.000Z |
| dev | `facebook-react-issue-8875` / #8875 | your website page not working properly in ie10 | 466bb4ff | #8886 | 8 | 1 | 581 | 2017-01-20T02:43:44.000Z → 2017-03-02T00:32:08.000Z |
| dev | `facebook-react-issue-10868` / #10868 | Grammar mistake on portals docs | 7811677a | #10870 | 6 | 1 | 870 | 2017-09-20T12:26:16.000Z → 2017-10-27T16:04:11.000Z |
| dev | `facebook-react-issue-11043` / #11043 | Active Tab is not included in current route or permalinks on new docs site | 75ad1a9c | #11050 | 6 | 3 | 1194 | 2017-09-25T20:22:40.000Z → 2017-11-01T22:45:49.000Z |
| dev | `facebook-react-issue-17481` / #17481 | Changelog markdown formatting issue for v16.3.0 (React Test Renderer) | b64938e1 | #17487 | 8 | 1 | 1381 | 2019-11-21T05:31:12.000Z → 2019-12-29T13:57:39.000Z |

### Fiber / Reconciler（79）

| Split | Case / Issue | Issue title | Gold | Closing PR | Score | Files | Query chars | Lifecycle window |
|---|---|---|---|---|---:|---:|---:|---|
| dev | `facebook-react-issue-10831` / #10831 | Warning: Stateless function components cannot be given refs. Attempts to access this ref will fail.null after updating to React 16 | 83a536e6 | #10915 | 11 | 7 | 1532 | 2017-09-19T14:12:57.000Z → 2017-10-28T19:40:27.000Z |
| dev | `facebook-react-issue-12089` / #12089 | Debug render-phase side effects in strict-mode for DEV | d3b183c3 | #12094 | 6 | 18 | 1349 | 2018-01-17T23:20:58.000Z → 2018-02-24T22:30:54.000Z |
| test | `facebook-react-issue-12177` / #12177 | Removing a ref callback works differently on HostComponents vs ClassComponents | d529d203 | #12178 | 8 | 2 | 1481 | 2018-01-31T18:47:09.000Z → 2018-03-09T20:13:42.000Z |
| test | `facebook-react-issue-12502` / #12502 | Possible regression in dev mode in v16.3 | 59dac9d7 | #12510 | 6 | 3 | 642 | 2018-03-24T11:22:27.000Z → 2018-05-01T18:10:38.000Z |
| dev | `facebook-react-issue-12551` / #12551 | New Context Provider may block Old context propagation if children are constant | 7c393285 | #12586 | 11 | 2 | 1472 | 2018-03-29T09:18:08.000Z → 2018-05-26T19:59:18.000Z |
| dev | `facebook-react-issue-12964` / #12964 | Returning an empty fragment throws a confusing error | d480782c | #12966 | 9 | 2 | 596 | 2018-05-25T21:11:00.000Z → 2018-07-11T13:43:31.000Z |
| dev | `facebook-react-issue-13425` / #13425 | Host components outside the setState path are sometimes unnecessarily diffed and updated | d2f5c3fb | #13423 | 7 | 5 | 565 | 2018-08-10T16:48:43.000Z → 2018-09-16T17:13:47.000Z |
| test | `facebook-react-issue-13574` / #13574 | Interaction reference count decremented too aggressively | 13965b4d | #13590 | 7 | 7 | 711 | 2018-08-29T22:43:34.000Z → 2018-10-25T16:27:42.000Z |
| test | `facebook-react-issue-13601` / #13601 | react-dom/profiling TypeError: Cannot read property 'current' of null | 03ab1efe | #13605 | 8 | 4 | 383 | 2018-09-01T19:17:46.000Z → 2018-10-10T15:32:56.000Z |
| dev | `facebook-react-issue-13820` / #13820 | componentDidCatch doesn't catch some invariants | 3c69a188 | #14104 | 8 | 2 | 1151 | 2018-10-03T18:58:40.000Z → 2018-12-06T23:38:13.000Z |
| dev | `facebook-react-issue-14159` / #14159 | React.memo and React.lazy ignore propTypes | d14ba87b | #14298 | 11 | 5 | 1215 | 2018-11-01T23:48:09.000Z → 2018-12-29T20:06:28.000Z |
| dev | `facebook-react-issue-14220` / #14220 | When using React.lazy will cause the GPU/CPU to run overloaded, and the page is very slow. | 4a107219 | #14429 | 11 | 14 | 849 | 2018-11-06T17:30:14.000Z → 2019-01-13T19:03:24.000Z |
| test | `facebook-react-issue-14310` / #14310 | Re-rendering lazy() doesn't respect defaultProps on memo() | 0c7189d9 | #14312 | 8 | 2 | 356 | 2018-11-15T17:55:14.000Z → 2018-12-22T19:40:43.000Z |
| test | `facebook-react-issue-14583` / #14583 | 16.8.0-alpha.0 (and 16.7) IE11 Suspense doesn't stop rendering fallback after Lazy resolves | 0fc15475 | #14592 | 8 | 1 | 1492 | 2019-01-06T21:43:25.000Z → 2019-02-14T01:00:16.000Z |
| dev | `facebook-react-issue-14629` / #14629 | useImperativeHandle should warn when second arg isn't a function | 8f45a7fd | #14647 | 6 | 3 | 1458 | 2019-01-11T14:56:20.000Z → 2019-02-20T19:44:19.000Z |
| dev | `facebook-react-issue-14792` / #14792 | Question: ReactDOM render call in useEffect delayed until first update | 3ae94e18 | #14799 | 11 | 2 | 1290 | 2019-02-01T00:09:18.000Z → 2019-03-14T20:18:36.000Z |
| dev | `facebook-react-issue-15088` / #15088 | useReducer - eagerReducer optimization discussion/questions | 66388150 | #22445 | 9 | 3 | 1461 | 2019-03-05T09:57:43.000Z → 2021-10-27T23:25:10.000Z |
| dev | `facebook-react-issue-16938` / #16938 | React 16.10 broke Next.js/SSR applications | d8a76ad5 | #16943 | 8 | 2 | 838 | 2019-09-21T03:18:10.000Z → 2019-10-28T17:43:54.000Z |
| dev | `facebook-react-issue-17151` / #17151 | Bailing out doesn't work properly in lazy components with default props | 241103a6 | #18539 | 11 | 3 | 974 | 2019-10-13T15:58:13.000Z → 2020-05-08T09:58:58.000Z |
| dev | `facebook-react-issue-17272` / #17272 | When calling a useTransition startTransition callback outside of event handlers, isPending is never set to true | 25863036 | #17382 | 9 | 2 | 927 | 2019-10-28T22:49:03.000Z → 2019-12-15T23:46:10.000Z |
| dev | `facebook-react-issue-17273` / #17273 | useTransition's startTransition function can result in infinite loop when it's included as a useEffect dependency | ddd1faa1 | #19719 | 11 | 10 | 1378 | 2019-10-28T23:12:15.000Z → 2020-09-27T18:49:01.000Z |
| dev | `facebook-react-issue-17276` / #17276 | Unexpected value order with useTransition | a632f7de | #20976 | 6 | 15 | 1441 | 2019-10-29T09:17:35.000Z → 2021-05-20T16:21:44.000Z |
| dev | `facebook-react-issue-17356` / #17356 | Memoized child of Suspense component doesn't update when Context updates. | 8bff8987 | #19216 | 11 | 6 | 1470 | 2019-11-06T20:11:50.000Z → 2020-07-30T21:06:47.000Z |
| dev | `facebook-react-issue-17953` / #17953 | Bug: useReducer runs the queued updates with new props | 66388150 | #22445 | 11 | 3 | 612 | 2020-01-25T07:58:03.000Z → 2021-10-27T23:25:11.000Z |
| test | `facebook-react-issue-18020` / #18020 | Bug: event.preventDefault is wrecking havoc with startTransition | ddc4b65c | #18515 | 11 | 2 | 1144 | 2020-02-04T21:41:06.000Z → 2020-05-07T20:34:42.000Z |
| dev | `facebook-react-issue-18178` / #18178 | Bug: too hard to fix "Cannot update a component from inside the function body of a different component." | fe1f79b9 | #18330 | 8 | 5 | 1504 | 2020-02-21T15:15:25.000Z → 2020-04-17T00:07:15.000Z |
| dev | `facebook-react-issue-18183` / #18183 | useMutableSource and hydration | 142d4f1c | #18771 | 4 | 15 | 1429 | 2020-02-21T21:38:11.000Z → 2020-06-20T23:00:47.000Z |
| dev | `facebook-react-issue-18353` / #18353 | Bug: Updates in the primary tree only unsuspend once | 9d67847f | #18384 | 6 | 4 | 287 | 2020-03-13T01:41:21.000Z → 2020-04-25T18:31:41.000Z |
| dev | `facebook-react-issue-18357` / #18357 | Bug: High-pri setState causes primary tree to get unhidden | d7382b6c | #18411 | 10 | 5 | 186 | 2020-03-13T18:08:47.000Z → 2020-04-29T18:25:05.000Z |
| dev | `facebook-react-issue-18426` / #18426 | Call all functions twice in StrictMode | ba31ad40 | #18430 | 6 | 12 | 777 | 2020-03-22T08:59:55.000Z → 2020-04-28T22:13:47.000Z |
| dev | `facebook-react-issue-18486` / #18486 | Bug: Dropped update when render phase update happens before suspending | 2dddd1e0 | #18537 | 10 | 3 | 340 | 2020-03-28T00:49:12.000Z → 2020-05-08T02:17:02.000Z |
| dev | `facebook-react-issue-18571` / #18571 | DevTools: Memo(ForwardRef()) and "Rendered By" List | 0c52e24c | #19556 | 2 | 6 | 358 | 2020-04-03T17:05:56.000Z → 2020-09-09T14:49:11.000Z |
| dev | `facebook-react-issue-18657` / #18657 | Bug: Normal update between Idle render and a Ping causes Fallback to get stuck | cfefc81a | #18663 | 11 | 3 | 578 | 2020-04-10T17:46:44.000Z → 2020-05-17T23:32:56.000Z |
| dev | `facebook-react-issue-18768` / #18768 | Bug: `React.lazy` throws undefined instead of an `Error` object | 5aa0c567 | #21642 | 11 | 2 | 1463 | 2020-04-21T15:13:02.000Z → 2021-07-07T21:47:18.000Z |
| dev | `facebook-react-issue-18823` / #18823 | useMutableSource: allow getSnapshot to return a function | 8f4dc3e5 | #18933 | 6 | 3 | 882 | 2020-04-27T23:34:25.000Z → 2020-06-20T23:14:30.000Z |
| dev | `facebook-react-issue-18844` / #18844 | Bug: Render after suspense is thrown away leaving DOM unmatched with state | 8bff8987 | #19216 | 11 | 6 | 819 | 2020-04-29T16:31:08.000Z → 2020-07-30T21:06:47.000Z |
| dev | `facebook-react-issue-19548` / #19548 | Bug: HOC (memo/forwardRef) should throw for noop function | a63893ff | #19550 | 6 | 3 | 541 | 2020-07-30T15:43:15.000Z → 2020-09-05T20:12:34.000Z |
| dev | `facebook-react-issue-19701` / #19701 | Bug: `Context.Consumer` inside `Suspense` does not receive context updates while suspended | d8cfeaf2 | #23095 | 11 | 6 | 1488 | 2020-08-19T18:09:04.000Z → 2022-02-18T16:30:35.000Z |
| dev | `facebook-react-issue-19948` / #19948 | Bug: unstable_useMutableSource throws error when mutated before subscribe | 766a7a28 | #20665 | 9 | 6 | 984 | 2020-09-25T19:53:35.000Z → 2021-02-28T15:22:56.000Z |
| dev | `facebook-react-issue-20202` / #20202 | Scheduling profiler tweaks | 760d9ab5 | #20215 | 4 | 4 | 515 | 2020-11-02T17:57:29.000Z → 2020-12-12T14:47:40.000Z |
| dev | `facebook-react-issue-20594` / #20594 | Bug: unintended .valueOf() maybe? | 2e948e0d | #20617 | 8 | 2 | 1404 | 2021-01-08T02:49:07.000Z → 2021-02-19T01:59:32.000Z |
| test | `facebook-react-issue-20675` / #20675 | Bug: FunctionComponent re-render phase cause a bug | bb1b7951 | #20676 | 11 | 4 | 1451 | 2021-01-20T11:36:45.000Z → 2021-02-28T15:51:12.000Z |
| dev | `facebook-react-issue-20932` / #20932 | Bug: SuspenseList crash | f04bcb81 | #20948 | 9 | 3 | 1031 | 2021-02-26T00:04:16.000Z → 2021-04-06T17:20:02.000Z |
| dev | `facebook-react-issue-21111` / #21111 | flushSync should change priority of commit phase updates to sync, even though it can't flush them immediately | 1102224b | #21122 | 4 | 3 | 510 | 2021-03-19T04:49:41.000Z → 2021-04-27T23:50:30.000Z |
| dev | `facebook-react-issue-21262` / #21262 | DevTools use the renderer version to detect features on react-reconciler | 15e779d9, 68097787 | #21268, #21269 | 2 | 4 | 1472 | 2021-04-07T07:53:21.000Z → 2021-05-14T18:47:36.000Z |
| dev | `facebook-react-issue-21416` / #21416 | Bug: useReducer, reducer function gets called twice (possible memory leak) | 66388150 | #22445 | 11 | 3 | 1190 | 2021-04-26T20:03:20.000Z → 2021-10-27T23:25:11.000Z |
| dev | `facebook-react-issue-21676` / #21676 | Bug: Layout effects don't re-fire in 18 on Suspense re-showing | d0f348dc | #21694 | 8 | 3 | 325 | 2021-06-07T15:19:13.000Z → 2021-07-16T23:44:44.000Z |
| test | `facebook-react-issue-21712` / #21712 | React 18: Error boundaries actually catches errors in effects | 7fec3804 | #21723 | 6 | 3 | 900 | 2021-06-14T10:43:39.000Z → 2021-07-24T14:48:28.000Z |
| test | `facebook-react-issue-21765` / #21765 | React 18: "missing act()" warnings partially missing if a prior render threw | 9090257e | #21766 | 6 | 3 | 1199 | 2021-06-22T12:50:36.000Z → 2021-08-12T21:38:26.000Z |
| dev | `facebook-react-issue-21876` / #21876 | [React 18] Bug: `Maximum update depth exceeded` on the `ref` prop when suspending | a97b5ac0 | #21875 | 6 | 6 | 494 | 2021-07-07T11:58:30.000Z → 2021-08-13T17:37:11.000Z |
| dev | `facebook-react-issue-22459` / #22459 | Bug: setState updater called but not rendered, in Safari, in concurrent mode | 790b5246 | #23111 | 11 | 3 | 1475 | 2021-09-22T08:43:19.000Z → 2022-02-17T18:25:35.000Z |
| dev | `facebook-react-issue-22796` / #22796 | React 18 Bug: react-dom/server "Detected multiple renderers..." if preceeded by react-test-renderer | 555ece0c | #22797 | 11 | 2 | 1500 | 2021-11-13T12:40:28.000Z → 2023-02-11T12:17:18.000Z |
| dev | `facebook-react-issue-24203` / #24203 | Bug: No warning on infinite useEffect loop in React 18 | d68b09de | #24295 | 8 | 2 | 245 | 2022-03-22T23:03:55.000Z → 2022-05-07T17:06:35.000Z |
| dev | `facebook-react-issue-24384` / #24384 | Bug: Incorrect Hydration Mismatch Detection during Suspense - "Hydration failed because the initial UI does not match what was rendered on the server." | 9ae80d6a | #24404 | 11 | 6 | 1552 | 2022-04-08T16:28:29.000Z → 2022-06-02T19:31:17.000Z |
| dev | `facebook-react-issue-24458` / #24458 | Bug: setState is not flushed if an iframe is added in the same tick in Safari | 2c8a1452 | #24459 | 11 | 3 | 692 | 2022-04-21T14:39:31.000Z → 2022-06-11T16:58:18.000Z |
| test | `facebook-react-issue-25565` / #25565 | Bug: useSyncExternalStore does not update internal value if a setState is also called, outside useEffect, causing store sets not re-render | 1e3e30da | #25578 | 8 | 3 | 1539 | 2022-10-19T00:15:04.000Z → 2022-12-08T10:25:44.000Z |
| dev | `facebook-react-issue-25625` / #25625 | Update before hydration completed error does not clarify which suspense boundary or which update | e1dd0a2f | #25692 | 6 | 3 | 800 | 2022-10-27T11:20:12.000Z → 2022-12-16T03:10:55.000Z |
| dev | `facebook-react-issue-25964` / #25964 | Bug: Suspense \| client component should have a queue | a8f971b7 | #26232 | 9 | 4 | 1165 | 2022-12-29T08:46:14.000Z → 2023-03-26T20:06:29.000Z |
| test | `facebook-react-issue-26095` / #26095 | Bug: useSyncExternalStore will cause hydration missmatch in `StrictMode` if `serverSnapshot` is different from `snapshot` | 4cd70656 | #26791 | 11 | 2 | 666 | 2023-01-26T08:53:46.000Z → 2023-06-11T21:18:05.000Z |
| dev | `facebook-react-issue-26910` / #26910 | Bug: React fails to log invariant 306 message when lazy() resolves to a `Fragment` | 9cc0f6e6 | #30372 | 8 | 2 | 593 | 2023-05-31T08:36:04.000Z → 2024-08-22T17:00:52.000Z |
| dev | `facebook-react-issue-27296` / #27296 | Bug: devtools source field disappears after component remount | eaa69687 | #27297 | 8 | 3 | 1454 | 2023-08-21T17:56:14.000Z → 2023-09-28T15:42:36.000Z |
| dev | `facebook-react-issue-27670` / #27670 | Bug: useSyncExternalStore does not schedule update after mutation | 2860e00c | #36947 | 7 | 2 | 1468 | 2023-11-01T15:52:50.000Z → 2026-08-20T03:39:11.000Z |
| dev | `facebook-react-issue-27989` / #27989 | [DevTools Bug]: Console.log in second call to useMemo callback in strict mode is not dimmed or suppressed | db120f69 | #28249 | 11 | 2 | 1162 | 2024-01-11T20:06:13.000Z → 2024-03-07T16:45:19.000Z |
| dev | `facebook-react-issue-28556` / #28556 | Bug: useFormState formAction becomes null in strict mode | 8ef14cf2 | #28557 | 11 | 2 | 906 | 2024-03-07T07:30:03.000Z → 2024-04-19T15:15:24.000Z |
| dev | `facebook-react-issue-28923` / #28923 | [React 19] useTransition()'s pending state does not go back to false (revision 94eed63c49-20240425) | adbec0c2 | #29670 | 9 | 2 | 1493 | 2024-04-19T12:28:58.000Z → 2024-06-30T21:52:48.000Z |
| test | `facebook-react-issue-29788` / #29788 | [DevTools Bug]: Null destructuring error inspecting a component with `useFormStatus` | 88ee14ff | #28728 | 9 | 11 | 1483 | 2024-05-30T19:59:05.000Z → 2024-08-31T08:55:55.000Z |
| dev | `facebook-react-issue-29915` / #29915 | [React 19] useEffect does not re-fire on hot reload with React 19 and vite | da9325b5 | #35962 | 9 | 2 | 754 | 2024-06-09T17:05:39.000Z → 2026-05-17T16:14:52.000Z |
| dev | `facebook-react-issue-30368` / #30368 | Bug: useFormStatus pending state is reset when component state is updated | 8ac5f4eb | #34075 | 11 | 3 | 1473 | 2024-07-11T01:59:20.000Z → 2025-12-19T17:22:08.000Z |
| dev | `facebook-react-issue-31578` / #31578 | [React 19] useState's setter function becomes arity 2 | 2bd1c756 | #31808 | 2 | 8 | 593 | 2024-11-12T12:18:22.000Z → 2025-01-17T13:08:57.000Z |
| dev | `facebook-react-issue-33580` / #33580 | Bug: Rendered more hooks than during the previous render when component calls use(thenable) after hydration in a specific transition | c3555f0c | #36911 | 11 | 3 | 1534 | 2025-06-13T03:22:31.000Z → 2026-07-30T19:39:01.000Z |
| dev | `facebook-react-issue-34693` / #34693 | Bug: OOM when passing reference to big Uint8Array as component props | 1be3ce99 | #34742 | 8 | 2 | 774 | 2025-09-25T18:30:48.000Z → 2025-11-04T23:13:24.000Z |
| test | `facebook-react-issue-34770` / #34770 | Bug: Massive memory allocations using React dev build under frequent updates (prod build unaffected) | b9ec735d | #34803 | 6 | 2 | 1499 | 2025-10-01T05:09:16.000Z → 2025-11-12T21:42:15.000Z |
| test | `facebook-react-issue-34818` / #34818 | Bug: Stale closures with `useEffectEvent` | 93d4458f | #34831 | 9 | 2 | 1030 | 2025-10-05T10:55:35.000Z → 2025-11-12T15:58:44.000Z |
| dev | `facebook-react-issue-34840` / #34840 | Bug: `react-dom-client.development.js` tries to read `$$typeof` on iframe object | 6853d7ab | #35679 | 8 | 2 | 830 | 2025-10-07T06:12:50.000Z → 2026-03-05T16:53:47.000Z |
| test | `facebook-react-issue-35000` / #35000 | Activity mode=“hidden” does not hide nested portals | 52684925 | #35091 | 8 | 4 | 1406 | 2025-10-21T11:41:56.000Z → 2025-12-10T19:39:41.000Z |
| dev | `facebook-react-issue-35004` / #35004 | Bug: React 19 Uncaught TypeError: Do not know how to serialize a BigInt | ff191f24 | #35648 | 6 | 2 | 1467 | 2025-10-22T02:18:26.000Z → 2026-02-27T10:54:52.000Z |
| test | `facebook-react-issue-35210` / #35210 | Bug: A tree hydrated but some attributes of the server rendered HTML didn't match the client properties. | c1866240 | #35494 | 6 | 3 | 1504 | 2025-11-18T16:18:30.000Z → 2026-02-12T20:48:03.000Z |
| test | `facebook-react-issue-35821` / #35821 | Bug: useDeferredValue gets stuck with a stale value | c0d218f0 | #36134 | 11 | 3 | 1453 | 2026-02-11T21:15:25.000Z → 2026-04-23T00:49:06.000Z |
| test | `facebook-react-issue-36200` / #36200 | Bug: Large TypedArray props hang browser in dev mode in 19.2.X | e71a6393 | #36913 | 8 | 2 | 1288 | 2026-03-26T21:04:22.000Z → 2026-08-01T18:51:07.000Z |

### Fixtures（1）

| Split | Case / Issue | Issue title | Gold | Closing PR | Score | Files | Query chars | Lifecycle window |
|---|---|---|---|---|---:|---:|---:|---|
| test | `facebook-react-issue-11132` / #11132 | DOM Test Fixtures: Unable to Load React 16 | ea507f16 | #11133 | 4 | 1 | 390 | 2017-09-29T11:15:15.000Z → 2017-11-10T09:50:38.000Z |

### Generated / Build Output（1）

| Split | Case / Issue | Issue title | Gold | Closing PR | Score | Files | Query chars | Lifecycle window |
|---|---|---|---|---|---:|---:|---:|---|
| test | `facebook-react-issue-7482` / #7482 | Master UMD builds don’t work as CommonJS using Webpack alias config | 92c84a6f | #7840 | 6 | 1 | 681 | 2016-08-05T13:57:22.000Z → 2016-11-02T22:49:10.000Z |

### Historical / Other（6）

| Split | Case / Issue | Issue title | Gold | Closing PR | Score | Files | Query chars | Lifecycle window |
|---|---|---|---|---|---:|---:|---:|---|
| dev | `facebook-react-issue-10965` / #10965 | [website] docsearch improvements | e367a447 | #11032 | 6 | 1 | 615 | 2017-09-22T16:36:29.000Z → 2017-11-02T17:39:15.000Z |
| test | `facebook-react-issue-10976` / #10976 | React.org enable tab out of Live JSX Editor | 53c1b8b0 | #10992 | 4 | 1 | 399 | 2017-09-22T20:26:43.000Z → 2017-11-02T18:15:01.000Z |
| dev | `facebook-react-issue-16396` / #16396 | use-subscription causes UI tearing in some random cases | d96f478f | #16623 | 8 | 2 | 952 | 2019-08-07T23:00:03.000Z → 2019-10-05T18:12:47.000Z |
| test | `facebook-react-issue-20224` / #20224 | Bug: Peer dependency change between use-subscription 1.4.1 and 1.5.0 | e7006d67 | #20225 | 8 | 1 | 1239 | 2020-11-04T17:40:09.000Z → 2020-12-12T00:30:20.000Z |
| test | `facebook-react-issue-24590` / #24590 | Bug: Support ESM for the use-sync-external-store shim | ad03c48a | #25231 | 8 | 2 | 1082 | 2022-05-13T23:26:42.000Z → 2025-03-26T12:02:00.000Z |
| dev | `facebook-react-issue-34328` / #34328 | Update CodeSandbox CI to Node 20 to match .nvmrc | 6b49c449 | #34329 | 8 | 1 | 585 | 2025-08-21T17:17:46.000Z → 2025-09-27T22:33:13.000Z |

### React ART（1）

| Split | Case / Issue | Issue title | Gold | Closing PR | Score | Files | Query chars | Lifecycle window |
|---|---|---|---|---|---:|---:|---:|---|
| dev | `facebook-react-issue-11254` / #11254 | react-art on npm is missing the /lib/ folder | f6c60dcb | #11343 | 4 | 5 | 191 | 2017-10-10T18:22:14.000Z → 2017-11-22T18:18:12.000Z |

### React Compiler（26）

| Split | Case / Issue | Issue title | Gold | Closing PR | Score | Files | Query chars | Lifecycle window |
|---|---|---|---|---|---:|---:|---:|---|
| test | `facebook-react-issue-29068` / #29068 | [React 19]: `eslint-plugin-react-compiler` defines no `main` in its package.json | cfeb491e | #29072 | 5 | 1 | 319 | 2024-05-08T18:28:21.000Z → 2024-06-14T21:02:21.000Z |
| test | `facebook-react-issue-29069` / #29069 | Compiler: Unexpected token error when using double quotes Inside single-quoted JSX prop | 3adca7a4 | #29079 | 8 | 8 | 481 | 2024-05-08T18:33:01.000Z → 2024-06-14T21:40:34.000Z |
| dev | `facebook-react-issue-29075` / #29075 | Bug: `react-compiler-healthcheck` doesn't recognize when strict mode is enabled with `<React.StrictMode />` | 5e11e7fc | #29076 | 6 | 1 | 872 | 2024-05-08T20:30:15.000Z → 2024-06-14T21:15:33.000Z |
| dev | `facebook-react-issue-29130` / #29130 | `react-compiler-healthcheck` prints "StrictMode usage not found." in Next.js project with `reactStrictMode: true` in `next.config.js` | d3ce0d3e | #29167 | 4 | 2 | 489 | 2024-05-10T11:17:01.000Z → 2024-06-19T15:55:36.000Z |
| dev | `facebook-react-issue-29617` / #29617 | Compiler String Concat Constant Propagation | a9a01068 | #29621 | 3 | 3 | 292 | 2024-05-21T18:28:44.000Z → 2024-06-27T23:15:47.000Z |
| test | `facebook-react-issue-29622` / #29622 | Compiler Logical Negation Constant Propagation | 320da675 | #29623 | 4 | 3 | 688 | 2024-05-21T20:33:25.000Z → 2024-06-28T16:17:44.000Z |
| dev | `facebook-react-issue-29649` / #29649 | [compiler] Add more arithmetic binary expressions to constant propagation | c2b45ef0 | #29650 | 4 | 4 | 708 | 2024-05-22T16:53:55.000Z → 2024-06-28T17:35:20.000Z |
| dev | `facebook-react-issue-30782` / #30782 | [Compiler Bug]: eslint-plugin-react-compiler errors when updating initialization of ref.current | 43956899 | #34024 | 11 | 3 | 1490 | 2024-08-14T23:52:41.000Z → 2025-08-28T17:53:14.000Z |
| dev | `facebook-react-issue-31407` / #31407 | [Compiler Bug]: `'Unused 'use no memo' directive'` lint warning even though the directive is used | 19f65ff1 | #34703 | 9 | 5 | 1500 | 2024-10-26T17:25:16.000Z → 2025-11-01T23:19:03.000Z |
| dev | `facebook-react-issue-31745` / #31745 | [Compiler Bug]: Handle TSInstantiationExpression expressions | 10a4c88f | #32302 | 11 | 3 | 1123 | 2024-12-05T17:26:06.000Z → 2025-03-05T16:41:06.000Z |
| dev | `facebook-react-issue-31864` / #31864 | [Compiler Bug]: Linter complains about ref `current` access during render when returning array with Typescript's `as const` | 6a3d6a43 | #31871 | 9 | 3 | 1523 | 2024-12-13T02:44:03.000Z → 2025-01-19T16:56:49.000Z |
| dev | `facebook-react-issue-32014` / #32014 | [Compiler Bug]: Playground doesn't display compiler violations | 8932ca32 | #32035 | 9 | 1 | 914 | 2025-01-01T09:48:07.000Z → 2025-02-08T17:21:08.000Z |
| dev | `facebook-react-issue-32123` / #32123 | [Compiler Bug]: Compiler messes up with escape character | 7c864c98 | #32131 | 11 | 3 | 1140 | 2025-01-12T06:05:54.000Z → 2025-02-21T19:22:37.000Z |
| dev | `facebook-react-issue-32137` / #32137 | [Compiler Bug]: double quote compile incorrectly | e5a2062c | #32138 | 11 | 3 | 858 | 2025-01-13T22:32:12.000Z → 2025-02-21T17:05:01.000Z |
| test | `facebook-react-issue-32269` / #32269 | [Compiler Bug]: Upgrading from `e552027-20250112` to `27714ef-20250124` no longer optimizes | fcb4e0f1 | #32417 | 11 | 3 | 1492 | 2025-01-23T08:10:31.000Z → 2025-03-21T21:22:55.000Z |
| dev | `facebook-react-issue-33577` / #33577 | [Compiler Bug]: Compiler tries to assign to variables that does not exist | 9894c488 | #33624 | 11 | 4 | 1324 | 2025-06-12T14:24:26.000Z → 2025-07-25T18:10:10.000Z |
| dev | `facebook-react-issue-33978` / #33978 | [Compiler Bug]: Component defined inside function cause incorrect optimization | b8700429 | #34305 | 11 | 7 | 1480 | 2025-07-17T08:17:01.000Z → 2025-09-26T17:59:27.000Z |
| dev | `facebook-react-issue-34108` / #34108 | [Compiler Bug]: Compiler introduces unnecessary breaks that skips its own memoization | 5d64f742 | #34335 | 11 | 7 | 1297 | 2025-07-29T02:20:05.000Z → 2025-10-04T00:44:43.000Z |
| test | `facebook-react-issue-34311` / #34311 | [Compiler Bug]: errors when the `this` type is declared in a function | bd5b1b76 | #34322 | 9 | 2 | 1069 | 2025-08-20T07:37:01.000Z → 2025-09-26T21:58:45.000Z |
| dev | `facebook-react-issue-34622` / #34622 | [playground]: Syntax error crashes playground | 06fcc8f3 | #34623 | 11 | 2 | 1115 | 2025-09-20T14:58:11.000Z → 2025-11-08T19:02:57.000Z |
| dev | `facebook-react-issue-34748` / #34748 | [Compiler Bug]: `startTransition` shouldn't be required as a dependency for `useCallback`. | e096403c | #34847 | 9 | 9 | 1493 | 2025-09-29T07:24:39.000Z → 2025-11-14T16:45:07.000Z |
| dev | `facebook-react-issue-34971` / #34971 | [Compiler Bug]: Memoization is not correctly applied around `for` loops | 0ca9d207 | #36732 | 11 | 10 | 1472 | 2025-10-17T20:26:40.000Z → 2026-07-17T22:54:16.000Z |
| dev | `facebook-react-issue-35040` / #35040 | Bug: Getting `Cannot access refs during render` error from event handler. | 21f28242 | #35062 | 6 | 13 | 1475 | 2025-10-28T17:36:26.000Z → 2025-12-14T17:00:35.000Z |
| test | `facebook-react-issue-35122` / #35122 | [Compiler Bug]: function are not memorized correctly. | 2cb08e65 | #35284 | 11 | 3 | 1450 | 2025-11-05T18:32:06.000Z → 2026-01-04T19:29:07.000Z |
| test | `facebook-react-issue-36101` / #36101 | Bug: react-hooks/set-state-in-effect fails to flag violation if prop has a `NewExpression` default value | 808e7ed8 | #36107 | 8 | 3 | 703 | 2026-03-12T10:11:50.000Z → 2026-05-08T18:52:51.000Z |
| test | `facebook-react-issue-36601` / #36601 | [Compiler Bug]: Components prefixed with `_` are assumed host components | fc08d760 | #36688 | 11 | 3 | 1473 | 2026-05-27T06:36:51.000Z → 2026-08-06T05:24:55.000Z |

### React Core（26）

| Split | Case / Issue | Issue title | Gold | Closing PR | Score | Files | Query chars | Lifecycle window |
|---|---|---|---|---|---:|---:|---:|---|
| dev | `facebook-react-issue-6351` / #6351 | Bundle React into a flat file | 4b2eac3d | #9327 | 3 | 240 | 438 | 2016-03-19T22:11:40.000Z → 2017-05-05T15:47:29.000Z |
| test | `facebook-react-issue-6599` / #6599 | context does not update using `unstable_renderSubtreeIntoContainer` | 25f9f456 | #7125 | 4 | 4 | 1360 | 2016-04-17T10:45:32.000Z → 2016-07-27T22:29:43.000Z |
| test | `facebook-react-issue-7349` / #7349 | Did not expect componentDidMount timer to start while render timer is still in progress for another instance | a229cdba | #7548 | 6 | 4 | 1179 | 2016-07-18T14:57:30.000Z → 2016-09-23T18:18:32.000Z |
| dev | `facebook-react-issue-7406` / #7406 | Memory leak in React 15.3.0 non-production server side rendering | 38c4ade6 | #7455 | 8 | 5 | 1269 | 2016-07-26T20:26:19.000Z → 2016-09-09T18:50:18.000Z |
| dev | `facebook-react-issue-7424` / #7424 | False-positive mutation warning | 38c4ade6 | #7455 | 6 | 5 | 460 | 2016-07-28T12:52:04.000Z → 2016-10-13T13:25:31.000Z |
| dev | `facebook-react-issue-7856` / #7856 | Show component stack for invalid type warning during element creation | fb7e4943 | #8495 | 4 | 3 | 556 | 2016-09-26T23:14:48.000Z → 2017-02-08T15:26:01.000Z |
| dev | `facebook-react-issue-7927` / #7927 | Changing state too quickly cause error with shallow render | 6eebed05 | #8097 | 6 | 3 | 1458 | 2016-10-03T10:07:15.000Z → 2016-11-26T09:31:10.000Z |
| test | `facebook-react-issue-8392` / #8392 | Cannot use addons.Perf or addons.ReactTransitionGroup in AMD environment with 15.4.1 | ca2c71c0 | #8686 | 4 | 44 | 360 | 2016-11-16T07:53:19.000Z → 2017-02-04T21:16:09.000Z |
| test | `facebook-react-issue-9589` / #9589 | Ensure flat bundles don't duplicate code with weak minifiers | 34092a0f | #10446 | 3 | 1 | 311 | 2017-04-25T22:34:08.000Z → 2017-10-13T22:51:43.000Z |
| dev | `facebook-react-issue-10336` / #10336 | Delete rAF from ReactDOMFrameScheduling? | 37244573 | #10337 | 1 | 1 | 198 | 2017-07-25T01:58:04.000Z → 2017-09-01T14:26:38.000Z |
| test | `facebook-react-issue-10598` / #10598 | Returning plain string from component renders collapsed text nodes on server | 32ec7972 | #11109 | 9 | 2 | 433 | 2017-08-26T22:53:32.000Z → 2017-11-04T19:05:00.000Z |
| dev | `facebook-react-issue-10906` / #10906 | In React 16, onMouseEnter is triggered an extra time when entering a new child | 80596c2c | #11164 | 7 | 2 | 1428 | 2017-09-21T07:06:35.000Z → 2017-11-08T19:30:04.000Z |
| dev | `facebook-react-issue-11759` / #11759 | "React.createElement: type is invalid" warning in IE11 when using React.Fragment | a5025b16 | #11823 | 8 | 1 | 333 | 2017-11-27T08:56:34.000Z → 2018-01-10T03:25:29.000Z |
| test | `facebook-react-issue-12930` / #12930 | Broken `fiber-triangle-demo` and `schedule` fixtures | 79a740c6 | #12931 | 8 | 2 | 992 | 2018-05-22T23:01:14.000Z → 2018-06-29T00:54:39.000Z |
| dev | `facebook-react-issue-16686` / #16686 | Compile error `react-refresh/babel` 0.4.0 | 9044bb0f | #16687 | 9 | 3 | 840 | 2019-08-30T16:55:45.000Z → 2019-10-06T18:58:08.000Z |
| dev | `facebook-react-issue-17237` / #17237 | react-refresh: add options to override $RefreshReg$ and $RefreshSig$ for better System.js integration | f4cc45ce | #17340 | 4 | 3 | 967 | 2019-10-24T12:41:06.000Z → 2019-12-12T14:16:24.000Z |
| dev | `facebook-react-issue-17626` / #17626 | react-refresh + ReactDOM: hot reloading only works when bundling React | c2d1561c | #17633 | 8 | 3 | 1467 | 2019-12-09T19:39:27.000Z → 2020-01-16T01:15:37.000Z |
| dev | `facebook-react-issue-18831` / #18831 | Error: "Commit tree does not contain fiber 256. This is a bug in React DevTools." | a89854bc | #19373 | 9 | 22 | 1480 | 2020-04-28T18:01:22.000Z → 2020-08-14T16:25:28.000Z |
| dev | `facebook-react-issue-19748` / #19748 | Bug: (17.0.0-rc.1) lazy is eager in dev mode | bc6b7b6b | #19871 | 11 | 6 | 1442 | 2020-08-26T10:59:01.000Z → 2020-10-21T15:04:50.000Z |
| dev | `facebook-react-issue-20100` / #20100 | Bug: DevTools not finding/showing React components | 343d7a4a | #20129 | 11 | 4 | 1241 | 2020-10-19T12:48:50.000Z → 2020-11-28T17:23:58.000Z |
| dev | `facebook-react-issue-20417` / #20417 | Bug: MobX-like observer pattern doesn't work with Fast Refresh because Hooks don't get detected | 516b76b9 | #21104 | 11 | 5 | 1123 | 2020-12-02T20:49:59.000Z → 2021-04-29T15:08:51.000Z |
| dev | `facebook-react-issue-22113` / #22113 | react-dom@alpha UMD bundle throws when rendering | 9eb2aaaf | #22117 | 11 | 1 | 486 | 2021-08-10T18:04:29.000Z → 2021-09-17T05:40:56.000Z |
| dev | `facebook-react-issue-22413` / #22413 | Bug: Components inside typescript namespaces cause ReferenceError | ff9897d2 | #22621 | 9 | 6 | 1457 | 2021-09-17T10:11:29.000Z → 2021-12-09T20:22:19.000Z |
| dev | `facebook-react-issue-22947` / #22947 | Missing entry point in package.json | fe905f15 | #22954 | 3 | 1 | 257 | 2021-12-06T06:12:38.000Z → 2022-02-06T20:59:47.000Z |
| dev | `facebook-react-issue-30659` / #30659 | Bug: React refresh fails when component type is changed to memo or forward ref and vice versa | de1eaa26, eb343c7c | #30660, #36950 | 11 | 4 | 1493 | 2024-08-05T10:27:17.000Z → 2026-08-06T23:30:48.000Z |
| dev | `facebook-react-issue-32354` / #32354 | Bug: Poor error message when useEffect is called with no parameters | 192555bb | #32355 | 8 | 1 | 1470 | 2025-02-04T12:44:02.000Z → 2025-03-13T22:01:05.000Z |

### React DevTools（143）

| Split | Case / Issue | Issue title | Gold | Closing PR | Score | Files | Query chars | Lifecycle window |
|---|---|---|---|---|---:|---:|---:|---|
| dev | `facebook-react-issue-16437` / #16437 | Devtools V4: Where is Highlight Updates? | 0545f366 | #16989 | 1 | 19 | 268 | 2019-08-10T09:45:03.000Z → 2019-11-02T17:46:01.000Z |
| dev | `facebook-react-issue-16462` / #16462 | DevTools: Fully disable 0.14 support | b6606ecb | #16897 | 4 | 12 | 525 | 2019-08-12T21:33:32.000Z → 2019-10-26T15:41:47.000Z |
| dev | `facebook-react-issue-16466` / #16466 | DevTools: Don't show "context" for classes without either contextType or contextTypes | 4ef6387d | #16617 | 1 | 7 | 315 | 2019-08-12T21:39:10.000Z → 2019-10-10T20:30:21.000Z |
| dev | `facebook-react-issue-16473` / #16473 | DevTools: Switch between "Rendered At" renders using keyboard arrow keys | 6c43a62c | #18586 | 4 | 1 | 882 | 2019-08-12T21:49:37.000Z → 2020-05-13T20:00:14.000Z |
| test | `facebook-react-issue-16492` / #16492 | DevTools: Commit picker should register leaving the picker at a side as setting a terminal value | 62077431 | #18852 | 1 | 2 | 235 | 2019-08-12T22:26:10.000Z → 2020-06-07T18:19:58.000Z |
| dev | `facebook-react-issue-16497` / #16497 | DevTools: Show component file path | 031a5aaf | #17567 | 6 | 2 | 512 | 2019-08-12T23:05:12.000Z → 2020-01-09T17:24:35.000Z |
| dev | `facebook-react-issue-16527` / #16527 | DevTools: Profiler: Save profile does nothing on Firefox | 77bb1023 | #16612 | 9 | 2 | 762 | 2019-08-14T18:04:11.000Z → 2019-10-03T15:35:13.000Z |
| dev | `facebook-react-issue-16691` / #16691 | DevTools: Failed to execute 'postMessage' on 'Window': #<HTMLAllCollection> could not be cloned. | 49af8899 | #19619 | 11 | 2 | 1499 | 2019-08-30T22:12:51.000Z → 2020-09-20T13:31:17.000Z |
| test | `facebook-react-issue-16722` / #16722 | memo name is Anonymous when passed the result of forwardRef | 4f02c93c | #17274 | 8 | 1 | 1113 | 2019-09-03T05:50:12.000Z → 2019-12-05T22:08:02.000Z |
| dev | `facebook-react-issue-16749` / #16749 | DevTools: Show Source should point to `render`, not `constructor` | ba932a5a | #16759 | 8 | 1 | 755 | 2019-09-04T11:00:12.000Z → 2019-10-12T15:32:42.000Z |
| test | `facebook-react-issue-16843` / #16843 | DevTools: showing wrong state | fa1a3262 | #16878 | 11 | 8 | 1377 | 2019-09-13T13:24:58.000Z → 2019-10-25T17:46:27.000Z |
| dev | `facebook-react-issue-17073` / #17073 | [DevTools] polish hooks: complex values preview | 12c00041 | #17579 | 2 | 9 | 460 | 2019-10-05T11:32:51.000Z → 2020-01-11T01:52:18.000Z |
| test | `facebook-react-issue-17134` / #17134 | React Devtools should produce a better error message when integers are present as keys on react elements | 3497ccc1 | #17164 | 9 | 3 | 748 | 2019-10-11T08:42:25.000Z → 2019-11-28T15:41:49.000Z |
| test | `facebook-react-issue-17207` / #17207 | Bug: react-devtools TypeError: Do not know how to serialize a BigInt | 5235d193 | #17233 | 11 | 6 | 1383 | 2019-10-22T12:07:08.000Z → 2020-01-03T15:53:01.000Z |
| test | `facebook-react-issue-17432` / #17432 | Devtools : highlight box is shown too small. | c93a6cb4 | #18973 | 11 | 1 | 448 | 2019-11-15T10:43:23.000Z → 2020-06-20T17:04:38.000Z |
| dev | `facebook-react-issue-17620` / #17620 | Firefox React DevTools breaks XML formatting | 2b903da3 | #17739 | 8 | 1 | 345 | 2019-12-09T13:46:30.000Z → 2020-01-28T21:02:51.000Z |
| test | `facebook-react-issue-17624` / #17624 | React DevTools might retain references to unmounted DOM elements (and their Fibers) | f50ff357 | #22346 | 4 | 1 | 506 | 2019-12-09T18:55:33.000Z → 2021-10-17T16:53:08.000Z |
| test | `facebook-react-issue-17629` / #17629 | Update DevTools build process to use artifacts from CI | 95056b68 | #17653 | 4 | 12 | 806 | 2019-12-09T21:46:19.000Z → 2020-01-17T22:34:41.000Z |
| dev | `facebook-react-issue-17630` / #17630 | Fix broken DevTools tests | 36a6e29b | #17631 | 6 | 5 | 516 | 2019-12-09T22:47:59.000Z → 2020-01-16T00:03:13.000Z |
| test | `facebook-react-issue-17681` / #17681 | Re-enable context menu options in Firefox | 1e1a9894 | #17838 | 1 | 2 | 338 | 2019-12-13T18:12:28.000Z → 2020-03-05T17:09:24.000Z |
| dev | `facebook-react-issue-17754` / #17754 | DevTools can't inspect object without prototype | 195b3db6 | #17757 | 9 | 6 | 1440 | 2019-12-26T09:56:13.000Z → 2020-02-01T16:27:30.000Z |
| test | `facebook-react-issue-17761` / #17761 | Error: "f.hasOwnProperty is not a function" | 7e2ab87a | #17768 | 9 | 10 | 1322 | 2019-12-27T03:51:53.000Z → 2020-02-02T17:34:13.000Z |
| test | `facebook-react-issue-17832` / #17832 | [react-devtools-extensions] Bug: Uncaught TypeError: Cannot read property 'sub' of undefined when navigating to plain-text pages | 08c1f79e | #17848 | 11 | 6 | 1531 | 2020-01-07T09:43:10.000Z → 2020-03-03T20:04:49.000Z |
| dev | `facebook-react-issue-17855` / #17855 | Bug: DevTools DOM highlighting gets stuck after a prolonged hover | 4f273bd3 | #36177 | 10 | 1 | 303 | 2020-01-09T17:16:35.000Z → 2026-06-01T08:50:28.000Z |
| test | `facebook-react-issue-17895` / #17895 | Bug: fix BigInt in copyElementPath in react-devtools | d9a51705 | #17931 | 9 | 2 | 1446 | 2020-01-16T11:59:29.000Z → 2020-03-01T22:36:00.000Z |
| test | `facebook-react-issue-17928` / #17928 | Profiler should highlight host components (e.g. DOM elements) on mouseover | d897c35e | #18745 | 1 | 4 | 252 | 2020-01-22T21:21:56.000Z → 2020-06-17T18:13:17.000Z |
| dev | `facebook-react-issue-17935` / #17935 | Bug: Excessive cpu usage of the page when react-devtools is active | c7811561 | #18498 | 11 | 1 | 1148 | 2020-01-23T10:19:22.000Z → 2020-05-06T15:17:46.000Z |
| dev | `facebook-react-issue-18010` / #18010 | DevTools Profiler: "Could not find commit data for root …" | a3fccd25 | #18880 | 11 | 1 | 552 | 2020-02-03T19:24:14.000Z → 2020-06-11T22:47:24.000Z |
| test | `facebook-react-issue-18256` / #18256 | Error: "Cannot read property 'concat' of undefined" | e614e696 | #19987 | 9 | 3 | 1453 | 2020-03-02T17:40:03.000Z → 2020-11-12T17:38:59.000Z |
| test | `facebook-react-issue-18472` / #18472 | DevTools: Hovering "Rendered by" list should highlight elements | 7785a526 | #18479 | 3 | 4 | 301 | 2020-03-26T23:13:49.000Z → 2020-05-03T17:49:50.000Z |
| dev | `facebook-react-issue-18702` / #18702 | Improve UX of finding full `key` value | 2b9d7cf6 | #18737 | 6 | 7 | 599 | 2020-04-15T15:00:02.000Z → 2020-06-10T20:17:14.000Z |
| test | `facebook-react-issue-18798` / #18798 | Error: "Cannot read property 'duration' of undefined" | 69e732ac | #18862 | 9 | 2 | 1304 | 2020-04-24T12:41:08.000Z → 2020-06-07T00:07:21.000Z |
| dev | `facebook-react-issue-18843` / #18843 | "Pause on caught exceptions" enabled always breaks on this line | 7e405d45 | #18994 | 2 | 15 | 895 | 2020-04-29T14:14:46.000Z → 2020-11-11T17:07:11.000Z |
| dev | `facebook-react-issue-18924` / #18924 | Error: "Could not find node with id "4557" in commit tree" | 2eb3181e | #20019 | 7 | 3 | 1336 | 2020-05-07T13:10:10.000Z → 2020-11-14T18:45:24.000Z |
| dev | `facebook-react-issue-18935` / #18935 | DevTools: Uncaught error doesn't go away on page refresh | 099f7371 | #18956 | 3 | 7 | 306 | 2020-05-09T06:51:01.000Z → 2020-06-20T18:21:23.000Z |
| dev | `facebook-react-issue-18945` / #18945 | DevTools: Improve browser extension iframe support | a99bf5c5 | #19854 | 8 | 30 | 1070 | 2020-05-11T09:35:01.000Z → 2024-05-17T18:15:59.000Z |
| dev | `facebook-react-issue-19045` / #19045 | [DevTools Feature Request] Break on Warnings | 2efe63d9 | #19048 | 3 | 19 | 250 | 2020-05-22T18:28:30.000Z → 2020-06-28T21:34:44.000Z |
| test | `facebook-react-issue-19279` / #19279 | Security: 4 Electron (react-devtools dep) security advisories | a5b44929 | #19280 | 4 | 2 | 840 | 2020-07-01T12:42:47.000Z → 2020-08-08T14:13:27.000Z |
| test | `facebook-react-issue-19308` / #19308 | Bug: Unexpected debugger statement in DevTools (solved) | 8eaf05e0 | #19309 | 9 | 1 | 535 | 2020-07-03T10:49:41.000Z → 2020-08-10T15:50:49.000Z |
| dev | `facebook-react-issue-19320` / #19320 | Bug: DevTools extension component tree view crashes on empty Suspense element | fbc63863 | #19337 | 11 | 4 | 1452 | 2020-07-04T13:49:29.000Z → 2020-08-12T20:21:57.000Z |
| dev | `facebook-react-issue-19545` / #19545 | Bug: Proxy on Context throws an error in DevTools | b6e1d086 | #19584 | 11 | 5 | 742 | 2020-07-30T14:50:25.000Z → 2020-09-11T16:15:54.000Z |
| dev | `facebook-react-issue-19629` / #19629 | Bug: Clicking the troubleshooting instructions button on the devtools opens 2 tabs | 24f1923b | #19632 | 10 | 1 | 355 | 2020-08-10T17:28:59.000Z → 2020-09-17T14:17:01.000Z |
| test | `facebook-react-issue-19633` / #19633 | Error: "Commit tree does not contain fiber 2094. This is a bug in React DevTools." | e614e696 | #19987 | 9 | 3 | 1473 | 2020-08-11T07:14:13.000Z → 2020-11-12T17:38:59.000Z |
| dev | `facebook-react-issue-19639` / #19639 | Bug: Property list does not render repeated spaces properly. | c45a1954 | #19640 | 11 | 1 | 996 | 2020-08-11T17:13:11.000Z → 2020-09-18T12:50:47.000Z |
| dev | `facebook-react-issue-19662` / #19662 | Add a toggle for Boolean props in DevTools | 835c11eb | #19714 | 4 | 2 | 434 | 2020-08-13T16:54:00.000Z → 2020-10-03T12:57:13.000Z |
| dev | `facebook-react-issue-19674` / #19674 | Add SuspenseList to DevTools Element Names | 60ba723b | #19684 | 9 | 3 | 628 | 2020-08-14T22:09:50.000Z → 2020-09-25T17:04:44.000Z |
| dev | `facebook-react-issue-19676` / #19676 | Bug: Broken Scheduling Profiler landing styles | 38a512ac | #19707 | 8 | 20 | 522 | 2020-08-15T08:01:10.000Z → 2020-10-03T16:08:41.000Z |
| dev | `facebook-react-issue-19726` / #19726 | Bug: DevTools calls arbitrary generators which may be stateful | 92c7e498 | #19831 | 9 | 6 | 1463 | 2020-08-23T01:03:14.000Z → 2020-10-22T18:23:20.000Z |
| test | `facebook-react-issue-19732` / #19732 | Bug: React DevTools 'Why did this component render?' incorrectly reports 'The parent component rendered' | 24f215ce | #35723 | 8 | 2 | 582 | 2020-08-24T23:15:59.000Z → 2024-05-17T18:12:22.000Z |
| test | `facebook-react-issue-19911` / #19911 | Bug: devtools Profiler causes unexpected errors | f75f8b48 | #20011 | 11 | 2 | 1326 | 2020-09-18T18:18:33.000Z → 2020-11-13T17:19:48.000Z |
| dev | `facebook-react-issue-20431` / #20431 | Error: "Commit tree does not contain fiber "5766". This is a bug in React DevTools." | a0d6b155 | #21377 | 7 | 1 | 1433 | 2020-12-04T04:00:11.000Z → 2021-05-28T14:29:22.000Z |
| dev | `facebook-react-issue-20454` / #20454 | React DevTools should bump the Electron version to 11.0.1 for darwin-arm64 builds | beb38aba | #20496 | 6 | 2 | 1136 | 2020-12-06T23:57:36.000Z → 2021-02-03T15:38:12.000Z |
| dev | `facebook-react-issue-20696` / #20696 | Bug: React Dev Tools fail to show component updates with memoized components. | b54f36f2 | #22008 | 11 | 1 | 608 | 2021-01-23T05:35:47.000Z → 2021-09-02T15:50:00.000Z |
| dev | `facebook-react-issue-20767` / #20767 | Scheduling profiler: Unrecognized event type from Chrome Canary | e5f6b91d | #20808 | 7 | 13 | 616 | 2021-02-02T14:00:28.000Z → 2021-03-25T16:31:29.000Z |
| dev | `facebook-react-issue-20806` / #20806 | Bug: devtools reload-and-profile feature is defeated by sync-xhr feature policy | bd245c1b | #20879 | 8 | 4 | 1031 | 2021-02-04T19:01:26.000Z → 2021-04-10T15:31:57.000Z |
| dev | `facebook-react-issue-20905` / #20905 | Redundant condition in react-devtools-shared | a5aa9d52 | #21101 | 5 | 1 | 289 | 2021-02-22T15:16:34.000Z → 2021-04-25T17:50:58.000Z |
| test | `facebook-react-issue-20997` / #20997 | Bug: Can't build react-devtools-extensions | c06d245f | #21004 | 5 | 4 | 277 | 2021-03-06T18:15:02.000Z → 2021-04-14T13:46:46.000Z |
| test | `facebook-react-issue-21118` / #21118 | Bump DevTools Chrome and Firefox versions | ee6a05c2 | #21185 | 2 | 3 | 1441 | 2021-03-20T14:37:13.000Z → 2021-05-06T15:18:46.000Z |
| test | `facebook-react-issue-21172` / #21172 | Bug: DevTools settings dialog no longer opens | a817840e | #21173 | 6 | 1 | 196 | 2021-03-27T13:24:52.000Z → 2021-05-05T15:09:43.000Z |
| test | `facebook-react-issue-21235` / #21235 | Bug(react-devtools-inline@4.11.0): publish artifact points to /Users/bvaughn/Documents/git/react.devtools/ | 9d48779b | #21237 | 3 | 3 | 367 | 2021-04-04T15:51:16.000Z → 2021-05-11T18:54:26.000Z |
| dev | `facebook-react-issue-21271` / #21271 | Error: "Could not find node with id "40035" in commit tree" | a0d6b155 | #21377 | 7 | 1 | 1448 | 2021-04-07T19:16:21.000Z → 2021-05-28T14:29:23.000Z |
| test | `facebook-react-issue-21436` / #21436 | Error: "Cannot add node "1" because a node with that id is already in the Store." | d6604ac0 | #21523 | 9 | 3 | 897 | 2021-04-28T17:58:25.000Z → 2021-06-18T02:44:30.000Z |
| dev | `facebook-react-issue-21528` / #21528 | [DevTools Bug]: Fast Refresh + DevTools breaks component inspection | b8bbb6a1 | #21536 | 11 | 2 | 433 | 2021-05-12T15:50:20.000Z → 2021-06-19T15:24:09.000Z |
| test | `facebook-react-issue-21718` / #21718 | [DevTools Bug]: Settings panel layout broken | 386e8f2e | #21747 | 11 | 2 | 558 | 2021-06-15T09:42:35.000Z → 2021-07-24T15:19:57.000Z |
| test | `facebook-react-issue-21736` / #21736 | [DevTools]: Show which context(s) changed for function components | da627ded | #22047 | 3 | 4 | 266 | 2021-06-16T18:54:52.000Z → 2021-09-09T18:16:55.000Z |
| dev | `facebook-react-issue-21792` / #21792 | [DevTools] Use line number and column number to match hook | f52b73f9, 64bbd7a7 | #21833, #21865 | 4 | 24 | 730 | 2021-06-25T14:38:02.000Z → 2021-08-12T17:28:01.000Z |
| dev | `facebook-react-issue-21793` / #21793 | [DevTools] Support Flow syntax for named hooks parsing | b6258b05 | #21815 | 4 | 1 | 678 | 2021-06-25T14:41:32.000Z → 2021-08-06T18:29:41.000Z |
| test | `facebook-react-issue-21794` / #21794 | [DevTools] Handle bundles (multi sources) when parsing hook names | 9c7f29eb | #21790 | 4 | 25 | 736 | 2021-06-25T14:44:27.000Z → 2021-08-06T17:07:58.000Z |
| test | `facebook-react-issue-21796` / #21796 | [DevTools] Improve Fast Refresh support for named hook detection | e26cb8f8 | #21891 | 6 | 14 | 1190 | 2021-06-26T17:22:22.000Z → 2021-08-15T03:39:30.000Z |
| dev | `facebook-react-issue-21811` / #21811 | [DevTools] Don't serialize hook source fileNames (URLs) | 42b3c89c | #21814 | 3 | 3 | 195 | 2021-06-30T15:18:56.000Z → 2021-08-06T18:24:18.000Z |
| dev | `facebook-react-issue-21819` / #21819 | [DevTools] Improve "retry" function for inspected component props/state/hooks | 92f3414d | #21821 | 4 | 4 | 500 | 2021-06-30T19:27:38.000Z → 2021-08-07T18:07:15.000Z |
| dev | `facebook-react-issue-21822` / #21822 | [DevTools] Make sure named hooks Suspense cache is persisting between elements | feb2f689 | #21831 | 1 | 5 | 349 | 2021-06-30T22:19:13.000Z → 2021-08-07T17:54:17.000Z |
| test | `facebook-react-issue-21834` / #21834 | [DevTools] Skip loading and parsing source for unnamed built-in hooks | 32d88d43 | #21835 | 1 | 5 | 256 | 2021-07-01T20:11:17.000Z → 2021-08-07T20:46:17.000Z |
| dev | `facebook-react-issue-21855` / #21855 | [DevTools] Parse named source AST in a worker | 25f09e3e | #21902 | 4 | 9 | 1443 | 2021-07-05T21:04:01.000Z → 2021-08-20T16:16:08.000Z |
| dev | `facebook-react-issue-21856` / #21856 | [DevTools] Show which hooks (names) changed in the Profiler | 7ff4d057 | #31398 | 2 | 7 | 797 | 2021-07-05T21:06:23.000Z → 2025-05-15T10:10:01.000Z |
| test | `facebook-react-issue-21868` / #21868 | [DevTools] Named hooks compatibility for create-react-app DEV mode | 87b3ada8 | #21874 | 8 | 15 | 562 | 2021-07-06T17:38:20.000Z → 2021-08-13T18:37:28.000Z |
| dev | `facebook-react-issue-21870` / #21870 | [DevTools] Handle sources that contain the string "sourceMappingURL=" | 9fec3f2a | #21871 | 6 | 12 | 702 | 2021-07-06T19:52:12.000Z → 2021-08-12T20:39:29.000Z |
| test | `facebook-react-issue-21889` / #21889 | [DevTools] Console logging and StrictMode double rendering | 60a30cf3 | #22030 | 1 | 49 | 943 | 2021-07-08T19:54:27.000Z → 2021-09-24T22:35:38.000Z |
| dev | `facebook-react-issue-21939` / #21939 | DevTools: Order of higher-order component badges | b66936ec | #21952 | 4 | 4 | 815 | 2021-07-15T09:48:55.000Z → 2022-08-24T07:02:13.000Z |
| dev | `facebook-react-issue-21986` / #21986 | [DevTools Bug]: Component tree size too small, components can't be selected | e4e8226c | #22083 | 9 | 3 | 1099 | 2021-07-22T05:13:14.000Z → 2021-09-12T00:41:56.000Z |
| dev | `facebook-react-issue-22099` / #22099 | [DevTools Bug] Could not inspect element with id "1335" | edfe5051 | #22160 | 11 | 4 | 1414 | 2021-08-09T14:53:28.000Z → 2021-09-22T23:22:31.000Z |
| test | `facebook-react-issue-22115` / #22115 | DevTools: Better Bundle Names for Dynamically Imported Modules | e8feb11b | #22322 | 4 | 2 | 454 | 2021-08-10T20:46:42.000Z → 2021-10-15T17:51:34.000Z |
| test | `facebook-react-issue-22143` / #22143 | DevTools scroll-to error or warning feature broken | b6ff9ad1 | #22144 | 6 | 2 | 358 | 2021-08-12T23:04:36.000Z → 2021-09-19T15:55:42.000Z |
| dev | `facebook-react-issue-22241` / #22241 | [DevTools Bug] Could not inspect element with id "219". Error thrown:Cached data for element "219" not found | 47177247 | #22472 | 11 | 8 | 1436 | 2021-08-27T12:41:47.000Z → 2021-10-30T16:48:54.000Z |
| dev | `facebook-react-issue-22293` / #22293 | Bug: Maximum call stack size exceeded (React Devtools) | f2fd1b80 | #22330 | 11 | 1 | 1313 | 2021-09-03T21:18:32.000Z → 2021-10-17T13:52:52.000Z |
| dev | `facebook-react-issue-22422` / #22422 | [DevTools Bug]: Emoji as visual helper produce strange symbole | 2e415683 | #22424 | 9 | 3 | 534 | 2021-09-17T20:15:48.000Z → 2021-10-27T17:34:39.000Z |
| test | `facebook-react-issue-22486` / #22486 | Detect and warn if multiple copies of React DevTools are installed | 930c9e7e | #22563 | 4 | 6 | 464 | 2021-09-24T20:41:13.000Z → 2021-11-14T15:27:13.000Z |
| dev | `facebook-react-issue-22572` / #22572 | [DevTools Bug]: Firefox and Edge show error in console about unrecognized installation on v4.20.0 | b72dc8e9 | #22571 | 10 | 1 | 299 | 2021-10-08T20:09:41.000Z → 2021-11-14T21:18:20.000Z |
| test | `facebook-react-issue-22577` / #22577 | [DevTools Bug]: Blank tools localhost only | 5ca4b043 | #22597 | 11 | 3 | 414 | 2021-10-11T10:24:54.000Z → 2021-12-03T14:35:42.000Z |
| dev | `facebook-react-issue-22579` / #22579 | Scheduling Profiler: De-emphasize React internals | 4ba20579 | #22588 | 4 | 21 | 1451 | 2021-10-11T18:48:54.000Z → 2021-11-20T18:40:42.000Z |
| test | `facebook-react-issue-22591` / #22591 | [DevTools Bug]: Loading / parsing hook names is failing on v4.20 | fe0356ce | #22590 | 10 | 1 | 234 | 2021-10-12T22:09:48.000Z → 2021-12-04T15:46:52.000Z |
| test | `facebook-react-issue-22613` / #22613 | Scheduling Profiler flags useDeferredValue / useTransition updates as expensive | bfb40225 | #22614 | 1 | 2 | 270 | 2021-10-14T17:44:39.000Z → 2021-11-20T19:16:26.000Z |
| dev | `facebook-react-issue-22678` / #22678 | Improve DevTools CSS variables situation | 2db6d6a5 | #22716 | 4 | 11 | 1144 | 2021-10-26T14:03:53.000Z → 2021-12-08T20:17:22.000Z |
| dev | `facebook-react-issue-22834` / #22834 | [DevTools Bug]: CDN-based site not working | 2c1cf561 | #22932 | 11 | 1 | 807 | 2021-11-19T00:52:17.000Z → 2022-01-08T20:32:11.000Z |
| dev | `facebook-react-issue-22959` / #22959 | react-devtools report Error: Cannot find module './app' | 3f45b681 | #22960 | 7 | 1 | 1112 | 2021-12-08T03:33:08.000Z → 2022-01-14T04:28:57.000Z |
| dev | `facebook-react-issue-22970` / #22970 | [DevTools Bug] Could not find ID for Fiber "App" | 13036bfb | #23162 | 11 | 2 | 1373 | 2021-12-08T20:20:58.000Z → 2022-02-20T16:05:49.000Z |
| dev | `facebook-react-issue-23225` / #23225 | [DevTools Bug] Could not find ID for Fiber "App" | 645ec5d6 | #24116 | 11 | 2 | 1441 | 2022-01-26T10:58:47.000Z → 2022-04-16T19:40:04.000Z |
| test | `facebook-react-issue-23283` / #23283 | [DevTools Bug] Could not find node with id "18" in commit tree | 48a8574a | #24031 | 11 | 3 | 1391 | 2022-02-05T23:29:52.000Z → 2022-04-09T18:35:52.000Z |
| dev | `facebook-react-issue-24096` / #24096 | [React DevTools] Improve DevTools UI when Inspecting a Component that Throws an Error | e531a4a6 | #24248 | 8 | 10 | 812 | 2022-03-07T19:02:35.000Z → 2022-06-05T00:17:24.000Z |
| test | `facebook-react-issue-24170` / #24170 | [React DevTools] Component Stacks for Timeline Profiler | 2e1c8841 | #24805 | 4 | 16 | 1399 | 2022-03-18T22:21:08.000Z → 2022-07-28T21:15:24.000Z |
| dev | `facebook-react-issue-24302` / #24302 | Console dimming on second StrictMode render forces string cast | d63cd972 | #24373 | 9 | 5 | 1458 | 2022-03-31T20:49:39.000Z → 2022-05-14T16:30:04.000Z |
| dev | `facebook-react-issue-24428` / #24428 | [DevTools Bug]: forwardRef components not marked as "rendered" if context changed | 3dc9a8af | #24494 | 11 | 1 | 587 | 2022-04-16T16:38:15.000Z → 2022-06-03T20:25:28.000Z |
| dev | `facebook-react-issue-24441` / #24441 | [DevTools Bug]: TreeContext error: Can't access property "id" in undefined | d4acbe85 | #24501 | 9 | 1 | 1451 | 2022-04-19T14:07:21.000Z → 2022-06-04T15:46:57.000Z |
| dev | `facebook-react-issue-24522` / #24522 | [DevTools] Manifest version 2 is deprecated | 6dbccb92 | #25145 | 8 | 14 | 779 | 2022-05-02T12:37:52.000Z → 2022-11-21T02:52:19.000Z |
| dev | `facebook-react-issue-24539` / #24539 | [DevTools Bug]: When inspecting with DevTools, it fails to select correct react component when there are multiple react-dom instances in the application | 3e92eb0f | #24665 | 11 | 7 | 1267 | 2022-05-04T10:41:10.000Z → 2022-07-08T20:01:07.000Z |
| dev | `facebook-react-issue-24543` / #24543 | [DevTools Bug]: console.log crashes when I enable DevTools on Chrome | 852f10b5 | #24546 | 11 | 2 | 1133 | 2022-05-05T09:55:13.000Z → 2022-06-11T14:29:36.000Z |
| dev | `facebook-react-issue-24603` / #24603 | [DevTools Bug]: "Reload and profile" aways disabled on Timeline tab | f7b44539 | #24702 | 11 | 1 | 680 | 2022-05-16T20:29:50.000Z → 2022-07-10T14:38:33.000Z |
| dev | `facebook-react-issue-24623` / #24623 | [DevTools Bug] When inspecting, hook values after `useDeferredValue` are offset | 72ebc703 | #24742 | 11 | 2 | 1402 | 2022-05-19T02:08:32.000Z → 2022-07-17T18:43:10.000Z |
| dev | `facebook-react-issue-24781` / #24781 | [DevTools Bug]: Selecting/deselecting boolean from DevTools Component props causing loss of class functions | b14f8da1 | #26522 | 11 | 5 | 1286 | 2022-06-16T17:43:19.000Z → 2023-05-03T10:32:19.000Z |
| dev | `facebook-react-issue-24894` / #24894 | Upgrade to modern version of Rollup and related plugins | 6b6d0617 | #24916 | 4 | 6 | 1445 | 2022-07-05T11:04:14.000Z → 2023-03-22T06:35:58.000Z |
| dev | `facebook-react-issue-25052` / #25052 | Bug: Can't build react-devtools-extension project locally | 65b3449c | #25053 | 8 | 1 | 1436 | 2022-07-29T17:24:18.000Z → 2022-09-05T00:04:19.000Z |
| dev | `facebook-react-issue-25187` / #25187 | [DevTools Bug]: DevTools shouldn't skip over keyed Fragments in the tree | c80e5411 | #25197 | 11 | 1 | 646 | 2022-08-29T03:06:52.000Z → 2022-10-07T17:21:31.000Z |
| test | `facebook-react-issue-25667` / #25667 | [DevTools Bug]: react-devtools depends on vulnerable version of electron | aef93031 | #26337 | 11 | 5 | 717 | 2022-11-04T12:15:45.000Z → 2023-04-07T03:31:56.000Z |
| dev | `facebook-react-issue-25924` / #25924 | Bug: Scripts injected by browser extensions (e.g. React dev tools) may cause hydration errors | 56416609 | #26233 | 6 | 1 | 1489 | 2022-12-15T10:42:37.000Z → 2023-03-26T20:13:07.000Z |
| dev | `facebook-react-issue-26051` / #26051 | [DevTools Bug]: Can not work on devtools, instructions lead to error | 78c4bec2 | #26067 | 11 | 2 | 1469 | 2023-01-19T00:43:30.000Z → 2023-02-26T20:35:08.000Z |
| dev | `facebook-react-issue-26200` / #26200 | Bug: React dev tools inspect element of hover does not work on shadow elements | 91004569 | #26888 | 6 | 1 | 437 | 2023-02-12T16:12:16.000Z → 2023-07-07T15:38:40.000Z |
| dev | `facebook-react-issue-26500` / #26500 | [DevTools Bug]: copy operations don't work in Chrome | 21021fb0 | #26604 | 11 | 10 | 492 | 2023-03-21T19:02:59.000Z → 2023-05-12T15:12:06.000Z |
| dev | `facebook-react-issue-26756` / #26756 | [DevTools Bug]: React pages not being detected as using React in Incognito mode | 8a25302c | #26765 | 11 | 1 | 657 | 2023-04-25T03:53:41.000Z → 2023-06-02T16:27:41.000Z |
| dev | `facebook-react-issue-26787` / #26787 | [DevTools Bug] Cannot add node "1751" because a node with that id is already in the Store. | 2468a873 | #26823 | 11 | 8 | 1107 | 2023-04-29T23:03:50.000Z → 2023-06-16T10:40:52.000Z |
| test | `facebook-react-issue-26793` / #26793 | [DevTools Bug] Cannot remove node "226752" because no matching node was found in the Store. | 997f52fb | #27147 | 11 | 2 | 1089 | 2023-05-01T06:59:51.000Z → 2023-09-02T19:02:20.000Z |
| dev | `facebook-react-issue-26821` / #26821 | [DevTools Bug]: Strict mode badge points to the old docs | d7a98a5e | #26825 | 11 | 1 | 749 | 2023-05-09T18:27:09.000Z → 2023-06-16T12:34:36.000Z |
| dev | `facebook-react-issue-26911` / #26911 | [DevTools Bug]: React devtools stuck at Loading React Element Tree, troubleshooting instructions are Chrome-specific | 2c4c8471 | #27179 | 9 | 5 | 774 | 2023-05-31T17:26:43.000Z → 2023-09-28T09:40:04.000Z |
| dev | `facebook-react-issue-27119` / #27119 | [DevTools Bug]: Chrome extension gets disconnected from the page after 30sec of inactivity | 8fbd3079 | #27215 | 11 | 22 | 1094 | 2023-07-10T22:43:05.000Z → 2023-09-28T11:09:28.000Z |
| dev | `facebook-react-issue-27889` / #27889 | [DevTools Bug]: Hook parsing fails if a hook uses useSyncExternalStore | 47beb96c | #28399 | 11 | 2 | 1222 | 2023-12-31T05:08:52.000Z → 2024-03-23T11:42:53.000Z |
| test | `facebook-react-issue-28584` / #28584 | [DevTools Bug]: React Profiler reports higher hook numbers than shown in Components | 53daaf5a | #35123 | 11 | 4 | 1084 | 2024-03-12T00:40:07.000Z → 2026-02-14T11:06:16.000Z |
| dev | `facebook-react-issue-28960` / #28960 | [DevTools Bug]: React 17 error while trying to inspect hooks "Context reads do not line up with context dependencies." | f5f2799a | #28974 | 11 | 2 | 1521 | 2024-04-23T20:09:34.000Z → 2024-06-01T20:08:42.000Z |
| test | `facebook-react-issue-29647` / #29647 | [DevTools Bug]: devtools does not works on null origin(sandbox) | 583e2003 | #35208 | 11 | 11 | 764 | 2024-05-22T12:44:16.000Z → 2026-02-12T16:49:51.000Z |
| dev | `facebook-react-issue-29724` / #29724 | [DevTools Bug]: CVE-2024-29415 (`ip` dependency) | 1434af3d | #29918 | 11 | 8 | 519 | 2024-05-27T11:21:16.000Z → 2024-07-05T10:17:37.000Z |
| test | `facebook-react-issue-31100` / #31100 | [DevTools Bug]: Script tag connection method not working in 6.0.0 | 40357fe6 | #31102 | 11 | 1 | 1170 | 2024-09-23T15:00:54.000Z → 2024-10-31T13:03:50.000Z |
| dev | `facebook-react-issue-31422` / #31422 | [DevTools Bug]: Copy to clipboard doesn't work | f13abbbb | #32077 | 11 | 3 | 631 | 2024-10-29T15:05:30.000Z → 2025-02-14T18:41:23.000Z |
| test | `facebook-react-issue-31463` / #31463 | [DevTools Bug] getCommitTree(): Invalid commit "7" for root "1". There are only "7" commits. | 5dad2b47 | #35672 | 11 | 2 | 1455 | 2024-11-01T18:59:44.000Z → 2026-03-05T12:44:07.000Z |
| test | `facebook-react-issue-31679` / #31679 | [DevTools Bug]: Profiler stuck and crash | 453f5052 | #32066 | 11 | 1 | 1035 | 2024-11-28T21:46:57.000Z → 2025-02-13T20:23:44.000Z |
| test | `facebook-react-issue-31977` / #31977 | [DevTools Bug]: React DevTools Profiler freezes after recording multiple events | 453f5052 | #32066 | 11 | 1 | 1109 | 2024-12-28T16:15:59.000Z → 2025-02-13T20:23:43.000Z |
| dev | `facebook-react-issue-32552` / #32552 | [DevTools Bug]: Negative infinity is serialized and shown as `Infinity` | 9635257c | #36347 | 11 | 6 | 808 | 2025-03-01T11:14:40.000Z → 2026-06-01T08:50:42.000Z |
| dev | `facebook-react-issue-32574` / #32574 | [React 19] Need Bring Back `_debugSource` or Provide an Equivalent for Better Developer Experience | fae15df4 | #35240 | 6 | 7 | 1499 | 2025-03-04T21:08:21.000Z → 2026-02-14T12:24:09.000Z |
| test | `facebook-react-issue-33423` / #33423 | Bug: profiler incorrectly reports 'The parent component rendered' | 24f215ce | #35723 | 8 | 2 | 1462 | 2025-05-27T16:20:59.000Z → 2026-03-11T20:39:35.000Z |
| test | `facebook-react-issue-34268` / #34268 | [DevTools Bug]: devtools does not works on null origin(sandbox) | 583e2003 | #35208 | 11 | 11 | 1466 | 2025-08-15T14:01:47.000Z → 2026-02-12T16:49:51.000Z |
| dev | `facebook-react-issue-34791` / #34791 | Bug: “Display density” field appears twice in React Developer Tools settings | 91e5c3da | #34792 | 7 | 1 | 253 | 2025-10-02T09:50:24.000Z → 2025-11-08T17:38:25.000Z |
| test | `facebook-react-issue-35245` / #35245 | [DevTools Bug]: Internal state change in cousin component causing a "re-render" in another cousin component wrapped inside parent divs. | 24f215ce | #35723 | 11 | 2 | 1538 | 2025-11-21T16:15:34.000Z → 2026-03-11T23:19:54.000Z |
| dev | `facebook-react-issue-35923` / #35923 | [DevTools Bug] Cannot read properties of null (reading 'ownerDocument') | 46103596 | #35929 | 11 | 2 | 1460 | 2026-02-20T11:23:36.000Z → 2026-04-04T15:52:25.000Z |
| test | `facebook-react-issue-35954` / #35954 | [DevTools Bug]: confused on prerender pages and resulting in high-cpu usage loop | 23b2d851 | #35958 | 11 | 2 | 1474 | 2026-02-24T17:47:53.000Z → 2026-04-03T12:39:19.000Z |
| dev | `facebook-react-issue-36525` / #36525 | [DevTools Bug]: Profiler's "What changed" context becomes unusable when inspecting commits with long render histories | 91cd8128 | #36244 | 11 | 3 | 842 | 2026-05-15T01:24:12.000Z → 2026-08-06T13:18:53.000Z |
| dev | `facebook-react-issue-37003` / #37003 | [DevTools Bug]: confused on prerender pages and resulting in high-cpu usage loop | 7023f501 | #37009 | 11 | 1 | 1481 | 2026-07-06T13:31:27.000Z → 2026-08-13T09:04:47.000Z |

### React DOM（99）

| Split | Case / Issue | Issue title | Gold | Closing PR | Score | Files | Query chars | Lifecycle window |
|---|---|---|---|---|---:|---:|---:|---|
| dev | `facebook-react-issue-1471` / #1471 | onChange handler for radio buttons does not fire according to spec. | 045f1a79 | #5746 | 7 | 7 | 574 | 2014-04-24T12:18:43.000Z → 2016-05-15T21:37:26.000Z |
| dev | `facebook-react-issue-2185` / #2185 | EN-Dash Causes onChange to fire in IE11 on Render | 045f1a79 | #5746 | 4 | 7 | 227 | 2014-09-05T16:15:25.000Z → 2016-05-15T21:37:26.000Z |
| test | `facebook-react-issue-4618` / #4618 | Can't update defaultChecked/defaultValue. | 4338c8db | #6406 | 6 | 8 | 387 | 2015-08-05T16:42:46.000Z → 2016-06-24T01:28:01.000Z |
| dev | `facebook-react-issue-5473` / #5473 | ReactDOMServer.renderToString: presence of onClick handler causes errors on async update | dbdddf1c | #7127 | 6 | 8 | 751 | 2015-11-08T17:18:30.000Z → 2016-08-03T14:47:01.000Z |
| dev | `facebook-react-issue-6348` / #6348 | Warn when using overlapping styles (e.g. border and borderBottom) | 8ae867e6 | #14181 | 7 | 4 | 1457 | 2016-03-19T18:25:22.000Z → 2018-12-09T23:21:48.000Z |
| dev | `facebook-react-issue-6441` / #6441 | Warning when changing the type and value of an input field | 08a08958 | #7333 | 11 | 2 | 769 | 2016-03-31T22:08:21.000Z → 2016-08-22T01:38:29.000Z |
| test | `facebook-react-issue-6626` / #6626 | SSR should not warn about onscroll | eb116482 | #6678 | 3 | 2 | 205 | 2016-04-19T23:02:31.000Z → 2016-06-01T21:26:35.000Z |
| test | `facebook-react-issue-6731` / #6731 | Textarea placeholder isn't shown in IE 11 being rendered using React | e644faa6 | #8020 | 3 | 2 | 365 | 2016-05-02T10:03:41.000Z → 2016-12-05T16:47:55.000Z |
| dev | `facebook-react-issue-7144` / #7144 | Type of input field is not correctly updated in Safari | 08a08958 | #7333 | 8 | 2 | 1300 | 2016-06-22T04:47:39.000Z → 2016-08-22T01:38:29.000Z |
| dev | `facebook-react-issue-7630` / #7630 | Radio buttons are not correctly checked when using multiple lists of radio buttons | 70abda5b | #11227 | 11 | 5 | 944 | 2016-08-25T14:18:26.000Z → 2017-12-19T15:44:35.000Z |
| dev | `facebook-react-issue-8529` / #8529 | Feature Request: Support auxclick event (onAuxClick) | ac723885 | #11571 | 1 | 3 | 254 | 2016-12-01T07:12:28.000Z → 2018-09-02T18:57:34.000Z |
| dev | `facebook-react-issue-9230` / #9230 | Boolean attributes on Web Components | 82c64e1a | #24541 | 4 | 8 | 716 | 2017-03-14T15:09:51.000Z → 2022-06-19T17:10:44.000Z |
| dev | `facebook-react-issue-9988` / #9988 | Regression: onChange doesn't fire with defaultChecked and radio inputs | 999df3e7 | #10156 | 8 | 9 | 687 | 2017-06-09T12:00:38.000Z → 2017-08-12T20:02:32.000Z |
| dev | `facebook-react-issue-10013` / #10013 | dangerouslySetInnerHTML in IE11 for svg elements | 6ad6dcd1 | #11108 | 9 | 2 | 1450 | 2017-06-13T16:38:38.000Z → 2017-11-09T10:54:47.000Z |
| dev | `facebook-react-issue-10196` / #10196 | Uncontrolled radio fix is breaking master | 9043ad6b | #10207 | 8 | 3 | 263 | 2017-07-09T17:32:05.000Z → 2017-08-17T15:31:06.000Z |
| dev | `facebook-react-issue-10265` / #10265 | Invalid "unknown prop" warnings for SSR | 4c46b6c9 | #10272 | 6 | 2 | 566 | 2017-07-17T16:26:59.000Z → 2017-08-24T16:01:49.000Z |
| test | `facebook-react-issue-10739` / #10739 | Recent radio input onChange changes break expected behavior | e0e91310 | #11028 | 8 | 5 | 1455 | 2017-09-11T19:40:55.000Z → 2017-12-16T14:08:15.000Z |
| dev | `facebook-react-issue-10772` / #10772 | Unexpected SSR difference warning with SVG <filter> primitives | f42dfcdb | #11174 | 11 | 2 | 618 | 2017-09-14T16:05:03.000Z → 2017-11-09T18:34:38.000Z |
| test | `facebook-react-issue-10987` / #10987 | <svg tabIndex="2"> doesn't work | fbd6b9de | #11033 | 7 | 3 | 403 | 2017-09-23T10:24:07.000Z → 2017-11-01T17:52:26.000Z |
| dev | `facebook-react-issue-10993` / #10993 | React 16 fails to rehydrate noscripts | e5db5302 | #11157 | 11 | 2 | 1440 | 2017-09-23T18:25:41.000Z → 2017-11-09T18:35:44.000Z |
| test | `facebook-react-issue-11010` / #11010 | Reset of select ignores defaultValue | 5c6cb597 | #11057 | 11 | 2 | 1069 | 2017-09-24T14:57:47.000Z → 2017-11-09T15:54:59.000Z |
| dev | `facebook-react-issue-11017` / #11017 | Fiber cannot render to DocumentFragment/ShadowRoot | 8b4ec79d | #11037 | 11 | 6 | 1252 | 2017-09-24T23:33:20.000Z → 2017-11-01T19:50:15.000Z |
| dev | `facebook-react-issue-11103` / #11103 | SSR: ReactDOM client and server handling newlines differently causing mismatch warnings | 44c32fc2 | #11119 | 9 | 2 | 1483 | 2017-09-28T00:58:59.000Z → 2017-11-04T19:59:44.000Z |
| dev | `facebook-react-issue-11172` / #11172 | React 16 does not render text area placeholder initially in IE11 Win10 | 309fa6c8 | #11177 | 8 | 2 | 470 | 2017-10-03T13:34:55.000Z → 2017-11-09T16:50:00.000Z |
| dev | `facebook-react-issue-11265` / #11265 | No way to set SVG transform-origin attribute? | 28fcae06 | #26130 | 8 | 4 | 561 | 2017-10-11T11:05:04.000Z → 2023-03-11T12:47:52.000Z |
| dev | `facebook-react-issue-11423` / #11423 | Ignore <noscript> content on the client and don't warn about mismatches | 0b74e95d | #13537 | 6 | 3 | 898 | 2017-10-25T13:51:13.000Z → 2018-10-03T16:17:54.000Z |
| dev | `facebook-react-issue-11526` / #11526 | Transpilation in v16.1.0 freezes the react-dom/server interface | 901a091f | #11531 | 4 | 4 | 1235 | 2017-11-04T04:00:34.000Z → 2017-12-13T13:52:59.000Z |
| test | `facebook-react-issue-11656` / #11656 | Deprecate TestUtils.SimulateNative | e55855e7 | #13407 | 4 | 3 | 632 | 2017-11-18T02:56:16.000Z → 2020-05-02T22:48:04.000Z |
| dev | `facebook-react-issue-11726` / #11726 | client/server mismatch for text inside of an a/button causes the the a/button to focus on page load | 19bc2dd0 | #11737 | 11 | 2 | 1265 | 2017-11-23T19:53:33.000Z → 2018-01-05T15:23:37.000Z |
| test | `facebook-react-issue-11789` / #11789 | hydrating a component with `dangerouslySetInnerHTML` and `toString` causes a warning, and the component to not render | be4533af | #13353 | 11 | 4 | 1518 | 2017-11-30T00:21:56.000Z → 2018-09-08T17:05:06.000Z |
| dev | `facebook-react-issue-11807` / #11807 | False positive warning about style mismatch when hydrating server markup in IE11 | 2d4705e7 | #13534 | 9 | 2 | 1291 | 2017-12-01T02:20:24.000Z → 2018-10-04T13:26:52.000Z |
| dev | `facebook-react-issue-11911` / #11911 | React DOM crashes when <option> contains three interpolated value if one is a conditional. | 0182a746 | #13261 | 11 | 7 | 776 | 2017-12-15T12:10:29.000Z → 2018-08-31T15:16:35.000Z |
| dev | `facebook-react-issue-11918` / #11918 | Click events don't bubble from Portal content on mobile Safari | b3a4cfea | #11927 | 9 | 2 | 977 | 2017-12-17T17:20:21.000Z → 2018-09-17T01:10:20.000Z |
| test | `facebook-react-issue-12171` / #12171 | Remove use of Proxy for events in development | acbb4f93 | #13225 | 3 | 2 | 295 | 2018-01-31T08:17:56.000Z → 2018-08-16T23:14:14.000Z |
| dev | `facebook-react-issue-12251` / #12251 | Does react still require non-toplevel submit handler? | 725e499c | #13358 | 8 | 5 | 404 | 2018-02-13T05:09:50.000Z → 2018-09-09T19:10:36.000Z |
| dev | `facebook-react-issue-12506` / #12506 | Possible incorrect event.target on number inputs in IE9? | 4ac6f133 | #12976 | 11 | 1 | 868 | 2018-03-24T14:45:51.000Z → 2018-07-11T13:35:43.000Z |
| dev | `facebook-react-issue-12872` / #12872 | Submit/Reset inputs lose text when value=undefined. | 9832a1b6 | #12780 | 9 | 2 | 693 | 2018-05-14T01:28:08.000Z → 2018-09-15T14:19:05.000Z |
| dev | `facebook-react-issue-13222` / #13222 | Select multiple - does not scroll to selected item(items) | 2d0356a5 | #13270 | 6 | 2 | 263 | 2018-07-10T10:29:34.000Z → 2018-09-02T17:05:26.000Z |
| dev | `facebook-react-issue-13648` / #13648 | 16.5 with better support of iframe has some side effects | 9c961c0a | #13650 | 11 | 1 | 1142 | 2018-09-07T08:15:25.000Z → 2018-10-14T15:44:15.000Z |
| dev | `facebook-react-issue-13777` / #13777 | The gray overlay when tap the react root container | f47a958e | #13778 | 11 | 3 | 871 | 2018-09-27T22:20:19.000Z → 2018-11-08T08:27:07.000Z |
| dev | `facebook-react-issue-14764` / #14764 | 16.8 regression: react-dom/test-utils no longer require()-able in pure node | 1107b967 | #14768 | 6 | 2 | 1474 | 2019-01-30T10:29:55.000Z → 2019-03-08T16:25:27.000Z |
| dev | `facebook-react-issue-15219` / #15219 | Combination of componentDidCatch and hooks throws "Should have a queue. This is likely a bug in React." | b0935286 | #20002 | 11 | 1 | 1490 | 2019-03-20T00:53:53.000Z → 2020-11-15T15:07:28.000Z |
| dev | `facebook-react-issue-15301` / #15301 | renderWithHooks may initialize workInProgressHook at the beginning | b0935286 | #20002 | 11 | 1 | 1256 | 2019-03-27T02:47:52.000Z → 2020-11-15T15:07:28.000Z |
| dev | `facebook-react-issue-15418` / #15418 | Field type="email" with multiple attribute cursor jumps to start | 9b88b78b | #18379 | 11 | 7 | 799 | 2019-04-08T08:32:08.000Z → 2026-08-06T04:56:07.000Z |
| test | `facebook-react-issue-15566` / #15566 | Batched updates break interaction tracing for mounts | 6da04b5d | #15567 | 6 | 4 | 1386 | 2019-04-27T21:06:37.000Z → 2019-06-05T19:59:49.000Z |
| test | `facebook-react-issue-16376` / #16376 | Add Priorities for All Event Types | 148f8e49 | #21077 | 5 | 1 | 522 | 2019-08-06T05:27:07.000Z → 2021-04-23T19:57:17.000Z |
| dev | `facebook-react-issue-16402` / #16402 | textarea with `required` attribute renders in invalid state in FF | a5df18a9 | #16578 | 6 | 3 | 449 | 2019-08-08T14:38:52.000Z → 2019-10-18T21:38:03.000Z |
| test | `facebook-react-issue-17069` / #17069 | The warning for uncontrolled -> controlled inputs is confusing | 03de849a | #17070 | 6 | 4 | 634 | 2019-10-04T20:10:26.000Z → 2020-05-07T22:19:56.000Z |
| test | `facebook-react-issue-17170` / #17170 | dangerouslySetInnerHTML, children, and a bogus hydration warning | ffb6c6c0 | #18676 | 11 | 2 | 1466 | 2019-10-16T11:13:04.000Z → 2020-05-20T17:46:56.000Z |
| dev | `facebook-react-issue-19211` / #19211 | Bug: React hook state not cleared when rendering using ReactDOMServer if component errors | b85b4763 | #19212 | 8 | 3 | 1490 | 2020-06-22T23:26:29.000Z → 2020-08-07T02:10:24.000Z |
| dev | `facebook-react-issue-19558` / #19558 | Bug: In react@next ShadowRoot as rootElement in ReactDOM.render crashes | 12876701 | #15894 | 11 | 1 | 701 | 2020-07-31T21:30:44.000Z → 2020-09-16T14:47:50.000Z |
| dev | `facebook-react-issue-19560` / #19560 | Bug: event.type no longer matches the listener name for onFocus and onBlur | 7f696bd9 | #19561 | 11 | 13 | 562 | 2020-07-31T22:30:51.000Z → 2020-09-09T11:54:11.000Z |
| dev | `facebook-react-issue-19562` / #19562 | Bug: mouseEnter fires twice in react@next | 94c0244b | #19571 | 11 | 2 | 517 | 2020-08-01T10:25:23.000Z → 2020-09-09T14:08:23.000Z |
| dev | `facebook-react-issue-19608` / #19608 | Bug: (17.0.0-rc.0) Event propagation through portals is inconsistent | 848bb242 | #19659 | 11 | 25 | 880 | 2020-08-06T18:46:02.000Z → 2020-09-23T15:50:20.000Z |
| dev | `facebook-react-issue-20492` / #20492 | Bug: BigInt does not get toString()'d when rendered | 2f240c91 | #24580 | 8 | 30 | 462 | 2020-12-14T11:06:39.000Z → 2024-03-27T18:18:51.000Z |
| dev | `facebook-react-issue-21098` / #21098 | Bug: aspectRatio not being applied via style | a7c57268 | #21100 | 8 | 1 | 623 | 2021-03-18T15:03:36.000Z → 2021-04-24T17:01:36.000Z |
| dev | `facebook-react-issue-22888` / #22888 | Bug: `onChange` event handlers don't work on custom elements | 05a55a4b | #22938 | 8 | 2 | 522 | 2021-12-02T00:12:00.000Z → 2022-01-09T21:50:50.000Z |
| dev | `facebook-react-issue-23041` / #23041 | Bug: custom element properties can't accept functions | a87adefe | #23042 | 8 | 2 | 516 | 2021-12-21T17:23:40.000Z → 2022-02-11T20:12:07.000Z |
| dev | `facebook-react-issue-23063` / #23063 | React 18: bootstrapScriptContent escapes HTML so quotes can’t be used | d40dc73c | #24385 | 4 | 2 | 582 | 2021-12-27T20:36:40.000Z → 2022-05-16T17:47:46.000Z |
| test | `facebook-react-issue-23089` / #23089 | React 18: Context providers are reset to initial value in SSR during rendering | 529dc3ce | #23171 | 7 | 2 | 1407 | 2022-01-03T17:54:13.000Z → 2022-02-23T17:52:51.000Z |
| dev | `facebook-react-issue-24032` / #24032 | renderToReadableStream Passes Reusable Chunks | e09518e5 | #24034 | 5 | 2 | 431 | 2022-02-25T20:49:02.000Z → 2022-04-06T18:34:11.000Z |
| dev | `facebook-react-issue-24270` / #24270 | Bug: `suppressHydrationWarning` is not taken into account in production builds in React 18 | fc47cb1b | #24271 | 11 | 3 | 1466 | 2022-03-28T00:59:24.000Z → 2022-05-04T15:23:59.000Z |
| dev | `facebook-react-issue-24883` / #24883 | Bug: React 18 renderToPipeableStream missing support for nonce for bootstrapScripts and bootstrapModules | 9545e481 | #26738 | 8 | 5 | 1507 | 2022-07-02T21:01:51.000Z → 2023-05-31T16:19:04.000Z |
| dev | `facebook-react-issue-24985` / #24985 | Bug: `renderToPipeableStream()` emit mysterious mojibake whitespace chars in the result | 96cdeaf8 | #26228 | 8 | 2 | 1490 | 2022-07-18T13:02:52.000Z → 2023-03-26T19:33:57.000Z |
| dev | `facebook-react-issue-25682` / #25682 | Bug: `<img fetchPriority>` attribute is not supported | de7d1c90 | #25927 | 8 | 3 | 1036 | 2022-11-08T00:44:09.000Z → 2023-01-22T19:31:28.000Z |
| dev | `facebook-react-issue-25989` / #25989 | Feat(renderToPipeableStream): Allow passing crossorigin attribute on bootstrapScripts | 90229eb9 | #26844 | 6 | 2 | 496 | 2023-01-05T02:24:01.000Z → 2023-07-13T16:12:11.000Z |
| dev | `facebook-react-issue-26065` / #26065 | Bug: onTransitionStart | dfd3d5af | #27345 | 8 | 6 | 544 | 2023-01-20T17:12:59.000Z → 2024-05-08T21:23:05.000Z |
| dev | `facebook-react-issue-26112` / #26112 | Bug: transform-origin is not recognized as a valid attribute despite being in SVG specs | 28fcae06 | #26130 | 8 | 4 | 768 | 2023-01-30T05:42:35.000Z → 2023-03-11T12:47:52.000Z |
| dev | `facebook-react-issue-26173` / #26173 | Bug: Css scale style Property can be added as a unitlessNumber | fbf3bc31 | #25601 | 6 | 1 | 733 | 2023-02-09T06:48:51.000Z → 2023-03-18T10:12:35.000Z |
| dev | `facebook-react-issue-26876` / #26876 | Bug: Radio button onChange not called in current React Canary | 3c27178a, 4f4c52a3 | #27394, #27443 | 11 | 3 | 742 | 2023-05-24T15:17:41.000Z → 2023-10-21T04:57:11.000Z |
| test | `facebook-react-issue-27177` / #27177 | Bug: [18.3.0-canary] renderToString hoists some tags to top(working in 18.2) | 86198b92 | #27269 | 9 | 3 | 1060 | 2023-07-26T02:26:00.000Z → 2023-09-21T17:54:34.000Z |
| dev | `facebook-react-issue-27200` / #27200 | Bug: `ReactDOM.preload()` | ea17cc18 | #27201 | 8 | 1 | 458 | 2023-07-31T19:21:39.000Z → 2023-09-06T22:22:50.000Z |
| dev | `facebook-react-issue-27233` / #27233 | Bug: support `fetchPriority` in camel-case on DOM nodes. | de7d1c90 | #25927 | 8 | 3 | 1452 | 2023-08-08T12:11:09.000Z → 2024-05-03T17:25:08.000Z |
| dev | `facebook-react-issue-27286` / #27286 | Bug: Hydration fails in Next.js with server actions actions custom tags | bb778528 | #27511 | 8 | 2 | 1175 | 2023-08-19T13:58:05.000Z → 2023-11-11T22:02:28.000Z |
| dev | `facebook-react-issue-27391` / #27391 | Bug: missing button data in form when submitted via `formAction` | 29d3c83f | #28056 | 11 | 2 | 1460 | 2023-09-11T20:36:14.000Z → 2024-06-01T11:06:29.000Z |
| dev | `facebook-react-issue-27479` / #27479 | Bug: Popover API not supported | 6f903651 | #27981 | 8 | 16 | 853 | 2023-09-30T19:52:17.000Z → 2024-06-19T20:01:41.000Z |
| dev | `facebook-react-issue-27540` / #27540 | Bug: ReadableStream can be written to after close | 601e5c38 | #27541 | 6 | 3 | 1021 | 2023-10-11T16:01:21.000Z → 2023-11-17T17:05:20.000Z |
| dev | `facebook-react-issue-27585` / #27585 | Bug: hoisted stylesheets should not reorder when re-rendered in a transition | a9985529 | #27586 | 6 | 2 | 676 | 2023-10-18T18:10:51.000Z → 2023-11-24T18:51:03.000Z |
| dev | `facebook-react-issue-27657` / #27657 | Bug: Select when passed a value as Prop errors with a suggestion to pass readOnly | 5dd35968 | #27740 | 6 | 2 | 793 | 2023-10-30T04:04:20.000Z → 2023-12-31T15:55:57.000Z |
| dev | `facebook-react-issue-27910` / #27910 | Bug: Random preloads added for images | dc6a7e01 | #28815 | 6 | 2 | 740 | 2024-01-02T16:32:06.000Z → 2024-05-10T19:15:05.000Z |
| dev | `facebook-react-issue-28203` / #28203 | Bug: Removal of custom element property sets it to `null` rather than `undefined` | 48ec17b8 | #28716 | 8 | 2 | 981 | 2024-01-25T22:57:26.000Z → 2024-05-02T15:48:28.000Z |
| test | `facebook-react-issue-29018` / #29018 | Bug: Incorrect form data when using an image submit button | 65eec428 | #29028 | 11 | 5 | 1460 | 2024-05-01T00:40:11.000Z → 2026-01-17T10:34:17.000Z |
| test | `facebook-react-issue-29862` / #29862 | [React 19] Controlled number input does not update defaultValue when value prop has changed | c0c39a6b | #36980 | 9 | 3 | 407 | 2024-06-04T19:15:35.000Z → 2026-08-09T02:58:36.000Z |
| dev | `facebook-react-issue-30864` / #30864 | Bug: Focus restore after elements are reordered does not work in child windows | d9c4920e | #30951 | 8 | 3 | 1293 | 2024-08-27T15:25:58.000Z → 2024-10-13T20:29:41.000Z |
| dev | `facebook-react-issue-30994` / #30994 | [React 19] [bug] SVG with dangerouslySetInnerHTML content does not trigger first click | b8f50c93 | #36949 | 9 | 2 | 1459 | 2024-09-11T13:52:05.000Z → 2026-08-06T16:09:12.000Z |
| test | `facebook-react-issue-32437` / #32437 | Bug: responsive images not supported in link preload headers | 9b042f9d | #32445 | 4 | 2 | 440 | 2025-02-13T20:03:36.000Z → 2025-03-23T17:48:33.000Z |
| dev | `facebook-react-issue-32449` / #32449 | `nonce` is dropped from style tags that use `precedence` | 14094f80 | #32461 | 4 | 11 | 1282 | 2025-02-14T20:54:15.000Z → 2025-06-28T15:17:11.000Z |
| test | `facebook-react-issue-33033` / #33033 | Bug: form submit event does not expose event.submitter | 7b023d70 | #35590 | 8 | 4 | 835 | 2025-04-19T13:39:57.000Z → 2026-03-04T20:17:32.000Z |
| dev | `facebook-react-issue-33612` / #33612 | Bug: renderToPipeableStream is missing in Bun exports | b4455a6e | #34193 | 8 | 7 | 1443 | 2025-06-15T12:32:24.000Z → 2025-11-26T22:06:46.000Z |
| dev | `facebook-react-issue-33630` / #33630 | Bug: onReset is not called during automatic form reset | dcab44d7 | #35176 | 6 | 4 | 1453 | 2025-06-17T17:52:56.000Z → 2026-03-04T20:17:15.000Z |
| dev | `facebook-react-issue-33937` / #33937 | Bug: `React.use` inside `React.lazy`-ed component returns other `React.use` value on SSR | cc015840 | #33941 | 11 | 2 | 1489 | 2025-07-11T00:42:48.000Z → 2025-08-27T08:36:09.000Z |
| dev | `facebook-react-issue-34098` / #34098 | Bug: `Transition was aborted because of invalid state` when browser tab not active | a34c5dff | #34450 | 8 | 1 | 1307 | 2025-07-28T06:59:51.000Z → 2025-10-10T13:07:12.000Z |
| test | `facebook-react-issue-34944` / #34944 | Bug: Form submitter is missing, if form includes input with name 'id' | 65eec428 | #29028 | 8 | 5 | 1462 | 2025-10-15T12:37:38.000Z → 2026-01-17T10:34:17.000Z |
| test | `facebook-react-issue-35920` / #35920 | Bug: React does not recognize the `maskType` prop on a DOM element. | 843d69f0 | #35921 | 8 | 2 | 579 | 2026-02-19T22:31:47.000Z → 2026-03-29T12:41:23.000Z |
| dev | `facebook-react-issue-36440` / #36440 | Bug: ReactDOM.preloadModule crashes with repeated custom as value | 247fbb45 | #36564 | 8 | 2 | 1126 | 2026-05-02T18:34:48.000Z → 2026-07-22T16:47:41.000Z |
| test | `facebook-react-issue-36563` / #36563 | Bug: Fizz image preload headers drop referrerPolicy for rendered <img> | a7cce7b3 | #36803 | 8 | 2 | 1124 | 2026-05-21T10:45:23.000Z → 2026-07-17T12:57:16.000Z |
| dev | `facebook-react-issue-36834` / #36834 | Bug: `fetchPriority` is not available in `ReactDOM.preloadModule()` | 39c2c1d4 | #36835 | 6 | 4 | 1413 | 2026-06-14T07:39:49.000Z → 2026-07-24T17:41:48.000Z |
| dev | `facebook-react-issue-36890` / #36890 | Bug: onAllReady called after onShellError | a1a6bc89 | #36903 | 11 | 2 | 818 | 2026-06-19T18:53:23.000Z → 2026-07-31T10:07:33.000Z |
| dev | `facebook-react-issue-37124` / #37124 | Bug: Fragment ref blur() does not blur nested focused elements | 1724e9ce | #37125 | 8 | 2 | 1036 | 2026-07-18T19:57:01.000Z → 2026-08-28T16:21:39.000Z |

### React Hooks ESLint（31）

| Split | Case / Issue | Issue title | Gold | Closing PR | Score | Files | Query chars | Lifecycle window |
|---|---|---|---|---|---:|---:|---:|---|
| dev | `facebook-react-issue-15510` / #15510 | [ESLint] Assignment like foo.bar.baz = X should warn about foo.bar instead | 2ff27ec1 | #16784 | 2 | 2 | 456 | 2019-04-19T12:27:09.000Z → 2020-05-04T13:26:40.000Z |
| dev | `facebook-react-issue-15971` / #15971 | [eslint-plugin-react-hooks] Compatibility with ESLint 6.0.0 | 7439b48c | #15974 | 8 | 3 | 827 | 2019-06-17T09:54:48.000Z → 2019-07-24T21:30:13.000Z |
| dev | `facebook-react-issue-16313` / #16313 | [ESLint]react-hooks/exhaustive-deps rule autofix modifies code function, violating eslint best practices | 93a229ba | #17385 | 6 | 2 | 1506 | 2019-07-31T17:37:42.000Z → 2020-03-18T20:24:28.000Z |
| test | `facebook-react-issue-16573` / #16573 | [react-hooks/exhaustive-deps] missed warning when passing a function | da54641a | #18435 | 9 | 2 | 933 | 2019-08-19T19:19:58.000Z → 2020-04-30T01:09:33.000Z |
| dev | `facebook-react-issue-17220` / #17220 | [eslint-plugin-react-hooks] Apply the rules of hooks to a forwardRef-wrapped component | a807c307 | #17255 | 6 | 2 | 809 | 2019-10-23T11:56:28.000Z → 2019-12-17T13:39:09.000Z |
| dev | `facebook-react-issue-18494` / #18494 | Bug: eslint-plugin-react-hooks@3.0.0 no change logs / release page | 4e93b936 | #18801 | 6 | 1 | 610 | 2020-03-28T23:10:54.000Z → 2020-05-04T23:46:51.000Z |
| dev | `facebook-react-issue-18828` / #18828 | Bug [ESLint Hooks Plugin]: When using a `typeof` type guard it requires the value as a dependency | 84479046 | #19316 | 8 | 2 | 667 | 2020-04-28T13:33:32.000Z → 2020-08-12T16:57:01.000Z |
| dev | `facebook-react-issue-19243` / #19243 | Bug: Cannot read property 'references' of undefined in eslint-plugin-react-hooks v4.0.5 | 0f84b0f0 | #19260 | 11 | 2 | 1464 | 2020-06-25T16:02:21.000Z → 2020-08-05T19:52:15.000Z |
| test | `facebook-react-issue-19312` / #19312 | Bug: Exhaustive deps lint rule mistakingly flags an assignment | 47915fd6 | #19313 | 8 | 2 | 339 | 2020-07-03T17:41:51.000Z → 2020-08-09T18:02:09.000Z |
| dev | `facebook-react-issue-19661` / #19661 | Bug: eslint-plugin-react-hooks optional chaining in deps | 1396e4a8 | #19680 | 8 | 6 | 267 | 2020-08-13T15:52:59.000Z → 2020-09-28T20:03:24.000Z |
| dev | `facebook-react-issue-19742` / #19742 | Bug: Types incorrectly identified as missing dependencies for `eslint-plugin-react-hooks@4.1.0` with `@typescript-eslint/parser@4.0.1` | cd75f93c | #19751 | 8 | 1 | 1113 | 2020-08-25T21:07:30.000Z → 2020-10-10T10:30:18.000Z |
| test | `facebook-react-issue-19810` / #19810 | Bug: eslint-plugin-react-hooks "Cannot read property parent of null" | 0f70d4dd | #19815 | 11 | 2 | 538 | 2020-09-04T04:22:06.000Z → 2020-10-11T12:13:44.000Z |
| test | `facebook-react-issue-20162` / #20162 | Bug: react-hooks/exhaustive-deps false positive when deps is defined with typescript const typing | a1433ca0 | #28189 | 11 | 2 | 1103 | 2020-10-29T12:17:58.000Z → 2024-03-02T19:30:19.000Z |
| test | `facebook-react-issue-20204` / #20204 | Bug: eslint-plugin-react-hooks: Cannot read property 'type' of undefined at analyzePropertyChain | eb58c390 | #20247 | 11 | 2 | 1488 | 2020-11-02T18:15:07.000Z → 2021-04-23T16:45:28.000Z |
| dev | `facebook-react-issue-20343` / #20343 | [eslint-plugin-react-hooks] Bug: ESLint crashes if there's a `useEffect` / `useLayoutEffect` invocation without any arguments. | e8eff119 | #20385 | 11 | 2 | 646 | 2020-11-21T15:49:52.000Z → 2021-02-10T20:18:46.000Z |
| dev | `facebook-react-issue-20750` / #20750 | Bug: react-hooks/exhaustive-deps false positive when function is casted with TypeScript | 2efa3833 | #28202 | 11 | 2 | 865 | 2021-01-29T23:05:20.000Z → 2024-03-02T20:08:23.000Z |
| test | `facebook-react-issue-22246` / #22246 | [eslint-plugin-react-hooks] Support ESLint 8.x | 0c0d1dda | #22248 | 2 | 7 | 447 | 2021-08-28T17:10:00.000Z → 2021-10-06T19:17:52.000Z |
| dev | `facebook-react-issue-24233` / #24233 | eslint-plugin-react-hooks CHANGELOG missing 4.4.0 release | aa05e731 | #24234 | 4 | 1 | 463 | 2022-03-24T14:05:12.000Z → 2022-04-30T14:43:08.000Z |
| dev | `facebook-react-issue-24268` / #24268 | Bug: [eslint-plugin-exhaustive-deps] can't find unstable value. | 069d23bb | #24343 | 11 | 2 | 652 | 2022-03-27T15:14:27.000Z → 2022-05-11T20:43:16.000Z |
| dev | `facebook-react-issue-24279` / #24279 | Bug: [eslint-plugin-exhaustive-deps] hook wrongly marked as conditional (at exact number of conditionals in FC) | 1f7a901d | #24287 | 11 | 4 | 1280 | 2022-03-29T13:03:48.000Z → 2022-05-07T23:22:47.000Z |
| test | `facebook-react-issue-24777` / #24777 | Changes since v4.5.0 of eslint-plugin-react-hooks are not listed in CHANGELOG | 59bc52a1 | #24853 | 8 | 1 | 725 | 2022-06-16T03:01:19.000Z → 2022-08-20T19:46:11.000Z |
| test | `facebook-react-issue-25844` / #25844 | Bug: react-hooks/exhaustive-deps does not accept readonly arrays as deps | a1433ca0 | #28189 | 8 | 2 | 1467 | 2022-11-30T14:53:00.000Z → 2024-03-02T19:30:19.000Z |
| dev | `facebook-react-issue-28313` / #28313 | eslint-plugin-react-hooks & "Flat Config" (ESLint 9) | 61e713c1 | #30774 | 4 | 2 | 1449 | 2024-02-06T14:14:11.000Z → 2025-02-15T23:39:12.000Z |
| dev | `facebook-react-issue-28713` / #28713 | Bug: `react-hooks/rules-of-hooks` does not support `do/while` loops | 9daabc0b | #28714 | 8 | 2 | 688 | 2024-03-26T13:33:13.000Z → 2024-11-21T20:07:11.000Z |
| dev | `facebook-react-issue-30119` / #30119 | [eslint-plugin-react-hooks] Missing type declarations | 5adf4020 | #32240 | 6 | 14 | 1451 | 2024-06-20T15:54:21.000Z → 2025-03-18T19:10:55.000Z |
| test | `facebook-react-issue-31687` / #31687 | Bug: [eslint-plugin-react-hooks] incorrectly reports an error when hook is called outside of a loop. | 7c4a7c9d | #31720 | 8 | 2 | 1263 | 2024-11-29T05:23:00.000Z → 2025-01-09T21:46:34.000Z |
| dev | `facebook-react-issue-31717` / #31717 | [eslint-plugin-react-hooks] v5.1.0 was released without any changes in github | 562f17ef | #32536 | 4 | 1 | 479 | 2024-12-03T07:50:10.000Z → 2025-04-05T18:58:40.000Z |
| dev | `facebook-react-issue-32494` / #32494 | Bug [`eslint-plugin-react-hooks`]: `Config (unnamed): Key "plugins": This appears to be in eslintrc format (array of strings) rather than flat config format (object).` | 443b7ff2 | #32498 | 6 | 1 | 1564 | 2025-02-21T20:09:48.000Z → 2025-04-01T12:38:18.000Z |
| dev | `facebook-react-issue-34679` / #34679 | Bug: eslint-plugin-react-hooks v.6.1.0 recommended config uses array instead of object | 26b177bc | #34700 | 8 | 10 | 1482 | 2025-09-25T04:50:27.000Z → 2025-11-01T22:52:53.000Z |
| test | `facebook-react-issue-34745` / #34745 | Bug: eslint-plugin-react-hooks@6.1.1 does not export config types correctly | c7862584 | #34746 | 8 | 6 | 815 | 2025-09-29T01:07:38.000Z → 2025-11-05T04:53:22.000Z |
| dev | `facebook-react-issue-34793` / #34793 | Bug: `react-hooks/rules-of-hooks` does not error when `useEffectEvent` is passed down when inlined in a prop | 2381ecc2 | #34820 | 8 | 2 | 707 | 2025-10-02T12:46:10.000Z → 2025-11-15T18:18:03.000Z |

### React Native Renderer（1）

| Split | Case / Issue | Issue title | Gold | Closing PR | Score | Files | Query chars | Lifecycle window |
|---|---|---|---|---|---:|---:|---:|---|
| dev | `facebook-react-issue-17885` / #17885 | Enable a lint rule not to define after return and fix existing callsites | 53e622ca | #19733 | 4 | 6 | 382 | 2020-01-14T19:07:16.000Z → 2020-10-01T12:55:11.000Z |

### React Server Components / Flight（7）

| Split | Case / Issue | Issue title | Gold | Closing PR | Score | Files | Query chars | Lifecycle window |
|---|---|---|---|---|---:|---:|---:|---|
| dev | `facebook-react-issue-22772` / #22772 | React 18: "The stream is not in a state that permits close" in `renderToReadableStream` | 2c693b2d | #23342 | 6 | 3 | 1481 | 2021-11-08T22:45:59.000Z → 2022-03-25T05:33:41.000Z |
| dev | `facebook-react-issue-28595` / #28595 | Bug: [Flight] Async server components in `ai/rsc` not rendered correctly | 93f91795 | #28669 | 8 | 3 | 1147 | 2024-03-13T15:45:57.000Z → 2024-05-01T16:37:28.000Z |
| dev | `facebook-react-issue-33155` / #33155 | Bug: ReactFlightWebpackPlugin does not write files with .mjs extension to the manifest | 2bcf06b6 | #33028 | 8 | 1 | 1488 | 2025-05-01T19:05:10.000Z → 2025-06-12T01:16:17.000Z |
| test | `facebook-react-issue-33534` / #33534 | Bug: Server functions error when returning a client reference | 1d163962, c499adf8 | #33761, #34084 | 8 | 3 | 1084 | 2025-06-07T21:03:18.000Z → 2025-09-01T22:11:55.000Z |
| dev | `facebook-react-issue-34751` / #34751 | Bug: RSC `renderToReadableStream/createFromReadableStream` gets stuck for certain objects on development | 0d721b60 | #34988 | 6 | 2 | 1440 | 2025-09-29T08:04:34.000Z → 2025-11-26T21:06:30.000Z |
| dev | `facebook-react-issue-35340` / #35340 | Bug: Server Components error when directly rendering a Context | 3e00319b | #35675 | 6 | 9 | 868 | 2025-12-02T21:46:08.000Z → 2026-03-05T15:23:04.000Z |
| test | `facebook-react-issue-35368` / #35368 | Improve cyclic thenable detection in ReactFlightReplyServer | b731fe28 | #35369 | 8 | 1 | 1372 | 2025-12-09T06:42:13.000Z → 2026-01-16T11:22:27.000Z |

### Scheduler（6）

| Split | Case / Issue | Issue title | Gold | Closing PR | Score | Files | Query chars | Lifecycle window |
|---|---|---|---|---|---:|---:|---:|---|
| dev | `facebook-react-issue-13694` / #13694 | Schedule, SSR, window.addEventListener is not a function | 7601c376 | #13731 | 6 | 1 | 1148 | 2018-09-12T19:32:11.000Z → 2018-10-26T12:38:56.000Z |
| test | `facebook-react-issue-14352` / #14352 | useEffect is broken for React Native with JSC | 52bea95c | #14358 | 9 | 11 | 1136 | 2018-11-21T21:31:23.000Z → 2018-12-31T21:03:20.000Z |
| test | `facebook-react-issue-14904` / #14904 | controlled input cursor jumps to end (again) | 7de4d239 | #14914 | 8 | 5 | 850 | 2019-02-13T21:56:52.000Z → 2019-03-23T17:20:29.000Z |
| dev | `facebook-react-issue-16109` / #16109 | Consider using reactjs.org instead of fb.me in react's error/warning messages | 36df9185 | #19830 | 4 | 1 | 402 | 2019-07-04T12:18:34.000Z → 2020-09-16T12:26:38.000Z |
| dev | `facebook-react-issue-20756` / #20756 | Bug: using MessageChannel prevents node.js process from exiting | 09916479, d857f9e4 | #20834, #20906 | 8 | 5 | 742 | 2021-01-31T14:13:53.000Z → 2021-03-31T18:34:13.000Z |
| test | `facebook-react-issue-20829` / #20829 | Scheduler's use of SharedArrayBuffer will require cross-origin isolation | 8fa0ccca | #20831 | 8 | 1 | 1475 | 2021-02-10T03:34:47.000Z → 2021-03-19T21:43:26.000Z |

### Shared React Infrastructure（13）

| Split | Case / Issue | Issue title | Gold | Closing PR | Score | Files | Query chars | Lifecycle window |
|---|---|---|---|---|---:|---:|---:|---|
| dev | `facebook-react-issue-11519` / #11519 | Consider including directory name into the stack trace for some files | 54d86eb8 | #12059 | 3 | 2 | 293 | 2017-11-03T19:51:16.000Z → 2018-09-08T02:33:30.000Z |
| dev | `facebook-react-issue-11687` / #11687 | react-dom: Ability to access window.event in development | 69e2a0d7 | #11696 | 11 | 2 | 1450 | 2017-11-21T20:33:31.000Z → 2018-09-13T20:35:31.000Z |
| dev | `facebook-react-issue-12058` / #12058 | __source makes component stack less useful | 54d86eb8 | #12059 | 8 | 2 | 1445 | 2018-01-13T00:32:03.000Z → 2018-09-08T02:33:30.000Z |
| dev | `facebook-react-issue-16393` / #16393 | Shorthand CSS property collision should trigger a warning | 4f71f25a | #18002 | 4 | 8 | 1352 | 2019-08-07T20:45:35.000Z → 2020-03-11T11:42:12.000Z |
| dev | `facebook-react-issue-16585` / #16585 | useState's setState hangs when called in closed window | f918b0eb | #19220 | 11 | 1 | 981 | 2019-08-20T14:32:08.000Z → 2020-07-31T14:33:30.000Z |
| dev | `facebook-react-issue-16734` / #16734 | window.print() crashes if a 'print' event listener causes a rerender (Chrome, DEV-mode only) | f918b0eb | #19220 | 11 | 1 | 1488 | 2019-09-03T17:05:25.000Z → 2020-07-31T14:33:30.000Z |
| dev | `facebook-react-issue-17157` / #17157 | [DOM] Add support for the `inert` attribute | bbc571ae | #24730 | 11 | 14 | 549 | 2019-10-14T12:06:09.000Z → 2024-04-12T22:10:42.000Z |
| dev | `facebook-react-issue-17945` / #17945 | Passive effect destroy and create functions are interleaved | 86b4070d | #19021 | 9 | 15 | 1457 | 2020-01-24T18:49:40.000Z → 2020-06-27T15:32:38.000Z |
| test | `facebook-react-issue-19099` / #19099 | Bug: TypeError: "log" is read-only. | 5b986569 | #19123 | 8 | 1 | 291 | 2020-06-01T13:13:10.000Z → 2020-07-23T14:34:54.000Z |
| dev | `facebook-react-issue-19651` / #19651 | Touch/Wheel Event Passiveness in React 17 | dd651df0 | #19654 | 6 | 13 | 1321 | 2020-08-12T14:35:07.000Z → 2020-09-18T17:42:34.000Z |
| test | `facebook-react-issue-22441` / #22441 | Several tests fail on main with Node v16 | c16b005f | #22477 | 8 | 4 | 519 | 2021-09-20T18:16:22.000Z → 2021-11-10T22:40:43.000Z |
| dev | `facebook-react-issue-26670` / #26670 | Bug: `useInsertionEffect()` cleanup function does not fire if a component is wrapped in React.lazy | d3d4d3a4 | #30954 | 9 | 13 | 1180 | 2023-04-12T09:57:00.000Z → 2024-10-17T18:01:17.000Z |
| dev | `facebook-react-issue-35652` / #35652 | ReactPerformanceTrackProperties/addValueToProperties fails to handle cursors (fn + proxy) | da641178 | #35659 | 4 | 1 | 858 | 2026-01-21T15:35:53.000Z → 2026-02-28T17:32:20.000Z |

### Test Renderers（4）

| Split | Case / Issue | Issue title | Gold | Closing PR | Score | Files | Query chars | Lifecycle window |
|---|---|---|---|---|---:|---:|---:|---|
| dev | `facebook-react-issue-12106` / #12106 | react-test-renderer: toTree() does not yet know how to handle nodes with tag=10 | 8b83ea02 | #12154 | 11 | 2 | 555 | 2018-01-20T15:52:20.000Z → 2018-02-26T23:03:55.000Z |
| dev | `facebook-react-issue-12432` / #12432 | Remove DEV-only warnings from shallow renderer | 8c20615b | #12433 | 2 | 3 | 350 | 2018-03-15T18:08:16.000Z → 2018-04-21T18:32:38.000Z |
| dev | `facebook-react-issue-14607` / #14607 | Bug: in shallow renderer `this.state` in `shouldComponentUpdate` will be updated by `getDeriveStateFromProps` | 4f332885 | #14613 | 8 | 3 | 1510 | 2019-01-09T10:50:35.000Z → 2019-02-17T02:31:15.000Z |
| dev | `facebook-react-issue-17321` / #17321 | [Shallow Renderer] Plan forward | 293878e0 | #18144 | 4 | 4 | 733 | 2019-11-01T21:54:52.000Z → 2020-03-28T18:10:26.000Z |

## 6. 解释边界

- 75 条工程回归 case 与 461 条 RCA pilot 是两套不同用途的数据集，运行时通过 `--dataset` 明确选择，不会自动合并。
- 原始 RCA pilot 和 time-window RCA 各有 461 行，但它们是同一组 case；不能声称有 922 条独立 RCA case。
- 461 条已经具备 Issue → closing PR → corpus commit 的机器可验证链路，但仍是 model-prescreened、non-gold、release-gate-ineligible。
- 327/134 的 dev/test split 可用于诊断 held-out 排名表现，但不能将 test 指标表述为生产准确率或人工 gold 准确率。
- 完整问题正文保存在 RCA `cases.jsonl`；本目录使用 Issue title 保持可读性，Case ID 可精确回查原始行。

## 7. 重新生成

从 `src` 目录运行：

```powershell
npm run catalog:eval-cases
```

