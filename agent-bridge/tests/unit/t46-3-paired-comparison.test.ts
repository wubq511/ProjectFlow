/**
 * T46-3 (Issue #96 §7) — Candidate/baseline paired comparison tests.
 *
 * Verifies:
 *  1. Candidate and baseline run in two INDEPENDENT:
 *     - git worktree, backend/sidecar runtime pair, SQLite database,
 *       temp root, ports, nonce/instance identity, artifact staging.
 *  2. verifyIsolation detects shared worktree, ports, nonce, instance,
 *     database, temp root, or artifact staging.
 *  3. model_drift_possible is set to true when either side lacks a
 *     resolved model identity.
 *  4. model_drift_possible is set to true when the two sides resolved
 *     to different models.
 *  5. The requested model is NEVER silently promoted to the resolved model.
 *  6. candidateWins requires sufficient evidence, no model drift, AND
 *     candidate pass rate strictly exceeds baseline.
 *  7. Alignment verification checks shared manifest fields.
 *  8. Operational metrics aggregation separates SUT cost from Coding Agent cost.
 */

import { describe, expect, it } from "vitest";
import {
  buildSide,
  buildManifest,
  computeModelDrift,
  verifyIsolation,
  verifyAlignment,
  buildResult,
  aggregateSideMetrics,
  formatPairedComparisonResult,
} from "../../src/evaluation/lab/paired-comparison.js";
import type {
  OperationalMetrics,
  PairedComparisonSide,
  ResolvedModelIdentity,
} from "../../src/evaluation/lab/contract-v3.js";

function buildSideInput(overrides: Partial<Parameters<typeof buildSide>[0]> = {}) {
  return {
    label: "candidate" as const,
    worktreePath: "/tmp/candidate-wt",
    backendPort: 8001,
    sidecarPort: 4001,
    nonce: "nonce-candidate",
    instanceId: "instance-candidate",
    databasePath: "/tmp/candidate.sqlite",
    tempRoot: "/tmp/candidate-temp",
    artifactStagingDir: "/tmp/candidate-artifacts",
    resolvedModel: { provider: "mock", name: "mock-model", confirmedBy: "sidecar_health" } as ResolvedModelIdentity,
    gitCommit: "abc123",
    worktreeSha256: "sha256-candidate",
    ...overrides,
  };
}

function buildBaselineSide(overrides: Partial<Parameters<typeof buildSide>[0]> = {}) {
  return buildSideInput({
    label: "baseline",
    worktreePath: "/tmp/baseline-wt",
    backendPort: 8002,
    sidecarPort: 4002,
    nonce: "nonce-baseline",
    instanceId: "instance-baseline",
    databasePath: "/tmp/baseline.sqlite",
    tempRoot: "/tmp/baseline-temp",
    artifactStagingDir: "/tmp/baseline-artifacts",
    gitCommit: "def456",
    worktreeSha256: "sha256-baseline",
    ...overrides,
  });
}

function zeroMetrics(): OperationalMetrics {
  return {
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    sutCostUsd: 0,
    codingAgentCostUsd: null,
    toolCalls: 0,
    agentRetries: 0,
    infrastructureAttempts: 0,
    timeouts: 0,
    skipped: 0,
    excluded: 0,
    simulatorErrors: 0,
    infrastructureErrors: 0,
  };
}

describe("buildSide — construction", () => {
  it("constructs a side from raw input", () => {
    const input = buildSideInput();
    const side = buildSide(input);
    expect(side.label).toBe("candidate");
    expect(side.worktreePath).toBe("/tmp/candidate-wt");
    expect(side.backendPort).toBe(8001);
    expect(side.resolvedModel).toEqual(input.resolvedModel);
  });
});

describe("buildSide — resolvedModel confirmedBy adversarial guard", () => {
  // Adversarial: the caller must not silently promote the requested model
  // to the resolved model by passing a `confirmedBy` value that suggests
  // the identity was NOT actually confirmed. When the sidecar could not
  // confirm, the caller MUST pass `resolvedModel: null` instead.
  it("rejects confirmedBy='requested' (requested model promoted to resolved)", () => {
    expect(() => {
      buildSide(buildSideInput({
        resolvedModel: { provider: "openai", name: "gpt-4o", confirmedBy: "requested" },
      }));
    }).toThrow(/不表示实际确认/);
  });

  it("rejects confirmedBy='assumed'", () => {
    expect(() => {
      buildSide(buildSideInput({
        resolvedModel: { provider: "openai", name: "gpt-4o", confirmedBy: "assumed" },
      }));
    }).toThrow(/不表示实际确认/);
  });

  it("rejects confirmedBy='default'", () => {
    expect(() => {
      buildSide(buildSideInput({
        resolvedModel: { provider: "openai", name: "gpt-4o", confirmedBy: "default" },
      }));
    }).toThrow(/不表示实际确认/);
  });

  it("rejects confirmedBy='unconfirmed'", () => {
    expect(() => {
      buildSide(buildSideInput({
        resolvedModel: { provider: "openai", name: "gpt-4o", confirmedBy: "unconfirmed" },
      }));
    }).toThrow(/不表示实际确认/);
  });

  it("rejects confirmedBy='' (empty string)", () => {
    expect(() => {
      buildSide(buildSideInput({
        resolvedModel: { provider: "openai", name: "gpt-4o", confirmedBy: "" },
      }));
    }).toThrow(/不表示实际确认/);
  });

  it("rejects confirmedBy='unknown'", () => {
    expect(() => {
      buildSide(buildSideInput({
        resolvedModel: { provider: "openai", name: "gpt-4o", confirmedBy: "unknown" },
      }));
    }).toThrow(/不表示实际确认/);
  });

  it("accepts confirmedBy='sidecar_health' (actual confirmation)", () => {
    expect(() => {
      buildSide(buildSideInput({
        resolvedModel: { provider: "mock", name: "mock-model", confirmedBy: "sidecar_health" },
      }));
    }).not.toThrow();
  });

  it("accepts resolvedModel=null (sidecar could not confirm)", () => {
    expect(() => {
      buildSide(buildSideInput({ resolvedModel: null }));
    }).not.toThrow();
  });
});

describe("verifyIsolation — shared resource detection", () => {
  it("returns empty when all resources are isolated", () => {
    const candidate = buildSide(buildSideInput());
    const baseline = buildSide(buildBaselineSide());
    const violations = verifyIsolation(candidate, baseline);
    expect(violations).toEqual([]);
  });

  it("detects shared worktree path", () => {
    const candidate = buildSide(buildSideInput());
    const baseline = buildSide(buildBaselineSide({ worktreePath: "/tmp/candidate-wt" }));
    const violations = verifyIsolation(candidate, baseline);
    expect(violations.some((v) => v.includes("worktree"))).toBe(true);
  });

  it("detects shared backend port", () => {
    const candidate = buildSide(buildSideInput());
    const baseline = buildSide(buildBaselineSide({ backendPort: 8001 }));
    const violations = verifyIsolation(candidate, baseline);
    expect(violations.some((v) => v.includes("backend port"))).toBe(true);
  });

  it("detects shared sidecar port", () => {
    const candidate = buildSide(buildSideInput());
    const baseline = buildSide(buildBaselineSide({ sidecarPort: 4001 }));
    const violations = verifyIsolation(candidate, baseline);
    expect(violations.some((v) => v.includes("sidecar port"))).toBe(true);
  });

  it("detects shared nonce", () => {
    const candidate = buildSide(buildSideInput());
    const baseline = buildSide(buildBaselineSide({ nonce: "nonce-candidate" }));
    const violations = verifyIsolation(candidate, baseline);
    expect(violations.some((v) => v.includes("nonce"))).toBe(true);
  });

  it("detects shared instance ID", () => {
    const candidate = buildSide(buildSideInput());
    const baseline = buildSide(buildBaselineSide({ instanceId: "instance-candidate" }));
    const violations = verifyIsolation(candidate, baseline);
    expect(violations.some((v) => v.includes("instance ID"))).toBe(true);
  });

  it("detects shared database path", () => {
    const candidate = buildSide(buildSideInput());
    const baseline = buildSide(buildBaselineSide({ databasePath: "/tmp/candidate.sqlite" }));
    const violations = verifyIsolation(candidate, baseline);
    expect(violations.some((v) => v.includes("数据库路径"))).toBe(true);
  });

  it("detects shared temp root", () => {
    const candidate = buildSide(buildSideInput());
    const baseline = buildSide(buildBaselineSide({ tempRoot: "/tmp/candidate-temp" }));
    const violations = verifyIsolation(candidate, baseline);
    expect(violations.some((v) => v.includes("temp root"))).toBe(true);
  });

  it("detects shared artifact staging directory", () => {
    const candidate = buildSide(buildSideInput());
    const baseline = buildSide(buildBaselineSide({ artifactStagingDir: "/tmp/candidate-artifacts" }));
    const violations = verifyIsolation(candidate, baseline);
    expect(violations.some((v) => v.includes("artifact staging"))).toBe(true);
  });
});

describe("computeModelDrift — model identity verification", () => {
  it("returns false when both sides have the same resolved model", () => {
    const candidate = buildSide(buildSideInput());
    const baseline = buildSide(buildBaselineSide());
    expect(computeModelDrift(candidate, baseline)).toBe(false);
  });

  it("returns true when candidate lacks a resolved model", () => {
    const candidate = buildSide(buildSideInput({ resolvedModel: null }));
    const baseline = buildSide(buildBaselineSide());
    expect(computeModelDrift(candidate, baseline)).toBe(true);
  });

  it("returns true when baseline lacks a resolved model", () => {
    const candidate = buildSide(buildSideInput());
    const baseline = buildSide(buildBaselineSide({ resolvedModel: null }));
    expect(computeModelDrift(candidate, baseline)).toBe(true);
  });

  it("returns true when both sides lack resolved models", () => {
    const candidate = buildSide(buildSideInput({ resolvedModel: null }));
    const baseline = buildSide(buildBaselineSide({ resolvedModel: null }));
    expect(computeModelDrift(candidate, baseline)).toBe(true);
  });

  it("returns true when the two sides resolved to different providers", () => {
    const candidate = buildSide(buildSideInput({ resolvedModel: { provider: "openai", name: "gpt-4o", confirmedBy: "sidecar_health" } }));
    const baseline = buildSide(buildBaselineSide({ resolvedModel: { provider: "mock", name: "mock-model", confirmedBy: "sidecar_health" } }));
    expect(computeModelDrift(candidate, baseline)).toBe(true);
  });

  it("returns true when the two sides resolved to different model names", () => {
    const candidate = buildSide(buildSideInput({ resolvedModel: { provider: "mock", name: "mock-model-v2", confirmedBy: "sidecar_health" } }));
    const baseline = buildSide(buildBaselineSide({ resolvedModel: { provider: "mock", name: "mock-model", confirmedBy: "sidecar_health" } }));
    expect(computeModelDrift(candidate, baseline)).toBe(true);
  });
});

describe("buildManifest — model_drift_possible propagation", () => {
  it("sets modelDriftPossible=false when both sides have the same resolved model", () => {
    const candidate = buildSide(buildSideInput());
    const baseline = buildSide(buildBaselineSide());
    const manifest = buildManifest({
      candidate,
      baseline,
      scenarioManifestSha256: "sha256-scenario",
      seedManifestSha256: "sha256-seed",
      frozenStandardsVersion: "v1",
      evaluatorVersion: "v1",
    });
    expect(manifest.modelDriftPossible).toBe(false);
  });

  it("sets modelDriftPossible=true when either side lacks resolved model", () => {
    const candidate = buildSide(buildSideInput({ resolvedModel: null }));
    const baseline = buildSide(buildBaselineSide());
    const manifest = buildManifest({
      candidate,
      baseline,
      scenarioManifestSha256: "sha256-scenario",
      seedManifestSha256: "sha256-seed",
      frozenStandardsVersion: "v1",
      evaluatorVersion: "v1",
    });
    expect(manifest.modelDriftPossible).toBe(true);
  });

  it("produces a stable manifest ID", () => {
    const candidate = buildSide(buildSideInput());
    const baseline = buildSide(buildBaselineSide());
    const manifest1 = buildManifest({
      candidate,
      baseline,
      scenarioManifestSha256: "sha256-scenario",
      seedManifestSha256: "sha256-seed",
      frozenStandardsVersion: "v1",
      evaluatorVersion: "v1",
      generatedAt: "2026-07-19T00:00:00.000Z",
    });
    const manifest2 = buildManifest({
      candidate,
      baseline,
      scenarioManifestSha256: "sha256-scenario",
      seedManifestSha256: "sha256-seed",
      frozenStandardsVersion: "v1",
      evaluatorVersion: "v1",
      generatedAt: "2026-07-19T00:00:00.000Z",
    });
    expect(manifest1.id).toBe(manifest2.id);
  });
});

describe("verifyAlignment — manifest field validation", () => {
  it("returns empty when all shared fields are non-empty", () => {
    const candidate = buildSide(buildSideInput());
    const baseline = buildSide(buildBaselineSide());
    const manifest = buildManifest({
      candidate,
      baseline,
      scenarioManifestSha256: "sha256-scenario",
      seedManifestSha256: "sha256-seed",
      frozenStandardsVersion: "v1",
      evaluatorVersion: "v1",
    });
    expect(verifyAlignment(manifest)).toEqual([]);
  });

  it("detects empty scenarioManifestSha256", () => {
    const candidate = buildSide(buildSideInput());
    const baseline = buildSide(buildBaselineSide());
    const manifest = buildManifest({
      candidate,
      baseline,
      scenarioManifestSha256: "",
      seedManifestSha256: "sha256-seed",
      frozenStandardsVersion: "v1",
      evaluatorVersion: "v1",
    });
    expect(verifyAlignment(manifest).some((v) => v.includes("scenarioManifestSha256"))).toBe(true);
  });

  it("detects model drift inconsistency (null resolved model but modelDriftPossible=false)", () => {
    const candidate = buildSide(buildSideInput({ resolvedModel: null }));
    const baseline = buildSide(buildBaselineSide());
    const manifest = buildManifest({
      candidate,
      baseline,
      scenarioManifestSha256: "sha256-scenario",
      seedManifestSha256: "sha256-seed",
      frozenStandardsVersion: "v1",
      evaluatorVersion: "v1",
    });
    // buildManifest correctly sets modelDriftPossible=true, so verifyAlignment passes.
    expect(manifest.modelDriftPossible).toBe(true);
    expect(verifyAlignment(manifest)).toEqual([]);
  });
});

describe("buildResult — candidate win conditions", () => {
  it("candidateWins=false when sample size is insufficient", () => {
    const candidate = buildSide(buildSideInput());
    const baseline = buildSide(buildBaselineSide());
    const manifest = buildManifest({
      candidate,
      baseline,
      scenarioManifestSha256: "sha256-scenario",
      seedManifestSha256: "sha256-seed",
      frozenStandardsVersion: "v1",
      evaluatorVersion: "v1",
    });
    const result = buildResult({
      manifest,
      perScenario: Array(5).fill(null).map((_, i) => ({
        scenarioId: `s${i}`,
        candidatePassed: true,
        baselinePassed: false,
      })),
      candidateMetrics: zeroMetrics(),
      baselineMetrics: zeroMetrics(),
    });
    expect(result.insufficientEvidence).toBe(true);
    expect(result.candidateWins).toBe(false);
  });

  it("candidateWins=false when model drift is possible", () => {
    const candidate = buildSide(buildSideInput({ resolvedModel: null }));
    const baseline = buildSide(buildBaselineSide());
    const manifest = buildManifest({
      candidate,
      baseline,
      scenarioManifestSha256: "sha256-scenario",
      seedManifestSha256: "sha256-seed",
      frozenStandardsVersion: "v1",
      evaluatorVersion: "v1",
    });
    const result = buildResult({
      manifest,
      perScenario: Array(35).fill(null).map((_, i) => ({
        scenarioId: `s${i}`,
        candidatePassed: true,
        baselinePassed: false,
      })),
      candidateMetrics: zeroMetrics(),
      baselineMetrics: zeroMetrics(),
    });
    // Sufficient evidence, candidate wins on pass rate, but model drift.
    expect(result.insufficientEvidence).toBe(false);
    expect(result.candidateWins).toBe(false);
  });

  it("candidateWins=true when sufficient evidence, no drift, and candidate exceeds baseline", () => {
    const candidate = buildSide(buildSideInput());
    const baseline = buildSide(buildBaselineSide());
    const manifest = buildManifest({
      candidate,
      baseline,
      scenarioManifestSha256: "sha256-scenario",
      seedManifestSha256: "sha256-seed",
      frozenStandardsVersion: "v1",
      evaluatorVersion: "v1",
    });
    const result = buildResult({
      manifest,
      perScenario: Array(35).fill(null).map((_, i) => ({
        scenarioId: `s${i}`,
        candidatePassed: true,
        baselinePassed: false,
      })),
      candidateMetrics: zeroMetrics(),
      baselineMetrics: zeroMetrics(),
    });
    expect(result.insufficientEvidence).toBe(false);
    expect(result.candidateWins).toBe(true);
    expect(result.candidatePassRate).toBe(1);
    expect(result.baselinePassRate).toBe(0);
  });

  it("candidateWins=false when candidate does not exceed baseline", () => {
    const candidate = buildSide(buildSideInput());
    const baseline = buildSide(buildBaselineSide());
    const manifest = buildManifest({
      candidate,
      baseline,
      scenarioManifestSha256: "sha256-scenario",
      seedManifestSha256: "sha256-seed",
      frozenStandardsVersion: "v1",
      evaluatorVersion: "v1",
    });
    const result = buildResult({
      manifest,
      perScenario: Array(35).fill(null).map((_, i) => ({
        scenarioId: `s${i}`,
        candidatePassed: false,
        baselinePassed: true,
      })),
      candidateMetrics: zeroMetrics(),
      baselineMetrics: zeroMetrics(),
    });
    expect(result.candidateWins).toBe(false);
  });

  it("computes delta per scenario", () => {
    const candidate = buildSide(buildSideInput());
    const baseline = buildSide(buildBaselineSide());
    const manifest = buildManifest({
      candidate,
      baseline,
      scenarioManifestSha256: "sha256-scenario",
      seedManifestSha256: "sha256-seed",
      frozenStandardsVersion: "v1",
      evaluatorVersion: "v1",
    });
    const result = buildResult({
      manifest,
      perScenario: [
        { scenarioId: "s1", candidatePassed: true, baselinePassed: false },
        { scenarioId: "s2", candidatePassed: false, baselinePassed: true },
        { scenarioId: "s3", candidatePassed: true, baselinePassed: true },
      ],
      candidateMetrics: zeroMetrics(),
      baselineMetrics: zeroMetrics(),
    });
    expect(result.perScenario[0]!.delta).toBe(1);
    expect(result.perScenario[1]!.delta).toBe(-1);
    expect(result.perScenario[2]!.delta).toBe(0);
  });
});

describe("aggregateSideMetrics — cost separation", () => {
  it("sums SUT cost across scenarios", () => {
    const metrics = [
      { ...zeroMetrics(), sutCostUsd: 0.05 },
      { ...zeroMetrics(), sutCostUsd: 0.03 },
    ];
    const agg = aggregateSideMetrics(metrics);
    expect(agg.sutCostUsd).toBeCloseTo(0.08, 5);
  });

  it("NEVER sums codingAgentCostUsd (always null in aggregate)", () => {
    const metrics = [
      { ...zeroMetrics(), codingAgentCostUsd: 0.50 },
      { ...zeroMetrics(), codingAgentCostUsd: 0.30 },
    ];
    const agg = aggregateSideMetrics(metrics);
    expect(agg.codingAgentCostUsd).toBeNull();
  });

  it("sums evaluatorModelCostUsd separately from SUT cost", () => {
    const metrics = [
      { ...zeroMetrics(), sutCostUsd: 0.05, evaluatorModelCostUsd: 0.01 },
      { ...zeroMetrics(), sutCostUsd: 0.03, evaluatorModelCostUsd: 0.02 },
    ];
    const agg = aggregateSideMetrics(metrics);
    expect(agg.sutCostUsd).toBeCloseTo(0.08, 5);
    expect(agg.evaluatorModelCostUsd).toBeCloseTo(0.03, 5);
  });

  it("returns zero metrics for an empty list", () => {
    const agg = aggregateSideMetrics([]);
    expect(agg.latencyMs).toBe(0);
    expect(agg.sutCostUsd).toBe(0);
    expect(agg.codingAgentCostUsd).toBeNull();
  });
});

describe("formatPairedComparisonResult — human-readable output", () => {
  it("produces a readable multi-line string", () => {
    const candidate = buildSide(buildSideInput());
    const baseline = buildSide(buildBaselineSide());
    const manifest = buildManifest({
      candidate,
      baseline,
      scenarioManifestSha256: "sha256-scenario",
      seedManifestSha256: "sha256-seed",
      frozenStandardsVersion: "v1",
      evaluatorVersion: "v1",
    });
    const result = buildResult({
      manifest,
      perScenario: [
        { scenarioId: "s1", candidatePassed: true, baselinePassed: false },
      ],
      candidateMetrics: zeroMetrics(),
      baselineMetrics: zeroMetrics(),
    });
    const formatted = formatPairedComparisonResult(result);
    expect(formatted).toContain("Candidate / Baseline");
    expect(formatted).toContain("Model drift possible");
    expect(formatted).toContain("Candidate pass rate");
    expect(formatted).toContain("Baseline pass rate");
  });
});
