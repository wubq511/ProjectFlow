# T46 Slice 3 Governed Calibration & Semantic Standards 交接

> Issue：[#98](https://github.com/wubq511/ProjectFlow/issues/98)
>
> 状态：2026-07-20 合并到 `main`（`14e106e`）并关闭 Issue #98；下一项为 Issue #99 Golden Core expansion/freeze。
>
> 边界：#98 在 #97 的诊断/修复面之上补齐 Slice 3 受治理的 proxy-expert calibration 与 semantic quality evaluation。ProjectFlow deterministic hard gates 永远优先；Semantic Judge 默认只是 soft evidence；普通 eval 不能修改 active standards；calibration 只能产生 candidate standards；没有可靠独立 Judge 或存在冲突时返回 `needs_review`；所有标准变更都是版本化、可审查、可回滚的 Git diff；未经 Robert 显式批准，任何 Agent、Judge 或普通命令都不能 promotion。本 ticket 验收使用 mock/deterministic Judge，不运行真实付费模型。

## 交付结论

Issue #98 已实现 governed calibration pipeline 与 criterion-scoped semantic rubric：active/candidate registries 严格分离；6 类 standard conflict pattern 检测并阻止 promotion；criterion-scoped semantic rubric 与 5 类 verdict；blinding + 随机顺序 + reverse repetition + 6 类 bias metric（position / verbosity / same-family / disagreement / repeated-run / anchor-ordering）；good/boundary/bad anchors 与 Judge 稳定性测试；9 类 fail-safe 条件按优先级降级到 `needs_review`；`calibrate` preset 与 SUT `$3` + 独立 evaluator ceiling + 三类 cost provenance（provider_reported / versioned_price_estimate / unknown）；immutable calibration artifact 进入 SHA-256 result graph；`applyPromotionApproval` 是唯一 active registry mutation path，需要显式 Robert instruction + reviewable Git diff + matching fingerprints + all conflicts resolved。

本 issue 不包含付费模型真实校准、跨模型 Judge 横评、Dashboard 自动化或 Slice 4+ 的 semantic hard-gate promotion。`semanticHardGateEligible` 字段默认 `false`，必须由独立校准证据单独提升，不能由单次成功 Judge 调用冒充。

## 核心实现

### Active vs Candidate registries 严格分离

`agent-bridge/standards/active/registry.json` 是普通 eval / diagnose / repair-packet / Judge 的只读输入。`agent-bridge/standards/candidate/` 是 calibration 产物命名空间。两条路径不重叠。

- `loadActiveRegistry` 是 READ-ONLY：未找到文件时返回稳定 bootstrap registry（固定时间戳 `1970-01-01T00:00:00.000Z`），保证 `assertActiveRegistryUnchanged` 在 ENOENT bootstrap 路径下也能 byte-identical。
- `buildCandidateRegistry` 总是产出 `registry="candidate"` 与 `registryId="projectflow-candidate-<runId>"`，与 active registry fingerprint 必然不同。
- `assertSupportedRegistrySchema(1)` 只接受 schema version 1；future versions fail-closed。
- `verifyRegistryInvariants` 检测 duplicate `(id, version)`、`source.registry` 与 registry kind 不一致、fingerprint mismatch。
- Registry fingerprint 进入 SHA-256 result graph：`calibrationArtifact.activeRegistryFingerprint` 与 `candidateRegistryFingerprint` 是必填字段。
- 普通 eval / diagnose / repair-packet / Judge 路径没有任何 active write path。Calibration 只能写 candidate namespace。
- Failed / unapproved / fail-safe / conflict-blocked calibration 都不会修改 active registry；pipeline 在执行前后两次 `loadActiveRegistry` 并通过 `assertActiveRegistryUnchanged` 验证 byte-identical。

### Standard conflict detection

`FROZEN_CONFLICT_PATTERNS` 列出 6 类 frozen 冲突模式：`canonical-vs-adr` / `canonical-vs-schema` / `canonical-vs-public-behavior` / `schema-vs-code` / `frozen-scenario-vs-code` / `frozen-standard-vs-candidate`。

`detectStandardConflicts` 按 `aspectKey` 分组，若同一 aspect 有多个不同 `value` 则记录冲突。冲突结构包含：`conflictId`（SHA-256 of sorted claim hashes）、`conflictingClaims`（双方均被记录，不静默选择）、`severity`（`current_code_behavior` vs authoritative 源为 `high`，两个 authoritative 源不一致为 `medium`，frozen standard/scenario 涉及为 `medium`，其余 `low`）、`resolutionStatus`（`unresolved | resolved | deferred`）、`affectedCandidateStandards`、`detectedAt`。

冲突解决语义：

- `unresolved`：刚检测到，尚未处理；
- `resolved`：经 Robert 显式指令解决，附 `resolutionRationale`；
- `deferred`：明确推迟到下个迭代，附 `resolutionRationale`。

**`hasUnresolvedConflict` 把 `unresolved` 和 `deferred` 都视为阻塞。** 只有 `resolved` 才能解锁 promotion。否则可以 defer 所有冲突后推广一个有已知语义分歧的 candidate，违反 #98 spec。

当前代码行为永远不能因为"实际如此"自动成为标准；calibration 不得偷偷选择其中一方；unresolved/deferred 冲突必须保留并显式展示。

### Criterion-scoped semantic rubric

每个 rubric 一次只评估一个 criterion。`SemanticRubricPayload` 包含：`rubricId`、`rubricVersion`、`criterion`、`label`、`description`、`scoreScale`、`evidenceReferences`、`verdict`（`pass | fail | needs_review | infra_error | insufficient_evidence`）、`score`、`reason`、`confidence`、`judgeManifestRef`、`semanticHardGateEligible`（默认 `false`，必须由独立校准证据单独提升）。

Judge 输入只包含：可见任务事实、可见 ProjectFlow state、candidate output、已计算的 deterministic evidence、经过脱敏的 trace/evidence references。**不得包含**：hidden chain-of-thought、evaluator hidden oracle、raw private transcript、secret/token、candidate model identity（在可以盲化时）、不属于 scenario viewer 的 ProjectMemory 或会话内容。

`combineHardGateWithSemantic(hardGatePassed, semanticVerdict)` 是 ProjectFlow hard gate 优先的核心守卫：hard gate 失败永远产生 `fail`，无论 semantic verdict 是什么；hard gate 通过时保留 semantic verdict，但 `needs_review` 永远不会被升级为 `pass`。

`FROZEN_HARD_GATES` 列出 8 类 ProjectFlow hard gate：`state_invariant` / `authority` / `privacy_visibility` / `proposal_confirm` / `terminal_consistency` / `idempotency` / `forbidden_side_effect` / `frozen_p0_gate`。Semantic result 永远不能覆盖这些 gate。

### Blinding、随机顺序与 provenance

Pairwise semantic evaluation 必须：

- 尽可能隐藏 candidate identity（`candidateBlinded` 标记；无法盲化时显式记录 `blindingLimitation`）；
- 使用 manifest 中的 seed 随机化 A/B 顺序（`actualOrder` 字段记录实际展示顺序）；
- 支持反向顺序重复（`reverseResult` 与 `forwardResult` 同时记录）；
- 记录 Judge provider/model/family、prompt/rubric/anchor/scenario version；
- 记录 disagreement，而不是只保留平均值；
- 无法盲化时显式记录 `blindingLimitation`。

### Semantic anchors 与 Judge 稳定性

`SemanticAnchorSet` 至少包含 `good`、`bad`、`boundary` 三类 anchor。`evaluateAnchorOrdering` 检查 `good > boundary > bad` 的 confidence 排序。`computeAnchorStability` 按 anchor kind 推导 expected verdict（`good→pass`、`bad→fail`、`boundary→needs_review`），计算重复运行的稳定性。

6 类 bias metric：

- `positionBias`：A/B 顺序偏好（`computePositionBias`）；
- `verbosityBias`：长输出偏好（`computeVerbosityBias`）；
- `sameFamilyPreference`：同系列模型偏好（`computeSameFamilyPreference`，含 `sameFamilyDetected` 标记）；
- `disagreementRate`：forward/reverse 结果不一致率；
- `repeatedRunFlipRate`：重复运行 verdict 翻转率；
- `anchorOrdering`：anchor ordering 违反率。

anchor 必须由版本化候选标准声明，不能由 Judge 自己生成金标。无法稳定区分 anchors 的 Judge 不能成为 hard gate。`semanticHardGateEligible` 必须是单独字段，默认 `false`，只有通过 acceptance proposal 全部阈值时才能由独立校准证据提升。

### 9 类 fail-safe 条件

`decideJudgeFailSafe` 按优先级降级到 `needs_review`：

1. `no_independent_judge`：没有独立 Judge；
2. `judge_identity_unconfirmed`：Judge identity 无法确认；
3. `only_same_family_uncalibrated`：只找到与 candidate 同系列且未校准的 Judge；
4. `judges_conflict`：多个 Judge 之间冲突；
5. `anchor_ordering_unstable`：anchor ordering 不稳定；
6. `bias_metrics_exceeded`：bias metrics 超过候选阈值；
7. `judge_telemetry_incomplete`：Judge telemetry 不完整；
8. `judge_schema_unrepairable`：Judge schema 输出无法修复；
9. `calibration_evidence_insufficient`：calibration evidence 不足。

**禁止静默切换到同系列 Judge 后继续形成 hard verdict。** Fail-safe 触发时：active registry 必须保持 byte-identical；calibration artifact 仍然产出（保留 partial evidence）；exit gate 失败；任何 candidate 不可 promotion。

### Calibrate preset 与预算

`CALIBRATE_PRESET` 包含：`acceptanceProposal`（5 个 bias threshold + repeated anchor stability + disagreement rate）、`rubrics`（P0 planning specificity rubric）、`anchorSets`（P0 planning specificity anchor set：good/boundary/bad）、`judgeManifest`（mock judge）、`calibrateBudget`。

ProjectFlow Agent (SUT) 预算上限：**$3**。这个上限只计算 SUT，不包含 Coding Agent，不包含 evaluator Judge/simulator。

Evaluator model 独立 ceiling：`maxCalls`、`maxInputTokens`、`maxOutputTokens`、`maxWallMs`、`maxMeasurableUsd`。

Cost provenance 三类：`provider_reported`（Provider 直接报告）、`versioned_price_estimate`（冻结价格表估算）、`unknown`（无法测量）。

要求：

- 没有冻结价格表和调用前最坏成本估算时，付费 calibration 必须 fail-closed；
- unknown cost 不能显示为 `$0`（`amountUsd` 必须为 `null` 或非零数）；
- Coding Agent cost 单独为 `external/unknown`，不计入 SUT `$3` 上限；
- evaluator budget exhaustion 停止新 Judge calls，但保留 completed evidence 和 partial artifact；
- 普通单测和 CI 不能自动触发付费模型。

本 Ticket 验收使用 mock/deterministic Judge，不运行真实付费模型。

### Calibration artifact

一次 calibration 产出 immutable、可恢复、可核验的 `CalibrationArtifact`，至少包含：

- `schemaVersion`（`CALIBRATION_ARTIFACT_SCHEMA_VERSION = 1`）；
- `calibrationId`、`createdAt`；
- `activeRegistryFingerprint`、`candidateRegistryFingerprint`；
- `anchorVersions`、`rubricVersions`、`judgeVersions`；
- `repeatedAnchorResults`、`biasMetrics`、`disagreementSummary`；
- `mutationResults`、`standardConflicts`；
- `costLedger`（SUT / evaluator / Coding Agent 三类 + provenance）；
- `candidateStandards`、`standardDiffs`；
- `promotionEligibility`、`failureReasons`；
- `integritySha256`；
- `exitGateEvidence`。

要求：

- artifact 进入现有 SHA-256 result graph（`publishCalibrationArtifact` 原子写入 `calibration-artifact.json`）；
- resume 不重复已完成 Judge calls（`determineRemainingJudgeCalls` 计算剩余调用）；
- failed calibration 不修改 active；
- unapproved calibration 不修改 active；
- `verifyCalibrationArtifactInvariants` 检查：missing `integritySha256`、unknown cost 显示为 `$0`、candidate status 非 `candidate`、非法 provenance、fingerprint mismatch 等。

### Promotion approval 是唯一 active mutation path

`applyPromotionApproval(active, candidate, approval, resolvedConflictIds, now?)` 是唯一修改 active registry 的函数。它要求：

1. `candidate.status === "approved"`（不是 `candidate`）；
2. `approval.candidateId === candidate.candidateId`；
3. `candidate.affectedByConflicts` 全部在 `resolvedConflictIds` 中；
4. `approval.beforeActiveFingerprint === active.fingerprint`；
5. `approval.afterActiveFingerprint === newActive.fingerprint`（计算后验证）。

`buildPromotionApproval` 构造 approval record，要求：

- 非空 `approverInstruction`（必须显式声明 Robert instruction）；
- 非空 `reviewableDiff.diffPath` 与 `reviewableDiff.commit`；
- matching `beforeActiveFingerprint` 与计算后的 `afterActiveFingerprint`。

**approval record 永远不声称密码学身份认证。** 它是 repository governance with reviewable history，不是密码学签名。Robert 的身份通过仓库 governance 与 reviewable Git history 验证。

## 模块

| 模块 | 文件 | 说明 |
| --- | --- | --- |
| Calibration contract | `calibration-contract.ts` | V5 additive extension：`StandardsRegistry` / `StandardEntry` / `CandidateStandard` / `PromotionApprovalRecord` / `SemanticRubric` / `SemanticAnchorSet` / `SemanticJudgeManifest` / `CalibrationArtifact` / `CalibrationCostLedger` / frozen verdicts / frozen candidate statuses / frozen conflict resolutions / 8 frozen hard gates / 9 fail-safe reasons / cost provenance |
| Standards registry | `standards-registry.ts` | Active/candidate separation、`loadActiveRegistry`（READ-ONLY）、`buildEmptyActiveRegistry`（稳定 bootstrap timestamp）、`buildCandidateRegistry`、`computeRegistryFingerprint`、`assertActiveRegistryUnchanged`、`applyPromotionApproval`（唯一 active mutation）、`verifyRegistryInvariants` |
| Standard conflicts | `standard-conflicts.ts` | `FROZEN_CONFLICT_PATTERNS`（6 类）、`generateConflictId`、`inferSeverity`、`detectStandardConflicts`、`resolveStandardConflict`、`hasUnresolvedConflict`（`unresolved` 与 `deferred` 均阻塞）、`getUnresolvedConflicts`、`verifyConflictCatalog` |
| Semantic judge | `semantic-judge.ts` | `evaluateAnchorOrdering`、`computeAnchorStability`（按 anchor kind 推导 expected verdict）、`applyFailSafe`、`combineHardGateWithSemantic` |
| Judge bias | `judge-bias.ts` | 6 类 bias metric：`computePositionBias` / `computeVerbosityBias` / `computeSameFamilyPreference` / `computeDisagreementRate` / `computeRepeatedRunFlipRate` / `computeAnchorOrderingInstability`，`anyBiasExceeded` 聚合 |
| Calibration runner | `calibration-runner.ts` | 15 步 pipeline：load active → detect conflicts → run anchor evaluations → run pairwise evaluations → compute bias metrics → check fail-safe → build candidate standards → compute standard diffs → check promotion eligibility → build exit gate evidence → build calibration artifact → compute integritySha256 → publish artifacts → verify invariants → assert active registry unchanged |
| Presets | `presets.ts` | `CALIBRATE_PRESET`、`CALIBRATE_BUDGET`、`P0_PLANNING_SPECIFICITY_ANCHOR_SET`、`P0_PLANNING_SPECIFICITY_RUBRIC`、`P0_MOCK_JUDGE_MANIFEST`、`CALIBRATE_ACCEPTANCE_PROPOSAL` |
| Artifact store V5 | `artifact-store.ts` | 6 个 V5 publish 方法：`publishCalibrationArtifact` / `publishCandidateRegistry` / `publishStandardConflicts` / `publishStandardDiff` / `publishCandidateStandard` / `publishPromotionApproval`，全部原子写入并进入 SHA-256 result graph |
| CLI | `cli.ts` | 新命令 `calibrate` / `promote-standard` / `conflict-catalog`（plus `validate --preset calibrate`） |
| Validation | `validation.ts` | V5 additive：`stableStringify` 支持 V5 schema、`sha256` 覆盖新增 artifact 类型 |

## CLI 新命令

```bash
# 运行 calibration pipeline（mock judge，不调用付费模型）
scripts/eval-lab validate --preset calibrate --model mock:mock-model
scripts/eval-lab calibrate <run-id> --json

# 构造 promotion approval record（必须显式 --approver-robert）
scripts/eval-lab promote-standard \
  --candidate-id <id> \
  --approver-robert \
  --diff-path <path> \
  --commit <sha> \
  --before-fingerprint <fp> \
  --after-fingerprint <fp> \
  [--run-id <id>] \
  --json

# 验证 6 类 frozen conflict pattern 完整性
scripts/eval-lab conflict-catalog --json
```

`calibrate` 退出码：`0` 通过、`1` calibration 失败（fail-safe 触发 / 冲突未解决 / invariant 违反）、`2` infrastructure、`3` validation、`4` budget exhausted。`promote-standard` 退出码：`0` approval recorded、`1` approval rejected（candidate 非 approved / fingerprint 不匹配 / 未解决冲突）、`3` validation。

## 对抗性自审

按用户要求，本 ticket 不做跨 Slice 全面架构审查；统一全面审查在全部 T46 tickets 完成后进行。实现者级别自审修复的 bug：

1. **JSDoc `*/` 注释陷阱**：`calibration-contract.ts` 与 `standard-conflicts.ts` 的 JSDoc 注释中包含 `agent-bridge/src/**/*` 等 glob，esbuild 把 `**/` 解释为注释结束。修复：重写注释文本避免 `**/` 模式。
2. **变量遮蔽**：`judge-bias.ts` `computeSameFamilyPreference` 中 `let samples = 0` 遮蔽了 `samples` 参数，导致循环遍历 local 0 而非参数。修复：重命名为 `countedSamples`。
3. **`generateConflictId` 字段访问错误**：原实现访问 `c.sourceHash`，但 `StructuredClaim` 有 `source.hash`。修复：更新函数签名与字段访问。
4. **`buildEmptyActiveRegistry` 时间戳不稳定**：原实现用 `new Date().toISOString()`，导致 ENOENT bootstrap 路径下两次 `loadActiveRegistry` 返回不同 fingerprint。修复：使用固定 bootstrap timestamp `1970-01-01T00:00:00.000Z`。
5. **`isEligibleForPromotion` 检查不完整**：原实现只检查 `candidate.candidateId`，但冲突可能引用 `entry.id`（如 rubricId）。修复：同时检查 `candidateId` 和 `entry.id`。
6. **`computeAnchorStability` expected verdict 推导错误**：原实现把所有 anchor 的 expected verdict 默认为 `pass`，导致 boundary（`needs_review`）和 bad（`fail`）anchor 即使按设计返回正确 verdict 也被判为不稳定。修复：按 anchor kind 推导（good→pass / bad→fail / boundary→needs_review）。
7. **`hasUnresolvedConflict` 语义错误**：原实现只把 `unresolved` 视为阻塞，允许 `deferred` 解锁 promotion。修复：只有 `resolved` 才能解锁，`unresolved` 与 `deferred` 都阻塞。
8. **`applyPromotionApproval` 测试 flakiness**：测试与函数分别调用 `new Date().toISOString()`，不同毫秒会产生不同 fingerprint。修复：函数新增可选 `now` 参数，测试传入固定 timestamp。

## 验收

当前验证基线（仓库锁定工具链）：

- backend：890 passed / 4 skipped；Ruff 全量通过（本 ticket 未改 backend）；
- agent-bridge：2170/2170 全量通过（93 个测试文件，其中 8 个 t46-5 文件共 225 tests）；typecheck 与 build 通过；
- frontend：未改业务代码，全量回归通过；
- `calibrate` 真实 CLI 路径：mock Judge 下完整 pipeline 跑通；
- `git diff --check`：通过。

验收命令：

```bash
backend/.venv/bin/pytest backend/app/tests -q
backend/.venv/bin/ruff check backend/app
scripts/npm --prefix agent-bridge run test
scripts/npm --prefix agent-bridge run typecheck
scripts/npm --prefix agent-bridge run build
scripts/eval-lab validate --preset calibrate --model mock:mock-model
scripts/eval-lab calibrate <run-id> --json
scripts/eval-lab conflict-catalog --json
git diff --check main...HEAD
```

## Slice 3 关闭证据

#98 合并关闭时保留以下确定性证据：

1. 8 个 t46-5 测试文件 225 个测试全部通过，覆盖 active/candidate registry、standard conflicts、semantic judge、judge bias、calibration runner pipeline、mutation、governance；
2. `verifyCalibrationArtifactInvariants` 检查 5 类 invariant；
3. `decideJudgeFailSafe` 9 类 fail-safe 条件按优先级降级；
4. `applyPromotionApproval` 是唯一 active mutation path，7 类 reject 条件全部覆盖；
5. `FROZEN_HARD_GATES` 8 类 gate 与 `FROZEN_CONFLICT_PATTERNS` 6 类 pattern 全部覆盖；
6. active registry 在所有 fail-safe / conflict / unapproved 路径下保持 byte-identical；
7. mock Judge 完整 pipeline 真实 CLI 路径跑通；
8. 轻量关闭门禁通过 Agent Bridge 2170/2170、typecheck/build、preset validation、conflict catalog 与真实 deterministic mock calibration；backend/frontend 未在关闭门禁重复运行，因为本 issue 未修改这两个 surface。

## 合并前轻量发布门禁修复

按 Robert 的节奏要求，本次没有做跨 Slice 全面审查；只修复真实入口暴露的 4 个阻塞问题：

1. `calibrate` CLI 原先没有向 runner 传入 deterministic mock Judge anchor/pairwise evidence，导致文档声称可跑通但实际 fail-safe；
2. runner 把“每个 anchor 的重复结果”直接当成“同一轮的多个 anchors”计算 ordering，导致 ordering violation 恒为 1；
3. fail-safe 或 acceptance 未通过时，artifact 仍可能同时报告 candidate `eligible: true`；
4. 所有 calibration failure 都误用 exit `4`，混淆普通回归与真正的 budget exhaustion。

修复后真实命令 `scripts/eval-lab calibrate review98_calibrate_gate2 --json` 返回 `passed: true` / exit `0`，position、verbosity、same-family、disagreement、repeated-run、anchor-ordering 六类 metric 均有非零样本且未超过冻结阈值；active registry fingerprint 保持不变。全面对抗审查与跨切片修复继续留到全部 T46 tickets 完成后统一进行。

真实付费模型 canary 不属于本 ticket 关闭条件。在冻结价格表与调用前最坏成本上限前，付费 calibration 继续 fail-closed。Slice 3 后续可能工作（不属于 #98）：付费模型真实校准、跨模型 Judge 横评、Dashboard 自动化、semantic hard-gate promotion 评估。全面对抗审查按用户要求留到全部 T46 tickets 完成后统一进行。

## 第一性原理对抗审查修复（2026-07-20）

对 Slice 3 实现做了第一性原理对称性 + 代码审查，发现并修复 6 个问题（3 个直接修复 + 3 个设计选择修复）和 10 个 pre-existing typecheck 错误。

### 已修复（含回归测试）

1. **`failSafeVerified` tautology**（`calibration-runner.ts`）：原表达式 `(failSafeReason === null || failSafeReason !== null)` 永远为 true，是 dead code。简化为 `candidateStandards.every((c) => c.status === "candidate")`。新增 `failSafeVerified is true when all candidates are in 'candidate' status` 回归测试。

2. **`runCalibrationPipeline` resume 副作用**（`calibration-runner.ts`）：原代码 `const anchorResults = input.existingAnchorResults ?? []` 引用调用者数组，后续 `push` 会修改调用者数组。改为 `[...(input.existingAnchorResults ?? [])]` 创建新数组。pairwise records 同样修复。新增 `resume does NOT mutate the caller's existingAnchorResults / existingPairwiseRecords arrays` 回归测试。

3. **`applyPromotionApproval` dead code**（`standards-registry.ts`）：原代码先按 `candidate.entry` 构建 `newEntries`，随后又按 `newEntry`（覆盖 source 字段）重新构建，第一次赋值被完全覆盖。合并为单次构建，直接用 `newEntry`。

4. **`runAnchorEvaluation` 硬编码 fail-safe 参数**（`calibration-runner.ts`）：原 anchor 级 `applyFailSafe` 所有参数硬编码为"安全"值，anchor verdict 不会被 fail-safe 降级。移除 `runAnchorEvaluation` 中的 `applyFailSafe` 调用，只处理 missing Judge result；在 pipeline §6.5 新增 fail-safe 触发时的降级后处理：构建 `anchorResultsForArtifact` 与 `anchorRepeatResultsForArtifact`，所有 verdicts 降级为 `needs_review`，stability=0，orderingPreserved=false；acceptance proposal 与 artifact 使用降级后的结果。新增 `degrades anchor verdicts to needs_review in artifact when fail-safe triggers` 回归测试。

5. **Cost provenance 检查不对称**（`calibration-runner.ts`）：`verifyCalibrationArtifactInvariants` 原本只对 SUT cost 强制"unknown 不得为 $0"，不检查 evaluator cost。新增 evaluator cost `unknown + $0` violation 检查，对称强制两类 cost provenance。新增 `flags evaluator cost provenance=unknown with amountUsd=0 (symmetric with SUT)` 回归测试。

6. **Resume 逻辑不 idempotent**（`calibration-runner.ts`）：原 resume 时对所有 anchor 重新计算并追加，导致重复；现有测试用 `>=` 和 `> 0` 容忍了重复，测试名"does NOT repeat"与实际行为矛盾。新增 `existingAnchorIds` / `existingPairwiseIds` Set 跳过已计算项目；为跳过的 anchor 重新推导 `anchorRepeatResults` 以保证 summary 完整；更新现有 resume 测试：`>=` / `> 0` 改为严格 `toBe`，验证 verdicts 完全相同。

### Pre-existing typecheck 错误修复（10 个）

在审查过程中发现 10 个 pre-existing typecheck 错误（通过 `git stash` 确认是 pre-existing，非本次审查引入），全部修复：

1. `calibration-contract.ts` 新增 4 个 V5 reserved 占位接口：`ScenarioVersion`、`JudgePromptVersion`、`JudgeModelCompatibility`、`SemanticThreshold`。
2. `calibration-runner.ts` 移除未使用 import：`V5_CONTRACT_VERSION`、`combineHardGateWithSemantic`、`applyFailSafe`。
3. `cli.ts` 移除未使用 import：`join`（from `node:path`）、`CalibrateBudget`（from `calibration-contract.js`）。
4. `semantic-judge.ts` `evaluateAnchorOrdering` 移除未使用的 `good`/`boundary`/`bad` 局部变量。
5. `standard-conflicts.ts` `detectStandardConflicts` 中 `for (const [aspectKey, group]` 改为 `for (const [, group]`（移除未使用变量）。

### 验证

- t46-5 测试从 221 增加到 225（+4 回归测试），全部 pass
- agent-bridge typecheck pass
- agent-bridge build pass
- 8 个不变量强制点全部通过验证（详见审查报告）
