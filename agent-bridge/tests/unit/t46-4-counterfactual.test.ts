/**
 * T46-4 (Issue #97 §4) — Single-variable counterfactual tests.
 *
 * Verifies:
 *  1. A valid counterfactual with one changed factor supports intervention.
 *  2. Multi-variable changes MUST NOT support intervention.
 *  3. Model drift possible MUST NOT support intervention.
 *  4. Outcome not changed MUST NOT support intervention.
 *  5. Baseline and intervention must use isolated run IDs.
 *  6. The paired manifest SHA-256 is required and deterministic.
 *  7. `assertSingleVariable` detects multi-variable changes.
 *  8. `counterfactualSupportedStatus` returns the correct status.
 *  9. `stableCounterfactualId` produces stable IDs.
 */

import { describe, expect, it } from "vitest";
import {
  buildCounterfactualRecord,
  outcomesDiffer,
  computePairedManifestSha256,
  assertSingleVariable,
  counterfactualSupportedStatus,
  stableCounterfactualId,
  type BuildCounterfactualInput,
} from "../../src/evaluation/lab/counterfactual.js";
import { EvaluationValidationError } from "../../src/evaluation/lab/errors.js";
import type { CounterfactualOutcome } from "../../src/evaluation/lab/diagnosis-contract.js";

function buildOutcome(overrides: Partial<CounterfactualOutcome> = {}): CounterfactualOutcome {
  return {
    scenarioId: "scn-1",
    finalStatus: "failed",
    hardGradePassed: false,
    sideEffectCount: 1,
    observationSha256: "abc123",
    ...overrides,
  };
}

function buildValidInput(overrides: Partial<BuildCounterfactualInput> = {}): BuildCounterfactualInput {
  return {
    counterfactualId: "cf-1",
    baselineRunId: "run-baseline",
    interventionRunId: "run-intervention",
    changedFactor: {
      name: "routing_mode",
      baselineValue: "action",
      interventionValue: "answer",
    },
    unchangedFactors: [
      { name: "model", baselineValue: "mock", interventionValue: "mock" },
      { name: "seed", baselineValue: "42", interventionValue: "42" },
    ],
    resolvedModelConfirmed: true,
    modelDriftPossible: false,
    pairedManifestSha256: "manifest-hash-abc",
    baselineOutcome: buildOutcome({ observationSha256: "baseline-obs" }),
    interventionOutcome: buildOutcome({
      observationSha256: "intervention-obs",
      finalStatus: "completed",
      hardGradePassed: true,
    }),
    ...overrides,
  };
}

describe("T46-4 counterfactual — valid construction", () => {
  it("builds a counterfactual that supports intervention", () => {
    const record = buildCounterfactualRecord(buildValidInput());
    expect(record.supportsIntervention).toBe(true);
    expect(record.outcomeChanged).toBe(true);
    expect(record.rejectionReason).toBeUndefined();
  });

  it("records the changed factor and unchanged factors", () => {
    const record = buildCounterfactualRecord(buildValidInput());
    expect(record.changedFactor.name).toBe("routing_mode");
    expect(record.unchangedFactors.length).toBe(2);
    expect(record.unchangedFactors.map((f) => f.name)).toEqual(["model", "seed"]);
  });
});

describe("T46-4 counterfactual — multi-variable guard", () => {
  it("rejects when the changed factor also appears in unchanged factors", () => {
    const input = buildValidInput({
      unchangedFactors: [
        { name: "routing_mode", baselineValue: "action", interventionValue: "answer" },
      ],
    });
    expect(() => buildCounterfactualRecord(input)).toThrow(/同时出现在/);
  });

  it("assertSingleVariable throws when multiple factors changed", () => {
    expect(() =>
      assertSingleVariable(
        { name: "routing_mode", baselineValue: "action", interventionValue: "answer" },
        [{ name: "model", baselineValue: "mock", interventionValue: "mock" }],
        { routing_mode: "action", model: "mock", seed: "42" },
        { routing_mode: "answer", model: "different", seed: "42" },
      ),
    ).toThrow(/改变了多个因素/);
  });

  it("assertSingleVariable passes when only the declared factor changed", () => {
    expect(() =>
      assertSingleVariable(
        { name: "routing_mode", baselineValue: "action", interventionValue: "answer" },
        [{ name: "model", baselineValue: "mock", interventionValue: "mock" }],
        { routing_mode: "action", model: "mock" },
        { routing_mode: "answer", model: "mock" },
      ),
    ).not.toThrow();
  });

  it("assertSingleVariable throws when changedFactor is not in declared set", () => {
    // All declared factors are the same (no multi-variable change), but
    // the declared changedFactor.name is not in the declared set.
    expect(() =>
      assertSingleVariable(
        { name: "missing_factor", baselineValue: "a", interventionValue: "b" },
        [],
        { routing_mode: "action" },
        { routing_mode: "action" },
      ),
    ).toThrow(/未出现在声明的因素集合中/);
  });
});

describe("T46-4 counterfactual — model drift guard", () => {
  it("does NOT support intervention when model drift is possible", () => {
    const input = buildValidInput({ modelDriftPossible: true });
    const record = buildCounterfactualRecord(input);
    expect(record.supportsIntervention).toBe(false);
    expect(record.rejectionReason).toContain("model drift");
  });

  it("does NOT support intervention when resolved model is unconfirmed", () => {
    const input = buildValidInput({ resolvedModelConfirmed: false });
    const record = buildCounterfactualRecord(input);
    expect(record.supportsIntervention).toBe(false);
    expect(record.rejectionReason).toContain("resolved model");
  });
});

describe("T46-4 counterfactual — outcome change guard", () => {
  it("does NOT support intervention when outcome did not change", () => {
    const input = buildValidInput({
      interventionOutcome: buildOutcome({
        observationSha256: "intervention-obs",
        // Same finalStatus, hardGradePassed, sideEffectCount as baseline.
      }),
    });
    // Baseline: failed/false/1, Intervention: failed/false/1 — no observable difference.
    const record = buildCounterfactualRecord(input);
    expect(record.outcomeChanged).toBe(false);
    expect(record.supportsIntervention).toBe(false);
    expect(record.rejectionReason).toContain("未改变 outcome");
  });

  it("outcomesDiffer detects finalStatus changes", () => {
    const baseline = buildOutcome({ finalStatus: "failed" });
    const intervention = buildOutcome({ finalStatus: "completed" });
    expect(outcomesDiffer(baseline, intervention)).toBe(true);
  });

  it("outcomesDiffer detects hardGradePassed changes", () => {
    const baseline = buildOutcome({ hardGradePassed: false });
    const intervention = buildOutcome({ hardGradePassed: true });
    expect(outcomesDiffer(baseline, intervention)).toBe(true);
  });

  it("outcomesDiffer detects sideEffectCount changes", () => {
    const baseline = buildOutcome({ sideEffectCount: 1 });
    const intervention = buildOutcome({ sideEffectCount: 2 });
    expect(outcomesDiffer(baseline, intervention)).toBe(true);
  });

  it("outcomesDiffer returns false when only observation SHA-256 differs", () => {
    const baseline = buildOutcome({ observationSha256: "a" });
    const intervention = buildOutcome({ observationSha256: "b" });
    expect(outcomesDiffer(baseline, intervention)).toBe(false);
  });
});

describe("T46-4 counterfactual — isolation guards", () => {
  it("rejects when baseline and intervention share a run ID", () => {
    const input = buildValidInput({
      baselineRunId: "same-run",
      interventionRunId: "same-run",
    });
    expect(() => buildCounterfactualRecord(input)).toThrow(/隔离 runtime/);
  });

  it("rejects when observation SHA-256 is identical between baseline and intervention", () => {
    const input = buildValidInput({
      baselineOutcome: buildOutcome({ observationSha256: "same", scenarioId: "scn-1" }),
      interventionOutcome: buildOutcome({ observationSha256: "same", scenarioId: "scn-1" }),
    });
    expect(() => buildCounterfactualRecord(input)).toThrow(/observation SHA-256 相同/);
  });

  it("rejects when pairedManifestSha256 is empty", () => {
    const input = buildValidInput({ pairedManifestSha256: "" });
    expect(() => buildCounterfactualRecord(input)).toThrow(/pairedManifestSha256/);
  });
});

describe("T46-4 counterfactual — status promotion mapping", () => {
  it("returns intervention_supported when supportsIntervention is true", () => {
    const record = buildCounterfactualRecord(buildValidInput());
    expect(counterfactualSupportedStatus(record)).toBe("intervention_supported");
  });

  it("returns localized_hypothesis when outcome changed but model drift", () => {
    const input = buildValidInput({ modelDriftPossible: true });
    const record = buildCounterfactualRecord(input);
    expect(counterfactualSupportedStatus(record)).toBe("localized_hypothesis");
  });

  it("returns unresolved when outcome did not change", () => {
    const input = buildValidInput({
      interventionOutcome: buildOutcome({ observationSha256: "intervention-obs" }),
    });
    const record = buildCounterfactualRecord(input);
    expect(counterfactualSupportedStatus(record)).toBe("unresolved");
  });
});

describe("T46-4 counterfactual — paired manifest", () => {
  it("computePairedManifestSha256 is deterministic", () => {
    const alignment = {
      scenarioManifestSha256: "abc",
      seedManifestSha256: "def",
      frozenStandardsVersion: "1.0",
      evaluatorVersion: "1.0",
      changedFactorName: "routing_mode",
      unchangedFactorNames: ["model", "seed"],
    };
    const hash1 = computePairedManifestSha256(alignment);
    const hash2 = computePairedManifestSha256(alignment);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("computePairedManifestSha256 differs for different alignments", () => {
    const base = {
      scenarioManifestSha256: "abc",
      seedManifestSha256: "def",
      frozenStandardsVersion: "1.0",
      evaluatorVersion: "1.0",
      changedFactorName: "routing_mode",
      unchangedFactorNames: ["model", "seed"],
    };
    const hash1 = computePairedManifestSha256(base);
    const hash2 = computePairedManifestSha256({ ...base, changedFactorName: "different" });
    expect(hash1).not.toBe(hash2);
  });
});

describe("T46-4 counterfactual — stable ID", () => {
  it("produces the same ID for the same inputs", () => {
    const id1 = stableCounterfactualId("run-a", "run-b", "routing_mode");
    const id2 = stableCounterfactualId("run-a", "run-b", "routing_mode");
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^cf-/);
  });

  it("produces different IDs for different inputs", () => {
    const id1 = stableCounterfactualId("run-a", "run-b", "routing_mode");
    const id2 = stableCounterfactualId("run-a", "run-b", "model");
    expect(id1).not.toBe(id2);
  });
});

describe("T46-4 counterfactual — error type", () => {
  it("uses EvaluationValidationError for all guard failures", () => {
    const input = buildValidInput({ pairedManifestSha256: "" });
    try {
      buildCounterfactualRecord(input);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EvaluationValidationError);
    }
  });
});