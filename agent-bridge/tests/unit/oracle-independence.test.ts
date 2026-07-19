/**
 * T46-2 (Issue #95 §3) — Oracle independence tests.
 *
 * The oracle (HardGraderContract) is authored from the scenario goal and
 * invariants alone. It MUST NOT be derived from the Reference Program or
 * from the observed Agent output. These tests verify the structural and
 * behavioral preconditions for independence:
 *
 * 1. {@link assertOracleIndependence} rejects oracles that embed reference
 *    program identity, and rejects reference programs that embed oracle
 *    constraint fields.
 * 2. {@link deriveOracleFingerprint} is stable under reference mutations
 *    and changes when the oracle itself is mutated.
 * 3. {@link probeIndependence} verifies two-way independence: mutating one
 *    artifact does not change the other's fingerprint.
 * 4. The smoke-v2 preset's oracle and reference program satisfy the
 *    independence assertion.
 */

import { describe, expect, it } from "vitest";
import {
  assertOracleIndependence,
  deriveOracleFingerprint,
  deriveReferenceFingerprint,
  probeIndependence,
} from "../../src/evaluation/lab/oracle.js";
import {
  HARD_GRADER_CONTRACT_VERSION,
  type HardGraderContract,
  type ReferenceProgram,
} from "../../src/evaluation/lab/contract-v2.js";
import { SMOKE_V2_REFERENCE_PROGRAMS, SMOKE_V2_SCENARIOS } from "../../src/evaluation/lab/presets.js";

function buildOracle(overrides: Partial<HardGraderContract> = {}): HardGraderContract {
  return {
    version: HARD_GRADER_CONTRACT_VERSION,
    viewer: { primaryUserId: "user-001" },
    run: { finalStatus: "completed" },
    ...overrides,
  };
}

function buildReference(overrides: Partial<ReferenceProgram> = {}): ReferenceProgram {
  return {
    id: "ref-001",
    prompt: "你好,请介绍一下当前项目。",
    viewer: { primaryUserId: "user-001" },
    expectedMilestoneSubset: [],
    ...overrides,
  };
}

describe("assertOracleIndependence — structural coupling rejection", () => {
  it("accepts an oracle and reference with no coupling", () => {
    expect(() => assertOracleIndependence(buildOracle(), buildReference())).not.toThrow();
  });

  it("rejects an oracle that embeds referenceProgramId", () => {
    const oracle = buildOracle() as HardGraderContract & { referenceProgramId?: string };
    oracle.referenceProgramId = "ref-001";
    expect(() => assertOracleIndependence(oracle, buildReference())).toThrow(/referenceProgramId/);
  });

  it("rejects an oracle that embeds referenceProgramFingerprint", () => {
    const oracle = buildOracle() as HardGraderContract & { referenceProgramFingerprint?: string };
    oracle.referenceProgramFingerprint = "abc";
    expect(() => assertOracleIndependence(oracle, buildReference())).toThrow(/referenceProgramFingerprint/);
  });

  it("rejects an oracle that embeds referenceObservationSha", () => {
    const oracle = buildOracle() as HardGraderContract & { referenceObservationSha?: string };
    oracle.referenceObservationSha = "abc";
    expect(() => assertOracleIndependence(oracle, buildReference())).toThrow(/referenceObservationSha/);
  });

  it("rejects a reference program that embeds stateConstraints", () => {
    const reference = buildReference() as ReferenceProgram & { stateConstraints?: unknown };
    reference.stateConstraints = { required: [] };
    expect(() => assertOracleIndependence(buildOracle(), reference)).toThrow(/stateConstraints/);
  });

  it("rejects a reference program that embeds milestoneDag", () => {
    const reference = buildReference() as ReferenceProgram & { milestoneDag?: unknown };
    reference.milestoneDag = { mode: "strict", milestones: [] };
    expect(() => assertOracleIndependence(buildOracle(), reference)).toThrow(/milestoneDag/);
  });

  it("rejects a reference program that embeds privacy", () => {
    const reference = buildReference() as ReferenceProgram & { privacy?: unknown };
    reference.privacy = {};
    expect(() => assertOracleIndependence(buildOracle(), reference)).toThrow(/privacy/);
  });

  it("accepts a reference program with a legitimate viewer field", () => {
    // ReferenceProgram declares `viewer` as a required field (the scope
    // the reference runs as). This is NOT an oracle-constraint field and
    // must not trigger the independence check.
    const reference = buildReference({
      viewer: { primaryUserId: "user-001" },
    });
    expect(() => assertOracleIndependence(buildOracle(), reference)).not.toThrow();
  });

  it("rejects a reference program whose expectedMilestoneSubset equals the oracle's milestoneDag.milestones", () => {
    const oracle = buildOracle({
      milestoneDag: { mode: "subset", milestones: ["a", "b", "c"] },
    });
    const reference = buildReference({
      expectedMilestoneSubset: ["a", "b", "c"],
    });
    expect(() => assertOracleIndependence(oracle, reference)).toThrow(/expectedMilestoneSubset/);
  });

  it("accepts a reference program whose expectedMilestoneSubset differs from the oracle's milestones", () => {
    const oracle = buildOracle({
      milestoneDag: { mode: "subset", milestones: ["a", "b", "c"] },
    });
    const reference = buildReference({
      expectedMilestoneSubset: ["a"],
    });
    expect(() => assertOracleIndependence(oracle, reference)).not.toThrow();
  });
});

describe("deriveOracleFingerprint — stability and uniqueness", () => {
  it("is stable across calls with the same oracle", () => {
    const oracle = buildOracle();
    expect(deriveOracleFingerprint(oracle)).toBe(deriveOracleFingerprint(oracle));
  });

  it("ignores the version field so a schema bump alone does not change identity", () => {
    const oracleV1 = buildOracle();
    const oracleV2 = buildOracle();
    // Bump version — fingerprint should be unchanged because version is a
    // contract compatibility marker, not a part of the goal state.
    (oracleV2 as HardGraderContract).version = 999 as unknown as typeof HARD_GRADER_CONTRACT_VERSION;
    expect(deriveOracleFingerprint(oracleV1)).toBe(deriveOracleFingerprint(oracleV2));
  });

  it("changes when the oracle's goal state changes", () => {
    const oracleA = buildOracle({ run: { finalStatus: "completed" } });
    const oracleB = buildOracle({ run: { finalStatus: "failed" } });
    expect(deriveOracleFingerprint(oracleA)).not.toBe(deriveOracleFingerprint(oracleB));
  });

  it("changes when state constraints are added", () => {
    const before = buildOracle();
    const after = buildOracle({
      stateConstraints: { required: [{ path: "project_status", values: ["active"] }] },
    });
    expect(deriveOracleFingerprint(before)).not.toBe(deriveOracleFingerprint(after));
  });

  it("produces different fingerprints for different viewer scopes", () => {
    const oracleA = buildOracle({ viewer: { primaryUserId: "user-001" } });
    const oracleB = buildOracle({ viewer: { primaryUserId: "user-002" } });
    expect(deriveOracleFingerprint(oracleA)).not.toBe(deriveOracleFingerprint(oracleB));
  });
});

describe("deriveReferenceFingerprint — stability and uniqueness", () => {
  it("is stable across calls with the same reference", () => {
    const reference = buildReference();
    expect(deriveReferenceFingerprint(reference)).toBe(deriveReferenceFingerprint(reference));
  });

  it("changes when the reference's prompt changes", () => {
    const refA = buildReference({ prompt: "你好" });
    const refB = buildReference({ prompt: "请介绍项目" });
    expect(deriveReferenceFingerprint(refA)).not.toBe(deriveReferenceFingerprint(refB));
  });
});

describe("probeIndependence — two-way independence verification", () => {
  it("verifies oracle fingerprint does not change when reference is mutated", () => {
    const oracle = buildOracle();
    const reference = buildReference();
    const result = probeIndependence(
      oracle,
      reference,
      (ref) => ({ ...ref, prompt: "修改后的提示" }),
      (o) => ({ ...o, run: { finalStatus: "failed" } }),
    );
    expect(result.oracleStableUnderReferenceMutation).toBe(true);
  });

  it("verifies reference fingerprint does not change when oracle is mutated", () => {
    const oracle = buildOracle();
    const reference = buildReference();
    const result = probeIndependence(
      oracle,
      reference,
      (ref) => ({ ...ref, prompt: "修改后的提示" }),
      (o) => ({ ...o, run: { finalStatus: "failed" } }),
    );
    expect(result.referenceStableUnderOracleMutation).toBe(true);
  });

  it("verifies oracle fingerprint changes when oracle is mutated", () => {
    const oracle = buildOracle();
    const reference = buildReference();
    const result = probeIndependence(
      oracle,
      reference,
      (ref) => ({ ...ref, prompt: "修改后的提示" }),
      (o) => ({ ...o, run: { finalStatus: "failed" } }),
    );
    expect(result.oracleFingerprintBefore).not.toBe(result.oracleFingerprintAfter);
  });

  it("verifies reference fingerprint changes when reference is mutated", () => {
    const oracle = buildOracle();
    const reference = buildReference();
    const result = probeIndependence(
      oracle,
      reference,
      (ref) => ({ ...ref, prompt: "修改后的提示" }),
      (o) => ({ ...o, run: { finalStatus: "failed" } }),
    );
    expect(result.referenceFingerprintBefore).not.toBe(result.referenceFingerprintAfter);
  });

  it("verifies oracle and reference fingerprints are distinct", () => {
    const oracle = buildOracle();
    const reference = buildReference();
    expect(deriveOracleFingerprint(oracle)).not.toBe(deriveReferenceFingerprint(reference));
  });
});

describe("smoke-v2 preset independence", () => {
  it("satisfies assertOracleIndependence", () => {
    const scenario = SMOKE_V2_SCENARIOS[0];
    if (!scenario?.hardGrader) throw new Error("smoke-v2 scenario missing hardGrader");
    const reference = SMOKE_V2_REFERENCE_PROGRAMS[scenario.scenarioId];
    if (!reference) throw new Error("smoke-v2 reference missing");
    expect(() => assertOracleIndependence(scenario.hardGrader, reference)).not.toThrow();
  });

  it("oracle and reference fingerprints are distinct", () => {
    const scenario = SMOKE_V2_SCENARIOS[0];
    if (!scenario?.hardGrader) throw new Error("smoke-v2 scenario missing hardGrader");
    const reference = SMOKE_V2_REFERENCE_PROGRAMS[scenario.scenarioId];
    if (!reference) throw new Error("smoke-v2 reference missing");
    expect(deriveOracleFingerprint(scenario.hardGrader))
      .not.toBe(deriveReferenceFingerprint(reference));
  });

  it("mutating the smoke-v2 reference does not change the oracle fingerprint", () => {
    const scenario = SMOKE_V2_SCENARIOS[0];
    if (!scenario?.hardGrader) throw new Error("smoke-v2 scenario missing hardGrader");
    const reference = SMOKE_V2_REFERENCE_PROGRAMS[scenario.scenarioId];
    if (!reference) throw new Error("smoke-v2 reference missing");
    const oracleFingerprintBefore = deriveOracleFingerprint(scenario.hardGrader);
    const mutatedReference: ReferenceProgram = {
      ...reference,
      prompt: "修改后的提示, 用于验证 oracle 不受 reference 影响。",
    };
    // The oracle is unchanged; only the reference was mutated.
    const oracleFingerprintAfter = deriveOracleFingerprint(scenario.hardGrader);
    expect(oracleFingerprintBefore).toBe(oracleFingerprintAfter);
    // The reference fingerprint should differ.
    expect(deriveReferenceFingerprint(mutatedReference))
      .not.toBe(deriveReferenceFingerprint(reference));
  });
});