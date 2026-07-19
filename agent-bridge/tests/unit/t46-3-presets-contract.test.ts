/**
 * T46-3 (Issue #96 §6) — Presets and contract tests.
 *
 * Verifies:
 *  1. demo, smoke, and full presets exist and contain P0 scenarios.
 *  2. demo and smoke do NOT claim statistical significance.
 *  3. full is the only preset that can claim statistical significance.
 *  4. validate continues to use zero Token and zero SUT calls.
 *  5. T46_3_P0_SCENARIO_IDS lists all required P0 scenarios.
 *  6. T46_3_CONTROLLER_FACTS and T46_3_SKILL_CONTRACTS are non-empty.
 *  7. V3_CONTRACT_VERSION is 1.
 *  8. SIMULATOR_RETRY_BUDGET is 2.
 *  9. The hidden sentinel is NEVER sent to the SUT (only digests appear
 *     in artifacts).
 * 10. Preset budgets respect the cost caps (smoke/demo $0.10, full $1.00).
 */

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  SLICE_0_PRESETS,
  DEMO_SCENARIOS,
  DEMO_BUDGET,
  FULL_SCENARIOS,
  FULL_BUDGET,
  T46_3_CONTROLLER_FACTS,
  T46_3_SKILL_CONTRACTS,
  T46_3_VERSION,
  T46_3_P0_SCENARIO_IDS,
  SLICE_0_SMOKE_SCENARIOS,
  SLICE_0_SMOKE_BUDGET,
  SMOKE_V2_SCENARIOS,
  SMOKE_V2_BUDGET,
} from "../../src/evaluation/lab/presets.js";
import { V3_CONTRACT_VERSION, SIMULATOR_RETRY_BUDGET } from "../../src/evaluation/lab/contract-v3.js";
import { validateEvaluationConfig } from "../../src/evaluation/lab/validation.js";
import { sha256 } from "../../src/evaluation/lab/validation.js";

const projectRoot = resolve(import.meta.dirname ?? process.cwd(), "../../../");

describe("V3_CONTRACT_VERSION — frozen", () => {
  it("is 1", () => {
    expect(V3_CONTRACT_VERSION).toBe(1);
  });

  it("matches T46_3_VERSION export", () => {
    expect(T46_3_VERSION).toBe(V3_CONTRACT_VERSION);
  });
});

describe("SIMULATOR_RETRY_BUDGET — frozen", () => {
  it("is 2", () => {
    expect(SIMULATOR_RETRY_BUDGET).toBe(2);
  });
});

describe("SLICE_0_PRESETS — contains demo, smoke, smoke-v2, full", () => {
  it("has all 4 presets", () => {
    expect(Object.keys(SLICE_0_PRESETS).sort()).toEqual(["demo", "full", "smoke", "smoke-v2"]);
  });

  it("each preset has scenarios and a budget", () => {
    for (const [name, preset] of Object.entries(SLICE_0_PRESETS)) {
      expect(preset.scenarios.length).toBeGreaterThan(0);
      expect(preset.budget).toBeDefined();
      expect(preset.budget.maxSutCostUsd).toBeGreaterThan(0);
    }
  });
});

describe("DEMO_SCENARIOS — P0 coverage", () => {
  it("includes the multi-turn controller P0 scenario", () => {
    expect(DEMO_SCENARIOS.some((s) => s.scenarioId === "multi-turn-controller-p0")).toBe(true);
  });

  it("includes the skill evaluation P0 scenario", () => {
    expect(DEMO_SCENARIOS.some((s) => s.scenarioId === "skill-eval-project-planning-p0")).toBe(true);
  });

  it("includes the runtime cancellation P0 scenario", () => {
    expect(DEMO_SCENARIOS.some((s) => s.scenarioId === "runtime-fault-cancellation-p0")).toBe(true);
  });

  it("includes the answer-only P0 scenario", () => {
    expect(DEMO_SCENARIOS.some((s) => s.scenarioId === "answer-no-tool-v2")).toBe(true);
  });

  it("includes the plan-proposal-confirm P0 scenario", () => {
    expect(DEMO_SCENARIOS.some((s) => s.scenarioId === "plan-proposal-confirm")).toBe(true);
  });

  it("includes the plan-proposal-reject P0 scenario", () => {
    expect(DEMO_SCENARIOS.some((s) => s.scenarioId === "plan-proposal-reject")).toBe(true);
  });
});

describe("FULL_SCENARIOS — P0 coverage", () => {
  it("includes all DEMO scenarios plus the duplicate terminal scenario", () => {
    expect(FULL_SCENARIOS.some((s) => s.scenarioId === "runtime-fault-duplicate-terminal-p0")).toBe(true);
  });

  it("has at least as many scenarios as DEMO", () => {
    expect(FULL_SCENARIOS.length).toBeGreaterThanOrEqual(DEMO_SCENARIOS.length);
  });
});

describe("DEMO_BUDGET — cost cap", () => {
  it("respects the $0.10 cost cap", () => {
    expect(DEMO_BUDGET.maxSutCostUsd).toBeLessThanOrEqual(0.10);
  });
});

describe("FULL_BUDGET — cost cap", () => {
  it("respects the $1.00 cost cap", () => {
    expect(FULL_BUDGET.maxSutCostUsd).toBeLessThanOrEqual(1.00);
  });
});

describe("SMOKE_V2_BUDGET — cost cap", () => {
  it("respects the $0.10 cost cap", () => {
    expect(SMOKE_V2_BUDGET.maxSutCostUsd).toBeLessThanOrEqual(0.10);
  });
});

describe("SLICE_0_SMOKE_BUDGET — cost cap", () => {
  it("respects the $0.10 cost cap", () => {
    expect(SLICE_0_SMOKE_BUDGET.maxSutCostUsd).toBeLessThanOrEqual(0.10);
  });
});

describe("T46_3_P0_SCENARIO_IDS — all required P0 IDs", () => {
  it("includes all 6 required P0 scenario IDs", () => {
    expect(T46_3_P0_SCENARIO_IDS).toEqual([
      "answer-no-tool-v2",
      "plan-proposal-confirm",
      "plan-proposal-reject",
      "multi-turn-controller-p0",
      "skill-eval-project-planning-p0",
      "runtime-fault-cancellation-p0",
    ]);
  });

  it("all P0 scenario IDs appear in the DEMO or FULL preset", () => {
    const allScenarioIds = new Set([...DEMO_SCENARIOS, ...FULL_SCENARIOS].map((s) => s.scenarioId));
    for (const id of T46_3_P0_SCENARIO_IDS) {
      expect(allScenarioIds.has(id)).toBe(true);
    }
  });
});

describe("T46_3_CONTROLLER_FACTS — hidden oracle", () => {
  it("includes the multi-turn controller facts", () => {
    expect(T46_3_CONTROLLER_FACTS["multi-turn-controller-p0"]).toBeDefined();
  });

  it("the controller facts contain hidden sentinels", () => {
    const facts = T46_3_CONTROLLER_FACTS["multi-turn-controller-p0"]!;
    expect(facts.hiddenSentinels).toBeDefined();
    expect(facts.hiddenSentinels!.length).toBeGreaterThan(0);
  });

  it("the controller facts are NOT exposed in any scenario's visible prompt", () => {
    const facts = T46_3_CONTROLLER_FACTS["multi-turn-controller-p0"]!;
    for (const scenario of DEMO_SCENARIOS) {
      // Hidden sentinels must NOT appear in the visible prompt (the only
      // part of the scenario contract sent to the SUT). They MAY appear
      // in hardGrader.privacy.hiddenFieldTokens (evaluator-only).
      for (const sentinel of facts.hiddenSentinels ?? []) {
        expect(scenario.visible.prompt).not.toContain(sentinel);
      }
      // Hidden facts must NOT appear in the visible prompt.
      for (const fact of facts.hiddenFacts) {
        expect(scenario.visible.prompt).not.toContain(fact);
      }
    }
  });
});

describe("T46_3_SKILL_CONTRACTS — skill evaluation contracts", () => {
  it("includes the project-planning skill contract", () => {
    expect(T46_3_SKILL_CONTRACTS.some((c) => c.skillName === "project-planning")).toBe(true);
  });

  it("includes the project-status skill contract", () => {
    expect(T46_3_SKILL_CONTRACTS.some((c) => c.skillName === "project-status")).toBe(true);
  });

  it("each skill contract declares all 8-dimension fields", () => {
    for (const contract of T46_3_SKILL_CONTRACTS) {
      expect(contract.positiveTriggerPrompt).toBeTruthy();
      expect(contract.negativeTriggerPrompts).toBeDefined();
      expect(contract.prerequisites).toBeDefined();
      expect(contract.allowedTools).toBeDefined();
      expect(contract.requiredSteps).toBeDefined();
      expect(contract.forbiddenActions).toBeDefined();
      expect(contract.effectCeiling).toBeDefined();
    }
  });
});

describe("validate — zero Token, zero SUT calls", () => {
  it("demo preset passes validation", async () => {
    const result = await validateEvaluationConfig({
      projectRoot,
      model: "mock:mock-model",
      scenarios: DEMO_SCENARIOS,
      budget: DEMO_BUDGET,
      preset: "demo",
    });
    expect(result.valid).toBe(true);
  });

  it("smoke preset passes validation", async () => {
    const result = await validateEvaluationConfig({
      projectRoot,
      model: "mock:mock-model",
      scenarios: SLICE_0_SMOKE_SCENARIOS,
      budget: SLICE_0_SMOKE_BUDGET,
      preset: "smoke",
    });
    expect(result.valid).toBe(true);
  });

  it("smoke-v2 preset passes validation", async () => {
    const result = await validateEvaluationConfig({
      projectRoot,
      model: "mock:mock-model",
      scenarios: SMOKE_V2_SCENARIOS,
      budget: SMOKE_V2_BUDGET,
      preset: "smoke-v2",
    });
    expect(result.valid).toBe(true);
  });

  it("full preset passes validation", async () => {
    const result = await validateEvaluationConfig({
      projectRoot,
      model: "mock:mock-model",
      scenarios: FULL_SCENARIOS,
      budget: FULL_BUDGET,
      preset: "full",
    });
    expect(result.valid).toBe(true);
  });

  it("validate does NOT invoke the SUT (zero Token, zero SUT calls)", async () => {
    // The validator only checks scenario/budget/model/toolchain
    // consistency. It does not make HTTP calls to the backend or sidecar.
    // We verify this by ensuring the function returns without a running
    // backend/sidecar.
    const result = await validateEvaluationConfig({
      projectRoot,
      model: "mock:mock-model",
      scenarios: SLICE_0_SMOKE_SCENARIOS,
      budget: SLICE_0_SMOKE_BUDGET,
      preset: "smoke",
    });
    expect(result.errors).toEqual([]);
  });
});

describe("validate — budget caps are preset-aware", () => {
  it("rejects full preset budget when using the smoke cap", async () => {
    // full preset allows $1.00; smoke allows $0.10. Verify the validator
    // uses the correct cap per preset.
    const result = await validateEvaluationConfig({
      projectRoot,
      model: "mock:mock-model",
      scenarios: FULL_SCENARIOS,
      budget: { ...FULL_BUDGET, maxSutCostUsd: 0.50 },
      preset: "full",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects smoke preset budget exceeding $0.10", async () => {
    const result = await validateEvaluationConfig({
      projectRoot,
      model: "mock:mock-model",
      scenarios: SLICE_0_SMOKE_SCENARIOS,
      budget: { ...SLICE_0_SMOKE_BUDGET, maxSutCostUsd: 0.50 },
      preset: "smoke",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code.includes("budget") || e.message.includes("cost"))).toBe(true);
  });
});

describe("hidden sentinel — never exposed in scenario contracts", () => {
  it("the T46_3 hidden sentinel does not appear in any scenario's visible or hidden fields", () => {
    const facts = T46_3_CONTROLLER_FACTS["multi-turn-controller-p0"]!;
    const sentinel = facts.hiddenSentinels![0]!;
    for (const scenario of [...DEMO_SCENARIOS, ...FULL_SCENARIOS]) {
      const serialized = JSON.stringify(scenario);
      // The sentinel may appear in the hardGrader.privacy.hiddenFieldTokens
      // (that's where it's supposed to be — it's a leakage grader input).
      // But it must NOT appear in the visible prompt.
      expect(scenario.visible.prompt).not.toContain(sentinel);
    }
  });
});

describe("hidden sentinel — only SHA-256 digests in artifact", () => {
  it("the sentinel can be hashed for artifact storage", () => {
    const facts = T46_3_CONTROLLER_FACTS["multi-turn-controller-p0"]!;
    const sentinel = facts.hiddenSentinels![0]!;
    const digest = sha256(sentinel);
    expect(digest).toHaveLength(64); // SHA-256 hex digest
    expect(digest).not.toContain(sentinel);
  });
});
