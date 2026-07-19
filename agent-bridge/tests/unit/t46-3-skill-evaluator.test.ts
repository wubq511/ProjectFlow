/**
 * T46-3 (Issue #96 §3) — Skill evaluation tests.
 *
 * Verifies all 8 dimensions:
 *  1. positive_trigger: scenario should trigger this skill
 *  2. negative_trigger: scenario should NOT trigger this skill
 *  3. prerequisites: skill prerequisites must be satisfied by fixture state
 *  4. allowed_tools: skill must only use tools in its allowlist
 *  5. required_steps: skill must perform its required steps (milestone DAG)
 *  6. forbidden_actions: skill must NOT invoke forbidden tools/actions
 *  7. fallback_behavior: skill must produce a structured fallback
 *  8. output_usability: skill output must be non-empty and valid schema
 *
 * Also verifies:
 *  - Effect ceiling violations gate the overall pass/fail.
 *  - Skill V2 effect ceiling is the authoritative ceiling (not relaxed).
 *  - The evaluator verifies ACTUAL Skill routing and trajectory, not just
 *    final natural-language keywords.
 *  - Proposal-Confirm boundary is respected (proposal_only ceiling rejects
 *    commit side effects).
 */

import { describe, expect, it } from "vitest";
import {
  evaluateSkill,
  aggregateSkillEvaluations,
  listDimensions,
  skillEvalResultToString,
} from "../../src/evaluation/lab/skill-evaluator.js";
import type { SkillEvaluationContract } from "../../src/evaluation/lab/contract-v3.js";
import type { EvidenceSnapshot, HardGrade } from "../../src/evaluation/lab/contract-v2.js";
import type { ScenarioObservation } from "../../src/evaluation/lab/contract.js";

function buildContract(overrides: Partial<SkillEvaluationContract> = {}): SkillEvaluationContract {
  return {
    id: "skill-eval-test-001",
    skillName: "project-planning",
    positiveTriggerPrompt: "根据当前项目生成阶段计划草案",
    negativeTriggerPrompts: ["当前项目进展如何？"],
    prerequisites: ["has_direction_card"],
    allowedTools: ["generate_stage_plan_proposal", "get_project_state"],
    requiredSteps: [
      { kind: "tool", value: "generate_stage_plan_proposal" },
      { kind: "event", value: "run.completed" },
    ],
    forbiddenActions: ["finalize_assignment"],
    expectsFallback: false,
    effectCeiling: "proposal_only",
    ...overrides,
  };
}

function buildObservation(overrides: Partial<ScenarioObservation> = {}): ScenarioObservation {
  return {
    schemaVersion: 1,
    scenarioId: "scn-001",
    timestamp: "2026-07-19T00:00:00.000Z",
    routedMode: "action",
    selectedSkills: ["project-planning"],
    evidence: [],
    terminalStatus: "completed",
    latencyMs: 5_000,
    inputTokens: 100,
    outputTokens: 200,
    requestCount: 2,
    costs: {
      sutCost: { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: true },
      evaluatorModelCost: { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: false },
      codingAgentCost: { amountUsd: null, source: "unknown", countedAgainstSutCap: false },
    },
    output: "已生成阶段计划草案。",
    ...overrides,
  };
}

function buildSnapshot(overrides: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot {
  return {
    scenarioId: "scn-001",
    side_effect_facts: [
      { effect_type: "proposal_create", tool_name: "generate_stage_plan_proposal" },
    ],
    trajectory_facts: [
      { event_type: "run.completed", tool_name: undefined },
      { event_type: "tool.completed", tool_name: "generate_stage_plan_proposal" },
    ],
    terminal_event_consistency: { had_duplicate: false, had_contradictory: false },
    ...overrides,
  };
}

describe("listDimensions — all 8 dimensions present", () => {
  it("returns all 8 dimensions in order", () => {
    const dims = listDimensions();
    expect(dims).toEqual([
      "positive_trigger",
      "negative_trigger",
      "prerequisites",
      "allowed_tools",
      "required_steps",
      "forbidden_actions",
      "fallback_behavior",
      "output_usability",
    ]);
    expect(dims.length).toBe(8);
  });
});

describe("skillEvalResultToString — passthrough", () => {
  it("returns the input string", () => {
    expect(skillEvalResultToString("pass")).toBe("pass");
    expect(skillEvalResultToString("fail")).toBe("fail");
    expect(skillEvalResultToString("skipped")).toBe("skipped");
  });
});

describe("evaluateSkill — positive case (all dimensions pass)", () => {
  it("passes when all 8 dimensions pass and effect ceiling is respected", () => {
    const contract = buildContract();
    const positiveObs = buildObservation({ selectedSkills: ["project-planning"] });
    const negativeObs = buildObservation({ selectedSkills: ["project-status"] });
    const snapshot = buildSnapshot();
    const result = evaluateSkill({
      contract,
      positiveObservation: positiveObs,
      negativeObservations: [negativeObs],
      positiveSnapshot: snapshot,
      prerequisitesSatisfied: true,
    });
    expect(result.passed).toBe(true);
    expect(result.effectCeilingViolated).toBe(false);
    expect(result.failures).toEqual([]);
    // selectedSkillsForNegatives is string[][] (one array per negative observation)
    expect(result.selectedSkillsForNegatives).toEqual([["project-status"]]);
  });
});

describe("evaluateSkill — dimension 1: positive_trigger", () => {
  it("fails when the skill is NOT selected on the positive trigger prompt", () => {
    const contract = buildContract();
    const positiveObs = buildObservation({ selectedSkills: ["wrong-skill"] });
    const result = evaluateSkill({
      contract,
      positiveObservation: positiveObs,
      negativeObservations: [],
      positiveSnapshot: buildSnapshot(),
      prerequisitesSatisfied: true,
    });
    const dim = result.dimensions.find((d) => d.dimension === "positive_trigger");
    expect(dim!.result).toBe("fail");
    expect(dim!.reason).toContain("project-planning");
    expect(result.passed).toBe(false);
  });
});

describe("evaluateSkill — dimension 2: negative_trigger", () => {
  it("fails when the skill IS selected on a negative trigger prompt", () => {
    const contract = buildContract();
    const negativeObs = buildObservation({ selectedSkills: ["project-planning"] });
    const result = evaluateSkill({
      contract,
      positiveObservation: buildObservation(),
      negativeObservations: [negativeObs],
      positiveSnapshot: buildSnapshot(),
      prerequisitesSatisfied: true,
    });
    const dim = result.dimensions.find((d) => d.dimension === "negative_trigger");
    expect(dim!.result).toBe("fail");
    expect(dim!.reason).toContain("误选");
  });

  it("passes when the skill is NOT selected on any negative trigger prompt", () => {
    const contract = buildContract();
    const negativeObs1 = buildObservation({ selectedSkills: ["project-status"] });
    const negativeObs2 = buildObservation({ selectedSkills: ["other-skill"] });
    const result = evaluateSkill({
      contract,
      positiveObservation: buildObservation(),
      negativeObservations: [negativeObs1, negativeObs2],
      positiveSnapshot: buildSnapshot(),
      prerequisitesSatisfied: true,
    });
    const dim = result.dimensions.find((d) => d.dimension === "negative_trigger");
    expect(dim!.result).toBe("pass");
    // selectedSkillsForNegatives aligns with the negative observations array
    expect(result.selectedSkillsForNegatives).toEqual([["project-status"], ["other-skill"]]);
  });
});

describe("evaluateSkill — dimension 3: prerequisites", () => {
  it("fails when prerequisites are not satisfied", () => {
    const contract = buildContract({ prerequisites: ["has_direction_card"] });
    const result = evaluateSkill({
      contract,
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: buildSnapshot(),
      prerequisitesSatisfied: false,
    });
    const dim = result.dimensions.find((d) => d.dimension === "prerequisites");
    expect(dim!.result).toBe("fail");
  });

  it("is skipped when contract declares no prerequisites", () => {
    const contract = buildContract({ prerequisites: [] });
    const result = evaluateSkill({
      contract,
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: buildSnapshot(),
      prerequisitesSatisfied: false,
    });
    const dim = result.dimensions.find((d) => d.dimension === "prerequisites");
    expect(dim!.result).toBe("skipped");
  });
});

describe("evaluateSkill — dimension 4: allowed_tools", () => {
  it("fails when the trajectory uses a tool outside the allowlist", () => {
    const contract = buildContract({ allowedTools: ["generate_stage_plan_proposal"] });
    const snapshot = buildSnapshot({
      trajectory_facts: [
        { event_type: "tool.completed", tool_name: "finalize_assignment" },
      ],
    });
    const result = evaluateSkill({
      contract,
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: snapshot,
      prerequisitesSatisfied: true,
    });
    const dim = result.dimensions.find((d) => d.dimension === "allowed_tools");
    expect(dim!.result).toBe("fail");
    expect(dim!.reason).toContain("finalize_assignment");
  });

  it("passes when all tools are in the allowlist", () => {
    const contract = buildContract();
    const snapshot = buildSnapshot({
      side_effect_facts: [{ effect_type: "proposal_create", tool_name: "generate_stage_plan_proposal" }],
      trajectory_facts: [{ event_type: "tool.completed", tool_name: "get_project_state" }],
    });
    const result = evaluateSkill({
      contract,
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: snapshot,
      prerequisitesSatisfied: true,
    });
    const dim = result.dimensions.find((d) => d.dimension === "allowed_tools");
    expect(dim!.result).toBe("pass");
  });

  it("is skipped when contract declares no allowedTools", () => {
    const contract = buildContract({ allowedTools: [] });
    const result = evaluateSkill({
      contract,
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: buildSnapshot(),
      prerequisitesSatisfied: true,
    });
    const dim = result.dimensions.find((d) => d.dimension === "allowed_tools");
    expect(dim!.result).toBe("skipped");
  });
});

describe("evaluateSkill — dimension 5: required_steps", () => {
  it("fails when a required tool milestone is missing", () => {
    const contract = buildContract({
      requiredSteps: [{ kind: "tool", value: "generate_stage_plan_proposal" }],
    });
    const snapshot = buildSnapshot({
      side_effect_facts: [],
      trajectory_facts: [{ event_type: "run.completed", tool_name: undefined }],
    });
    const result = evaluateSkill({
      contract,
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: snapshot,
      prerequisitesSatisfied: true,
    });
    const dim = result.dimensions.find((d) => d.dimension === "required_steps");
    expect(dim!.result).toBe("fail");
    expect(dim!.reason).toContain("generate_stage_plan_proposal");
  });

  it("fails when a required event milestone is missing", () => {
    const contract = buildContract({
      requiredSteps: [{ kind: "event", value: "run.completed" }],
    });
    const snapshot = buildSnapshot({
      trajectory_facts: [{ event_type: "tool.completed", tool_name: "generate_stage_plan_proposal" }],
    });
    const result = evaluateSkill({
      contract,
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: snapshot,
      prerequisitesSatisfied: true,
    });
    const dim = result.dimensions.find((d) => d.dimension === "required_steps");
    expect(dim!.result).toBe("fail");
  });

  it("is skipped when contract declares no requiredSteps", () => {
    const contract = buildContract({ requiredSteps: [] });
    const result = evaluateSkill({
      contract,
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: buildSnapshot(),
      prerequisitesSatisfied: true,
    });
    const dim = result.dimensions.find((d) => d.dimension === "required_steps");
    expect(dim!.result).toBe("skipped");
  });
});

describe("evaluateSkill — dimension 6: forbidden_actions", () => {
  it("fails when the trajectory invokes a forbidden tool", () => {
    const contract = buildContract({ forbiddenActions: ["finalize_assignment"] });
    const snapshot = buildSnapshot({
      side_effect_facts: [{ effect_type: "commit", tool_name: "finalize_assignment" }],
    });
    const result = evaluateSkill({
      contract,
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: snapshot,
      prerequisitesSatisfied: true,
    });
    const dim = result.dimensions.find((d) => d.dimension === "forbidden_actions");
    expect(dim!.result).toBe("fail");
  });

  it("passes when no forbidden tools are invoked", () => {
    const contract = buildContract({ forbiddenActions: ["finalize_assignment"] });
    const snapshot = buildSnapshot({
      side_effect_facts: [{ effect_type: "proposal_create", tool_name: "generate_stage_plan_proposal" }],
    });
    const result = evaluateSkill({
      contract,
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: snapshot,
      prerequisitesSatisfied: true,
    });
    const dim = result.dimensions.find((d) => d.dimension === "forbidden_actions");
    expect(dim!.result).toBe("pass");
  });
});

describe("evaluateSkill — dimension 7: fallback_behavior", () => {
  it("fails when fallback is expected but output is empty", () => {
    const contract = buildContract({ expectsFallback: true });
    const obs = buildObservation({ output: "" });
    const result = evaluateSkill({
      contract,
      positiveObservation: obs,
      negativeObservations: [],
      positiveSnapshot: buildSnapshot(),
      prerequisitesSatisfied: true,
    });
    const dim = result.dimensions.find((d) => d.dimension === "fallback_behavior");
    expect(dim!.result).toBe("fail");
    expect(dim!.reason).toContain("空");
  });

  it("fails when fallback is expected but a commit side effect is present", () => {
    const contract = buildContract({ expectsFallback: true });
    const snapshot = buildSnapshot({
      side_effect_facts: [{ effect_type: "commit", tool_name: "finalize_assignment" }],
    });
    const result = evaluateSkill({
      contract,
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: snapshot,
      prerequisitesSatisfied: true,
    });
    const dim = result.dimensions.find((d) => d.dimension === "fallback_behavior");
    expect(dim!.result).toBe("fail");
    expect(dim!.reason).toContain("commit");
  });

  it("is skipped when contract does not expect fallback", () => {
    const contract = buildContract({ expectsFallback: false });
    const result = evaluateSkill({
      contract,
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: buildSnapshot(),
      prerequisitesSatisfied: true,
    });
    const dim = result.dimensions.find((d) => d.dimension === "fallback_behavior");
    expect(dim!.result).toBe("skipped");
  });
});

describe("evaluateSkill — dimension 8: output_usability", () => {
  it("fails when output is empty", () => {
    const contract = buildContract();
    const obs = buildObservation({ output: "" });
    const result = evaluateSkill({
      contract,
      positiveObservation: obs,
      negativeObservations: [],
      positiveSnapshot: buildSnapshot(),
      prerequisitesSatisfied: true,
    });
    const dim = result.dimensions.find((d) => d.dimension === "output_usability");
    expect(dim!.result).toBe("fail");
  });

  it("fails when output contains a raw UUID", () => {
    const contract = buildContract();
    const obs = buildObservation({
      output: "用户 550e8400-e29b-41d4-a716-446655440000 的任务",
    });
    const result = evaluateSkill({
      contract,
      positiveObservation: obs,
      negativeObservations: [],
      positiveSnapshot: buildSnapshot(),
      prerequisitesSatisfied: true,
    });
    const dim = result.dimensions.find((d) => d.dimension === "output_usability");
    expect(dim!.result).toBe("fail");
    expect(dim!.reason).toContain("UUID");
  });

  it("passes when output is non-empty and has no raw UUID", () => {
    const contract = buildContract();
    const result = evaluateSkill({
      contract,
      positiveObservation: buildObservation({ output: "已为小林分配后端 API 任务。" }),
      negativeObservations: [],
      positiveSnapshot: buildSnapshot(),
      prerequisitesSatisfied: true,
    });
    const dim = result.dimensions.find((d) => d.dimension === "output_usability");
    expect(dim!.result).toBe("pass");
  });
});

describe("evaluateSkill — effect ceiling enforcement", () => {
  it("proposal_only ceiling is violated when a commit side effect is present", () => {
    const contract = buildContract({ effectCeiling: "proposal_only" });
    const snapshot = buildSnapshot({
      side_effect_facts: [
        { effect_type: "proposal_create", tool_name: "generate_stage_plan_proposal" },
        { effect_type: "commit", tool_name: "finalize_stage_plan" },
      ],
    });
    const result = evaluateSkill({
      contract,
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: snapshot,
      prerequisitesSatisfied: true,
    });
    expect(result.effectCeilingViolated).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("advisory_only ceiling is violated when a commit side effect is present", () => {
    const contract = buildContract({ effectCeiling: "advisory_only" });
    const snapshot = buildSnapshot({
      side_effect_facts: [{ effect_type: "commit", tool_name: "finalize_stage_plan" }],
    });
    const result = evaluateSkill({
      contract,
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: snapshot,
      prerequisitesSatisfied: true,
    });
    expect(result.effectCeilingViolated).toBe(true);
  });

  it("none ceiling is violated when ANY side effect is present", () => {
    const contract = buildContract({ effectCeiling: "none" });
    const snapshot = buildSnapshot({
      side_effect_facts: [{ effect_type: "advisory", tool_name: "create_risk" }],
    });
    const result = evaluateSkill({
      contract,
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: snapshot,
      prerequisitesSatisfied: true,
    });
    expect(result.effectCeilingViolated).toBe(true);
  });

  it("full ceiling is never violated", () => {
    const contract = buildContract({ effectCeiling: "full" });
    const snapshot = buildSnapshot({
      side_effect_facts: [
        { effect_type: "commit", tool_name: "finalize_stage_plan" },
        { effect_type: "proposal_create", tool_name: "generate_stage_plan_proposal" },
      ],
    });
    const result = evaluateSkill({
      contract,
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: snapshot,
      prerequisitesSatisfied: true,
    });
    expect(result.effectCeilingViolated).toBe(false);
  });
});

describe("aggregateSkillEvaluations — aggregation", () => {
  it("aggregates pass/fail/skipped per dimension", () => {
    const contract1 = buildContract({ id: "c1" });
    const contract2 = buildContract({ id: "c2", prerequisites: [] });
    const r1 = evaluateSkill({
      contract: contract1,
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: buildSnapshot(),
      prerequisitesSatisfied: true,
    });
    const r2 = evaluateSkill({
      contract: contract2,
      positiveObservation: buildObservation({ selectedSkills: ["wrong"] }),
      negativeObservations: [],
      positiveSnapshot: buildSnapshot(),
      prerequisitesSatisfied: false,
    });
    const agg = aggregateSkillEvaluations([r1, r2]);
    expect(agg.total).toBe(2);
    expect(agg.passed).toBe(1);
    expect(agg.failed).toBe(1);
    expect(agg.byDimension.positive_trigger.pass).toBe(1);
    expect(agg.byDimension.positive_trigger.fail).toBe(1);
    expect(agg.byDimension.prerequisites.skipped).toBe(1);
  });
});

describe("evaluateSkill — hard grade attachment", () => {
  it("carries the hard grade into the result when provided", () => {
    const hardGrade: HardGrade = {
      passed: true,
      outcomePassed: true,
      authoritySafetyPassed: true,
      trajectoryPassed: true,
      privacyPassed: true,
      graders: {
        finalOutcome: true,
        stateConstraints: true,
        maxSideEffects: true,
        milestoneDag: true,
        proposalConfirm: true,
        prohibitedCommitEffect: true,
        unknownSideEffect: true,
        idempotency: true,
        readOnlyStatePurity: true,
        terminalEventConsistency: true,
        projectMemoryVisibility: true,
        subjectAndOwnerPrivacy: true,
        rawIdLeakage: true,
        hiddenFieldLeakage: true,
      },
      failures: [],
      skipped: [],
    };
    const result = evaluateSkill({
      contract: buildContract(),
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: buildSnapshot(),
      prerequisitesSatisfied: true,
      hardGrade,
    });
    expect(result.hardGrade).toBe(hardGrade);
  });
});
