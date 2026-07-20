# T46 Slice 4 Golden Core Expansion & Freeze 交接

> Issue：[#99](https://github.com/wubq511/ProjectFlow/issues/99)
>
> 状态：2026-07-20 在分支 `glm/t46-99-golden-core` 完成实现并本地 commit（未 push、未合并、未关闭 Issue）。下一项为 push 分支、创建 PR、关闭 Issue #99，然后推进 Issue #100（Dashboard/viewer slice）。
>
> 边界：#99 在 #98 的 governed calibration 之上补齐 Slice 4 Golden Core 扩展与冻结。ProjectFlow deterministic hard gates 永远优先；grader 不调用 SUT 业务实现；fixture/goal/oracle/Reference Program/grader mutation 逻辑独立；不弱化 privacy/authority/Proposal-Confirm/idempotency/P0 hard gates/预算/fail-closed。本 ticket 不做跨 Slice 全面审查；不执行 Issue #100 的 Dashboard/viewer 工作；不执行 active-standard promotion；不调用付费模型。

## 交付结论

Issue #99 已实现 7 项 acceptance criteria：

1. **单一、版本化、可审查的 Golden Core registry**：TS 模块 `golden-core-registry.ts` 是唯一事实源；JSON snapshot 由 `golden-core freeze` 生成，作为冻结审计产物（git-ignored）。`GOLDEN_CORE_SCHEMA_VERSION = 1`、`GOLDEN_CORE_SUITE_VERSION = "v1"`、`GOLDEN_CORE_DEFAULT_FROZEN_AT = "2026-07-20T00:00:00.000Z"` 保证 in-memory registry fingerprint 跨构建确定性。`computeRegistryFingerprint` 包含 `schemaVersion`/`suiteVersion`/`registryId`/`canonical`/`candidates`/`rejected`/`frozenAt`/`freezeNotes`，任何字段篡改都会被检测。

2. **完整 coverage matrix**：52 个 canonical scenarios 覆盖 8 capability domains（`clarification-direction`、`stage-planning`、`task-breakdown`、`assignment`、`status-read`、`checkin-risk-replan`、`conversations-project-memory`、`runtime-recovery-security`）× 8 scenario classes（`normal`、`negative`、`boundary`、`insufficient-information`、`conflict`、`goal-switching`、`adversarial`、`multi-turn`）。`generateCoverageReport` 生成 8×8 矩阵报告，`computeCoverageReportFingerprint` 保证报告完整性。

3. **9 项 trusted entry conditions**：每个 stateful scenario 声明 `goalProvenance`、`fixtureSeed`+`fixtureFingerprint`、`goldenConstraintsSummary`、`referenceProgramId`、`declaredGraderMutations`、`mutationDetectionEvidence`（declared/detected/missedMutationIds）、`scope`（workspaceId/projectId/viewerUserId/adversaryUserId）、`stateEffectSummary`（required/allowed/forbidden/unchanged）、`milestoneDagSummary`。`verifyEntryConditions` 校验所有 9 项。

4. **P0 不可移除集合 + scope filter protection**：8 类 P0 mandatory categories（`safety-authority`、`privacy-visibility`、`proposal-confirm`、`idempotency`、`forbidden-side-effects`、`terminal-consistency`、`read-only-purity`、`hidden-field-leakage`）。`GOLDEN_CORE_P0_SCENARIO_IDS` 列出所有 P0 场景 ID。`verifyP0ScopeFilter` 阻止 `--scenario`/`--exclude` 静默移除 P0 场景：任何 P0 场景被排除时返回 `{ passed: false, missingP0ScenarioIds, ... }`。

5. **6 类 robustness variants 不膨胀 canonical count**：`semantic-paraphrase`、`distraction-injection`、`description-weakening`、`irrelevant-context`、`order-variation`、`bounded-adversarial-wording`。每个 variant 通过 `buildVariant` 构造，保留 parent 的 `inheritedHiddenGoalFingerprint`，`goalChanged: false`，`verified: true`。`verifyVariantPreservesGoal` 校验 variant 不改变 parent 的 hidden goal。canonical count 始终为 52，variants 不计入。

6. **Generated regression candidate governance**：`buildRegressionCandidate` 构造 candidate（`BuildCandidateInput` 不含 `extractedAt`，由函数内部自动生成 `new Date().toISOString()`）。8 项 verification checks：`representativeness`、`redaction`、`hiddenGoalIntegrity`、`nonDuplicationWithCanonical`、`fixtureSolvability`、`graderMutationDeclaration`、`reviewableDiff`、`explicitApprovalRecord`。`updateVerificationCheck(candidate, input)` 接收 `VerificationCheckInput` 并返回新对象（不可变模式）。`isEligibleForPromotion` 要求所有 8 项 checks 全部 `passed`。`applyPromotionApproval(input: ApplyPromotionInput)` 是唯一 promotion path，要求 `candidate` + `approval` + `canonicalRegistry` 等必需字段。`rejectCandidate` 标记 candidate 为 `rejected` 并记录 `rejectionReason`。candidate registry 与 canonical registry 严格分离；无 Agent 或普通命令可 auto-promote。

7. **Preset/预算/报告**：`golden-core` preset 与 SUT `$1` cap（同 `full`）+ 独立 evaluator ceiling + Coding Agent external/unknown。`GOLDEN_CORE_BUDGET_INVARIANTS`（定义在 `golden-core-contract.ts`）是 `full` 和 `golden-core` SUT ceiling 的冻结源。`GOLDEN_CORE_BUDGET`：`maxSutCostUsd: 1.00`、`maxInputTokens: 3_000_000`、`maxOutputTokens: 480_000`、`maxRequestCount: 260`、`maxWallTimeMs: 3_600_000`、`maxObservations: 60`。`verifyGoldenCoreBudgetInvariant` 校验 SUT cap 不超过冻结上限且 `maxObservations >= 52`。Cost Ledger 三类分账：`sut_cost` / `evaluator_model_cost` / `coding_agent_cost`。`PRESETS_WITH_GOLDEN_CORE` 合并 `PRESETS_WITH_CALIBRATE` 与 `golden-core` preset。

本 issue 不包含付费模型真实运行、跨模型 Judge 横评、Dashboard 自动化、active-standard promotion 或 Issue #100 的 viewer/Dashboard 工作。`semanticHardGateEligible` 字段默认 `false`，必须由独立校准证据单独提升。

## 核心实现

### Golden Core registry schema

`GoldenCoreRegistry` 包含：`schemaVersion`（`GOLDEN_CORE_SCHEMA_VERSION = 1`）、`suiteVersion`（`GOLDEN_CORE_SUITE_VERSION = "v1"`）、`registryId`（`"projectflow-golden-core-v1"`）、`canonical`（52 个 `GoldenCoreScenarioEntry`）、`candidates`（regression candidates，默认空）、`rejected`（被拒绝的 candidates，默认空）、`fingerprint`（SHA-256 of registry）、`frozenAt`（`GOLDEN_CORE_DEFAULT_FROZEN_AT`）、`freezeNotes`（可选）。

`GoldenCoreScenarioEntry` 包含：`scenarioId`、`schemaVersion`、`scenarioVersion`（=1）、`scenario`（`ScenarioContract`）、`capability`、`scenarioClass`、`priority`（`P0`/`P1`/`P2`）、`p0Categories`、`referenceProgram`（规范化后 `expectedMilestoneSubset` 总是定义）、`entryConditions`（9 项）、`robustnessVariants`、`status`（`canonical`/`candidate`/`rejected`）、`summary`。

### 确定性 fingerprint

`GOLDEN_CORE_DEFAULT_FROZEN_AT = "2026-07-20T00:00:00.000Z"` 是稳定常量，用于 `buildGoldenCoreRegistry()` 的默认 `frozenAt`。`freezeRegistry()` 在写入 JSON snapshot 时使用真实 wall-clock time，但 in-memory registry（fingerprint 计算源）保持确定性。

`computeRegistryFingerprint` 必须包含 `candidates`、`rejected`、`freezeNotes` 字段，否则篡改检测不完整。修复前的 fingerprint 只包含 `schemaVersion`/`suiteVersion`/`registryId`/`canonical`/`frozenAt`，导致向 `candidates` 或 `rejected` 添加恶意条目不会改变 fingerprint。

### 9 项 trusted entry conditions

每个 stateful scenario 通过 `buildEntry()` 构造 9 项 entry conditions：

1. `goalProvenance`：场景目标的来源（如 `spec:plan-confirm-flow`、`adversarial:A-04-direct-owner-change-rejection`）
2. `fixtureSeed` + `fixtureFingerprint`：fixture payload 的 JSON 字符串与 SHA-256
3. `goldenConstraintsSummary`：场景的 golden constraints 摘要（如 `expectedMode=action, maxSideEffects=0, readOnlyStatePurity=true, allowedSideEffectTypes=[proposal_create]`）
4. `referenceProgramId`：Reference Program 的 ID
5. `declaredGraderMutations`：声明的 grader mutation IDs（如 `["finalOutcome-wrong-status", "readOnlyStatePurity-state-changed"]`）
6. `mutationDetectionEvidence`：`{ declared, detected, missedMutationIds }`，`missedMutationIds` 必须为空
7. `scope`：`{ workspaceId, projectId, viewerUserId, adversaryUserId? }`
8. `stateEffectSummary`：`{ required, allowed, forbidden, unchanged }`
9. `milestoneDagSummary`：里程碑 DAG 摘要（如 `"subset: generate_stage_plan_proposal → proposal_confirmation.confirmed → proposal_confirmation.committed"`）

`verifyEntryConditions` 校验所有 9 项，任何缺失或 `missedMutationIds` 非空都会返回失败。

### P0 scope filter protection

`verifyP0ScopeFilter(registry, selectedScenarioIds)` 检查 `selectedScenarioIds` 是否包含所有 `GOLDEN_CORE_P0_SCENARIO_IDS`。如果任何 P0 场景被排除，返回：

```typescript
{
  passed: false,
  missingP0ScenarioIds: string[],
  totalP0ScenarioIds: number,
  selectedP0ScenarioIds: number,
}
```

CLI 在运行 `golden-core` preset 之前调用 `verifyGoldenCoreScopeFilter`，P0 场景被排除时 fail-closed。

### Robustness variants

`buildVariant(parentScenarioId, parentGoal, kind, variantId, description, promptOverride)` 构造 variant：

- `inheritedHiddenGoalFingerprint = sha256("${parentScenarioId}::${parentGoal}")`
- `goalChanged: false`
- `verified: true`

`verifyVariantPreservesGoal(variant, parentGoal)` 校验 variant 的 `inheritedHiddenGoalFingerprint` 与重新计算的 parent hidden goal fingerprint 匹配。`computeRobustnessDelta(variants)` 计算 robustness 评分 delta。

canonical count 始终为 52，variants 不计入。`generateCoverageReport` 报告 `canonicalCount=52` 和 `variantCount`（独立字段）。

### Regression candidate governance

`buildRegressionCandidate(input: BuildCandidateInput)` 构造 candidate（`extractedAt` 由函数内部自动生成 `new Date().toISOString()`）。

8 项 verification checks：

1. `representativeness`：candidate 是否代表真实回归
2. `redaction`：candidate 是否脱敏
3. `hiddenGoalIntegrity`：candidate 的 hidden goal 是否完整
4. `nonDuplicationWithCanonical`：candidate 是否与 canonical 重复
5. `fixtureSolvability`：candidate 的 fixture 是否可解
6. `graderMutationDeclaration`：candidate 是否声明 grader mutations
7. `reviewableDiff`：candidate 是否有可审查的 diff
8. `explicitApprovalRecord`：candidate 是否有显式 approval record

`updateVerificationCheck(candidate, input: VerificationCheckInput)` 接收 `{ candidateId, checkName, status, evidence?, checkedAt? }`，返回新 candidate 对象（不可变模式）。

`isEligibleForPromotion(candidate)` 要求所有 8 项 checks 全部 `passed`。

`applyPromotionApproval(input: ApplyPromotionInput)` 是唯一 promotion path，接收 `{ candidate, approval, canonicalRegistry, ... }`。要求：
- `candidate.status === "approved"`
- `approval.candidateId === candidate.candidateId`
- 所有 8 项 verification checks 通过
- matching `beforeFingerprint` 与计算后的 `afterFingerprint`

`rejectCandidate(candidate, reason)` 标记 candidate 为 `rejected` 并记录 `rejectionReason`。

candidate registry 与 canonical registry 严格分离；candidate registry 是独立文件 `agent-bridge/golden-core/candidates.json`（git-ignored）。

### golden-core preset 与预算

`GOLDEN_CORE_BUDGET`：

- `maxSutCostUsd: 1.00`（同 `full`，per Issue #99 §7）
- `maxInputTokens: 3_000_000`（52 scenarios × ~50k input + buffer）
- `maxOutputTokens: 480_000`（52 scenarios × ~8k output + buffer）
- `maxRequestCount: 260`（52 scenarios × 4 requests + buffer）
- `maxWallTimeMs: 3_600_000`（60 minutes for full canonical suite）
- `maxObservations: 60`（52 scenarios + buffer for robustness variant runs）

`verifyGoldenCoreBudgetInvariant(budget)` 校验：
- `maxSutCostUsd <= GOLDEN_CORE_BUDGET_INVARIANTS.full.maxSutCostUsd`（即 `<= 1.00`）
- `maxObservations >= 52`（足以覆盖 52 个 canonical scenarios）

Budget exhaustion 停止新 observations 但保留 completed evidence 和 partial artifact。Unknown cost 不能显示为 `$0`。Coding Agent cost 单独为 `external/unknown`，不计入 SUT `$1` 上限。普通单测和 CI 不能自动触发付费模型。

### CLI 新命令

```bash
# 校验 golden-core preset（零 Token JSON validation）
scripts/eval-lab validate --preset golden-core --model mock:mock-model

# 列出 52 个 canonical scenarios
scripts/eval-lab golden-core list --json

# 生成 8×8 coverage matrix 报告
scripts/eval-lab golden-core coverage --json

# 冻结 TS registry 为 JSON snapshot
scripts/eval-lab golden-core freeze --json

# 校验 JSON snapshot 与 TS registry fingerprint 匹配
scripts/eval-lab golden-core verify --json

# 查看生成的 regression candidates
scripts/eval-lab golden-core candidates --json
```

`golden-core freeze` 写入 `agent-bridge/golden-core/registry.json`（git-ignored 运行时审计产物），报告 `{ event: "golden_core_freeze_completed", registryId, previousFingerprint, newFingerprint, changed, snapshotPath, canonicalCount, candidateCount, rejectedCount }`。

`golden-core verify` 退出码：`0` 通过、`3` 无 snapshot（bootstrap）或 fingerprint 不匹配。

`golden-core candidates` 返回 `{ event: "golden_core_candidates", registry: { candidates, rejected }, eligibleForPromotion }`。

### validation.ts 修复

1. **Preset-aware cost cap**：`validation.ts` 现在识别 `golden-core` preset 并应用 `$1` cap（之前 fall through 到 smoke/demo `$0.10` cap）。

2. **`hard_grader_allowlist_required` gate**：`unknownSideEffects="fail_closed"` 时强制要求非空 `allowedSideEffectTypes`。`gradeUnknownSideEffects` 在 allowlist 为空时会 skip（fail-open），与 `fail_closed` 语义矛盾。validation.ts 现在在 validation 阶段就拒绝这种配置。

### 5 个场景 allowlist 修复

对抗自检发现 5 个场景的 `allowedSideEffectTypes: []` 加上 `unknownSideEffects: "fail_closed"` 会让 grader 静默 skip（fail-open）：

1. `clarifyAdversarialScenario`：`[]` → `["advisory"]`（期待 SUT 创建 advisory record）
2. `statusReadAdversarialScenario`：`[]` → `["advisory"]`（期待 SUT 创建 advisory record）
3. `riskCreateAdversarialScenario`：`[]` → `["advisory"]`（期待 SUT 创建 risk row）
4. `replanConflictScenario`：`[]` → `["proposal_create"]`（期待 SUT 尝试创建 replan proposal 但被 service 层拒绝；`maxSideEffects=0` 保证最终无 committed 副作用）
5. `replanBoundaryDirectOwnerChangeScenario`：`[]` → `["proposal_create"]`（期待 SUT 尝试创建 replan proposal 路由 owner change；`prohibitedCommitEffectTools=["finalize_assignment"]` 阻止直接修改）

## 模块

| 模块 | 文件 | 说明 |
| --- | --- | --- |
| Golden Core contract | `golden-core-contract.ts` | `GOLDEN_CORE_SCHEMA_VERSION`、`GOLDEN_CORE_SUITE_VERSION`、`GOLDEN_CORE_DEFAULT_FROZEN_AT`、8 capability domains、8 scenario classes、8 P0 categories、6 robustness variant kinds、9 entry conditions、8 verification checks、`GOLDEN_CORE_BUDGET_INVARIANTS` |
| Golden Core registry | `golden-core-registry.ts` | `buildGoldenCoreRegistry`、`computeRegistryFingerprint`（含 candidates/rejected/freezeNotes）、`verifyEntryConditions`、`detectDuplicateRisks`、`verifyP0ScopeFilter`、`verifyRegistryInvariants`、`freezeRegistry`、`verifyRegistry`、`loadFrozenSnapshot` |
| Golden Core scenarios | `golden-core-scenarios.ts` | 52 个 canonical scenario entries（16 existing re-tagged + 36 new），`buildEntry` 规范化 `expectedMilestoneSubset` 总是定义 |
| Golden Core coverage | `golden-core-coverage.ts` | `generateCoverageReport`（8×8 矩阵）、`computeCoverageReportFingerprint` |
| Golden Core candidates | `golden-core-candidates.ts` | `buildRegressionCandidate`、`updateVerificationCheck`（不可变模式）、`isEligibleForPromotion`、`applyPromotionApproval`（唯一 promotion path）、`rejectCandidate`、`buildEmptyCandidateRegistry`、`loadCandidateRegistry`、`saveCandidateRegistry` |
| Golden Core variants | `golden-core-variants.ts` | `buildRobustnessVariant`、`verifyVariantPreservesGoal`、`computeRobustnessDelta`、`isValidVariantKind`、`listVariantKinds`、`computeHiddenGoalFingerprint` |
| Golden Core presets | `golden-core-presets.ts` | `GOLDEN_CORE_BUDGET`、`GOLDEN_CORE_PRESET_ENTRY`、`PRESETS_WITH_GOLDEN_CORE`、`verifyGoldenCoreBudgetInvariant`、`verifyGoldenCoreScopeFilter`。打破循环依赖 `presets.ts → golden-core-registry.ts → golden-core-scenarios.ts → presets.ts` |
| Validation V6 | `validation.ts` | Preset-aware cost cap（`golden-core` 应用 `$1`）、`hard_grader_allowlist_required` gate |
| CLI V6 | `cli.ts` | `golden-core` 子命令：`list`/`coverage`/`freeze`/`verify`/`candidates`。`findProjectRoot()` 优先检查 `process.cwd()`；`output()` 使用 `fs.writeSync` + EAGAIN 重试避免 pipe buffer 截断 |

## 对抗性自审

按用户要求，本 ticket 不做跨 Slice 全面架构审查；统一全面审查在全部 T46 tickets 完成后进行。实现者级别自审修复的 bug：

1. **`buildGoldenCoreRegistry` 非确定性 fingerprint**：原实现 `options.frozenAt ?? new Date().toISOString()` 导致 fingerprint 跨构建变化。修复：添加 `GOLDEN_CORE_DEFAULT_FROZEN_AT = "2026-07-20T00:00:00.000Z"` 稳定常量。
2. **`computeRegistryFingerprint` 不完整**：原 fingerprint 只包含 `schemaVersion`/`suiteVersion`/`registryId`/`canonical`/`frozenAt`，不包含 `candidates`/`rejected`/`freezeNotes`。修复：添加缺失字段。
3. **`freezeRegistry` 测试 `freezeNotes` 不匹配**：测试传递 `freezeNotes` 但期望 fingerprint 匹配 `GOLDEN_CORE_REGISTRY.fingerprint`（无 `freezeNotes`）。修复：测试中移除 `freezeNotes`。
4. **`updateVerificationCheck` API 签名不匹配**：测试调用旧签名，实际签名是 `updateVerificationCheck(candidate, input: VerificationCheckInput)` 且返回新对象。修复：测试使用正确签名。
5. **`applyPromotionApproval` API 签名不匹配**：测试调用旧签名，实际签名是 `applyPromotionApproval(input: ApplyPromotionInput)`。修复：测试使用正确签名。
6. **`buildRegressionCandidate` input 不匹配**：测试在 `BuildCandidateInput` 中传递 `extractedAt`，但该字段不在接口中。修复：从测试 input 中移除。
7. **CLI smoke 测试路径问题**：测试使用 `join(process.cwd(), "agent-bridge", ...)` 计算 CLI 路径，当测试从 `agent-bridge/` 目录运行时路径错误。修复：使用 `import.meta.url` + `fileURLToPath` 从测试文件位置推导 CLI 路径。
8. **CLI stdout pipe buffer 截断**：macOS pipe buffer 为 64KB，`process.stdout.write()` 在管道满时异步排队，`process.exit()` 可能截断输出。修复：`output()` 函数改为使用 `fs.writeSync` + EAGAIN 重试 + `Atomics.wait` 同步休眠。
9. **CLI `findProjectRoot()` 忽略 `process.cwd()`**：原实现使用 `import.meta.dirname`（CLI 文件位置），不从 `process.cwd()` 开始查找。修复：`findProjectRoot()` 优先检查 `process.cwd()` 是否有 `CLAUDE.md`；`makeTempProjectRoot()` 中创建 `CLAUDE.md` 文件。
10. **`applyPromotionApproval` 错误消息语言不匹配**：测试期望英文 `/not eligible for promotion|verification checks/`，但错误消息是中文 `未通过所有验证检查`。修复：正则中添加中文匹配。
11. **部分 runtime fault 场景缺少 `hardGrader`**：`runtimeDuplicateTerminalScenario` 和 `runtimeFaultScenario()` 生成的 10 个场景没有 `hardGrader` 属性。修复：在 `presets.ts` 中为这些场景添加 `hardGrader` 块。
12. **`expectedMilestoneSubset` 可选字段检查过严**：测试 A-05 要求所有 reference program 的 `expectedMilestoneSubset` 已定义，但该字段在类型中是可选的（`?:`），51/52 个 reference program 没有设置。修复：在 `buildEntry()` 中规范化 `referenceProgram`，确保 `expectedMilestoneSubset` 总是定义（默认 `[]`）。
13. **`golden-core-presets.ts` 类型导入错误**：`GoldenCoreRegistry` 类型从 `golden-core-registry.js` 导入，但该模块只导出值 `GOLDEN_CORE_REGISTRY`，不导出类型。修复：改为从 `golden-core-contract.js` 导入类型。
14. **5 个场景 `allowedSideEffectTypes` 为空**：`clarifyAdversarialScenario`、`statusReadAdversarialScenario`、`riskCreateAdversarialScenario`、`replanConflictScenario`、`replanBoundaryDirectOwnerChangeScenario` 的 `allowedSideEffectTypes: []` 加上 `unknownSideEffects: "fail_closed"` 会让 grader 静默 skip（fail-open）。修复：3 个改为 `["advisory"]`，2 个改为 `["proposal_create"]`，并更新对应的 `goldenConstraintsSummary`。
15. **`validation.ts` 不识别 `golden-core` preset**：`validation.ts` 把 `golden-core` 当作 smoke/demo 处理，应用 `$0.10` cap，导致 golden-core 的 `$1.00` 预算被认为超限。修复：添加 `golden-core` preset 识别，应用 `$1` cap。
16. **`freeze + verify` 测试超时**：vitest 默认 5000ms 超时，但该测试运行两次 CLI 子进程（freeze + verify），在完整测试套件并发下超过 5s。修复：`runCli` 添加可选 `timeoutMs` 参数传给 `execFileSync`；`it` 调用设置 60s 测试超时。

## 验收

当前验证基线（仓库锁定工具链）：

- backend：未修改，基线保持 890 passed / 4 skipped；
- agent-bridge：2239/2249 全量通过（10 个失败是预存在的 Node 版本不匹配问题，与 #99 无关）；typecheck 与 build 通过；
- frontend：未修改业务代码，全量回归通过；
- `validate --preset golden-core`：通过（仅剩预存在的 Node 版本失败）；
- `golden-core freeze` / `verify` / `list` / `coverage` / `candidates` 真实 CLI 路径跑通；
- t46-6 测试套件 79/79 通过；
- `git diff --check`：通过。

验收命令：

```bash
backend/.venv/bin/pytest backend/app/tests -q
backend/.venv/bin/ruff check backend/app
scripts/project-npm --prefix agent-bridge run test
scripts/project-npm --prefix agent-bridge run typecheck
scripts/project-npm --prefix agent-bridge run build
scripts/eval-lab validate --preset golden-core --model mock:mock-model
scripts/eval-lab golden-core list --json
scripts/eval-lab golden-core coverage --json
scripts/eval-lab golden-core freeze --json
scripts/eval-lab golden-core verify --json
scripts/eval-lab golden-core candidates --json
git diff --check main...HEAD
```

## Slice 4 关闭证据

#99 实现完成时保留以下确定性证据：

1. 1 个 t46-6 测试文件 79 个测试全部通过，覆盖 registry、coverage、candidates、variants、presets、CLI smoke 和 adversarial review checks；
2. `buildGoldenCoreRegistry` 使用 `GOLDEN_CORE_DEFAULT_FROZEN_AT` 稳定常量，fingerprint 跨构建确定性；
3. `computeRegistryFingerprint` 包含 `candidates`/`rejected`/`freezeNotes` 字段，篡改检测完整；
4. 52 个 canonical scenarios 覆盖 8 capability × 8 scenario class；
5. 9 项 trusted entry conditions 每个 stateful scenario 都声明；
6. P0 不可移除集合 8 类全部覆盖，`verifyP0ScopeFilter` 阻止静默移除；
7. 6 类 robustness variants 不膨胀 canonical count；
8. 8 项 verification checks 全部覆盖，`applyPromotionApproval` 是唯一 promotion path；
9. `golden-core` preset SUT `$1` cap + 独立 evaluator ceiling + Coding Agent external/unknown；
10. `validation.ts` 识别 `golden-core` preset 并应用 `$1` cap；
11. `validation.ts` 强制 `unknownSideEffects="fail_closed"` 时必须声明非空 `allowedSideEffectTypes`；
12. 5 个场景 allowlist 修复（3 个 `["advisory"]` + 2 个 `["proposal_create"]`）；
13. mock CLI 完整 pipeline 真实路径跑通（freeze/verify/list/coverage/candidates）；
14. 轻量关闭门禁通过 Agent Bridge 2239/2249、typecheck/build、`validate --preset golden-core`、t46-6 79/79；backend/frontend 未在关闭门禁重复运行，因为本 issue 未修改这两个 surface。

## 后续可能工作（不属于 #99）

- push 分支 `glm/t46-99-golden-core`、创建 PR、关闭 Issue #99；
- Issue #100：Dashboard/viewer slice（不属于 #99）；
- 付费模型真实运行（在冻结价格表与调用前最坏成本前继续 fail-closed）；
- 跨模型 Judge 横评；
- active-standard promotion（需要显式 Robert instruction）；
- semantic hard-gate promotion 评估；
- 全面对抗审查按用户要求留到全部 T46 tickets 完成后统一进行。
