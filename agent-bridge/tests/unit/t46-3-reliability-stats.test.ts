/**
 * T46-3 (Issue #96 §8) — Reliability statistics and reporting tests.
 *
 * Verifies all 6 metrics:
 *  1. observed_trial_pass_rate: passes / denominator
 *  2. empirical_all_k_reliability: groups where all k repeats passed
 *  3. pass_at_k: 1 - (1-p)^k (modeled)
 *  4. modeled_pass_k: Beta prior posterior expectation (modeled)
 *  5. all_invariant_pass: trials where all hard invariants passed
 *  6. confidence_interval: Wilson score interval
 *
 * Also verifies:
 *  - demo/smoke presets CANNOT claim statistical significance.
 *  - full preset can claim significance only with sufficient sample size.
 *  - insufficient_evidence is set when sample size < 30.
 *  - Each metric carries explicit numerator/denominator/excluded/
 *    assumptions/sample_size.
 *  - pass@k, pass^k, single-trial pass rate, and all-invariant-pass are
 *    NOT confused with each other.
 */

import { describe, expect, it } from "vitest";
import {
  computeReliabilityReport,
  hasSufficientEvidence,
  canClaimStatisticalSignificance,
  isEmpiricalMetric,
  isModeledMetric,
  formatMetric,
  formatReliabilityReport,
  MIN_STATISTICAL_SIGNIFICANCE_SAMPLE_SIZE,
  DEFAULT_CONFIDENCE_LEVEL,
} from "../../src/evaluation/lab/reliability-stats.js";
import type { ReliabilityMetric, ReliabilityTrial } from "../../src/evaluation/lab/contract-v3.js";

function buildTrial(overrides: Partial<ReliabilityTrial> = {}): ReliabilityTrial {
  return {
    scenarioId: "scn-001",
    passed: true,
    excluded: false,
    allInvariantsPassed: true,
    ...overrides,
  };
}

describe("MIN_STATISTICAL_SIGNIFICANCE_SAMPLE_SIZE — frozen", () => {
  it("is 30", () => {
    expect(MIN_STATISTICAL_SIGNIFICANCE_SAMPLE_SIZE).toBe(30);
  });
});

describe("DEFAULT_CONFIDENCE_LEVEL — frozen", () => {
  it("is 0.95", () => {
    expect(DEFAULT_CONFIDENCE_LEVEL).toBe(0.95);
  });
});

describe("isEmpiricalMetric / isModeledMetric — metric classification", () => {
  it("classifies empirical metrics correctly", () => {
    expect(isEmpiricalMetric("observed_trial_pass_rate")).toBe(true);
    expect(isEmpiricalMetric("empirical_all_k_reliability")).toBe(true);
    expect(isEmpiricalMetric("all_invariant_pass")).toBe(true);
  });

  it("classifies modeled metrics correctly", () => {
    expect(isModeledMetric("pass_at_k")).toBe(true);
    expect(isModeledMetric("modeled_pass_k")).toBe(true);
    expect(isModeledMetric("confidence_interval")).toBe(true);
  });

  it("empirical and modeled are mutually exclusive", () => {
    const empiricalKinds = ["observed_trial_pass_rate", "empirical_all_k_reliability", "all_invariant_pass"] as const;
    const modeledKinds = ["pass_at_k", "modeled_pass_k", "confidence_interval"] as const;
    for (const k of empiricalKinds) {
      expect(isModeledMetric(k)).toBe(false);
    }
    for (const k of modeledKinds) {
      expect(isEmpiricalMetric(k)).toBe(false);
    }
  });
});

describe("computeReliabilityReport — 6 metrics present", () => {
  it("produces all 6 metrics in declared order", () => {
    const trials = [buildTrial({ passed: true }), buildTrial({ passed: false })];
    const report = computeReliabilityReport(trials, { preset: "full" });
    expect(report.metrics.length).toBe(6);
    expect(report.metrics[0]!.kind).toBe("observed_trial_pass_rate");
    expect(report.metrics[1]!.kind).toBe("empirical_all_k_reliability");
    expect(report.metrics[2]!.kind).toBe("pass_at_k");
    expect(report.metrics[3]!.kind).toBe("modeled_pass_k");
    expect(report.metrics[4]!.kind).toBe("all_invariant_pass");
    expect(report.metrics[5]!.kind).toBe("confidence_interval");
  });
});

describe("computeReliabilityReport — observed_trial_pass_rate", () => {
  it("computes passes/denominator correctly", () => {
    const trials = [
      buildTrial({ passed: true }),
      buildTrial({ passed: true }),
      buildTrial({ passed: false }),
    ];
    const report = computeReliabilityReport(trials, { preset: "full" });
    const metric = report.metrics[0]!;
    expect(metric.numerator).toBe(2);
    expect(metric.denominator).toBe(3);
    expect(metric.value).toBeCloseTo(2 / 3, 5);
  });

  it("excludes excluded trials from the denominator", () => {
    const trials = [
      buildTrial({ passed: true }),
      buildTrial({ passed: false, excluded: true }),
    ];
    const report = computeReliabilityReport(trials, { preset: "full" });
    const metric = report.metrics[0]!;
    expect(metric.denominator).toBe(1);
    expect(metric.excluded).toBe(1);
    expect(metric.value).toBe(1);
  });

  it("returns null value when denominator is 0", () => {
    const trials = [buildTrial({ excluded: true })];
    const report = computeReliabilityReport(trials, { preset: "full" });
    const metric = report.metrics[0]!;
    expect(metric.value).toBeNull();
    expect(metric.denominator).toBe(0);
  });
});

describe("computeReliabilityReport — empirical_all_k_reliability", () => {
  it("computes the fraction of groups where all k repeats passed", () => {
    const trials = [
      buildTrial({ scenarioId: "g1", passed: true, repeatGroupId: "g1" }),
      buildTrial({ scenarioId: "g1", passed: true, repeatGroupId: "g1" }),
      buildTrial({ scenarioId: "g2", passed: true, repeatGroupId: "g2" }),
      buildTrial({ scenarioId: "g2", passed: false, repeatGroupId: "g2" }),
    ];
    const report = computeReliabilityReport(trials, { preset: "full" });
    const metric = report.metrics[1]!;
    // g1: all passed. g2: not all passed. So 1/2 = 0.5.
    expect(metric.numerator).toBe(1);
    expect(metric.denominator).toBe(2);
    expect(metric.value).toBe(0.5);
  });

  it("returns null when there are no repeat groups", () => {
    const trials = [buildTrial({ passed: true })];
    const report = computeReliabilityReport(trials, { preset: "full" });
    const metric = report.metrics[1]!;
    expect(metric.value).toBeNull();
    expect(metric.denominator).toBe(0);
  });
});

describe("computeReliabilityReport — pass_at_k (modeled, k=1)", () => {
  it("computes 1 - (1-p)^1 = p", () => {
    const trials = [
      buildTrial({ passed: true }),
      buildTrial({ passed: false }),
    ];
    const report = computeReliabilityReport(trials, { preset: "full" });
    const metric = report.metrics[2]!;
    // p = 0.5, k = 1, pass@1 = 1 - (1-0.5)^1 = 0.5
    expect(metric.value).toBeCloseTo(0.5, 5);
    expect(metric.k).toBe(1);
  });

  it("returns null when denominator is 0", () => {
    const trials = [buildTrial({ excluded: true })];
    const report = computeReliabilityReport(trials, { preset: "full" });
    const metric = report.metrics[2]!;
    expect(metric.value).toBeNull();
  });
});

describe("computeReliabilityReport — modeled_pass_k (Beta prior, k=1)", () => {
  it("computes E[1 - (1-p)^1 | data] = 1 - E[1-p | data]", () => {
    // With Beta(1,1) prior and 1 pass, 1 fail:
    // posterior is Beta(2, 2). E[1-p] = 2/4 = 0.5.
    // So modeled_pass_1 = 1 - 0.5 = 0.5.
    const trials = [
      buildTrial({ passed: true }),
      buildTrial({ passed: false }),
    ];
    const report = computeReliabilityReport(trials, { preset: "full" });
    const metric = report.metrics[3]!;
    expect(metric.value).toBeCloseTo(0.5, 5);
    expect(metric.k).toBe(1);
  });

  it("returns null when denominator is 0", () => {
    const trials = [buildTrial({ excluded: true })];
    const report = computeReliabilityReport(trials, { preset: "full" });
    const metric = report.metrics[3]!;
    expect(metric.value).toBeNull();
  });

  it("differs from pass_at_k when sample size is small (prior influence)", () => {
    // With 1 pass, 0 fails:
    // pass@1 = 1 - (1-1)^1 = 1.0
    // modeled_pass_1 with Beta(1,1) prior: posterior Beta(2,1),
    // E[1-p] = 1/3, so modeled = 2/3 ≈ 0.6667.
    const trials = [buildTrial({ passed: true })];
    const report = computeReliabilityReport(trials, { preset: "full" });
    const passAtK = report.metrics[2]!;
    const modeledPassK = report.metrics[3]!;
    expect(passAtK.value).toBe(1);
    expect(modeledPassK.value).toBeCloseTo(2 / 3, 5);
    // The two metrics are DIFFERENT — they cannot be confused.
    expect(modeledPassK.value).not.toBe(passAtK.value);
  });
});

describe("computeReliabilityReport — all_invariant_pass", () => {
  it("computes the fraction of trials where all hard invariants passed", () => {
    const trials = [
      buildTrial({ passed: true, allInvariantsPassed: true }),
      buildTrial({ passed: true, allInvariantsPassed: false }),
    ];
    const report = computeReliabilityReport(trials, { preset: "full" });
    const metric = report.metrics[4]!;
    expect(metric.numerator).toBe(1);
    expect(metric.denominator).toBe(2);
    expect(metric.value).toBe(0.5);
  });

  it("differs from observed_trial_pass_rate when invariants fail but trial passes", () => {
    const trials = [
      buildTrial({ passed: true, allInvariantsPassed: false }),
    ];
    const report = computeReliabilityReport(trials, { preset: "full" });
    const observed = report.metrics[0]!;
    const allInvariant = report.metrics[4]!;
    expect(observed.value).toBe(1);
    expect(allInvariant.value).toBe(0);
    // The two metrics are DIFFERENT — they cannot be confused.
    expect(allInvariant.value).not.toBe(observed.value);
  });
});

describe("computeReliabilityReport — confidence_interval (Wilson)", () => {
  it("computes lower and upper bounds", () => {
    const trials = Array(10).fill(null).map(() => buildTrial({ passed: true }));
    const report = computeReliabilityReport(trials, { preset: "full" });
    const ci = report.metrics[5]!;
    expect(ci.lowerBound).toBeDefined();
    expect(ci.upperBound).toBeDefined();
    expect(ci.lowerBound!).toBeLessThanOrEqual(ci.value!);
    expect(ci.upperBound!).toBeGreaterThanOrEqual(ci.value!);
    expect(ci.confidenceLevel).toBe(0.95);
  });

  it("returns null when denominator is 0", () => {
    const trials = [buildTrial({ excluded: true })];
    const report = computeReliabilityReport(trials, { preset: "full" });
    const ci = report.metrics[5]!;
    expect(ci.value).toBeNull();
  });
});

describe("computeReliabilityReport — insufficient evidence", () => {
  it("sets insufficientEvidence=true when sample size < 30", () => {
    const trials = Array(5).fill(null).map(() => buildTrial({ passed: true }));
    const report = computeReliabilityReport(trials, { preset: "full" });
    expect(report.insufficientEvidence).toBe(true);
    expect(report.totalTrials).toBe(5);
  });

  it("sets insufficientEvidence=false when sample size >= 30", () => {
    const trials = Array(30).fill(null).map(() => buildTrial({ passed: true }));
    const report = computeReliabilityReport(trials, { preset: "full" });
    expect(report.insufficientEvidence).toBe(false);
  });
});

describe("computeReliabilityReport — statistical significance claim", () => {
  it("demo preset CANNOT claim statistical significance", () => {
    const trials = Array(100).fill(null).map(() => buildTrial({ passed: true }));
    const report = computeReliabilityReport(trials, { preset: "demo" });
    expect(report.statisticalSignificanceClaimAllowed).toBe(false);
  });

  it("smoke preset CANNOT claim statistical significance", () => {
    const trials = Array(100).fill(null).map(() => buildTrial({ passed: true }));
    const report = computeReliabilityReport(trials, { preset: "smoke" });
    expect(report.statisticalSignificanceClaimAllowed).toBe(false);
  });

  it("smoke-v2 preset CANNOT claim statistical significance", () => {
    const trials = Array(100).fill(null).map(() => buildTrial({ passed: true }));
    const report = computeReliabilityReport(trials, { preset: "smoke-v2" });
    expect(report.statisticalSignificanceClaimAllowed).toBe(false);
  });

  it("full preset CAN claim significance when sample size >= 30", () => {
    const trials = Array(30).fill(null).map(() => buildTrial({ passed: true }));
    const report = computeReliabilityReport(trials, { preset: "full" });
    expect(report.statisticalSignificanceClaimAllowed).toBe(true);
  });

  it("full preset CANNOT claim significance when sample size < 30", () => {
    const trials = Array(10).fill(null).map(() => buildTrial({ passed: true }));
    const report = computeReliabilityReport(trials, { preset: "full" });
    expect(report.statisticalSignificanceClaimAllowed).toBe(false);
  });
});

describe("computeReliabilityReport — per-scenario metrics", () => {
  it("produces per-scenario metrics", () => {
    const trials = [
      buildTrial({ scenarioId: "s1", passed: true }),
      buildTrial({ scenarioId: "s1", passed: false }),
      buildTrial({ scenarioId: "s2", passed: true }),
    ];
    const report = computeReliabilityReport(trials, { preset: "full" });
    expect(report.perScenario.length).toBe(2);
    const s1 = report.perScenario.find((p) => p.scenarioId === "s1")!;
    expect(s1).toBeDefined();
    const observed = s1.metrics.find((m) => m.kind === "observed_trial_pass_rate")!;
    expect(observed.numerator).toBe(1);
    expect(observed.denominator).toBe(2);
  });
});

describe("hasSufficientEvidence / canClaimStatisticalSignificance", () => {
  it("hasSufficientEvidence returns the metric's flag", () => {
    const metric: ReliabilityMetric = {
      kind: "observed_trial_pass_rate",
      value: 0.5,
      numerator: 1,
      denominator: 2,
      excluded: 0,
      assumptions: [],
      sampleSize: 2,
      sufficientEvidence: true,
    };
    expect(hasSufficientEvidence(metric)).toBe(true);
  });

  it("canClaimStatisticalSignificance returns the report's flag", () => {
    const trials = Array(30).fill(null).map(() => buildTrial({ passed: true }));
    const report = computeReliabilityReport(trials, { preset: "full" });
    expect(canClaimStatisticalSignificance(report)).toBe(true);
  });
});

describe("formatMetric / formatReliabilityReport", () => {
  it("formatMetric produces a readable string with numerator/denominator/excluded/sampleSize", () => {
    const metric: ReliabilityMetric = {
      kind: "observed_trial_pass_rate",
      value: 0.5,
      numerator: 1,
      denominator: 2,
      excluded: 0,
      assumptions: ["test"],
      sampleSize: 2,
      sufficientEvidence: true,
    };
    const formatted = formatMetric(metric);
    expect(formatted).toContain("observed_trial_pass_rate");
    expect(formatted).toContain("numerator=1");
    expect(formatted).toContain("denominator=2");
    expect(formatted).toContain("sampleSize=2");
  });

  it("formatReliabilityReport produces a readable multi-line string", () => {
    const trials = [buildTrial({ passed: true }), buildTrial({ passed: false })];
    const report = computeReliabilityReport(trials, { preset: "full" });
    const formatted = formatReliabilityReport(report);
    expect(formatted).toContain("可靠性报告");
    expect(formatted).toContain("总 trials");
    expect(formatted).toContain("排除 trials");
    expect(formatted).toContain("聚合指标");
  });
});

describe("computeReliabilityReport — excluded trials do not inflate the denominator", () => {
  it("excluded trials reduce the denominator but are reported separately", () => {
    const trials = [
      buildTrial({ passed: true }),
      buildTrial({ passed: false, excluded: true }),
      buildTrial({ passed: true, excluded: true }),
    ];
    const report = computeReliabilityReport(trials, { preset: "full" });
    const observed = report.metrics[0]!;
    expect(observed.denominator).toBe(1);
    expect(observed.excluded).toBe(2);
    expect(report.excludedTrials).toBe(2);
    expect(report.totalTrials).toBe(3);
  });
});
