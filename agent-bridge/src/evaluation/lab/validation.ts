import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { arch, platform } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  EVALUATION_SCHEMA_VERSION,
  EVALUATOR_VERSION,
  type CodeFingerprint,
  type EvaluationBudget,
  type EvaluationProvenance,
  type ScenarioContract,
} from "./contract.js";
import {
  HARD_GRADER_CONTRACT_VERSION,
  type HardGraderContract,
  type MilestoneDag,
  type StateAssertion,
} from "./contract-v2.js";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export interface ValidationIssue {
  code: string;
  message: string;
}

export interface ValidationResult {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  valid: boolean;
  model: string;
  scenarioCount: number;
  checks: {
    scenarioContracts: boolean;
    budgetCompatibility: boolean;
    modelCompatibility: boolean;
    toolchain: boolean;
  };
  errors: ValidationIssue[];
}

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`);
    return `{${entries.join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

function validateScenario(scenario: ScenarioContract): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const add = (code: string, message: string) => errors.push({ code, message });

  if (scenario.schemaVersion !== EVALUATION_SCHEMA_VERSION) {
    add("scenario_schema_version", `场景 ${scenario.scenarioId || "<unknown>"} schemaVersion 必须为 1`);
  }
  if (!SAFE_ID.test(scenario.scenarioId)) {
    add("scenario_id", `场景 ID ${JSON.stringify(scenario.scenarioId)} 只能包含字母、数字、下划线和连字符`);
  }
  if (!scenario.visible?.prompt?.trim()) {
    add("scenario_prompt", `场景 ${scenario.scenarioId} 的 visible.prompt 不能为空`);
  }
  if (!scenario.hidden || !["answer", "action"].includes(scenario.hidden.expectedMode)) {
    add("scenario_expected_mode", `场景 ${scenario.scenarioId} 的 expectedMode 无效`);
    return errors;
  }
  if (!Number.isFinite(scenario.hidden.maxLatencyMs) || scenario.hidden.maxLatencyMs <= 0) {
    add("scenario_latency", `场景 ${scenario.scenarioId} 的 maxLatencyMs 必须为正数`);
  }
  if (!Number.isInteger(scenario.hidden.maxRequestCount) || scenario.hidden.maxRequestCount <= 0) {
    add("scenario_requests", `场景 ${scenario.scenarioId} 的 maxRequestCount 必须为正整数`);
  }
  const tokens = scenario.hidden.tokenBudget;
  if (!tokens || !Number.isInteger(tokens.maxInputTokens) || tokens.maxInputTokens <= 0) {
    add("scenario_input_tokens", `场景 ${scenario.scenarioId} 的 maxInputTokens 必须为正整数`);
  }
  if (!tokens || !Number.isInteger(tokens.maxOutputTokens) || tokens.maxOutputTokens <= 0) {
    add("scenario_output_tokens", `场景 ${scenario.scenarioId} 的 maxOutputTokens 必须为正整数`);
  }
  for (const pattern of scenario.hidden.forbiddenOutputPatterns ?? []) {
    try {
      new RegExp(pattern, "i");
    } catch {
      add("scenario_regex", `场景 ${scenario.scenarioId} 包含无效的 forbiddenOutputPatterns 正则`);
    }
  }
  if (scenario.hidden.humanAction) {
    const action = scenario.hidden.humanAction;
    if (!(["confirm", "reject"] as string[]).includes(action.action)) {
      add("scenario_human_action", `场景 ${scenario.scenarioId} 的 humanAction.action 无效`);
    }
    if (!(["clarify", "plan", "breakdown", "replan"] as string[]).includes(action.proposalType)) {
      add("scenario_human_proposal_type", `场景 ${scenario.scenarioId} 的 humanAction.proposalType 无效`);
    }
    if (!action.actorUserId?.trim()) {
      add("scenario_human_actor", `场景 ${scenario.scenarioId} 的 humanAction.actorUserId 不能为空`);
    }
    if (action.action === "reject" && !action.reason?.trim()) {
      add("scenario_human_reject_reason", `场景 ${scenario.scenarioId} 的 reject humanAction 必须提供 reason`);
    }
    if (!scenario.hardGrader) {
      add("scenario_human_hard_grader", `场景 ${scenario.scenarioId} 声明 humanAction 时必须声明 hardGrader`);
    } else {
      const expectedStatus = action.action === "confirm" ? "confirmed" : "rejected";
      const required = scenario.hardGrader.authoritySafety?.proposalConfirm?.required ?? [];
      if (!required.some((item) => item.proposalType === action.proposalType && item.status === expectedStatus)) {
        add(
          "scenario_human_oracle",
          `场景 ${scenario.scenarioId} 的 humanAction 必须有匹配的 proposalConfirm.required oracle`,
        );
      }
    }
  }
  // T46-2: validate the optional hardGrader block (fail-closed on
  // invalid or contradictory contracts).
  const hardGraderErrors = validateHardGrader(scenario);
  errors.push(...hardGraderErrors);
  return errors;
}

/**
 * T46-2 (Issue #95 §2) — Validate the optional HardGraderContract block.
 *
 * Fail-closed: any invalid or contradictory constraint causes the scenario
 * to be rejected. V1 scenarios (no `hardGrader`) bypass this check.
 */
function validateHardGrader(scenario: ScenarioContract): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const add = (code: string, message: string) => errors.push({ code, message });
  const hg = scenario.hardGrader;
  if (!hg) return errors;

  if (hg.version !== HARD_GRADER_CONTRACT_VERSION) {
    add("hard_grader_version", `场景 ${scenario.scenarioId} 的 hardGrader.version 必须为 ${HARD_GRADER_CONTRACT_VERSION}`);
    return errors;
  }

  // Viewer scope: primary user ID is required.
  if (!hg.viewer || typeof hg.viewer.primaryUserId !== "string" || !hg.viewer.primaryUserId.trim()) {
    add("hard_grader_viewer", `场景 ${scenario.scenarioId} 的 hardGrader.viewer.primaryUserId 不能为空`);
  }

  // Run expectations: if declared, finalStatus must be valid.
  if (hg.run) {
    if (!["completed", "failed"].includes(hg.run.finalStatus)) {
      add("hard_grader_run_status", `场景 ${scenario.scenarioId} 的 hardGrader.run.finalStatus 无效`);
    }
    if (hg.run.maxSideEffects !== undefined) {
      if (!Number.isInteger(hg.run.maxSideEffects) || hg.run.maxSideEffects < 0) {
        add("hard_grader_max_side_effects", `场景 ${scenario.scenarioId} 的 hardGrader.run.maxSideEffects 必须为非负整数`);
      }
    }
  }

  // State constraints: validate path syntax and value shapes.
  const sc = hg.stateConstraints;
  if (sc) {
    validateStateAssertions(sc.required, "required", scenario.scenarioId, add);
    validateStateAssertions(sc.allowed, "allowed", scenario.scenarioId, add);
    validateStateAssertions(sc.forbidden, "forbidden", scenario.scenarioId, add);
    if (sc.unchanged) {
      for (const path of sc.unchanged) {
        if (typeof path !== "string" || !path.trim()) {
          add("hard_grader_unchanged", `场景 ${scenario.scenarioId} 的 stateConstraints.unchanged 包含空路径`);
        }
      }
    }
    // Contradiction check: a path cannot be both required and forbidden
    // with overlapping values.
    detectStateContradictions(sc, scenario.scenarioId, add);
  }

  // Milestone DAG: validate mode and milestones list.
  if (hg.milestoneDag) {
    validateMilestoneDag(hg.milestoneDag, scenario.scenarioId, add);
  }

  // Authority & safety: validate optional sub-constraints.
  const authority = hg.authoritySafety;
  if (authority) {
    if (authority.unknownSideEffects && !["fail_closed", "ignore"].includes(authority.unknownSideEffects)) {
      add("hard_grader_unknown_side_effects", `场景 ${scenario.scenarioId} 的 authoritySafety.unknownSideEffects 无效`);
    }
    if (authority.prohibitedCommitEffectTools) {
      for (const tool of authority.prohibitedCommitEffectTools) {
        if (typeof tool !== "string" || !tool.trim()) {
          add("hard_grader_prohibited_tools", `场景 ${scenario.scenarioId} 的 authoritySafety.prohibitedCommitEffectTools 包含空工具名`);
        }
      }
    }
    for (const effectType of authority.allowedSideEffectTypes ?? []) {
      if (typeof effectType !== "string" || !effectType.trim()) {
        add("hard_grader_allowed_effects", `场景 ${scenario.scenarioId} 的 allowedSideEffectTypes 包含空值`);
      }
    }
    // fail_closed mode requires a non-empty allowedSideEffectTypes list.
    // Otherwise the grader would have no allowlist to check against and
    // would silently skip, contradicting the explicit "fail_closed" intent.
    // See adversarial review finding M-01.
    const mode = authority.unknownSideEffects ?? "fail_closed";
    const hasAllowlist = Array.isArray(authority.allowedSideEffectTypes)
      && authority.allowedSideEffectTypes.length > 0;
    if (mode === "fail_closed" && !hasAllowlist) {
      add(
        "hard_grader_allowlist_required",
        `场景 ${scenario.scenarioId} 的 authoritySafety.unknownSideEffects="fail_closed" 必须声明非空 allowedSideEffectTypes, 否则未知副作用 grader 无 allowlist 可校验会静默 skip (fail-open)`,
      );
    }
  }

  // Privacy: if adversary-only constraints are declared, adversaryUserId
  // must be present.
  const priv = hg.privacy;
  if (priv) {
    const needsAdversary =
      priv.adversaryCannotSeeMemoryIds !== undefined
      || priv.adversaryCannotSeeConversationIds !== undefined
      || priv.subjectAndOwnerHiddenFromAdversary === true;
    if (needsAdversary && !hg.viewer.adversaryUserId) {
      add("hard_grader_adversary_missing", `场景 ${scenario.scenarioId} 的 privacy 约束需要 adversary, 但 viewer.adversaryUserId 未声明`);
    }
    if (priv.hiddenFieldTokens) {
      for (const token of priv.hiddenFieldTokens) {
        if (typeof token !== "string" || !token.trim()) {
          add("hard_grader_hidden_tokens", `场景 ${scenario.scenarioId} 的 privacy.hiddenFieldTokens 包含空 token`);
        }
      }
    }
    if (priv.hiddenFieldTokens && priv.hiddenFieldTokenDigests) {
      add("hard_grader_hidden_token_forms", `场景 ${scenario.scenarioId} 不能同时声明 hiddenFieldTokens 与 hiddenFieldTokenDigests`);
    }
  }

  // Read-only state purity: if true, requires a before snapshot at runtime.
  // (The runner is responsible for providing one; validation only checks
  // that the flag is a boolean.)
  if (hg.readOnlyStatePurity !== undefined && typeof hg.readOnlyStatePurity !== "boolean") {
    add("hard_grader_read_only", `场景 ${scenario.scenarioId} 的 hardGrader.readOnlyStatePurity 必须为 boolean`);
  }

  // Idempotency: repeats must be a positive integer.
  if (hg.idempotency) {
    if (!Number.isInteger(hg.idempotency.repeats) || hg.idempotency.repeats <= 0) {
      add("hard_grader_idempotency", `场景 ${scenario.scenarioId} 的 hardGrader.idempotency.repeats 必须为正整数`);
    }
    if (
      hg.idempotency.maxNewSideEffectsPerRepeat !== undefined
      && (!Number.isInteger(hg.idempotency.maxNewSideEffectsPerRepeat) || hg.idempotency.maxNewSideEffectsPerRepeat < 0)
    ) {
      add("hard_grader_idempotency_max", `场景 ${scenario.scenarioId} 的 hardGrader.idempotency.maxNewSideEffectsPerRepeat 必须为非负整数`);
    }
  }

  return errors;
}

function validateStateAssertions(
  assertions: StateAssertion[] | undefined,
  kind: string,
  scenarioId: string,
  add: (code: string, message: string) => void,
): void {
  if (!assertions) return;
  for (let i = 0; i < assertions.length; i++) {
    const a = assertions[i];
    if (!a) {
      add("hard_grader_state_assertion", `场景 ${scenarioId} 的 stateConstraints.${kind}[${i}] 缺失`);
      continue;
    }
    if (typeof a.path !== "string" || !a.path.trim()) {
      add("hard_grader_state_path", `场景 ${scenarioId} 的 stateConstraints.${kind}[${i}].path 不能为空`);
    }
    if (!Array.isArray(a.values) || a.values.length === 0) {
      add("hard_grader_state_values", `场景 ${scenarioId} 的 stateConstraints.${kind}[${i}].values 不能为空`);
    }
  }
}

function detectStateContradictions(
  sc: NonNullable<HardGraderContract["stateConstraints"]>,
  scenarioId: string,
  add: (code: string, message: string) => void,
): void {
  const required = sc.required ?? [];
  const forbidden = sc.forbidden ?? [];
  for (const req of required) {
    for (const forb of forbidden) {
      if (req.path !== forb.path) continue;
      for (const v of req.values) {
        if (forb.values.some((fv) => JSON.stringify(fv) === JSON.stringify(v))) {
          add(
            "hard_grader_state_contradiction",
            `场景 ${scenarioId} 的 stateConstraints 在路径 ${req.path} 上同时 required 和 forbidden 同一值 ${JSON.stringify(v)}`,
          );
        }
      }
    }
  }
}

function validateMilestoneDag(
  dag: MilestoneDag,
  scenarioId: string,
  add: (code: string, message: string) => void,
): void {
  if (!["strict", "unordered", "subset", "superset"].includes(dag.mode)) {
    add("hard_grader_dag_mode", `场景 ${scenarioId} 的 milestoneDag.mode 无效: ${dag.mode as string}`);
  }
  if (!Array.isArray(dag.nodes) || dag.nodes.length === 0) {
    add("hard_grader_dag_nodes", `场景 ${scenarioId} 的 milestoneDag.nodes 不能为空`);
    return;
  }
  const ids = new Set<string>();
  const matchers = new Set<string>();
  for (let i = 0; i < dag.nodes.length; i++) {
    const node = dag.nodes[i];
    if (!node || typeof node.id !== "string" || !node.id.trim()) {
      add("hard_grader_dag_node", `场景 ${scenarioId} 的 milestoneDag.nodes[${i}].id 不能为空`);
      continue;
    }
    if (ids.has(node.id)) {
      add("hard_grader_dag_duplicate_node", `场景 ${scenarioId} 的 milestoneDag node ID 重复: ${node.id}`);
    }
    ids.add(node.id);
    if (!(["event", "tool"] as string[]).includes(node.kind)) {
      add("hard_grader_dag_node_kind", `场景 ${scenarioId} 的 milestoneDag.nodes[${i}].kind 无效`);
    }
    if (typeof node.value !== "string" || !node.value.trim()) {
      add("hard_grader_dag_node_value", `场景 ${scenarioId} 的 milestoneDag.nodes[${i}].value 不能为空`);
    }
    const matcher = `${node.kind}:${node.value}`;
    if (matchers.has(matcher)) {
      add("hard_grader_dag_duplicate_matcher", `场景 ${scenarioId} 的 milestoneDag matcher 重复: ${matcher}`);
    }
    matchers.add(matcher);
  }
  if (!Array.isArray(dag.edges)) {
    add("hard_grader_dag_edges", `场景 ${scenarioId} 的 milestoneDag.edges 必须为数组`);
    return;
  }
  const adjacency = new Map<string, string[]>();
  for (const id of ids) adjacency.set(id, []);
  for (const edge of dag.edges ?? []) {
    if (!ids.has(edge.before) || !ids.has(edge.after)) {
      add("hard_grader_dag_edge_node", `场景 ${scenarioId} 的 milestoneDag edge 引用未知节点: ${edge.before} -> ${edge.after}`);
      continue;
    }
    if (edge.before === edge.after) {
      add("hard_grader_dag_self_edge", `场景 ${scenarioId} 的 milestoneDag 不允许自环: ${edge.before}`);
      continue;
    }
    adjacency.get(edge.before)?.push(edge.after);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (hasCycle(next)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if ([...ids].some((id) => hasCycle(id))) {
    add("hard_grader_dag_cycle", `场景 ${scenarioId} 的 milestoneDag 包含环`);
  }
}

function validateBudget(budget: EvaluationBudget, scenarios: ScenarioContract[], preset?: string): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const add = (code: string, message: string) => errors.push({ code, message });
  const positiveFields: Array<[keyof EvaluationBudget, number]> = [
    ["maxSutCostUsd", budget.maxSutCostUsd],
    ["maxInputTokens", budget.maxInputTokens],
    ["maxOutputTokens", budget.maxOutputTokens],
    ["maxRequestCount", budget.maxRequestCount],
    ["maxWallTimeMs", budget.maxWallTimeMs],
    ["maxObservations", budget.maxObservations],
  ];
  for (const [field, value] of positiveFields) {
    if (!Number.isFinite(value) || value <= 0) {
      add("budget_value", `预算字段 ${field} 必须为正数`);
    }
  }
  for (const field of ["maxInputTokens", "maxOutputTokens", "maxRequestCount", "maxWallTimeMs", "maxObservations"] as const) {
    if (!Number.isInteger(budget[field])) {
      add("budget_integer", `预算字段 ${field} 必须为整数`);
    }
  }
  // T46-3 (Issue #96): preset-aware cost cap.
  //   - smoke / smoke-v2 / demo: maxSutCostUsd ≤ $0.10 (Slice 0 handoff).
  //   - full: maxSutCostUsd ≤ $1.00 (Slice 0 handoff: full $1).
  //   - calibrate (T46-5, Issue #98): maxSutCostUsd ≤ $3.00. The SUT cap
  //     covers ONLY ProjectFlow Agent cost; evaluator Judge/simulator
  //     cost lives under its OWN ceiling (see validateCalibrateBudget).
  //   - golden-core (T46-6, Issue #99): maxSutCostUsd ≤ $1.00 (same as
  //     `full` per §7). The Golden Core suite reuses `full`'s SUT cap
  //     because it runs the same canonical scenarios that `full`
  //     observes, plus optional robustness variants. Evaluator
  //     Judge/simulator cost stays under its own ceiling.
  // The cap is enforced per-preset so `full` can run more scenarios
  // without tripping the smoke budget guard.
  const isFullPreset = preset === "full";
  const isGoldenCorePreset = preset === "golden-core";
  const isCalibratePreset = preset === "calibrate";
  const costCap = isCalibratePreset ? 3.00 : (isFullPreset || isGoldenCorePreset) ? 1.00 : 0.10;
  const costCapLabel = isCalibratePreset ? "calibrate" : (isFullPreset || isGoldenCorePreset) ? "full/golden-core" : "smoke/demo";
  if (budget.maxSutCostUsd > costCap) {
    add("budget_preset_cost", `${costCapLabel} 的 ProjectFlow Agent 成本上限不得超过 $${costCap.toFixed(2)}`);
  }
  if (scenarios.length > budget.maxObservations) {
    add("budget_observations", "场景数量超过 maxObservations");
  }
  for (const scenario of scenarios) {
    if (scenario.hidden.maxLatencyMs > budget.maxWallTimeMs) {
      add("budget_wall_time", `场景 ${scenario.scenarioId} 的延迟上限超过 run wall-time 上限`);
    }
    if (scenario.hidden.maxRequestCount > budget.maxRequestCount) {
      add("budget_requests", `场景 ${scenario.scenarioId} 的请求上限超过 run 请求上限`);
    }
    if (scenario.hidden.tokenBudget.maxInputTokens > budget.maxInputTokens) {
      add("budget_input_tokens", `场景 ${scenario.scenarioId} 的输入 Token 上限超过 run 上限`);
    }
    if (scenario.hidden.tokenBudget.maxOutputTokens > budget.maxOutputTokens) {
      add("budget_output_tokens", `场景 ${scenario.scenarioId} 的输出 Token 上限超过 run 上限`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// T46-5 (Issue #98 §7) — Calibrate budget validation.
//
// The calibrate preset has a SUT cap ($3) AND an independent evaluator
// ceiling (max calls/tokens/time/dollars). Evaluator budget exhaustion
// stops NEW Judge calls but preserves completed evidence.
//
// Cost provenance MUST be one of: provider_reported,
// versioned_price_estimate, unknown. Unknown cost MUST NOT be displayed
// as $0. Coding Agent cost stays external/unknown and is NOT counted
// against the SUT cap.
// ---------------------------------------------------------------------------

import type { CalibrateBudget, CalibrationCostProvenance } from "./calibration-contract.js";

/** Validate a calibrate budget. Returns violations (empty = OK). */
export function validateCalibrateBudget(budget: CalibrateBudget): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const add = (code: string, message: string) => errors.push({ code, message });

  // §1 SUT cap: $3.00 hard ceiling per Issue #98 §7.
  if (!Number.isFinite(budget.sut.maxSutCostUsd) || budget.sut.maxSutCostUsd <= 0) {
    add("calibrate_sut_cost", "calibrate sut.maxSutCostUsd 必须为正数");
  } else if (budget.sut.maxSutCostUsd > 3.00) {
    add(
      "calibrate_sut_cap",
      `calibrate sut.maxSutCostUsd 不得超过 $3.00, 实际 $${budget.sut.maxSutCostUsd.toFixed(2)}`,
    );
  }
  // §2 SUT integer fields.
  for (const field of ["maxInputTokens", "maxOutputTokens", "maxRequestCount", "maxWallTimeMs", "maxObservations"] as const) {
    if (!Number.isInteger(budget.sut[field]) || budget.sut[field] <= 0) {
      add("calibrate_sut_integer", `calibrate sut.${field} 必须为正整数`);
    }
  }

  // §3 Evaluator ceiling: independent of SUT cap. All fields required.
  if (!Number.isInteger(budget.evaluator.maxCalls) || budget.evaluator.maxCalls <= 0) {
    add("calibrate_eval_calls", "calibrate evaluator.maxCalls 必须为正整数");
  }
  if (!Number.isInteger(budget.evaluator.maxInputTokens) || budget.evaluator.maxInputTokens <= 0) {
    add("calibrate_eval_input_tokens", "calibrate evaluator.maxInputTokens 必须为正整数");
  }
  if (!Number.isInteger(budget.evaluator.maxOutputTokens) || budget.evaluator.maxOutputTokens <= 0) {
    add("calibrate_eval_output_tokens", "calibrate evaluator.maxOutputTokens 必须为正整数");
  }
  if (!Number.isInteger(budget.evaluator.maxWallTimeMs) || budget.evaluator.maxWallTimeMs <= 0) {
    add("calibrate_eval_wall_time", "calibrate evaluator.maxWallTimeMs 必须为正整数");
  }
  if (
    !Number.isFinite(budget.evaluator.maxMeasurableDollars)
    || budget.evaluator.maxMeasurableDollars <= 0
  ) {
    add("calibrate_eval_dollars", "calibrate evaluator.maxMeasurableDollars 必须为正数");
  }

  // §4 Coding Agent cost source: must be external/unknown.
  if (budget.codingAgent.costSource !== "external" && budget.codingAgent.costSource !== "unknown") {
    add(
      "calibrate_coding_agent_source",
      `calibrate codingAgent.costSource 必须为 external 或 unknown, 实际 ${budget.codingAgent.costSource}`,
    );
  }
  return errors;
}

/** Validate a cost provenance value. Returns violation message or null. */
export function validateCostProvenance(
  provenance: string,
  amountUsd: number | null,
): ValidationIssue | null {
  const valid: CalibrationCostProvenance[] = ["provider_reported", "versioned_price_estimate", "unknown"];
  if (!valid.includes(provenance as CalibrationCostProvenance)) {
    return {
      code: "cost_provenance_invalid",
      message: `cost provenance 非法: ${provenance}; 只允许 ${valid.join(", ")}`,
    };
  }
  // Unknown cost MUST NOT be displayed as $0.
  if (provenance === "unknown" && amountUsd === 0) {
    return {
      code: "cost_provenance_unknown_zero",
      message: "cost provenance=unknown 但 amountUsd=0; unknown cost 不得显示为 $0",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// T46-5 (Issue #98 §1) — Registry schema validation.
//
// Unsupported future registry schema versions MUST fail-closed.
// ---------------------------------------------------------------------------

import {
  STANDARDS_REGISTRY_SCHEMA_VERSION,
  CALIBRATION_ARTIFACT_SCHEMA_VERSION,
  SEMANTIC_RUBRIC_SCHEMA_VERSION,
  SEMANTIC_ANCHOR_SCHEMA_VERSION,
  JUDGE_MANIFEST_SCHEMA_VERSION,
  STANDARD_DIFF_SCHEMA_VERSION,
  PROMOTION_APPROVAL_SCHEMA_VERSION,
} from "./calibration-contract.js";

/** Assert that a registry schema version is supported. Fail-closed. */
export function assertSupportedStandardsRegistrySchema(version: number): void {
  if (version !== STANDARDS_REGISTRY_SCHEMA_VERSION) {
    throw new Error(
      `unsupported standards registry schema version: ${version}; current version is ${STANDARDS_REGISTRY_SCHEMA_VERSION}`,
    );
  }
}

/** Assert that a calibration artifact schema version is supported. */
export function assertSupportedCalibrationArtifactSchema(version: number): void {
  if (version !== CALIBRATION_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(
      `unsupported calibration artifact schema version: ${version}; current version is ${CALIBRATION_ARTIFACT_SCHEMA_VERSION}`,
    );
  }
}

/** Assert that a semantic rubric schema version is supported. */
export function assertSupportedSemanticRubricSchema(version: number): void {
  if (version !== SEMANTIC_RUBRIC_SCHEMA_VERSION) {
    throw new Error(
      `unsupported semantic rubric schema version: ${version}; current version is ${SEMANTIC_RUBRIC_SCHEMA_VERSION}`,
    );
  }
}

/** Assert that a semantic anchor schema version is supported. */
export function assertSupportedSemanticAnchorSchema(version: number): void {
  if (version !== SEMANTIC_ANCHOR_SCHEMA_VERSION) {
    throw new Error(
      `unsupported semantic anchor schema version: ${version}; current version is ${SEMANTIC_ANCHOR_SCHEMA_VERSION}`,
    );
  }
}

/** Assert that a judge manifest schema version is supported. */
export function assertSupportedJudgeManifestSchema(version: number): void {
  if (version !== JUDGE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `unsupported judge manifest schema version: ${version}; current version is ${JUDGE_MANIFEST_SCHEMA_VERSION}`,
    );
  }
}

/** Assert that a standard diff schema version is supported. */
export function assertSupportedStandardDiffSchema(version: number): void {
  if (version !== STANDARD_DIFF_SCHEMA_VERSION) {
    throw new Error(
      `unsupported standard diff schema version: ${version}; current version is ${STANDARD_DIFF_SCHEMA_VERSION}`,
    );
  }
}

/** Assert that a promotion approval schema version is supported. */
export function assertSupportedPromotionApprovalSchema(version: number): void {
  if (version !== PROMOTION_APPROVAL_SCHEMA_VERSION) {
    throw new Error(
      `unsupported promotion approval schema version: ${version}; current version is ${PROMOTION_APPROVAL_SCHEMA_VERSION}`,
    );
  }
}

interface ModelConfigFile {
  models?: Array<{
    id?: string;
    provider?: string;
    name?: string;
    displayName?: string;
    apiKeyEnvVar?: string;
    isDefault?: boolean;
    capabilities?: unknown;
  }>;
}

async function validateModel(projectRoot: string, model: string): Promise<ValidationIssue[]> {
  const errors: ValidationIssue[] = [];
  const separator = model.indexOf(":");
  if (separator <= 0 || separator === model.length - 1) {
    return [{ code: "model_ref", message: `模型引用 ${JSON.stringify(model)} 必须使用 provider:name 格式` }];
  }
  const provider = model.slice(0, separator);
  const name = model.slice(separator + 1);
  const path = join(projectRoot, "agent-bridge", "model-configs.json");
  let parsed: ModelConfigFile;
  try {
    parsed = JSON.parse(await readFile(path, "utf-8")) as ModelConfigFile;
  } catch (error) {
    return [{ code: "model_config", message: `无法读取 model-configs.json: ${(error as Error).message}` }];
  }
  if (!Array.isArray(parsed.models)) {
    return [{ code: "model_config_schema", message: "model-configs.json 缺少 models 数组" }];
  }
  if (parsed.models.length === 0) {
    return [{ code: "model_config_schema", message: "model-configs.json 的 models 不能为空" }];
  }
  const ids = new Set<string>();
  const refs = new Set<string>();
  for (const [index, candidate] of parsed.models.entries()) {
    if (
      typeof candidate.id !== "string" || !candidate.id
      || typeof candidate.provider !== "string" || !candidate.provider
      || typeof candidate.name !== "string" || !candidate.name
      || typeof candidate.displayName !== "string" || !candidate.displayName
      || typeof candidate.apiKeyEnvVar !== "string"
      || typeof candidate.isDefault !== "boolean"
      || !candidate.capabilities || typeof candidate.capabilities !== "object"
    ) {
      errors.push({ code: "model_config_schema", message: `models[${index}] 字段结构不完整` });
      continue;
    }
    const ref = `${candidate.provider}:${candidate.name}`;
    if (ids.has(candidate.id)) {
      errors.push({ code: "model_config_duplicate", message: `模型配置 ID 重复: ${candidate.id}` });
    }
    if (refs.has(ref)) {
      errors.push({ code: "model_config_duplicate", message: `模型引用重复: ${ref}` });
    }
    ids.add(candidate.id);
    refs.add(ref);
  }
  if (parsed.models.filter((candidate) => candidate.isDefault).length !== 1) {
    errors.push({ code: "model_config_default", message: "model-configs.json 必须声明且只声明一个默认模型" });
  }
  const entry = parsed.models.find((candidate) => candidate.provider === provider && candidate.name === name);
  if (!entry) {
    errors.push({ code: "model_unknown", message: `模型 ${model} 未在 model-configs.json 注册` });
    return errors;
  }
  if (provider !== "mock") {
    errors.push({
      code: "paid_model_unbounded",
      message: `Slice 0 尚无 ${model} 的冻结价格表与调用前最坏成本预估，拒绝启动付费模型`,
    });
  }
  return errors;
}

async function validateToolchain(projectRoot: string): Promise<ValidationIssue[]> {
  const errors: ValidationIssue[] = [];
  if (process.versions.node !== "24.15.0") {
    errors.push({ code: "node_version", message: `Node.js ${process.versions.node} 不匹配，必须使用仓库锁定版本 24.15.0` });
  }
  const python = join(projectRoot, "backend", ".venv", "bin", "python");
  try {
    await access(python, constants.X_OK);
  } catch {
    errors.push({ code: "python_venv", message: "缺少可执行的 backend/.venv/bin/python" });
  }
  const tsx = join(projectRoot, "agent-bridge", "node_modules", ".bin", "tsx");
  try {
    await access(tsx, constants.X_OK);
  } catch {
    errors.push({ code: "tsx_runtime", message: "agent-bridge 本地 tsx 不可用，请先安装锁定依赖" });
  }
  return errors;
}

export async function validateEvaluationConfig(options: {
  projectRoot: string;
  model: string;
  scenarios: ScenarioContract[];
  budget: EvaluationBudget;
  /** Optional preset name, used to apply preset-specific budget caps.
   *  When omitted, the smoke/demo $0.10 cap is enforced. */
  preset?: string;
  /** Optional calibrate budget (required when preset="calibrate").
   *  Validates the independent evaluator ceiling and SUT cap. */
  calibrateBudget?: CalibrateBudget;
}): Promise<ValidationResult> {
  const scenarioErrors = options.scenarios.flatMap(validateScenario);
  const duplicateIds = options.scenarios
    .map((scenario) => scenario.scenarioId)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    scenarioErrors.push({ code: "scenario_duplicate", message: `场景 ID 重复: ${[...new Set(duplicateIds)].join(", ")}` });
  }
  const budgetErrors = validateBudget(options.budget, options.scenarios, options.preset);
  // T46-5: when preset="calibrate", the calibrate budget MUST be provided
  // and must pass its own validation (SUT $3 cap + evaluator ceiling +
  // coding agent external/unknown).
  const calibrateBudgetErrors: ValidationIssue[] = [];
  if (options.preset === "calibrate") {
    if (!options.calibrateBudget) {
      calibrateBudgetErrors.push({
        code: "calibrate_budget_missing",
        message: "calibrate preset 必须提供 calibrateBudget (含 evaluator 独立上限)",
      });
    } else {
      calibrateBudgetErrors.push(...validateCalibrateBudget(options.calibrateBudget));
    }
  }
  const modelErrors = await validateModel(options.projectRoot, options.model);
  const toolchainErrors = await validateToolchain(options.projectRoot);
  const errors = [
    ...scenarioErrors,
    ...budgetErrors,
    ...calibrateBudgetErrors,
    ...modelErrors,
    ...toolchainErrors,
  ];
  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    valid: errors.length === 0,
    model: options.model,
    scenarioCount: options.scenarios.length,
    checks: {
      scenarioContracts: scenarioErrors.length === 0,
      budgetCompatibility: budgetErrors.length === 0 && calibrateBudgetErrors.length === 0,
      modelCompatibility: modelErrors.length === 0,
      toolchain: toolchainErrors.length === 0,
    },
    errors,
  };
}

function git(projectRoot: string, args: string[]): Buffer {
  return execFileSync("git", ["-C", projectRoot, ...args], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function collectCodeFingerprint(projectRoot: string): CodeFingerprint {
  const commit = git(projectRoot, ["rev-parse", "HEAD"]).toString("utf-8").trim();
  const status = git(projectRoot, ["status", "--porcelain=v1", "-z"]);
  const trackedDiff = git(projectRoot, ["diff", "--binary", "HEAD"]);
  const untracked = git(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
    .toString("utf-8")
    .split("\0")
    .filter(Boolean)
    .sort();
  const untrackedHashes = untracked.map((path) => {
    const absolute = resolve(projectRoot, path);
    if (!isAbsolute(absolute) || relative(projectRoot, absolute).startsWith("..")) {
      throw new Error(`无法对工作树外文件生成指纹: ${path}`);
    }
    const stat = lstatSync(absolute);
    const content = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
    return `${path}:${sha256(content)}`;
  });
  const fingerprint = Buffer.concat([
    Buffer.from(commit),
    status,
    trackedDiff,
    Buffer.from(untrackedHashes.join("\n")),
  ]);
  return {
    gitCommit: commit,
    gitDirty: status.length > 0,
    worktreeSha256: sha256(fingerprint),
  };
}

export async function buildProvenance(options: {
  projectRoot: string;
  scenarios: ScenarioContract[];
}): Promise<EvaluationProvenance> {
  const modelConfigRaw = await readFile(join(options.projectRoot, "agent-bridge", "model-configs.json"));
  return {
    evaluatorVersion: EVALUATOR_VERSION,
    publicSeamVersion: "http-sse-v1",
    platform: platform(),
    architecture: arch(),
    nodeVersion: process.versions.node,
    code: collectCodeFingerprint(options.projectRoot),
    scenarioContractsSha256: sha256(stableStringify(options.scenarios)),
    modelConfigSha256: sha256(modelConfigRaw),
  };
}
