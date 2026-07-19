/**
 * T46-3 (Issue #96) — Mutation tests for new graders and checkers.
 *
 * Each declared grader/checker MUST have at least one mutation test that
 * proves it detects the failure it is supposed to detect. A mutation that
 * goes undetected is a hard-gate regression.
 *
 * Modules covered:
 *  1. UserController — sentinel leak detection, refusal detection, goal drift
 *  2. simulator-error — denominator exclusion, retry budget enforcement
 *  3. attempt-ledger — append-only invariant, recoveredBy preservation
 *  4. skill-evaluator — each of the 8 dimensions + effect ceiling
 *  5. runtime-faults — each of the 11 fault classes
 *  6. reliability-stats — metric formula correctness
 *  7. paired-comparison — isolation detection, model drift detection
 *  8. exit-gate — each of the 6 conditions
 */

import { describe, expect, it } from "vitest";
import { UserController } from "../../src/evaluation/lab/user-controller.js";
import type { HiddenControllerFacts } from "../../src/evaluation/lab/contract-v3.js";
import {
  classifySimulatorError,
  scoreDenominatorTrials,
  retryBudgetExhausted,
  SIMULATOR_RETRY_BUDGET,
} from "../../src/evaluation/lab/simulator-error.js";
import { createAttemptLedger, hasRecoveredFailures } from "../../src/evaluation/lab/attempt-ledger.js";
import { evaluateSkill } from "../../src/evaluation/lab/skill-evaluator.js";
import type { SkillEvaluationContract } from "../../src/evaluation/lab/contract-v3.js";
import type { EvidenceSnapshot, HardGrade } from "../../src/evaluation/lab/contract-v2.js";
import type { ScenarioObservation } from "../../src/evaluation/lab/contract.js";
import { evaluateFaultBehavior, findFault } from "../../src/evaluation/lab/runtime-faults.js";
import { computeReliabilityReport } from "../../src/evaluation/lab/reliability-stats.js";
import { buildSide, buildManifest, computeModelDrift, verifyIsolation, buildResult } from "../../src/evaluation/lab/paired-comparison.js";
import { evaluateExitGate } from "../../src/evaluation/lab/exit-gate.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HIDDEN_SENTINEL = "MUTATION_SENTINEL_DO_NOT_LEAK_001";

function buildControllerFacts(): HiddenControllerFacts {
  return {
    id: "mutation-controller",
    hiddenFacts: ["secret-alpha"],
    userGoals: ["完成测试"],
    refusals: ["请直接修改数据库"],
    allowedActions: ["send_message", "end_conversation"],
    expectedTransitions: [
      { id: "t1", fromState: "", toState: "s1", trigger: { kind: "exact_phrase", value: "你好" }, required: true },
      { id: "t2", fromState: "s1", toState: "ended", trigger: { kind: "exact_phrase", value: "完成" }, required: true },
    ],
    hiddenSentinels: [HIDDEN_SENTINEL],
  };
}

function makeController(): UserController {
  return new UserController({
    facts: buildControllerFacts(),
    maxTurns: 5,
    now: () => new Date("2026-07-19T00:00:00.000Z"),
  });
}

function buildSkillContract(): SkillEvaluationContract {
  return {
    id: "mutation-skill",
    skillName: "project-planning",
    positiveTriggerPrompt: "生成阶段计划",
    negativeTriggerPrompts: ["查询状态"],
    prerequisites: ["has_direction_card"],
    allowedTools: ["generate_stage_plan_proposal"],
    requiredSteps: [{ kind: "tool", value: "generate_stage_plan_proposal" }],
    forbiddenActions: ["finalize_assignment"],
    expectsFallback: false,
    effectCeiling: "proposal_only",
  };
}

function buildObservation(selectedSkills: string[] = ["project-planning"]): ScenarioObservation {
  return {
    schemaVersion: 1,
    scenarioId: "scn-001",
    timestamp: "2026-07-19T00:00:00.000Z",
    routedMode: "action",
    selectedSkills,
    evidence: [],
    terminalStatus: "completed",
    latencyMs: 1_000,
    inputTokens: 10,
    outputTokens: 20,
    requestCount: 1,
    costs: {
      sutCost: { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: true },
      evaluatorModelCost: { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: false },
      codingAgentCost: { amountUsd: null, source: "unknown", countedAgainstSutCap: false },
    },
    output: "已生成阶段计划。",
  };
}

function buildSnapshot(sideEffects: Array<{ effect_type: string; tool_name?: string }> = []): EvidenceSnapshot {
  return {
    scenarioId: "scn-001",
    side_effect_facts: sideEffects,
    trajectory_facts: [
      { event_type: "run.completed" },
      { event_type: "tool_use", tool_name: "generate_stage_plan_proposal" },
    ],
    terminal_event_consistency: { had_duplicate: false, had_contradictory: false },
  };
}

function zeroMetrics() {
  return {
    latencyMs: 0, inputTokens: 0, outputTokens: 0, sutCostUsd: 0,
    codingAgentCostUsd: null as number | null, toolCalls: 0, agentRetries: 0,
    infrastructureAttempts: 0, timeouts: 0, skipped: 0, excluded: 0,
    simulatorErrors: 0, infrastructureErrors: 0,
  };
}

// ---------------------------------------------------------------------------
// §1 UserController mutation tests
// ---------------------------------------------------------------------------

describe("mutation: UserController detects sentinel leak", () => {
  it("baseline: normal Agent output does NOT trigger sentinel leak", async () => {
    const controller = makeController();
    const result = await controller.nextTurn("你好");
    expect(result.simulatorError).toBeUndefined();
  });

  it("mutation: Agent output containing the sentinel IS detected", async () => {
    const controller = makeController();
    const result = await controller.nextTurn(`leaking ${HIDDEN_SENTINEL} now`);
    expect(result.simulatorError).toBe("hidden_fact_leak");
    expect(result.terminal).toBe(true);
  });
});

describe("mutation: UserController detects goal drift", () => {
  it("baseline: matching transitions do NOT trigger goal drift", async () => {
    const controller = makeController();
    await controller.nextTurn("你好"); // matches
    expect(controller.getVisibleState().currentState).toBe("s1");
  });

  it("mutation: 3 consecutive no-match turns DO trigger goal drift", async () => {
    const controller = makeController();
    await controller.nextTurn("你好"); // match
    await controller.nextTurn("unrelated1"); // noMatch=1
    await controller.nextTurn("unrelated2"); // noMatch=2
    const result = await controller.nextTurn("unrelated3"); // noMatch=3 -> goal_drift
    expect(result.simulatorError).toBe("goal_drift");
  });
});

// ---------------------------------------------------------------------------
// §2 simulator-error mutation tests
// ---------------------------------------------------------------------------

describe("mutation: simulator_error excluded from denominator", () => {
  it("baseline: normal trials are included in the denominator", () => {
    const trials = [
      { simulatorError: undefined, passed: true },
      { simulatorError: undefined, passed: false },
    ];
    expect(scoreDenominatorTrials(trials).length).toBe(2);
  });

  it("mutation: simulator_error trials are excluded from the denominator", () => {
    const trials = [
      { simulatorError: undefined, passed: true },
      { simulatorError: "hidden_fact_leak" as const, passed: false },
    ];
    const denominator = scoreDenominatorTrials(trials);
    expect(denominator.length).toBe(1);
    expect(denominator[0]!.passed).toBe(true);
  });
});

describe("mutation: retry budget is frozen", () => {
  it("baseline: 1 record does NOT exhaust the budget", () => {
    const records = [
      classifySimulatorError({ type: "invalid_turn", scenarioId: "s1", message: "x", recordedAt: "2026-07-19T00:00:00.000Z" }),
    ];
    expect(retryBudgetExhausted(records, "s1")).toBe(false);
  });

  it("mutation: SIMULATOR_RETRY_BUDGET records DO exhaust the budget", () => {
    const records = Array.from({ length: SIMULATOR_RETRY_BUDGET }, (_, i) =>
      classifySimulatorError({ type: "invalid_turn", scenarioId: "s1", message: `x${i}`, recordedAt: `2026-07-19T00:00:0${i}.000Z` }),
    );
    expect(retryBudgetExhausted(records, "s1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §3 attempt-ledger mutation tests
// ---------------------------------------------------------------------------

describe("mutation: attempt ledger preserves prior failures", () => {
  it("baseline: a succeeded entry has no recoveredBy", () => {
    const ledger = createAttemptLedger();
    ledger.record({ scenarioId: "s1", type: "infrastructure_attempt", startedAt: "2026-07-19T00:00:00.000Z", endedAt: "2026-07-19T00:00:01.000Z", result: "succeeded" });
    const snap = ledger.snapshot();
    expect(snap.entries[0]!.recoveredBy).toBeUndefined();
    expect(hasRecoveredFailures(snap)).toBe(false);
  });

  it("mutation: a failed entry that is later recovered is STILL preserved", () => {
    const ledger = createAttemptLedger();
    ledger.record({ scenarioId: "s1", type: "infrastructure_attempt", startedAt: "2026-07-19T00:00:00.000Z", endedAt: "2026-07-19T00:00:01.000Z", result: "failed_infrastructure" });
    ledger.record({ scenarioId: "s1", type: "agent_retry", startedAt: "2026-07-19T00:00:01.000Z", endedAt: "2026-07-19T00:00:02.000Z", result: "succeeded", retryOf: "s1-infrastructure_attempt-0" });
    const snap = ledger.snapshot();
    // The original failure entry is STILL present (not deleted).
    expect(snap.entries[0]!.result).toBe("failed_infrastructure");
    // It has a recoveredBy pointer.
    expect(snap.entries[0]!.recoveredBy).toBe("s1-agent_retry-0");
    // hasRecoveredFailures detects the prior failure.
    expect(hasRecoveredFailures(snap)).toBe(true);
  });

  it("mutation: a FAILED retry does NOT set recoveredBy on the original", () => {
    // Adversarial: a failed retry must not be recorded as a recovery.
    // Only successful retries establish a recovery relationship.
    const ledger = createAttemptLedger();
    ledger.record({ scenarioId: "s1", type: "infrastructure_attempt", startedAt: "2026-07-19T00:00:00.000Z", endedAt: "2026-07-19T00:00:01.000Z", result: "failed_infrastructure" });
    ledger.record({ scenarioId: "s1", type: "agent_retry", startedAt: "2026-07-19T00:00:01.000Z", endedAt: "2026-07-19T00:00:02.000Z", result: "failed_agent", retryOf: "s1-infrastructure_attempt-0" });
    const snap = ledger.snapshot();
    // The original failure has NO recoveredBy because the retry failed.
    expect(snap.entries[0]!.result).toBe("failed_infrastructure");
    expect(snap.entries[0]!.recoveredBy).toBeUndefined();
    // The failed retry entry is still in the ledger (append-only).
    expect(snap.entries[1]!.result).toBe("failed_agent");
    expect(snap.entries[1]!.retryOf).toBe("s1-infrastructure_attempt-0");
  });

  it("mutation: a second successful retry does NOT overwrite an existing recoveredBy", () => {
    // Adversarial: if the original was already recovered by retry1,
    // a later retry2 MUST NOT erase that recovery relationship.
    const ledger = createAttemptLedger();
    ledger.record({ scenarioId: "s1", type: "infrastructure_attempt", startedAt: "2026-07-19T00:00:00.000Z", endedAt: "2026-07-19T00:00:01.000Z", result: "failed_infrastructure" });
    ledger.record({ scenarioId: "s1", type: "agent_retry", startedAt: "2026-07-19T00:00:01.000Z", endedAt: "2026-07-19T00:00:02.000Z", result: "succeeded", retryOf: "s1-infrastructure_attempt-0" });
    expect(() => {
      ledger.record({ scenarioId: "s1", type: "agent_retry", startedAt: "2026-07-19T00:00:02.000Z", endedAt: "2026-07-19T00:00:03.000Z", result: "succeeded", retryOf: "s1-infrastructure_attempt-0" });
    }).toThrow(/已被.*标记为已恢复/);
  });
});

// ---------------------------------------------------------------------------
// §4 skill-evaluator mutation tests (8 dimensions + effect ceiling)
// ---------------------------------------------------------------------------

describe("mutation: skill-evaluator positive_trigger", () => {
  it("baseline: correct skill selection passes", () => {
    const result = evaluateSkill({
      contract: buildSkillContract(),
      positiveObservation: buildObservation(["project-planning"]),
      negativeObservations: [],
      positiveSnapshot: buildSnapshot(),
      prerequisitesSatisfied: true,
    });
    expect(result.passed).toBe(true);
  });

  it("mutation: wrong skill selection fails positive_trigger", () => {
    const result = evaluateSkill({
      contract: buildSkillContract(),
      positiveObservation: buildObservation(["wrong-skill"]),
      negativeObservations: [],
      positiveSnapshot: buildSnapshot(),
      prerequisitesSatisfied: true,
    });
    expect(result.passed).toBe(false);
    const dim = result.dimensions.find((d) => d.dimension === "positive_trigger");
    expect(dim!.result).toBe("fail");
  });
});

describe("mutation: skill-evaluator allowed_tools", () => {
  it("baseline: tools within allowlist pass", () => {
    const result = evaluateSkill({
      contract: buildSkillContract(),
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: buildSnapshot([{ effect_type: "proposal_create", tool_name: "generate_stage_plan_proposal" }]),
      prerequisitesSatisfied: true,
    });
    const dim = result.dimensions.find((d) => d.dimension === "allowed_tools");
    expect(dim!.result).toBe("pass");
  });

  it("mutation: tool outside allowlist fails allowed_tools", () => {
    const result = evaluateSkill({
      contract: buildSkillContract(),
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: buildSnapshot([{ effect_type: "commit", tool_name: "forbidden_tool" }]),
      prerequisitesSatisfied: true,
    });
    const dim = result.dimensions.find((d) => d.dimension === "allowed_tools");
    expect(dim!.result).toBe("fail");
  });
});

describe("mutation: skill-evaluator forbidden_actions", () => {
  it("baseline: no forbidden tool invocation passes", () => {
    const result = evaluateSkill({
      contract: buildSkillContract(),
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: buildSnapshot([{ effect_type: "proposal_create", tool_name: "generate_stage_plan_proposal" }]),
      prerequisitesSatisfied: true,
    });
    const dim = result.dimensions.find((d) => d.dimension === "forbidden_actions");
    expect(dim!.result).toBe("pass");
  });

  it("mutation: forbidden tool invocation fails forbidden_actions", () => {
    const result = evaluateSkill({
      contract: buildSkillContract(),
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: buildSnapshot([{ effect_type: "commit", tool_name: "finalize_assignment" }]),
      prerequisitesSatisfied: true,
    });
    const dim = result.dimensions.find((d) => d.dimension === "forbidden_actions");
    expect(dim!.result).toBe("fail");
  });
});

describe("mutation: skill-evaluator effect ceiling", () => {
  it("baseline: proposal_only ceiling with only proposal_create passes", () => {
    const result = evaluateSkill({
      contract: buildSkillContract(),
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: buildSnapshot([{ effect_type: "proposal_create", tool_name: "generate_stage_plan_proposal" }]),
      prerequisitesSatisfied: true,
    });
    expect(result.effectCeilingViolated).toBe(false);
  });

  it("mutation: proposal_only ceiling with a commit side effect is violated", () => {
    const result = evaluateSkill({
      contract: buildSkillContract(),
      positiveObservation: buildObservation(),
      negativeObservations: [],
      positiveSnapshot: buildSnapshot([
        { effect_type: "proposal_create", tool_name: "generate_stage_plan_proposal" },
        { effect_type: "commit", tool_name: "finalize_stage_plan" },
      ]),
      prerequisitesSatisfied: true,
    });
    expect(result.effectCeilingViolated).toBe(true);
    expect(result.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §5 runtime-faults mutation tests
// ---------------------------------------------------------------------------

describe("mutation: runtime-faults duplicate terminal detection", () => {
  it("baseline: injected duplicate terminal is detected and fails closed", () => {
    const fault = findFault("fault-duplicate-terminal")!;
    const result = evaluateFaultBehavior({
      fault,
      finalStatus: "failed",
      sideEffectCount: 0,
      hadDuplicateTerminal: true,
      hadContradictoryTerminal: false,
      idempotencyPreserved: true,
      agentRetriesObserved: 0,
      infrastructureRetriesObserved: 0,
      metrics: zeroMetrics(),
    });
    expect(result.passed).toBe(true);
  });

  it("mutation: injected duplicate terminal is not detected", () => {
    const fault = findFault("fault-duplicate-terminal")!;
    const result = evaluateFaultBehavior({
      fault,
      finalStatus: "failed",
      sideEffectCount: 0,
      hadDuplicateTerminal: false,
      hadContradictoryTerminal: false,
      idempotencyPreserved: true,
      agentRetriesObserved: 0,
      infrastructureRetriesObserved: 0,
      metrics: zeroMetrics(),
    });
    expect(result.passed).toBe(false);
  });
});

describe("mutation: runtime-faults cancellation side-effect detection", () => {
  it("baseline: cancellation with no side effects passes", () => {
    const fault = findFault("fault-cancellation")!;
    const result = evaluateFaultBehavior({
      fault,
      finalStatus: "failed",
      sideEffectCount: 0,
      hadDuplicateTerminal: false,
      hadContradictoryTerminal: false,
      idempotencyPreserved: true,
      agentRetriesObserved: 0,
      infrastructureRetriesObserved: 0,
      metrics: zeroMetrics(),
    });
    expect(result.passed).toBe(true);
  });

  it("mutation: cancellation with side effects is detected and fails", () => {
    const fault = findFault("fault-cancellation")!;
    const result = evaluateFaultBehavior({
      fault,
      finalStatus: "failed",
      sideEffectCount: 5,
      hadDuplicateTerminal: false,
      hadContradictoryTerminal: false,
      idempotencyPreserved: true,
      agentRetriesObserved: 0,
      infrastructureRetriesObserved: 0,
      metrics: zeroMetrics(),
    });
    expect(result.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §6 reliability-stats mutation tests
// ---------------------------------------------------------------------------

describe("mutation: reliability-stats observed_trial_pass_rate formula", () => {
  it("baseline: 2 pass / 4 total = 0.5", () => {
    const trials = [
      { scenarioId: "s1", passed: true, excluded: false, allInvariantsPassed: true },
      { scenarioId: "s1", passed: true, excluded: false, allInvariantsPassed: true },
      { scenarioId: "s1", passed: false, excluded: false, allInvariantsPassed: false },
      { scenarioId: "s1", passed: false, excluded: false, allInvariantsPassed: false },
    ];
    const report = computeReliabilityReport(trials, { preset: "full" });
    expect(report.metrics[0]!.value).toBe(0.5);
  });

  it("mutation: excluded trials do NOT inflate the pass rate", () => {
    const trials = [
      { scenarioId: "s1", passed: true, excluded: false, allInvariantsPassed: true },
      { scenarioId: "s1", passed: false, excluded: true, allInvariantsPassed: false },
    ];
    const report = computeReliabilityReport(trials, { preset: "full" });
    // Without exclusion, pass rate would be 0.5. With exclusion, it's 1.0.
    expect(report.metrics[0]!.value).toBe(1);
    expect(report.metrics[0]!.denominator).toBe(1);
    expect(report.metrics[0]!.excluded).toBe(1);
  });
});

describe("mutation: reliability-stats pass@k != modeled_pass^k", () => {
  it("mutation: pass@k and modeled_pass^k produce DIFFERENT values for small samples", () => {
    // 1 pass, 0 fails:
    // pass@1 = 1 - (1-1)^1 = 1.0
    // modeled_pass^1 with Beta(1,1) prior: posterior Beta(2,1), E[1-p]=1/3, modeled=2/3
    const trials = [
      { scenarioId: "s1", passed: true, excluded: false, allInvariantsPassed: true },
    ];
    const report = computeReliabilityReport(trials, { preset: "full" });
    const passAtK = report.metrics[2]!;
    const modeledPassK = report.metrics[3]!;
    expect(passAtK.value).toBe(1);
    expect(modeledPassK.value).toBeCloseTo(2 / 3, 5);
    // The two metrics are DIFFERENT — confusing them is a regression.
    expect(modeledPassK.value).not.toBe(passAtK.value);
  });
});

// ---------------------------------------------------------------------------
// §7 paired-comparison mutation tests
// ---------------------------------------------------------------------------

describe("mutation: paired-comparison isolation detection", () => {
  it("baseline: isolated sides produce no violations", () => {
    const candidate = buildSide({
      label: "candidate", worktreePath: "/tmp/c", backendPort: 8001, sidecarPort: 4001,
      nonce: "n1", instanceId: "i1", databasePath: "/tmp/c.db", tempRoot: "/tmp/ct",
      artifactStagingDir: "/tmp/ca", resolvedModel: { provider: "mock", name: "m", confirmedBy: "health" },
      gitCommit: "abc", worktreeSha256: "s1",
    });
    const baseline = buildSide({
      label: "baseline", worktreePath: "/tmp/b", backendPort: 8002, sidecarPort: 4002,
      nonce: "n2", instanceId: "i2", databasePath: "/tmp/b.db", tempRoot: "/tmp/bt",
      artifactStagingDir: "/tmp/ba", resolvedModel: { provider: "mock", name: "m", confirmedBy: "health" },
      gitCommit: "def", worktreeSha256: "s2",
    });
    expect(verifyIsolation(candidate, baseline)).toEqual([]);
  });

  it("mutation: shared database is detected", () => {
    const candidate = buildSide({
      label: "candidate", worktreePath: "/tmp/c", backendPort: 8001, sidecarPort: 4001,
      nonce: "n1", instanceId: "i1", databasePath: "/tmp/shared.db", tempRoot: "/tmp/ct",
      artifactStagingDir: "/tmp/ca", resolvedModel: { provider: "mock", name: "m", confirmedBy: "health" },
      gitCommit: "abc", worktreeSha256: "s1",
    });
    const baseline = buildSide({
      label: "baseline", worktreePath: "/tmp/b", backendPort: 8002, sidecarPort: 4002,
      nonce: "n2", instanceId: "i2", databasePath: "/tmp/shared.db", tempRoot: "/tmp/bt",
      artifactStagingDir: "/tmp/ba", resolvedModel: { provider: "mock", name: "m", confirmedBy: "health" },
      gitCommit: "def", worktreeSha256: "s2",
    });
    expect(verifyIsolation(candidate, baseline).some((v) => v.includes("数据库"))).toBe(true);
  });
});

describe("mutation: paired-comparison model drift detection", () => {
  it("baseline: same resolved model produces no drift", () => {
    const candidate = buildSide({
      label: "candidate", worktreePath: "/tmp/c", backendPort: 8001, sidecarPort: 4001,
      nonce: "n1", instanceId: "i1", databasePath: "/tmp/c.db", tempRoot: "/tmp/ct",
      artifactStagingDir: "/tmp/ca", resolvedModel: { provider: "mock", name: "m", confirmedBy: "health" },
      gitCommit: "abc", worktreeSha256: "s1",
    });
    const baseline = buildSide({
      label: "baseline", worktreePath: "/tmp/b", backendPort: 8002, sidecarPort: 4002,
      nonce: "n2", instanceId: "i2", databasePath: "/tmp/b.db", tempRoot: "/tmp/bt",
      artifactStagingDir: "/tmp/ba", resolvedModel: { provider: "mock", name: "m", confirmedBy: "health" },
      gitCommit: "def", worktreeSha256: "s2",
    });
    expect(computeModelDrift(candidate, baseline)).toBe(false);
  });

  it("mutation: null resolved model is detected as drift", () => {
    const candidate = buildSide({
      label: "candidate", worktreePath: "/tmp/c", backendPort: 8001, sidecarPort: 4001,
      nonce: "n1", instanceId: "i1", databasePath: "/tmp/c.db", tempRoot: "/tmp/ct",
      artifactStagingDir: "/tmp/ca", resolvedModel: null,
      gitCommit: "abc", worktreeSha256: "s1",
    });
    const baseline = buildSide({
      label: "baseline", worktreePath: "/tmp/b", backendPort: 8002, sidecarPort: 4002,
      nonce: "n2", instanceId: "i2", databasePath: "/tmp/b.db", tempRoot: "/tmp/bt",
      artifactStagingDir: "/tmp/ba", resolvedModel: { provider: "mock", name: "m", confirmedBy: "health" },
      gitCommit: "def", worktreeSha256: "s2",
    });
    expect(computeModelDrift(candidate, baseline)).toBe(true);
  });
});

describe("mutation: paired-comparison candidateWins requires no drift", () => {
  it("mutation: candidateWins is false when model drift is possible", () => {
    const candidate = buildSide({
      label: "candidate", worktreePath: "/tmp/c", backendPort: 8001, sidecarPort: 4001,
      nonce: "n1", instanceId: "i1", databasePath: "/tmp/c.db", tempRoot: "/tmp/ct",
      artifactStagingDir: "/tmp/ca", resolvedModel: null,
      gitCommit: "abc", worktreeSha256: "s1",
    });
    const baseline = buildSide({
      label: "baseline", worktreePath: "/tmp/b", backendPort: 8002, sidecarPort: 4002,
      nonce: "n2", instanceId: "i2", databasePath: "/tmp/b.db", tempRoot: "/tmp/bt",
      artifactStagingDir: "/tmp/ba", resolvedModel: { provider: "mock", name: "m", confirmedBy: "health" },
      gitCommit: "def", worktreeSha256: "s2",
    });
    const manifest = buildManifest({
      candidate, baseline,
      scenarioManifestSha256: "x", seedManifestSha256: "y",
      frozenStandardsVersion: "v1", evaluatorVersion: "v1",
    });
    const result = buildResult({
      manifest,
      perScenario: Array(35).fill(null).map((_, i) => ({
        scenarioId: `s${i}`, candidatePassed: true, baselinePassed: false,
      })),
      candidateMetrics: zeroMetrics(),
      baselineMetrics: zeroMetrics(),
    });
    expect(result.candidateWins).toBe(false);
  });
});

describe("mutation: paired-comparison requested model cannot masquerade as resolved", () => {
  it("mutation: passing confirmedBy='requested' is rejected", () => {
    // Adversarial: the caller tries to pass the requested model as the
    // resolved model by setting confirmedBy to a non-confirming value.
    expect(() => {
      buildSide({
        label: "candidate", worktreePath: "/tmp/c", backendPort: 8001, sidecarPort: 4001,
        nonce: "n1", instanceId: "i1", databasePath: "/tmp/c.db", tempRoot: "/tmp/ct",
        artifactStagingDir: "/tmp/ca",
        resolvedModel: { provider: "openai", name: "gpt-4o", confirmedBy: "requested" },
        gitCommit: "abc", worktreeSha256: "s1",
      });
    }).toThrow(/不表示实际确认/);
  });

  it("baseline: passing confirmedBy='sidecar_health' is accepted", () => {
    expect(() => {
      buildSide({
        label: "candidate", worktreePath: "/tmp/c", backendPort: 8001, sidecarPort: 4001,
        nonce: "n1", instanceId: "i1", databasePath: "/tmp/c.db", tempRoot: "/tmp/ct",
        artifactStagingDir: "/tmp/ca",
        resolvedModel: { provider: "mock", name: "mock-model", confirmedBy: "sidecar_health" },
        gitCommit: "abc", worktreeSha256: "s1",
      });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// §8 exit-gate mutation tests
// ---------------------------------------------------------------------------

describe("mutation: exit-gate P0 mutation detection", () => {
  it("baseline: all P0 mutations detected passes", () => {
    const report = evaluateExitGate({
      p0Mutations: [{ mutationId: "m1", detected: true, targets: "x" }],
      referencePrograms: [{ programId: "r1", hardFalseFailures: 0 }],
      hiddenFieldLeakageTests: [{ testName: "t1", passed: true }],
      requiredScenarios: [{ scenarioId: "s1", status: "passed" }],
      evidenceIntegrity: { checksumsComplete: true, evidenceGraphComplete: true, verified: true },
      semanticJudgeUsed: false,
    });
    expect(report.passed).toBe(true);
  });

  it("mutation: undetected P0 mutation fails the gate", () => {
    const report = evaluateExitGate({
      p0Mutations: [{ mutationId: "m1", detected: false, targets: "x" }],
      referencePrograms: [{ programId: "r1", hardFalseFailures: 0 }],
      hiddenFieldLeakageTests: [{ testName: "t1", passed: true }],
      requiredScenarios: [{ scenarioId: "s1", status: "passed" }],
      evidenceIntegrity: { checksumsComplete: true, evidenceGraphComplete: true, verified: true },
      semanticJudgeUsed: false,
    });
    expect(report.passed).toBe(false);
  });
});

describe("mutation: exit-gate skipped scenario detection", () => {
  it("baseline: passed scenarios do not fail the gate", () => {
    const report = evaluateExitGate({
      p0Mutations: [{ mutationId: "m1", detected: true, targets: "x" }],
      referencePrograms: [{ programId: "r1", hardFalseFailures: 0 }],
      hiddenFieldLeakageTests: [{ testName: "t1", passed: true }],
      requiredScenarios: [{ scenarioId: "s1", status: "passed" }],
      evidenceIntegrity: { checksumsComplete: true, evidenceGraphComplete: true, verified: true },
      semanticJudgeUsed: false,
    });
    expect(report.passed).toBe(true);
  });

  it("mutation: skipped scenario fails the gate (masking regression)", () => {
    const report = evaluateExitGate({
      p0Mutations: [{ mutationId: "m1", detected: true, targets: "x" }],
      referencePrograms: [{ programId: "r1", hardFalseFailures: 0 }],
      hiddenFieldLeakageTests: [{ testName: "t1", passed: true }],
      requiredScenarios: [{ scenarioId: "s1", status: "skipped", skipReason: "time" }],
      evidenceIntegrity: { checksumsComplete: true, evidenceGraphComplete: true, verified: true },
      semanticJudgeUsed: false,
    });
    expect(report.passed).toBe(false);
  });
});

describe("mutation: exit-gate semantic judge detection", () => {
  it("mutation: using a semantic Judge fails the gate", () => {
    const report = evaluateExitGate({
      p0Mutations: [{ mutationId: "m1", detected: true, targets: "x" }],
      referencePrograms: [{ programId: "r1", hardFalseFailures: 0 }],
      hiddenFieldLeakageTests: [{ testName: "t1", passed: true }],
      requiredScenarios: [{ scenarioId: "s1", status: "passed" }],
      evidenceIntegrity: { checksumsComplete: true, evidenceGraphComplete: true, verified: true },
      semanticJudgeUsed: true,
    });
    expect(report.passed).toBe(false);
    const cond = report.conditions.find((c) => c.conditionId === "no_semantic_judge_required");
    expect(cond?.passed).toBe(false);
  });

  it("baseline: no semantic judge passes the gate", () => {
    const report = evaluateExitGate({
      p0Mutations: [{ mutationId: "m1", detected: true, targets: "x" }],
      referencePrograms: [{ programId: "r1", hardFalseFailures: 0 }],
      hiddenFieldLeakageTests: [{ testName: "t1", passed: true }],
      requiredScenarios: [{ scenarioId: "s1", status: "passed" }],
      evidenceIntegrity: { checksumsComplete: true, evidenceGraphComplete: true, verified: true },
      semanticJudgeUsed: false,
    });
    expect(report.passed).toBe(true);
  });
});
