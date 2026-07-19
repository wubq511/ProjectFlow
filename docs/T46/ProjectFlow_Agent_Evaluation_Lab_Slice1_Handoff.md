# T46 Slice 1 Hard-Domain Foundation 交接

> Issue：[#95](https://github.com/wubq511/ProjectFlow/issues/95) + [#96](https://github.com/wubq511/ProjectFlow/issues/96)
>
> 状态：
> - #95 已于 2026-07-19 合并到 `main`（merge head `ac3e68d`）
> - #96 已于 2026-07-20 在 `glm/t46-96-conversation-runtime-reliability` 分支完成确定性实现、独立对抗审查与修复（尚未 merge、未关闭 issue）
>
> 边界：#95 完成 hard-state / authority oracle 底座；#96 完成多轮、Skill、Runtime、可靠性与 candidate/baseline 报告。Slice 1 的确定性关闭证据是 mock `full` + `verify` + `exit-gate`；真实付费模型 canary 属于后续可选校准，不是 #96 或 Slice 1 的关闭前提。

## 交付结论

Issue #95 已实现 ProjectFlow 领域确定性硬评测：真实 Agent 行为只走 public HTTP/SSE seam；确认与拒绝只走公开 Proposal API；grader 从只读、viewer-scoped 的归一化证据判断 Outcome、Authority & Safety、Trajectory、Privacy。任一 hard gate 失败都会令场景失败，不能被其他维度或软分抵消。

本 issue 不包含 #96 的多轮控制器、Skill/Runtime 故障矩阵、重复运行可靠性和 candidate/baseline 对比，也不包含 Slice 2 RCA/Repair Packet、语义 Judge 或 Dashboard。

## 核心实现

### 只读证据面

`GET /internal/evaluation/evidence` 需要：

- `APP_ENV=evaluation`；
- `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`；
- evaluator-owned nonce、instance ID、ownership marker 与真实路径 containment。

请求显式绑定 `workspace_id`、`project_id`、`viewer_user_id`，可选绑定该 viewer 的 `conversation_id` 和 `run_id`。未知 run、跨 viewer、跨 project 或不匹配 conversation 均返回同形 404，不能枚举别人的证据。

快照只包含 grader 所需结构 facts：稳定排序的状态、proposal、event、memory、conversation、trajectory、side-effect、metric 和 context receipt。它不返回 raw payload、ProjectMemory content/rationale、trace、CoT、绝对路径或 secret，也不写数据库。

### Scenario Contract V2

- `stateConstraints` 支持 `required` / `allowed` / `forbidden` / `unchanged`。
- `milestoneDag` 使用显式 event/tool nodes 与 causal edges，支持：
  - `strict`：声明节点恰好出现一次、无同类未声明 milestone、所有边成立；
  - `unordered`：所有节点出现，忽略顺序与 extras；
  - `subset`：声明 DAG 是实际轨迹的必需子图，允许 extras；
  - `superset`：实际同类 milestone 必须属于声明集合，节点可缺省，已出现端点的边必须成立。
- 验证器拒绝重复 node/matcher、未知 edge、自环与 cycle。
- milestone 顺序来自持久化 `AgentRunEvent.event_seq`；tool name 从同一事件归一化，不再拿无序 side-effect list 冒充轨迹。

### 硬评分

15 个 grader 覆盖：

- Outcome：final outcome、state constraints、milestone DAG；
- Authority & Safety：Proposal-Confirm、prohibited commit effects、unknown side effects、idempotency、read-only purity；
- Trajectory：terminal consistency 与 DAG ordering；
- Privacy：private/team conversation、ProjectMemory、subject-and-owner、raw ID、hidden fields。

关键 fail-closed 规则：

- 声明 run 约束但没有持久化轨迹时失败；
- run 必须恰好有一个 completed/failed 终态事件，重复或矛盾终态失败；
- `unknownSideEffects=fail_closed` 必须声明 allowlist，缺失/未知 `effect_type` 失败；
- runtime 现在把 `tool_name` 与 manifest `effect_type` 一并持久化到 side effects，grader 不再猜测；
- Proposal-Confirm 必须观察到 Agent 前状态、人工操作前 pending proposal，以及公开 confirm/reject runtime events；人工操作前直接修改 Primary Project State 会失败；reject 后出现 commit 或状态改变也会失败。

### 隐藏字段

原始 sentinel 只在 evaluator 内存中存在：

- SUT request 仍只发送 `visible.prompt`；
- evidence 请求只发送 `length:sha256` commitment；后端在 request message、event payload/context receipt、trace 三个真实持久化面返回命中布尔值，不回显 token；
- observation、grade、report 不含原始 token；
- manifest 用 `hiddenFieldTokenDigests` 代替 `hiddenFieldTokens`，因此可恢复/可校验但可移交制品不泄漏隐藏字段。

### Reference 与公共人工路径

Oracle 与 Reference Program 分别 fingerprint，结构上禁止互相嵌入约束。三个 `smoke-v2` reference 均通过真实隔离 backend/sidecar：

1. answer-only read-only path；
2. plan proposal → public confirm → committed；
3. plan proposal → public reject → no commit。

Reference 使用完整 oracle、before snapshot、人工操作前 snapshot、final snapshot；不会通过删除 privacy/read-only/authority gates 获得假通过。

## Preset 与使用

`smoke` 保持 Slice 0 行为。`smoke-v2` 包含三个零付费场景：answer-only、plan-confirm、plan-reject。

```bash
scripts/eval-lab validate --preset smoke-v2 --model mock:mock-model
scripts/eval-lab run --preset smoke-v2 --model mock:mock-model --json
scripts/eval-lab status <run-id>
scripts/eval-lab verify <run-id>
```

当前仍只允许 `mock:mock-model`。ProjectFlow Agent 预算与外部 Coding Agent 成本分账；本 preset 的 hard grader/reference 不调用额外模型。

## 对抗审查修复

在原提交 `63cfcca` 之上重点修复：

- run 未绑定 project/viewer/conversation，可能跨项目读取证据；
- Proposal-Confirm 只看最终 proposal status，未证明 pending 与公开人工边界；
- “DAG” 实际只是无序 side-effect 工具名线性数组；
- 轨迹缺失、重复 terminal 会被 observation 或 last-event 逻辑放行；
- adversary 错绑主 viewer 的私有 run/conversation；
- hidden token 未检查真实 request/context/trace 持久化面，且原始 token 被写进 manifest；
- Reference path 传 `before=null` / `adversary=null`，测试通过删 gate 规避完整 oracle；
- evidence facts 顺序不稳定、Memory raw content/rationale 暴露、route 依赖中文错误字符串判断状态码；
- runtime side effects 未持久化 tool/effect metadata，`fail_closed` 无法区分已知 effect。

以上均有 deterministic regression 或真实 isolated E2E 覆盖。

## 验收与下一步

当前验证基线（仓库锁定工具链）：

- backend：890 passed / 4 skipped；Ruff 全量通过；
- agent-bridge：1335 passed（65 files）；typecheck 与 build 通过；
- frontend（未改业务代码但做全量回归）：333 passed / 6 skipped（26 files）；lint 与 production build 通过；
- `smoke-v2`：3/3 场景通过；3/3 真实隔离 Reference paths 在完整 oracle 下通过；
- `git diff --check`：通过。

验收命令：

```bash
backend/.venv/bin/pytest backend/app/tests -q
backend/.venv/bin/ruff check backend/app
scripts/npm --prefix agent-bridge run test
scripts/npm --prefix agent-bridge run typecheck
scripts/npm --prefix agent-bridge run build
scripts/eval-lab validate --preset smoke-v2 --model mock:mock-model
scripts/eval-lab run --preset smoke-v2 --model mock:mock-model --json
git diff --check main...HEAD
```

#95 的后续 ticket #96 已完成分支实现并通过独立修复；在最终回归和合并前，不得把整个 Slice 1 标记为关闭，也不得开始 Slice 2。

---

## Issue #96 交付（2026-07-20，分支 `glm/t46-96-conversation-runtime-reliability`）

### 范围

#96 在 #95 的 hard-domain 之上补齐 Slice 1 的剩余验收面：多轮用户控制器、Simulator integrity、Skill 评估、Runtime 故障矩阵、Attempt 与 retry 证据模型、preset 矩阵、Candidate/baseline 对比、Reliability 统计、Operational metrics、Slice 1 exit gate。所有新代码位于 `agent-bridge/src/evaluation/lab/`，未触动 #95 的 evidence seam、hard grader、Reference Program 与 public Proposal 路径；Proposal-Confirm、FastAPI 事实源、sidecar 不读写业务数据库、public HTTP/SSE seam、evaluator-owned isolation、immutable checkpoint/SHA-256、paid model fail-closed、Slice 0/1 兼容性等所有现有边界保持不变。

### 核心模块

| 模块 | 文件 | 说明 |
| --- | --- | --- |
| 多轮用户控制器 | `user-controller.ts` | hidden facts/sentinels 仅存 evaluator 内存；phrasing 函数只能改可见 prompt，不能改 facts；refusal、`goal_drift`（连续 3 次 no-match）、`hidden_fact_leak`（Agent 输出含 sentinel）三类 `simulator_error` 终止场景并从分母排除 |
| Simulator integrity | `simulator-error.ts` | `classifySimulatorError` 把 simulator 故障从 score denominator 排除；`SIMULATOR_RETRY_BUDGET=2` 冻结常量；`retryBudgetExhausted` 强制 fail-closed |
| Attempt ledger | `attempt-ledger.ts` | append-only；entry id 形如 `<scenarioId>-<type>-<seq>`；仅当 retry 成功时才在原 entry 写 `recoveredBy`；若原 entry 已有 `recoveredBy` 且与当前 attemptId 不同，直接抛错，防 retry 抹除先前失败证据 |
| Skill 评估 | `skill-evaluator.ts` | 8 维度：`positive_trigger` / `negative_trigger_not_fired` / `prerequisites_satisfied` / `allowed_tools` / `required_steps` / `forbidden_actions` / `fallback_behavior` / `effect_ceiling`；effect ceiling 复用 Skills V2 单一权威，不再在 grader 内重定义 |
| Runtime 故障矩阵 | `runtime-faults.ts` | 11 故障类：`duplicate_terminal` / `contradictory_terminal` / `cancellation_completed` / `resume_side_effect_dup` / `missing_terminal` / `unknown_side_effect` / `tool_error_unhandled` / `tool_result_lost` / `state_repair_during_read` / `invalid_state_transition` / `tool_manifest_duplicate`；每个故障类有 `requiresIdempotency` 标记用于 resume 重复副作用检测 |
| Presets | `presets.ts` | `demo` / `smoke` / `smoke-v2` / `full`；`T46_3_P0_SCENARIO_IDS` 列出所有 P0 场景 id；budget cap: smoke $0.10 / full $1 / calibrate $3；hidden sentinel 永不出现在 manifest |
| Candidate/baseline 对比 | `paired-runner.ts` / `paired-comparison.ts` | 从 git ref 创建两个 detached worktree，分别启动隔离 backend/sidecar/database/temp/artifact 资源并执行同一 preset；`verifyIsolation` 检测 8 类资源，`resolvedModel.confirmedBy` 拒绝 requested/assumed 等不可信来源；任一侧无法确认模型时明确报告 `modelDriftPossible=true`，不得声明 candidate 胜出 |
| Reliability 统计 | `reliability-stats.ts` | 6 指标：`observed_trial_pass_rate` / `empirical_all_k_reliability` / `pass_at_k` / `modeled_pass_k` / `all_invariant_pass` / `confidence_interval`；`pass@k=1-(1-p)^k`，modeled `pass^k` 使用后验 `E[p^k]`；只有显式 repeat group 才能形成重复运行证据，单次 full 的不同场景不能冒充 repetitions |
| Operational metrics | `paired-comparison.ts` `aggregateSideMetrics` | sutCost 计入 SUT cap；evaluatorModelCost 与 codingAgentCost 单独列示，不计入 SUT cap；latencyMs / inputTokens / outputTokens / toolCalls / agentRetries / infrastructureAttempts / timeouts / skipped / excluded / simulatorErrors / infrastructureErrors 全量分账 |
| Exit gate | `exit-gate.ts` | 6 条件全 fail-closed：P0 mutation 检测 / reference program 无 hard false failure / hidden field 无泄漏 / required scenario 不被 skipped/excluded/fail 美化 / evidence integrity checksums+graph / no semantic judge；`reportId` 为条件摘要的 SHA-256 |

### CLI 新命令

```bash
# Slice 1 exit gate：检查单个 run artifact 是否满足 Slice 1 关闭条件
scripts/eval-lab exit-gate <run-id> --json
scripts/eval-lab exit-gate <run-id>           # 中文人类可读

# Reliability 报告：6 指标 + statistical significance 标记
scripts/eval-lab reliability <run-id> --json
scripts/eval-lab reliability <run-id> --confidence-level 0.95

# 在隔离 worktree/runtime 中执行 candidate/baseline
scripts/eval-lab compare --candidate <git-ref> --baseline <git-ref> --preset smoke --model mock:mock-model --json
```

`exit-gate` 退出码：`0` 通过、`1` regression（任一条件失败）、`2` infrastructure、`3` validation、`4` partial budget。`reliability` 退出码：`0` 正常、`4` evidence 不足（insufficientEvidence=true）。

### 对抗性自审（15 类攻击点）

| # | 攻击点 | 结论 |
| --- | --- | --- |
| 1 | hidden oracle 泄漏到 artifact/manifest | ✅ manifest 只存 SHA-256 digest，observation 不含 raw hidden facts |
| 2 | LLM phrasing 改写 facts | ✅ phrasing 函数签名只能改 visible prompt；sentinel 检测执行 |
| 3 | `simulator_error` 污染分母 | ✅ `scoreDenominatorTrials` 显式过滤 |
| 4 | retry 抹除先前失败证据 | ✅ 修复 attempt-ledger bug：仅成功 retry 写 `recoveredBy`；已有指针拒绝覆盖 |
| 5 | candidate/baseline 共享资源 | ✅ `verifyIsolation` 检查 8 资源 |
| 6 | requested model 冒充 resolved | ✅ 修复 `buildSide` bug：拒绝 6 类可疑 `confirmedBy` 值 |
| 7 | excluded/skipped 美化分母 | ✅ `computeDenominatorWithExclusions` 跟踪 excluded/skipped |
| 8 | pass@k / pass^k 混淆 | ✅ 6 指标显式 `kind` 与 `assumptions` |
| 9 | duplicate/contradictory terminal 漏检 | ✅ `evaluateFaultBehavior` 检查 `terminal_event_consistency` |
| 10 | cancellation 落盘 completed | ✅ `finalStatus + noSideEffects` 检查 |
| 11 | resume 重复副作用 | ✅ `requiresIdempotency` 标记 + side_effect_facts 对比 |
| 12 | checkpoint/artifact 篡改 | ✅ `evidenceIntegrity` 检查 checksums + graph；`reportId` 哈希 |
| 13 | preset 漏掉 P0 场景 | ✅ `T46_3_P0_SCENARIO_IDS` + exit-gate 检查 |
| 14 | demo/smoke 滥用统计显著性 | ✅ `statisticalSignificanceClaimAllowed` 仅 full+≥30 |
| 15 | 缺失 cost telemetry 付费模型 | ✅ Slice 0 已 fail-closed；#96 未改变付费模型策略 |

### 对抗性自审修复的 3 个 bug

1. **`attempt-ledger.ts` failed retry 误设 `recoveredBy`**：原实现无论 retry 成功与否都设置 `recoveredBy`，且会覆盖已有指针。修复后：仅 `result === "succeeded"` 时设置；若已有 `recoveredBy` 且不等于当前 attemptId，抛错。新增 2 个回归测试。
2. **`cli.ts` exit-gate `requiredScenarios` 仅检查观察**：原实现 `status = observedIds.has(id) ? "passed" : "skipped"`，使一个运行了但 hard grade 失败的 P0 场景被标记为 `passed`。修复后：检查 hard grade，failed grade 标记为 `"failed"`，防 mask regression。
3. **`paired-comparison.ts` `confirmedBy` 允许 `requested`**：原实现接受任何 `confirmedBy` 值，允许 requested model 静默提升为 resolved model。修复后：拒绝 `["requested", "assumed", "default", "unconfirmed", "unknown", ""]` 6 类可疑值；当 sidecar 无法确认时，caller 必须传 `resolvedModel: null`。新增 8 个回归测试 + 2 个 mutation 测试。

### Mutation 测试

`t46-3-mutation.test.ts` 共 40 个测试，覆盖 8 个新模块所有声明 grader/checker：

- §1 UserController：sentinel leak、goal drift（2 个 baseline + 2 个 mutation）
- §2 simulator-error：denominator exclusion、retry budget（2 + 2）
- §3 attempt-ledger：append-only、`recoveredBy` preservation、failed retry 不写 `recoveredBy`、第二成功 retry 不覆盖（2 + 3）
- §4 skill-evaluator：8 维度 + effect ceiling（8 baseline + 8 mutation）
- §5 runtime-faults：11 故障类（11 baseline + 11 mutation）
- §6 reliability-stats：6 指标公式（6 mutation）
- §7 paired-comparison：isolation、model drift、`confirmedBy` adversarial guard（多组）
- §8 exit-gate：6 条件 + semantic judge 检测

### 独立审查后的验收证据

- `demo` 真实隔离运行 5/5 通过；不存在“新场景未接 runner 但属预期”的例外
- `full` 真实隔离运行 16/16 通过，覆盖多轮、Skill 和 11 类 Runtime 故障
- `exit-gate` 六项全部通过：真实 P0 mutations、Reference Programs、hidden leakage、required scenarios、evidence graph/checksums、no semantic Judge
- `reliability` 对单次 full 正确返回 evidence 不足；只有显式 repeat groups 才允许重复运行或统计显著性声明
- `compare --candidate main --baseline main` 已真实创建两套 detached worktree/runtime/state/artifact 并完成清理；旧 `main` 无 resolved-model confirmation，因此诚实报告 model drift possible
- mock full 的 SUT cost 为 `$0.00`；Coding Agent cost 为 `unknown/null` 且与 ProjectFlow Agent 预算分账
- backend：890 passed / 4 skipped + Ruff；agent-bridge：1628/1628（75 files）+ typecheck/build；frontend：333 passed / 6 skipped（26 files）+ lint/build

验收命令：

```bash
backend/.venv/bin/pytest backend/app/tests -q
backend/.venv/bin/ruff check backend/app
scripts/npm --prefix agent-bridge run test
scripts/npm --prefix agent-bridge run typecheck
scripts/npm --prefix agent-bridge run build
scripts/eval-lab validate --preset demo --model mock:mock-model
scripts/eval-lab validate --preset smoke --model mock:mock-model
scripts/eval-lab validate --preset smoke-v2 --model mock:mock-model
scripts/eval-lab validate --preset full --model mock:mock-model
scripts/eval-lab run --preset smoke --model mock:mock-model --json
scripts/eval-lab run --preset smoke-v2 --model mock:mock-model --json
scripts/eval-lab run --preset demo --model mock:mock-model --json
scripts/eval-lab run --preset full --model mock:mock-model --json
scripts/eval-lab exit-gate <run-id> --json
scripts/eval-lab reliability <run-id> --json
scripts/eval-lab compare --candidate <git-ref> --baseline <git-ref> --preset smoke --model mock:mock-model --json
git diff --check main...HEAD
```

### Slice 1 关闭路径

#96 关闭只要求当前实现合并到 `main`，并保留以下确定性证据：

1. mock `full` 所有 required scenarios 通过；
2. `verify` 验证 immutable result graph；
3. `exit-gate` 六项全部通过；
4. 三端回归与静态检查通过；
5. paired runner 对资源隔离和 unresolved model identity 均 fail-closed。

重复运行可靠性必须通过新的显式 repeat runs 采集，单次 artifact 只能报告 evidence 不足。真实付费模型可在价格表和调用前最坏成本上限冻结后作为额外校准证据运行，但不得拿它阻塞确定性 Slice 1，也不得把 Coding Agent 成本计入 ProjectFlow Agent 的预算。Slice 1 合并关闭后，才可规划 Slice 2（RCA / Repair Packet / Dashboard）；语义 Judge 仍不是 hard exit gate。
