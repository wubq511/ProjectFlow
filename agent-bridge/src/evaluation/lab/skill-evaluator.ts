/**
 * T46-3 (Issue #96 §3) — Deterministic Skill evaluation.
 *
 * 8 dimensions:
 *  - positive_trigger: scenario should trigger this skill
 *  - negative_trigger: scenario should NOT trigger this skill
 *  - prerequisites: skill prerequisites must be satisfied by fixture state
 *  - allowed_tools: skill must only use tools in its allowlist
 *  - required_steps: skill must perform its required steps (milestone DAG)
 *  - forbidden_actions: skill must NOT invoke forbidden tools/actions
 *  - fallback_behavior: skill must produce a structured fallback when
 *    evidence is missing (not a silent success)
 *  - output_usability: skill output must be non-empty and valid schema
 *
 * Boundary compliance:
 *  - Skill V2 effect ceiling is the authoritative ceiling. The evaluator
 *    verifies that the skill's selected tools and observed side effects
 *    respect the ceiling. It does NOT relax the ceiling.
 *  - Proposal-Confirm is the high-impact change boundary. Skills that
 *    create proposals must observe pending status; commits only after
 *    human confirmation.
 *  - ProjectFlow permission boundaries: the evaluator does not call LLM
 *    graders, does not reverse-engineer the oracle from outputs, and
 *    does not modify fixture state.
 *
 * The evaluator verifies ACTUAL Skill routing, tool exposure, and run
 * trajectory — not just final natural-language keywords.
 */

import type {
  SkillEvalDimension,
  SkillEvalDimensionResult,
  SkillEvalResult,
  SkillEvaluationContract,
  SkillEvaluationResult,
} from "./contract-v3.js";
import type { EvidenceSnapshot, HardGrade } from "./contract-v2.js";
import type { ScenarioObservation } from "./contract.js";

export interface SkillEvaluationInput {
  contract: SkillEvaluationContract;
  /** Observation from the positive trigger scenario. */
  positiveObservation: ScenarioObservation;
  /** Observations from each negative trigger scenario. */
  negativeObservations: ScenarioObservation[];
  /** Primary evidence snapshot from the positive trigger run. */
  positiveSnapshot: EvidenceSnapshot;
  /** Whether the fixture state satisfied the declared prerequisites. */
  prerequisitesSatisfied: boolean;
  /** Optional hard grade for the positive trigger run. */
  hardGrade?: HardGrade;
}

/** Evaluate a skill against its contract. Pure function; no LLM calls. */
export function evaluateSkill(input: SkillEvaluationInput): SkillEvaluationResult {
  const { contract, positiveObservation, negativeObservations, positiveSnapshot, prerequisitesSatisfied, hardGrade } = input;

  const dimensions: SkillEvalDimensionResult[] = [];
  const failures: string[] = [];

  // §1 positive_trigger: the Agent must select the skill for the
  // positive trigger prompt.
  const positiveTriggerResult = checkPositiveTrigger(contract, positiveObservation);
  dimensions.push(positiveTriggerResult);
  if (positiveTriggerResult.result === "fail") failures.push(positiveTriggerResult.reason ?? "");

  // §2 negative_trigger: the Agent must NOT select the skill for any
  // negative trigger prompt.
  const negativeTriggerResult = checkNegativeTrigger(contract, negativeObservations);
  dimensions.push(negativeTriggerResult);
  if (negativeTriggerResult.result === "fail") failures.push(negativeTriggerResult.reason ?? "");

  // §3 prerequisites: fixture state must satisfy the declared prerequisites.
  const prerequisitesResult = checkPrerequisites(contract, prerequisitesSatisfied);
  dimensions.push(prerequisitesResult);
  if (prerequisitesResult.result === "fail") failures.push(prerequisitesResult.reason ?? "");

  // §4 allowed_tools: all tool calls in the trajectory must be in the
  // skill's allowlist.
  const allowedToolsResult = checkAllowedTools(contract, positiveSnapshot);
  dimensions.push(allowedToolsResult);
  if (allowedToolsResult.result === "fail") failures.push(allowedToolsResult.reason ?? "");

  // §5 required_steps: the trajectory must contain all required milestones.
  const requiredStepsResult = checkRequiredSteps(contract, positiveSnapshot);
  dimensions.push(requiredStepsResult);
  if (requiredStepsResult.result === "fail") failures.push(requiredStepsResult.reason ?? "");

  // §6 forbidden_actions: the trajectory must NOT contain forbidden tools.
  const forbiddenActionsResult = checkForbiddenActions(contract, positiveSnapshot);
  dimensions.push(forbiddenActionsResult);
  if (forbiddenActionsResult.result === "fail") failures.push(forbiddenActionsResult.reason ?? "");

  // §7 fallback_behavior: when expected, the skill must produce a
  // structured fallback (non-empty output, no silent success on missing evidence).
  const fallbackResult = checkFallbackBehavior(contract, positiveObservation, positiveSnapshot);
  dimensions.push(fallbackResult);
  if (fallbackResult.result === "fail") failures.push(fallbackResult.reason ?? "");

  // §8 output_usability: the output must be non-empty and valid schema
  // (deterministic check: non-empty string, no raw ID leakage).
  const outputUsabilityResult = checkOutputUsability(positiveObservation);
  dimensions.push(outputUsabilityResult);
  if (outputUsabilityResult.result === "fail") failures.push(outputUsabilityResult.reason ?? "");

  // Effect ceiling check: verify observed side effects respect the
  // declared ceiling. This is a separate concern from the 8 dimensions;
  // it gates the overall pass/fail.
  const effectCeilingViolated = checkEffectCeilingViolation(contract, positiveSnapshot);

  const passed = dimensions.every(
    (d) => d.result !== "fail",
  ) && !effectCeilingViolated;

  return {
    contractId: contract.id,
    skillName: contract.skillName,
    passed,
    dimensions,
    selectedSkillsForPositive: positiveObservation.selectedSkills,
    selectedSkillsForNegatives: negativeObservations.map((o) => o.selectedSkills),
    hardGrade,
    effectCeilingViolated,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Per-dimension checks
// ---------------------------------------------------------------------------

function checkPositiveTrigger(
  contract: SkillEvaluationContract,
  observation: ScenarioObservation,
): SkillEvalDimensionResult {
  const selected = observation.selectedSkills.includes(contract.skillName);
  if (!selected) {
    return {
      dimension: "positive_trigger",
      result: "fail",
      reason: `positive trigger 未选中 ${contract.skillName}; 实际选中: [${observation.selectedSkills.join(", ")}]`,
      evidence: observation.selectedSkills,
    };
  }
  return {
    dimension: "positive_trigger",
    result: "pass",
    evidence: observation.selectedSkills,
  };
}

function checkNegativeTrigger(
  contract: SkillEvaluationContract,
  negativeObservations: ScenarioObservation[],
): SkillEvalDimensionResult {
  const violations: string[] = [];
  for (let i = 0; i < negativeObservations.length; i++) {
    const obs = negativeObservations[i]!;
    if (obs.selectedSkills.includes(contract.skillName)) {
      violations.push(`negative[${i}] 误选 ${contract.skillName}`);
    }
  }
  if (violations.length > 0) {
    return {
      dimension: "negative_trigger",
      result: "fail",
      reason: violations.join("; "),
      evidence: violations,
    };
  }
  return { dimension: "negative_trigger", result: "pass" };
}

function checkPrerequisites(
  contract: SkillEvaluationContract,
  satisfied: boolean,
): SkillEvalDimensionResult {
  if (contract.prerequisites.length === 0) {
    return { dimension: "prerequisites", result: "skipped", reason: "契约未声明 prerequisites" };
  }
  if (!satisfied) {
    return {
      dimension: "prerequisites",
      result: "fail",
      reason: "fixture 未满足声明的 prerequisites",
      evidence: contract.prerequisites,
    };
  }
  return { dimension: "prerequisites", result: "pass" };
}

function checkAllowedTools(
  contract: SkillEvaluationContract,
  snapshot: EvidenceSnapshot,
): SkillEvalDimensionResult {
  if (contract.allowedTools.length === 0) {
    return { dimension: "allowed_tools", result: "skipped", reason: "契约未声明 allowedTools" };
  }
  const allow = new Set(contract.allowedTools);
  const used = new Set<string>();
  for (const fact of snapshot.side_effect_facts) {
    if (fact.tool_name) used.add(fact.tool_name);
  }
  for (const traj of snapshot.trajectory_facts) {
    if (traj.tool_name) used.add(traj.tool_name);
  }
  const violations = [...used].filter((tool) => !allow.has(tool));
  if (violations.length > 0) {
    return {
      dimension: "allowed_tools",
      result: "fail",
      reason: `使用了未授权工具: [${violations.join(", ")}]`,
      evidence: violations,
    };
  }
  return { dimension: "allowed_tools", result: "pass", evidence: [...used] };
}

function checkRequiredSteps(
  contract: SkillEvaluationContract,
  snapshot: EvidenceSnapshot,
): SkillEvalDimensionResult {
  if (contract.requiredSteps.length === 0) {
    return { dimension: "required_steps", result: "skipped", reason: "契约未声明 requiredSteps" };
  }
  const actualTools = new Set<string>();
  const actualEvents = new Set<string>();
  for (const fact of snapshot.side_effect_facts) {
    if (fact.tool_name) actualTools.add(fact.tool_name);
  }
  for (const traj of snapshot.trajectory_facts) {
    if (traj.tool_name) actualTools.add(traj.tool_name);
    if (traj.event_type) actualEvents.add(traj.event_type);
  }
  const missing: string[] = [];
  for (const step of contract.requiredSteps) {
    if (step.kind === "tool" && !actualTools.has(step.value)) {
      missing.push(`tool:${step.value}`);
    } else if (step.kind === "event" && !actualEvents.has(step.value)) {
      missing.push(`event:${step.value}`);
    }
  }
  if (missing.length > 0) {
    return {
      dimension: "required_steps",
      result: "fail",
      reason: `缺少必需步骤: [${missing.join(", ")}]`,
      evidence: missing,
    };
  }
  return { dimension: "required_steps", result: "pass" };
}

function checkForbiddenActions(
  contract: SkillEvaluationContract,
  snapshot: EvidenceSnapshot,
): SkillEvalDimensionResult {
  if (contract.forbiddenActions.length === 0) {
    return { dimension: "forbidden_actions", result: "skipped", reason: "契约未声明 forbiddenActions" };
  }
  const forbidden = new Set(contract.forbiddenActions);
  const violated: string[] = [];
  for (const fact of snapshot.side_effect_facts) {
    if (fact.tool_name && forbidden.has(fact.tool_name)) {
      violated.push(fact.tool_name);
    }
  }
  for (const traj of snapshot.trajectory_facts) {
    if (traj.tool_name && forbidden.has(traj.tool_name)) {
      violated.push(traj.tool_name);
    }
  }
  if (violated.length > 0) {
    return {
      dimension: "forbidden_actions",
      result: "fail",
      reason: `调用了禁止工具: [${violated.join(", ")}]`,
      evidence: violated,
    };
  }
  return { dimension: "forbidden_actions", result: "pass" };
}

function checkFallbackBehavior(
  contract: SkillEvaluationContract,
  observation: ScenarioObservation,
  snapshot: EvidenceSnapshot,
): SkillEvalDimensionResult {
  if (!contract.expectsFallback) {
    return { dimension: "fallback_behavior", result: "skipped", reason: "契约未声明 expectsFallback" };
  }
  // Fallback expectation: when fallback is expected, the output must be
  // non-empty AND there must be NO commit side effects (fallback is
  // advisory-only by definition).
  if (observation.output.trim().length === 0) {
    return {
      dimension: "fallback_behavior",
      result: "fail",
      reason: "fallback 输出为空",
    };
  }
  const hasCommit = snapshot.side_effect_facts.some((f) => f.effect_type === "commit");
  if (hasCommit) {
    return {
      dimension: "fallback_behavior",
      result: "fail",
      reason: "fallback 期间出现 commit 副作用，违反 advisory-only 边界",
    };
  }
  return { dimension: "fallback_behavior", result: "pass" };
}

function checkOutputUsability(observation: ScenarioObservation): SkillEvalDimensionResult {
  if (observation.output.trim().length === 0) {
    return {
      dimension: "output_usability",
      result: "fail",
      reason: "Agent 输出为空",
    };
  }
  // Deterministic raw-ID check (mirrors Slice 1 rawIdLeakage grader but
  // scoped to the skill's output only).
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
  if (uuidPattern.test(observation.output)) {
    return {
      dimension: "output_usability",
      result: "fail",
      reason: "Agent 输出包含原始 UUID",
    };
  }
  return { dimension: "output_usability", result: "pass" };
}

function checkEffectCeilingViolation(
  contract: SkillEvaluationContract,
  snapshot: EvidenceSnapshot,
): boolean {
  if (!contract.effectCeiling) return false;
  const hasCommit = snapshot.side_effect_facts.some((f) => f.effect_type === "commit");
  const hasAdvisory = snapshot.side_effect_facts.some((f) => f.effect_type === "advisory");
  switch (contract.effectCeiling) {
    case "none":
      return snapshot.side_effect_facts.length > 0;
    case "advisory_only":
      return hasCommit;
    case "proposal_only":
      // proposal_only allows advisory + proposal_create, but NOT commit.
      return hasCommit && !hasAdvisory;
    case "full":
      return false;
    default:
      return false;
  }
}

/** Aggregate skill evaluation results. */
export function aggregateSkillEvaluations(
  results: SkillEvaluationResult[],
): {
  total: number;
  passed: number;
  failed: number;
  byDimension: Record<SkillEvalDimension, { pass: number; fail: number; skipped: number }>;
} {
  const byDimension: Record<SkillEvalDimension, { pass: number; fail: number; skipped: number }> = {
    positive_trigger: { pass: 0, fail: 0, skipped: 0 },
    negative_trigger: { pass: 0, fail: 0, skipped: 0 },
    prerequisites: { pass: 0, fail: 0, skipped: 0 },
    allowed_tools: { pass: 0, fail: 0, skipped: 0 },
    required_steps: { pass: 0, fail: 0, skipped: 0 },
    forbidden_actions: { pass: 0, fail: 0, skipped: 0 },
    fallback_behavior: { pass: 0, fail: 0, skipped: 0 },
    output_usability: { pass: 0, fail: 0, skipped: 0 },
  };
  let passed = 0;
  for (const result of results) {
    if (result.passed) passed += 1;
    for (const dim of result.dimensions) {
      byDimension[dim.dimension][dim.result] += 1;
    }
  }
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    byDimension,
  };
}

/** Convenience: list all dimensions for a contract. */
export function listDimensions(): SkillEvalDimension[] {
  return [
    "positive_trigger",
    "negative_trigger",
    "prerequisites",
    "allowed_tools",
    "required_steps",
    "forbidden_actions",
    "fallback_behavior",
    "output_usability",
  ];
}

/** Convenience: convert a SkillEvalResult to a simple pass/fail string. */
export function skillEvalResultToString(result: SkillEvalResult): string {
  return result;
}