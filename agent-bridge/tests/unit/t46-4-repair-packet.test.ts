/**
 * T46-4 (Issue #97 §7-§9) — Repair Packet tests.
 *
 * Verifies the immutable Repair Packet invariants:
 *  1. Stale detection: commit/worktree mismatch fails-closed as `stale`.
 *  2. Fix/investigation gate: fix requires direct component evidence OR
 *     intervention_supported OR fault_injection_confirmed PLUS a falsifiable
 *     acceptance test, protected boundaries, verification commands and a
 *     valid code fingerprint; otherwise `investigation`.
 *  3. Scrubbing: packets never contain secrets, raw hidden fact markers,
 *     absolute temp paths or model hidden reasoning.
 *  4. Schema version: unsupported future versions fail-closed.
 *  5. buildRepairPacket: the canonical constructor enforces every invariant.
 *  6. verifyPacketInvariants: detects tampered integrity hash and bad
 *     candidate regression governance.
 *  7. stablePacketId: deterministic ID derived from runId + diagnosisId.
 *  8. verifyPacketStatusConsistency: packet causalStatus must be reachable
 *     from diagnosis causalStatus via the frozen promotion ladder.
 */

import { describe, expect, it } from "vitest";
import {
  buildRepairPacket,
  canGenerateFixPacket,
  computePacketIntegritySha256,
  assertSupportedSchemaVersion,
  detectStaleState,
  scrubContent,
  stablePacketId,
  validatePacketScrubbing,
  verifyPacketInvariants,
  verifyPacketStatusConsistency,
  type BuildRepairPacketInput,
  type CodeFingerprintInput,
} from "../../src/evaluation/lab/repair-packet.js";
import {
  REPAIR_PACKET_SCHEMA_VERSION,
  type CandidateCodeSurface,
  type CandidateRegression,
  type DiagnosisRecord,
  type EvidenceRecord,
  type HypothesisRecord,
  type IssueCluster,
  type RepairPacket,
} from "../../src/evaluation/lab/diagnosis-contract.js";
import { EvaluationValidationError } from "../../src/evaluation/lab/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCodeFingerprint(
  overrides: Partial<CodeFingerprintInput> = {},
): CodeFingerprintInput {
  return {
    gitCommit: "commit-abc123",
    gitDirty: false,
    worktreeSha256: "sha-worktree-abc",
    ...overrides,
  };
}

function buildCodeSurfaces(
  overrides: Partial<CandidateCodeSurface>[] = [],
): CandidateCodeSurface[] {
  const defaults: CandidateCodeSurface[] = [
    {
      surfaceId: "surface-1",
      component: "model-router.ts",
      reason: "路由模块出现 direct component evidence",
      evidenceLevel: "direct_component_evidence",
      evidence: ["evidence-1"],
    },
  ];
  return defaults.map((d, i) => ({ ...d, ...overrides[i] }));
}

function buildEvidence(): EvidenceRecord[] {
  return [
    {
      evidenceId: "evidence-1",
      kind: "direct_component_evidence",
      summary: "直接组件证据",
      reference: "observations/obs-1.json",
      referenceSha256: "sha-evidence-1",
      facts: {},
    },
  ];
}

function buildHypothesis(): HypothesisRecord[] {
  return [
    {
      hypothesisId: "hyp-1",
      candidateCause: "路由模块错误",
      status: "fault_injection_confirmed",
      supportingEvidence: ["evidence-1"],
      contradictingEvidence: [],
      candidateCodeSurfaces: buildCodeSurfaces(),
    },
  ];
}

function buildDiagnosis(
  overrides: Partial<DiagnosisRecord> = {},
): DiagnosisRecord {
  return {
    diagnosisId: "diag-1",
    runId: "run-1",
    scenarioId: "scn-1",
    observationId: "obs-1",
    observedSymptom: "可观测症状：路由错误",
    expectedContract: "契约：路由应进入预期模式",
    causalStatus: "fault_injection_confirmed",
    confidence: "high",
    evidence: buildEvidence(),
    hypotheses: buildHypothesis(),
    createdAt: "2026-07-20T00:00:00Z",
    ...overrides,
  };
}

function buildCluster(
  overrides: Partial<IssueCluster> = {},
): IssueCluster {
  return {
    clusterId: "cluster-1",
    runId: "run-1",
    sharedCauseEvidence: ["evidence-1"],
    sharedCause: "共享根因",
    members: [
      {
        scenarioId: "scn-1",
        observationId: "obs-1",
        diagnosisId: "diag-1",
      },
    ],
    refusedMerge: [],
    createdAt: "2026-07-20T00:00:00Z",
    confidence: "medium",
    causalStatus: "intervention_supported",
    ...overrides,
  };
}

function buildPacketInput(
  overrides: Partial<BuildRepairPacketInput> = {},
): BuildRepairPacketInput {
  return {
    packetId: "rp-test-1",
    runId: "run-1",
    diagnosisId: "diag-1",
    codeFingerprint: buildCodeFingerprint(),
    observedSymptom: "可观测症状：路由错误",
    expectedContract: "契约：路由应进入预期模式",
    reproductionCommand: "npm run test -- --filter routing",
    evidenceReferences: [
      { reference: "observations/obs-1.json", referenceSha256: "sha-evidence-1" },
    ],
    affectedComponents: ["model-router.ts"],
    candidateCodeSurfaces: buildCodeSurfaces(),
    protectedBoundaries: ["proposal-confirm 不可绕过"],
    nonGoals: ["不修改 frozen diagnosis statuses"],
    acceptanceCriteria: ["路由进入预期模式后 grader 通过"],
    verificationCommands: ["npm run test -- --filter routing"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §1 Stale detection
// ---------------------------------------------------------------------------

describe("T46-4 repair packet — stale detection", () => {
  it("returns 'unknown' when currentFingerprint is undefined", () => {
    const packetFingerprint = buildCodeFingerprint();
    expect(detectStaleState(packetFingerprint, undefined)).toBe("unknown");
  });

  it("returns 'stale' when gitCommit differs", () => {
    const packetFingerprint = buildCodeFingerprint({ gitCommit: "commit-A" });
    const currentFingerprint = buildCodeFingerprint({ gitCommit: "commit-B" });
    expect(detectStaleState(packetFingerprint, currentFingerprint)).toBe("stale");
  });

  it("returns 'stale' when worktreeSha256 differs", () => {
    const packetFingerprint = buildCodeFingerprint({ worktreeSha256: "sha-A" });
    const currentFingerprint = buildCodeFingerprint({ worktreeSha256: "sha-B" });
    expect(detectStaleState(packetFingerprint, currentFingerprint)).toBe("stale");
  });

  it("returns 'fresh' when both gitCommit and worktreeSha256 match", () => {
    const packetFingerprint = buildCodeFingerprint();
    const currentFingerprint = buildCodeFingerprint();
    expect(detectStaleState(packetFingerprint, currentFingerprint)).toBe("fresh");
  });

  it("returns 'fresh' when gitDirty differs but commit and worktree match", () => {
    const packetFingerprint = buildCodeFingerprint({ gitDirty: false });
    const currentFingerprint = buildCodeFingerprint({ gitDirty: true });
    expect(detectStaleState(packetFingerprint, currentFingerprint)).toBe("fresh");
  });
});

// ---------------------------------------------------------------------------
// §2 Fix/investigation gate
// ---------------------------------------------------------------------------

describe("T46-4 repair packet — fix/investigation gate", () => {
  const baseGateInput = {
    causalStatus: "fault_injection_confirmed" as const,
    candidateCodeSurfaces: buildCodeSurfaces(),
    acceptanceCriteria: ["路由进入预期模式后 grader 通过"],
    protectedBoundaries: ["proposal-confirm 不可绕过"],
    verificationCommands: ["npm run test -- --filter routing"],
    codeFingerprint: buildCodeFingerprint(),
  };

  it("allows fix when status is fault_injection_confirmed and all fields present", () => {
    const result = canGenerateFixPacket(baseGateInput);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("");
  });

  it("allows fix when status is intervention_supported and all fields present", () => {
    const result = canGenerateFixPacket({
      ...baseGateInput,
      causalStatus: "intervention_supported",
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("");
  });

  it("allows fix when direct_component_evidence is present regardless of status", () => {
    const result = canGenerateFixPacket({
      ...baseGateInput,
      causalStatus: "observed_failure",
      candidateCodeSurfaces: buildCodeSurfaces([{ evidenceLevel: "direct_component_evidence" }]),
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("");
  });

  it("refuses fix when no direct evidence and status is observed_failure", () => {
    const result = canGenerateFixPacket({
      ...baseGateInput,
      causalStatus: "observed_failure",
      candidateCodeSurfaces: buildCodeSurfaces([{ evidenceLevel: "hypothesis" }]),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/direct component evidence|intervention_supported|fault_injection_confirmed/);
  });

  it("refuses fix when no direct evidence and status is localized_hypothesis", () => {
    const result = canGenerateFixPacket({
      ...baseGateInput,
      causalStatus: "localized_hypothesis",
      candidateCodeSurfaces: buildCodeSurfaces([{ evidenceLevel: "hypothesis" }]),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/direct component evidence|intervention_supported|fault_injection_confirmed/);
  });

  it("refuses fix when no direct evidence and status is unresolved", () => {
    const result = canGenerateFixPacket({
      ...baseGateInput,
      causalStatus: "unresolved",
      candidateCodeSurfaces: buildCodeSurfaces([{ evidenceLevel: "hypothesis" }]),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/direct component evidence|intervention_supported|fault_injection_confirmed/);
  });

  it("refuses fix when acceptanceCriteria is empty", () => {
    const result = canGenerateFixPacket({
      ...baseGateInput,
      acceptanceCriteria: [],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/acceptance/);
  });

  it("refuses fix when protectedBoundaries is empty", () => {
    const result = canGenerateFixPacket({
      ...baseGateInput,
      protectedBoundaries: [],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/protected boundary/);
  });

  it("refuses fix when verificationCommands is empty", () => {
    const result = canGenerateFixPacket({
      ...baseGateInput,
      verificationCommands: [],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/verification command/);
  });

  it("refuses fix when codeFingerprint is missing gitCommit", () => {
    const result = canGenerateFixPacket({
      ...baseGateInput,
      codeFingerprint: buildCodeFingerprint({ gitCommit: "" }),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/code fingerprint/);
  });

  it("refuses fix when codeFingerprint is missing worktreeSha256", () => {
    const result = canGenerateFixPacket({
      ...baseGateInput,
      codeFingerprint: buildCodeFingerprint({ worktreeSha256: "" }),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/code fingerprint/);
  });
});

// ---------------------------------------------------------------------------
// §3 Scrubbing
// ---------------------------------------------------------------------------

describe("T46-4 repair packet — scrubbing", () => {
  it("detects api_key pattern", () => {
    const violations = scrubContent("api_key=abc123def456");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => /secret|api key|token/i.test(v))).toBe(true);
  });

  it("detects secret pattern", () => {
    const violations = scrubContent("secret=supersecretvalue123");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => /secret|api key|token/i.test(v))).toBe(true);
  });

  it("detects token pattern", () => {
    const violations = scrubContent("token=eyJabc123def456ghi");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => /secret|api key|token/i.test(v))).toBe(true);
  });

  it("detects password pattern", () => {
    const violations = scrubContent("password=p4ssw0rdsecretvalue");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => /secret|api key|token/i.test(v))).toBe(true);
  });

  it("detects PEM private key markers", () => {
    const violations = scrubContent("-----BEGIN RSA PRIVATE KEY-----");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => /secret|api key|token/i.test(v))).toBe(true);
  });

  it("detects /tmp/ absolute temp path", () => {
    const violations = scrubContent("/tmp/evaluation-sandbox/file.json");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => /绝对临时路径/.test(v))).toBe(true);
  });

  it("detects /var/folders/ absolute temp path", () => {
    const violations = scrubContent("/var/folders/abc/xyz/file.json");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => /绝对临时路径/.test(v))).toBe(true);
  });

  it("detects C:\\Users\\ absolute temp path", () => {
    const violations = scrubContent("C:\\Users\\robert\\temp\\file.json");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => /绝对临时路径/.test(v))).toBe(true);
  });

  it("detects __hidden__ raw hidden fact marker", () => {
    const violations = scrubContent("data contains __hidden__ marker");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => /raw hidden fact/.test(v))).toBe(true);
  });

  it("detects __oracle__ raw hidden fact marker", () => {
    const violations = scrubContent("leak from __oracle__ source");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => /raw hidden fact/.test(v))).toBe(true);
  });

  it("detects __expected_cause__ raw hidden fact marker", () => {
    const violations = scrubContent("found __expected_cause__ in packet");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => /raw hidden fact/.test(v))).toBe(true);
  });

  it("detects <think> model hidden reasoning marker", () => {
    const violations = scrubContent("model output <think>hidden reasoning</think>");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => /model hidden reasoning/.test(v))).toBe(true);
  });

  it("detects <reasoning> model hidden reasoning marker", () => {
    const violations = scrubContent("model output <reasoning>hidden</reasoning>");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => /model hidden reasoning/.test(v))).toBe(true);
  });

  it("detects <hidden> model hidden reasoning marker", () => {
    const violations = scrubContent("model output <hidden>internal</hidden>");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => /model hidden reasoning/.test(v))).toBe(true);
  });

  it("returns empty array for clean content", () => {
    const violations = scrubContent("正常的中英文内容，没有任何违禁信息 model-router.ts");
    expect(violations).toEqual([]);
  });

  it("validatePacketScrubbing aggregates violations across fields", () => {
    const input = buildPacketInput({
      observedSymptom: "症状包含 api_key=abc123def456",
      protectedBoundaries: ["__oracle__ marker present"],
    });
    const violations = validatePacketScrubbing(input);
    expect(violations.length).toBeGreaterThanOrEqual(2);
    expect(violations.some((v) => v.startsWith("observedSymptom:"))).toBe(true);
    expect(violations.some((v) => v.startsWith("protectedBoundaries[0]:"))).toBe(true);
  });

  it("validatePacketScrubbing returns empty for a clean packet input", () => {
    const input = buildPacketInput();
    expect(validatePacketScrubbing(input)).toEqual([]);
  });

  it("validatePacketScrubbing checks candidateRegression fields when present", () => {
    const candidateRegression: CandidateRegression = {
      regressionId: "reg-1",
      scenarioPrompt: "回归场景 prompt",
      expectedContract: "回归契约",
      verificationCommand: "verification contains api_key=abc123def456",
      status: "candidate",
      outsideFrozenSuite: true,
    };
    const input = buildPacketInput({ candidateRegression });
    const violations = validatePacketScrubbing(input);
    expect(violations.some((v) => v.startsWith("candidateRegression.verificationCommand:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §4 Schema version
// ---------------------------------------------------------------------------

describe("T46-4 repair packet — schema version", () => {
  it("does not throw for the current schema version", () => {
    expect(() =>
      assertSupportedSchemaVersion(REPAIR_PACKET_SCHEMA_VERSION),
    ).not.toThrow();
  });

  it("throws for unsupported version 3", () => {
    expect(() => assertSupportedSchemaVersion(3)).toThrow(EvaluationValidationError);
    expect(() => assertSupportedSchemaVersion(3)).toThrow(/unsupported repair packet schema version/);
  });

  it("throws for unsupported version 5", () => {
    expect(() => assertSupportedSchemaVersion(5)).toThrow(/unsupported repair packet schema version/);
  });

  it("throws for unsupported version 100", () => {
    expect(() => assertSupportedSchemaVersion(100)).toThrow(/unsupported repair packet schema version/);
  });

  it("throws for unsupported version 0", () => {
    expect(() => assertSupportedSchemaVersion(0)).toThrow(/unsupported repair packet schema version/);
  });
});

// ---------------------------------------------------------------------------
// §5 buildRepairPacket
// ---------------------------------------------------------------------------

describe("T46-4 repair packet — buildRepairPacket", () => {
  it("produces a 'fix' packet when the gate allows", () => {
    const diagnosis = buildDiagnosis({
      causalStatus: "fault_injection_confirmed",
      confidence: "high",
    });
    const input = buildPacketInput({
      candidateCodeSurfaces: buildCodeSurfaces([{ evidenceLevel: "direct_component_evidence" }]),
    });
    const packet = buildRepairPacket(input, diagnosis);
    expect(packet.packetType).toBe("fix");
    expect(packet.schemaVersion).toBe(REPAIR_PACKET_SCHEMA_VERSION);
    expect(packet.causalStatus).toBe("fault_injection_confirmed");
    expect(packet.confidence).toBe("high");
    expect(packet.severity).toBe("high");
  });

  it("produces an 'investigation' packet when the gate refuses", () => {
    const diagnosis = buildDiagnosis({
      causalStatus: "observed_failure",
      confidence: "low",
    });
    const input = buildPacketInput({
      candidateCodeSurfaces: buildCodeSurfaces([{ evidenceLevel: "hypothesis" }]),
      acceptanceCriteria: [],
    });
    const packet = buildRepairPacket(input, diagnosis);
    expect(packet.packetType).toBe("investigation");
  });

  it("produces an 'investigation' packet when status is unresolved", () => {
    const diagnosis = buildDiagnosis({
      causalStatus: "unresolved",
      confidence: "low",
    });
    const input = buildPacketInput({
      candidateCodeSurfaces: buildCodeSurfaces([{ evidenceLevel: "hypothesis" }]),
    });
    const packet = buildRepairPacket(input, diagnosis);
    expect(packet.packetType).toBe("investigation");
  });

  it("computes integritySha256 that matches computePacketIntegritySha256", () => {
    const diagnosis = buildDiagnosis();
    const input = buildPacketInput();
    const packet = buildRepairPacket(input, diagnosis);
    const { integritySha256, ...rest } = packet;
    const expected = computePacketIntegritySha256(rest);
    expect(integritySha256).toBe(expected);
  });

  it("throws when confidence exceeds status (very_high with observed_failure)", () => {
    const diagnosis = buildDiagnosis({
      causalStatus: "observed_failure",
      confidence: "very_high",
    });
    const input = buildPacketInput({
      candidateCodeSurfaces: buildCodeSurfaces([{ evidenceLevel: "hypothesis" }]),
    });
    expect(() => buildRepairPacket(input, diagnosis)).toThrow(EvaluationValidationError);
    expect(() => buildRepairPacket(input, diagnosis)).toThrow(/超过.*支持的范围/);
  });

  it("throws when scrub violations are present in observedSymptom", () => {
    const diagnosis = buildDiagnosis();
    const input = buildPacketInput({
      observedSymptom: "症状包含 api_key=abc123def456",
    });
    expect(() => buildRepairPacket(input, diagnosis)).toThrow(EvaluationValidationError);
    expect(() => buildRepairPacket(input, diagnosis)).toThrow(/禁止信息/);
  });

  it("throws when candidateRegression has status 'approved'", () => {
    const diagnosis = buildDiagnosis();
    const candidateRegression = {
      regressionId: "reg-1",
      scenarioPrompt: "回归场景",
      expectedContract: "回归契约",
      verificationCommand: "npm test",
      status: "approved" as "candidate",
      outsideFrozenSuite: true,
    };
    const input = buildPacketInput({ candidateRegression });
    expect(() => buildRepairPacket(input, diagnosis)).toThrow(EvaluationValidationError);
    expect(() => buildRepairPacket(input, diagnosis)).toThrow(/candidate regression 不得标记为 approved/);
  });

  it("throws when candidateRegression.outsideFrozenSuite is not true", () => {
    const diagnosis = buildDiagnosis();
    const candidateRegression = {
      regressionId: "reg-1",
      scenarioPrompt: "回归场景",
      expectedContract: "回归契约",
      verificationCommand: "npm test",
      status: "candidate" as const,
      outsideFrozenSuite: false as true,
    };
    const input = buildPacketInput({ candidateRegression });
    expect(() => buildRepairPacket(input, diagnosis)).toThrow(EvaluationValidationError);
    expect(() => buildRepairPacket(input, diagnosis)).toThrow(/outsideFrozenSuite: true/);
  });

  it("throws when candidateCodeSurfaces has an invalid evidenceLevel at runtime", () => {
    const diagnosis = buildDiagnosis();
    const input = buildPacketInput({
      candidateCodeSurfaces: [
        {
          surfaceId: "surface-bad",
          component: "model-router.ts",
          reason: "假设性 surface",
          evidenceLevel: "circumstantial" as "hypothesis",
          evidence: ["evidence-1"],
        },
      ],
    });
    expect(() => buildRepairPacket(input, diagnosis)).toThrow(EvaluationValidationError);
    expect(() => buildRepairPacket(input, diagnosis)).toThrow(/evidenceLevel 非法/);
  });

  it("picks higher status from cluster (diagnosis observed_failure + cluster fault_injection_confirmed)", () => {
    const diagnosis = buildDiagnosis({
      causalStatus: "observed_failure",
      confidence: "low",
    });
    const cluster = buildCluster({
      causalStatus: "fault_injection_confirmed",
      confidence: "very_low",
    });
    const input = buildPacketInput({
      clusterId: cluster.clusterId,
      candidateCodeSurfaces: buildCodeSurfaces([{ evidenceLevel: "direct_component_evidence" }]),
    });
    const packet = buildRepairPacket(input, diagnosis, cluster);
    expect(packet.causalStatus).toBe("fault_injection_confirmed");
  });

  it("picks lower confidence from cluster (diagnosis high + cluster low)", () => {
    const diagnosis = buildDiagnosis({
      causalStatus: "intervention_supported",
      confidence: "high",
    });
    const cluster = buildCluster({
      causalStatus: "intervention_supported",
      confidence: "low",
    });
    const input = buildPacketInput({
      clusterId: cluster.clusterId,
    });
    const packet = buildRepairPacket(input, diagnosis, cluster);
    expect(packet.confidence).toBe("low");
  });

  it("records clusterId when cluster provided", () => {
    const diagnosis = buildDiagnosis();
    const cluster = buildCluster();
    const input = buildPacketInput({ clusterId: cluster.clusterId });
    const packet = buildRepairPacket(input, diagnosis, cluster);
    expect(packet.clusterId).toBe(cluster.clusterId);
  });

  it("omits clusterId when cluster undefined", () => {
    const diagnosis = buildDiagnosis();
    const input = buildPacketInput();
    const packet = buildRepairPacket(input, diagnosis);
    expect(packet.clusterId).toBeUndefined();
  });

  it("uses currentCodeFingerprint for stale detection (stale when commits differ)", () => {
    const diagnosis = buildDiagnosis();
    const input = buildPacketInput({
      codeFingerprint: buildCodeFingerprint({ gitCommit: "commit-A" }),
      currentCodeFingerprint: buildCodeFingerprint({ gitCommit: "commit-B" }),
    });
    const packet = buildRepairPacket(input, diagnosis);
    expect(packet.staleState).toBe("stale");
  });

  it("uses currentCodeFingerprint for stale detection (fresh when match)", () => {
    const diagnosis = buildDiagnosis();
    const fingerprint = buildCodeFingerprint();
    const input = buildPacketInput({
      codeFingerprint: fingerprint,
      currentCodeFingerprint: fingerprint,
    });
    const packet = buildRepairPacket(input, diagnosis);
    expect(packet.staleState).toBe("fresh");
  });

  it("defaults staleState to 'unknown' when currentCodeFingerprint is omitted", () => {
    const diagnosis = buildDiagnosis();
    const input = buildPacketInput();
    const packet = buildRepairPacket(input, diagnosis);
    expect(packet.staleState).toBe("unknown");
  });

  it("respects createdAt override", () => {
    const diagnosis = buildDiagnosis();
    const input = buildPacketInput({ createdAt: "2026-01-01T00:00:00Z" });
    const packet = buildRepairPacket(input, diagnosis);
    expect(packet.createdAt).toBe("2026-01-01T00:00:00Z");
  });

  it("defaults createdAt to a valid ISO timestamp when not provided", () => {
    const diagnosis = buildDiagnosis();
    const input = buildPacketInput();
    const packet = buildRepairPacket(input, diagnosis);
    expect(() => new Date(packet.createdAt).toISOString()).not.toThrow();
    expect(packet.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("preserves counterfactualRef and faultProfileRef when provided", () => {
    const diagnosis = buildDiagnosis();
    const input = buildPacketInput({
      counterfactualRef: "counterfactual-1",
      faultProfileRef: "fault-profile-1",
    });
    const packet = buildRepairPacket(input, diagnosis);
    expect(packet.counterfactualRef).toBe("counterfactual-1");
    expect(packet.faultProfileRef).toBe("fault-profile-1");
  });

  it("copies array fields defensively (mutating input does not affect packet)", () => {
    const diagnosis = buildDiagnosis();
    const input = buildPacketInput();
    const packet = buildRepairPacket(input, diagnosis);
    input.acceptanceCriteria.push("new criteria");
    input.affectedComponents.push("new component");
    expect(packet.acceptanceCriteria).not.toContain("new criteria");
    expect(packet.affectedComponents).not.toContain("new component");
  });
});

// ---------------------------------------------------------------------------
// §6 verifyPacketInvariants
// ---------------------------------------------------------------------------

describe("T46-4 repair packet — verifyPacketInvariants", () => {
  it("returns empty array for a valid fix packet", () => {
    const diagnosis = buildDiagnosis();
    const input = buildPacketInput();
    const packet = buildRepairPacket(input, diagnosis);
    expect(verifyPacketInvariants(packet)).toEqual([]);
  });

  it("returns empty array for a valid packet with candidateRegression", () => {
    const diagnosis = buildDiagnosis();
    const candidateRegression: CandidateRegression = {
      regressionId: "reg-1",
      scenarioPrompt: "回归场景",
      expectedContract: "回归契约",
      verificationCommand: "npm test",
      status: "candidate",
      outsideFrozenSuite: true,
    };
    const input = buildPacketInput({ candidateRegression });
    const packet = buildRepairPacket(input, diagnosis);
    expect(verifyPacketInvariants(packet)).toEqual([]);
  });

  it("returns violation when integritySha256 is tampered", () => {
    const diagnosis = buildDiagnosis();
    const input = buildPacketInput();
    const packet = buildRepairPacket(input, diagnosis);
    const tampered: RepairPacket = { ...packet, integritySha256: "tampered-hash" };
    const violations = verifyPacketInvariants(tampered);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => /integritySha256 不匹配/.test(v))).toBe(true);
  });

  it("returns violation when candidateRegression.outsideFrozenSuite is not true", () => {
    const diagnosis = buildDiagnosis();
    const candidateRegression: CandidateRegression = {
      regressionId: "reg-1",
      scenarioPrompt: "回归场景",
      expectedContract: "回归契约",
      verificationCommand: "npm test",
      status: "candidate",
      outsideFrozenSuite: true,
    };
    const input = buildPacketInput({ candidateRegression });
    const packet = buildRepairPacket(input, diagnosis);
    const mutated: RepairPacket = {
      ...packet,
      candidateRegression: { ...packet.candidateRegression!, outsideFrozenSuite: false as true },
    };
    const violations = verifyPacketInvariants(mutated);
    expect(violations.some((v) => /outsideFrozenSuite: true/.test(v))).toBe(true);
  });

  it("returns violation when candidateRegression.status is 'approved'", () => {
    const diagnosis = buildDiagnosis();
    const candidateRegression: CandidateRegression = {
      regressionId: "reg-1",
      scenarioPrompt: "回归场景",
      expectedContract: "回归契约",
      verificationCommand: "npm test",
      status: "candidate",
      outsideFrozenSuite: true,
    };
    const input = buildPacketInput({ candidateRegression });
    const packet = buildRepairPacket(input, diagnosis);
    const mutated: RepairPacket = {
      ...packet,
      candidateRegression: { ...packet.candidateRegression!, status: "approved" as "candidate" },
    };
    const violations = verifyPacketInvariants(mutated);
    expect(violations.some((v) => /candidate regression 不得标记为 approved/.test(v))).toBe(true);
  });

  it("returns violation when schemaVersion is wrong", () => {
    const diagnosis = buildDiagnosis();
    const input = buildPacketInput();
    const packet = buildRepairPacket(input, diagnosis);
    const mutated: RepairPacket = {
      ...packet,
      schemaVersion: (REPAIR_PACKET_SCHEMA_VERSION + 1) as typeof REPAIR_PACKET_SCHEMA_VERSION,
    };
    const violations = verifyPacketInvariants(mutated);
    expect(violations.some((v) => /schemaVersion/.test(v))).toBe(true);
  });

  it("returns violation when candidateCodeSurfaces has invalid evidenceLevel", () => {
    const diagnosis = buildDiagnosis();
    const input = buildPacketInput();
    const packet = buildRepairPacket(input, diagnosis);
    const mutated: RepairPacket = {
      ...packet,
      candidateCodeSurfaces: [
        ...packet.candidateCodeSurfaces,
        {
          surfaceId: "bad",
          component: "x.ts",
          reason: "bad",
          evidenceLevel: "circumstantial" as "hypothesis",
          evidence: [],
        },
      ],
    };
    const violations = verifyPacketInvariants(mutated);
    expect(violations.some((v) => /evidenceLevel 非法/.test(v))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §7 stablePacketId
// ---------------------------------------------------------------------------

describe("T46-4 repair packet — stablePacketId", () => {
  it("returns a deterministic ID starting with 'rp-'", () => {
    const id = stablePacketId("run-1", "diag-1");
    expect(id.startsWith("rp-")).toBe(true);
    expect(id.length).toBeGreaterThan("rp-".length);
  });

  it("returns the same ID for the same runId + diagnosisId", () => {
    const id1 = stablePacketId("run-1", "diag-1");
    const id2 = stablePacketId("run-1", "diag-1");
    expect(id1).toBe(id2);
  });

  it("returns different IDs for different diagnosisIds", () => {
    const id1 = stablePacketId("run-1", "diag-1");
    const id2 = stablePacketId("run-1", "diag-2");
    expect(id1).not.toBe(id2);
  });

  it("returns different IDs for different runIds", () => {
    const id1 = stablePacketId("run-1", "diag-1");
    const id2 = stablePacketId("run-2", "diag-1");
    expect(id1).not.toBe(id2);
  });

  it("uses a 16-character lowercase hex hash suffix", () => {
    const id = stablePacketId("run-1", "diag-1");
    const hash = id.slice("rp-".length);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// §8 verifyPacketStatusConsistency
// ---------------------------------------------------------------------------

describe("T46-4 repair packet — verifyPacketStatusConsistency", () => {
  it("returns empty array when packet.causalStatus equals diagnosis.causalStatus", () => {
    const diagnosis = buildDiagnosis({
      causalStatus: "fault_injection_confirmed",
      confidence: "high",
    });
    const input = buildPacketInput();
    const packet = buildRepairPacket(input, diagnosis);
    expect(verifyPacketStatusConsistency(packet, diagnosis)).toEqual([]);
  });

  it("returns empty array for a valid forward transition (observed_failure → localized_hypothesis)", () => {
    const diagnosis = buildDiagnosis({
      causalStatus: "observed_failure",
      confidence: "low",
    });
    const cluster = buildCluster({
      causalStatus: "localized_hypothesis",
      confidence: "low",
    });
    const input = buildPacketInput({
      clusterId: cluster.clusterId,
      candidateCodeSurfaces: buildCodeSurfaces([{ evidenceLevel: "direct_component_evidence" }]),
    });
    const packet = buildRepairPacket(input, diagnosis, cluster);
    expect(packet.causalStatus).toBe("localized_hypothesis");
    expect(verifyPacketStatusConsistency(packet, diagnosis)).toEqual([]);
  });

  it("returns violation for an invalid backward transition (fault_injection_confirmed → observed_failure)", () => {
    // Build a valid packet with causalStatus = observed_failure (lowest status).
    const packetDiagnosis = buildDiagnosis({
      causalStatus: "observed_failure",
      confidence: "low",
    });
    const input = buildPacketInput({
      candidateCodeSurfaces: buildCodeSurfaces([{ evidenceLevel: "hypothesis" }]),
      acceptanceCriteria: [],
    });
    const packet = buildRepairPacket(input, packetDiagnosis);

    // Construct a separate diagnosis record with the higher terminal status.
    const separateDiagnosis = buildDiagnosis({
      diagnosisId: "diag-separate",
      causalStatus: "fault_injection_confirmed",
      confidence: "high",
    });

    const violations = verifyPacketStatusConsistency(packet, separateDiagnosis);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => /无合法转换/.test(v))).toBe(true);
  });

  it("returns violation for skipping levels (observed_failure → intervention_supported)", () => {
    // Build a packet with causalStatus = intervention_supported using a cluster.
    const packetDiagnosis = buildDiagnosis({
      causalStatus: "observed_failure",
      confidence: "low",
    });
    const cluster = buildCluster({
      causalStatus: "intervention_supported",
      confidence: "medium",
    });
    const input = buildPacketInput({
      clusterId: cluster.clusterId,
      candidateCodeSurfaces: buildCodeSurfaces([{ evidenceLevel: "direct_component_evidence" }]),
    });
    const packet = buildRepairPacket(input, packetDiagnosis, cluster);
    expect(packet.causalStatus).toBe("intervention_supported");

    // verifyPacketStatusConsistency: from diagnosis (observed_failure) to packet
    // (intervention_supported) skips levels and is invalid.
    const violations = verifyPacketStatusConsistency(packet, packetDiagnosis);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => /无合法转换/.test(v))).toBe(true);
  });
});
