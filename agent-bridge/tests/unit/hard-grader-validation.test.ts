/**
 * T46-2 (Issue #95 §2) — HardGraderContract validation tests.
 *
 * The validation module's `validateHardGrader` runs fail-closed checks on
 * the optional `hardGrader` block of a ScenarioContract. Invalid or
 * contradictory constraints cause the scenario to be rejected at validation
 * time, before any Agent run starts.
 *
 * These tests verify:
 * 1. A valid hardGrader block passes validation.
 * 2. Invalid version, missing viewer, invalid run status, etc. fail closed.
 * 3. State constraint contradictions (path both required and forbidden with
 *    overlapping values) are rejected.
 * 4. MilestoneDag mode and milestones are validated.
 * 5. Privacy constraints requiring an adversary fail when adversaryUserId
 *    is missing.
 * 6. Idempotency repeats must be a positive integer.
 * 7. Slice 0 scenarios (no hardGrader) bypass V2 validation.
 * 8. The smoke-v2 preset passes validation.
 */

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { validateEvaluationConfig } from "../../src/evaluation/lab/validation.js";
import {
  HARD_GRADER_CONTRACT_VERSION,
  type HardGraderContract,
} from "../../src/evaluation/lab/contract-v2.js";
import type { EvaluationBudget, ScenarioContract } from "../../src/evaluation/lab/contract.js";
import {
  SLICE_0_SMOKE_BUDGET,
  SLICE_0_SMOKE_SCENARIOS,
  SMOKE_V2_BUDGET,
  SMOKE_V2_SCENARIOS,
} from "../../src/evaluation/lab/presets.js";

const projectRoot = resolve(import.meta.dirname ?? process.cwd(), "../../../");

function buildScenario(hardGrader?: HardGraderContract): ScenarioContract {
  return {
    schemaVersion: 1,
    scenarioId: "test-v2-scenario",
    visible: { prompt: "测试提示" },
    hidden: {
      expectedMode: "answer",
      maxLatencyMs: 5_000,
      tokenBudget: { maxInputTokens: 100, maxOutputTokens: 100 },
      maxRequestCount: 2,
    },
    ...(hardGrader ? { hardGrader } : {}),
  };
}

function buildBudget(): EvaluationBudget {
  return {
    maxSutCostUsd: 0.10,
    maxInputTokens: 100,
    maxOutputTokens: 100,
    maxRequestCount: 2,
    maxWallTimeMs: 5_000,
    maxObservations: 1,
  };
}

function buildHardGrader(overrides: Partial<HardGraderContract> = {}): HardGraderContract {
  return {
    version: HARD_GRADER_CONTRACT_VERSION,
    viewer: { primaryUserId: "demo-user-001" },
    run: { finalStatus: "completed" },
    ...overrides,
  };
}

async function validate(hardGrader?: HardGraderContract) {
  return validateEvaluationConfig({
    projectRoot,
    model: "mock:mock-model",
    scenarios: [buildScenario(hardGrader)],
    budget: buildBudget(),
  });
}

function hasError(code: string, result: { errors: Array<{ code: string }> }): boolean {
  return result.errors.some((e) => e.code === code);
}

/**
 * Filter out environment-specific toolchain errors (node_version, etc.) so
 * the tests focus on hardGrader validation behavior. The toolchain check
 * is environment-dependent and not relevant to the hardGrader contract.
 */
function hardGraderErrors(result: { errors: Array<{ code: string; message: string }> }): Array<{ code: string; message: string }> {
  return result.errors.filter((e) => e.code.startsWith("hard_grader_"));
}

/**
 * Assert that validation passes for the hardGrader block specifically,
 * ignoring environment-specific toolchain errors.
 */
function expectHardGraderValid(result: { errors: Array<{ code: string; message: string }> }): void {
  const hgErrors = hardGraderErrors(result);
  expect(hgErrors, JSON.stringify(hgErrors)).toEqual([]);
}

describe("hardGrader validation — valid contracts", () => {
  it("accepts a minimal valid hardGrader block", async () => {
    const result = await validate(buildHardGrader());
    expectHardGraderValid(result);
  });

  it("accepts a hardGrader block with all constraint types", async () => {
    const hg = buildHardGrader({
      stateConstraints: {
        required: [{ path: "project_status", values: ["active"] }],
        forbidden: [{ path: "project_status", values: ["cancelled"] }],
        unchanged: ["workspace_id"],
      },
      milestoneDag: { mode: "subset", milestones: ["recommend_assignment"] },
      authoritySafety: {
        proposalConfirm: {
          required: [{ proposalType: "assignment", status: "pending" }],
        },
        prohibitedCommitEffectTools: ["finalize_assignment"],
        allowedSideEffectTypes: ["advisory"],
        unknownSideEffects: "fail_closed",
      },
      privacy: {
        adversaryCannotSeeConversationIds: ["conv-001"],
        hiddenFieldTokens: ["SECRET_TOKEN"],
        forbidRawIdsInOutput: true,
      },
      readOnlyStatePurity: true,
      idempotency: { repeats: 1, maxNewSideEffectsPerRepeat: 0 },
    });
    hg.viewer = { primaryUserId: "demo-user-001", adversaryUserId: "demo-user-002" };
    const result = await validate(hg);
    expectHardGraderValid(result);
  });

  it("accepts the smoke-v2 preset", async () => {
    const result = await validateEvaluationConfig({
      projectRoot,
      model: "mock:mock-model",
      scenarios: SMOKE_V2_SCENARIOS,
      budget: SMOKE_V2_BUDGET,
    });
    expectHardGraderValid(result);
  });
});

describe("hardGrader validation — fail-closed on invalid contracts", () => {
  it("rejects an invalid version", async () => {
    const hg = buildHardGrader();
    (hg as HardGraderContract).version = 999 as unknown as typeof HARD_GRADER_CONTRACT_VERSION;
    const result = await validate(hg);
    expect(hasError("hard_grader_version", result)).toBe(true);
    expect(result.valid).toBe(false);
  });

  it("rejects a missing viewer", async () => {
    const hg = buildHardGrader();
    (hg as HardGraderContract).viewer = undefined as unknown as HardGraderContract["viewer"];
    const result = await validate(hg);
    expect(hasError("hard_grader_viewer", result)).toBe(true);
  });

  it("rejects an empty primaryUserId", async () => {
    const hg = buildHardGrader({ viewer: { primaryUserId: "" } });
    const result = await validate(hg);
    expect(hasError("hard_grader_viewer", result)).toBe(true);
  });

  it("rejects an invalid run.finalStatus", async () => {
    const hg = buildHardGrader({
      run: { finalStatus: "unknown" as unknown as "completed" | "failed" },
    });
    const result = await validate(hg);
    expect(hasError("hard_grader_run_status", result)).toBe(true);
  });

  it("rejects a negative maxSideEffects", async () => {
    const hg = buildHardGrader({
      run: { finalStatus: "completed", maxSideEffects: -1 },
    });
    const result = await validate(hg);
    expect(hasError("hard_grader_max_side_effects", result)).toBe(true);
  });

  it("rejects an invalid unknownSideEffects mode", async () => {
    const hg = buildHardGrader({
      authoritySafety: {
        unknownSideEffects: "invalid" as unknown as "fail_closed" | "ignore",
      },
    });
    const result = await validate(hg);
    expect(hasError("hard_grader_unknown_side_effects", result)).toBe(true);
  });

  it("rejects an empty prohibitedCommitEffectTools entry", async () => {
    const hg = buildHardGrader({
      authoritySafety: {
        prohibitedCommitEffectTools: [""],
      },
    });
    const result = await validate(hg);
    expect(hasError("hard_grader_prohibited_tools", result)).toBe(true);
  });

  it("rejects an invalid milestoneDag mode", async () => {
    const hg = buildHardGrader({
      milestoneDag: { mode: "invalid" as unknown as "strict", milestones: ["a"] },
    });
    const result = await validate(hg);
    expect(hasError("hard_grader_dag_mode", result)).toBe(true);
  });

  it("rejects an empty milestones list", async () => {
    const hg = buildHardGrader({
      milestoneDag: { mode: "strict", milestones: [] },
    });
    const result = await validate(hg);
    expect(hasError("hard_grader_dag_milestones", result)).toBe(true);
  });

  it("rejects an empty milestone entry", async () => {
    const hg = buildHardGrader({
      milestoneDag: { mode: "strict", milestones: [""] },
    });
    const result = await validate(hg);
    expect(hasError("hard_grader_dag_milestone", result)).toBe(true);
  });

  it("rejects privacy constraints requiring an adversary when adversaryUserId is missing", async () => {
    const hg = buildHardGrader({
      viewer: { primaryUserId: "demo-user-001" },
      privacy: {
        adversaryCannotSeeConversationIds: ["conv-001"],
      },
    });
    const result = await validate(hg);
    expect(hasError("hard_grader_adversary_missing", result)).toBe(true);
  });

  it("rejects subjectAndOwnerHiddenFromAdversary without adversaryUserId", async () => {
    const hg = buildHardGrader({
      viewer: { primaryUserId: "demo-user-001" },
      privacy: {
        subjectAndOwnerHiddenFromAdversary: true,
      },
    });
    const result = await validate(hg);
    expect(hasError("hard_grader_adversary_missing", result)).toBe(true);
  });

  it("rejects an empty hiddenFieldTokens entry", async () => {
    const hg = buildHardGrader({
      privacy: {
        hiddenFieldTokens: [""],
      },
    });
    const result = await validate(hg);
    expect(hasError("hard_grader_hidden_tokens", result)).toBe(true);
  });

  it("rejects a non-boolean readOnlyStatePurity", async () => {
    const hg = buildHardGrader();
    (hg as HardGraderContract).readOnlyStatePurity = "yes" as unknown as boolean;
    const result = await validate(hg);
    expect(hasError("hard_grader_read_only", result)).toBe(true);
  });

  it("rejects idempotency with non-positive repeats", async () => {
    const hg = buildHardGrader({
      idempotency: { repeats: 0 },
    });
    const result = await validate(hg);
    expect(hasError("hard_grader_idempotency", result)).toBe(true);
  });

  it("rejects idempotency with negative maxNewSideEffectsPerRepeat", async () => {
    const hg = buildHardGrader({
      idempotency: { repeats: 1, maxNewSideEffectsPerRepeat: -1 },
    });
    const result = await validate(hg);
    expect(hasError("hard_grader_idempotency_max", result)).toBe(true);
  });

  it("rejects fail_closed mode without an allowedSideEffectTypes list (M-01)", async () => {
    // fail_closed mode without an allowlist would silently skip the
    // unknown-side-effects grader, contradicting the explicit "fail_closed"
    // intent. Validation must reject this combination at contract time.
    const hg = buildHardGrader({
      authoritySafety: {
        unknownSideEffects: "fail_closed",
        // allowedSideEffectTypes intentionally omitted.
      },
    });
    const result = await validate(hg);
    expect(hasError("hard_grader_allowlist_required", result)).toBe(true);
  });

  it("accepts fail_closed mode with a non-empty allowedSideEffectTypes list", async () => {
    const hg = buildHardGrader({
      authoritySafety: {
        unknownSideEffects: "fail_closed",
        allowedSideEffectTypes: ["advisory"],
      },
    });
    const result = await validate(hg);
    expectHardGraderValid(result);
  });

  it("accepts ignore mode without an allowedSideEffectTypes list", async () => {
    // ignore mode does not need an allowlist because unknown side effects
    // are not enforced.
    const hg = buildHardGrader({
      authoritySafety: {
        unknownSideEffects: "ignore",
      },
    });
    const result = await validate(hg);
    expectHardGraderValid(result);
  });
});

describe("hardGrader validation — state constraint assertions", () => {
  it("rejects a required assertion with an empty path", async () => {
    const hg = buildHardGrader({
      stateConstraints: {
        required: [{ path: "", values: ["active"] }],
      },
    });
    const result = await validate(hg);
    expect(hasError("hard_grader_state_path", result)).toBe(true);
  });

  it("rejects a required assertion with empty values", async () => {
    const hg = buildHardGrader({
      stateConstraints: {
        required: [{ path: "project_status", values: [] }],
      },
    });
    const result = await validate(hg);
    expect(hasError("hard_grader_state_values", result)).toBe(true);
  });

  it("rejects an empty unchanged path", async () => {
    const hg = buildHardGrader({
      stateConstraints: {
        unchanged: [""],
      },
    });
    const result = await validate(hg);
    expect(hasError("hard_grader_unchanged", result)).toBe(true);
  });
});

describe("hardGrader validation — contradiction detection", () => {
  it("rejects a path that is both required and forbidden with the same value", async () => {
    const hg = buildHardGrader({
      stateConstraints: {
        required: [{ path: "project_status", values: ["active"] }],
        forbidden: [{ path: "project_status", values: ["active"] }],
      },
    });
    const result = await validate(hg);
    expect(hasError("hard_grader_state_contradiction", result)).toBe(true);
  });

  it("accepts a path that is both required and forbidden with disjoint values", async () => {
    const hg = buildHardGrader({
      stateConstraints: {
        required: [{ path: "project_status", values: ["active"] }],
        forbidden: [{ path: "project_status", values: ["cancelled"] }],
      },
    });
    const result = await validate(hg);
    expect(hasError("hard_grader_state_contradiction", result)).toBe(false);
  });

  it("does not flag contradictions across different paths", async () => {
    const hg = buildHardGrader({
      stateConstraints: {
        required: [{ path: "project_status", values: ["active"] }],
        forbidden: [{ path: "stage_count", values: ["active"] }],
      },
    });
    const result = await validate(hg);
    expect(hasError("hard_grader_state_contradiction", result)).toBe(false);
  });
});

describe("hardGrader validation — Slice 0 bypass", () => {
  it("scenarios without hardGrader bypass V2 validation", async () => {
    const result = await validateEvaluationConfig({
      projectRoot,
      model: "mock:mock-model",
      scenarios: SLICE_0_SMOKE_SCENARIOS,
      budget: SLICE_0_SMOKE_BUDGET,
    });
    expectHardGraderValid(result);
  });

  it("scenarios without hardGrader do not produce hard_grader_* errors", async () => {
    const result = await validate();
    expectHardGraderValid(result);
  });
});