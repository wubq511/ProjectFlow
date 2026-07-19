/**
 * T46-4 (Issue #97 §10) — Repair Prompt tests.
 *
 * Verifies the copy-ready Coding Agent prompt invariants:
 *  1. buildRepairPrompt: produces a deterministic, section-complete prompt
 *     for fix and investigation packets; refuses stale packets.
 *  2. Stale-refusal invariant: promptRefusesStale detects the stale-check
 *     section; buildRepairPrompt throws on stale packets.
 *  3. Forbidden-actions invariants: prompt forbids modifying frozen
 *     standards and forbids auto push/merge/close-issue.
 *  4. verifyPromptContent: detects secrets, PEM markers, absolute temp
 *     paths, raw hidden fact markers and model hidden reasoning markers.
 *  5. Counterfactual/fault profile refs: prompt includes the optional
 *     references when set on the packet.
 *  6. Candidate regression governance: prompt includes the governance
 *     section when a candidate regression is attached, and omits it
 *     otherwise.
 */

import { describe, expect, it } from "vitest";
import {
  buildRepairPrompt,
  promptForbidsAutoPushMergeClose,
  promptForbidsFrozenStandardsModification,
  promptRefusesStale,
  verifyPromptContent,
} from "../../src/evaluation/lab/repair-prompt.js";
import {
  buildRepairPacket,
  stablePacketId,
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
// Fixture helpers
// ---------------------------------------------------------------------------

function buildCodeFingerprint(): CodeFingerprintInput {
  return { gitCommit: "abc123def456", gitDirty: false, worktreeSha256: "fedcba987654" };
}

function buildCodeSurfaces(
  evidenceLevel: "hypothesis" | "direct_component_evidence" = "direct_component_evidence",
): CandidateCodeSurface[] {
  return [{
    surfaceId: "surface-1",
    component: "model-router.ts",
    reason: "test surface",
    evidenceLevel,
    evidence: ["evid-1"],
  }];
}

function buildDiagnosis(overrides: Partial<DiagnosisRecord> = {}): DiagnosisRecord {
  return {
    diagnosisId: "diag-1",
    runId: "run-1",
    scenarioId: "scn-1",
    observationId: "obs-1",
    observedSymptom: "test symptom",
    expectedContract: "test contract",
    causalStatus: "fault_injection_confirmed",
    confidence: "high",
    evidence: [{
      evidenceId: "evid-1",
      kind: "fault_profile_reproduced",
      summary: "test evidence",
      reference: "observations/scn-1.json",
      facts: {},
    }],
    hypotheses: [{
      hypothesisId: "hyp-1",
      candidateCause: "model_router routing mismatch",
      status: "fault_injection_confirmed",
      supportingEvidence: ["evid-1"],
      contradictingEvidence: [],
      candidateCodeSurfaces: [{
        surfaceId: "surface-1",
        component: "model-router.ts",
        reason: "test",
        evidenceLevel: "direct_component_evidence",
        evidence: ["evid-1"],
      }],
    }],
    fromFaultProfile: true,
    createdAt: "2026-07-20T00:00:00Z",
    reproductionCommand: "scripts/eval-lab diagnose",
    ...overrides,
  };
}

function buildPacketInput(
  overrides: Partial<BuildRepairPacketInput> = {},
): BuildRepairPacketInput {
  return {
    packetId: stablePacketId("run-1", "diag-1"),
    runId: "run-1",
    diagnosisId: "diag-1",
    codeFingerprint: buildCodeFingerprint(),
    observedSymptom: "test symptom",
    expectedContract: "test contract",
    reproductionCommand: "scripts/eval-lab diagnose",
    evidenceReferences: [{ reference: "observations/scn-1.json", referenceSha256: "abc123" }],
    affectedComponents: ["model-router.ts"],
    candidateCodeSurfaces: buildCodeSurfaces("direct_component_evidence"),
    protectedBoundaries: ["Proposal-Confirm State Machine"],
    nonGoals: ["不修改 frozen standards"],
    acceptanceCriteria: ["修改后 hard grader 通过"],
    verificationCommands: ["npm run test"],
    createdAt: "2026-07-20T00:00:00Z",
    ...overrides,
  };
}

function buildFixPacket(overrides: Partial<BuildRepairPacketInput> = {}): RepairPacket {
  return buildRepairPacket(buildPacketInput(overrides), buildDiagnosis());
}

function buildInvestigationPacket(
  overrides: Partial<BuildRepairPacketInput> = {},
): RepairPacket {
  // Use observed_failure status with hypothesis-only evidence → investigation
  const diagnosis = buildDiagnosis({
    causalStatus: "observed_failure",
    confidence: "very_low",
    hypotheses: [{
      hypothesisId: "hyp-1",
      candidateCause: "unknown",
      status: "observed_failure",
      supportingEvidence: ["evid-1"],
      contradictingEvidence: [],
      candidateCodeSurfaces: [{
        surfaceId: "surface-1",
        component: "unknown",
        reason: "hypothesis only",
        evidenceLevel: "hypothesis",
        evidence: ["evid-1"],
      }],
    }],
  });
  return buildRepairPacket(buildPacketInput({
    candidateCodeSurfaces: buildCodeSurfaces("hypothesis"),
    ...overrides,
  }), diagnosis);
}

function buildCandidateRegression(
  overrides: Partial<CandidateRegression> = {},
): CandidateRegression {
  return {
    regressionId: "cand-reg-1",
    scenarioPrompt: "test scenario prompt",
    expectedContract: "test expected contract",
    verificationCommand: "npm run test -- --filter cand-reg-1",
    status: "candidate",
    outsideFrozenSuite: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §1 buildRepairPrompt core
// ---------------------------------------------------------------------------

describe("T46-4 repair prompt — buildRepairPrompt core", () => {
  it("returns a non-empty string for a fresh fix packet", () => {
    const packet = buildFixPacket();
    const prompt = buildRepairPrompt({ packet });
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("returns a non-empty string for a fresh investigation packet", () => {
    const packet = buildInvestigationPacket();
    const prompt = buildRepairPrompt({ packet });
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("investigation");
  });

  it("throws EvaluationValidationError for a stale packet", () => {
    const packet = buildFixPacket({
      currentCodeFingerprint: {
        gitCommit: "different-commit-xyz",
        gitDirty: false,
        worktreeSha256: "different-worktree-sha",
      },
    });
    expect(packet.staleState).toBe("stale");
    expect(() => buildRepairPrompt({ packet })).toThrow(EvaluationValidationError);
  });

  it("produces deterministic output for the same packet", () => {
    const packet = buildFixPacket();
    const prompt1 = buildRepairPrompt({ packet });
    const prompt2 = buildRepairPrompt({ packet });
    expect(prompt1).toBe(prompt2);
  });

  it("includes the packet ID in the header", () => {
    const packet = buildFixPacket();
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain(packet.packetId);
    expect(prompt).toContain(`# Repair Packet: ${packet.packetId}`);
  });

  it("includes the integrity SHA-256 in the header", () => {
    const packet = buildFixPacket();
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("Integrity SHA-256");
    expect(prompt).toContain(packet.integritySha256);
  });

  it("includes the schema version", () => {
    const packet = buildFixPacket();
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("Schema version");
    expect(prompt).toContain(String(REPAIR_PACKET_SCHEMA_VERSION));
  });

  it("includes the packet type (fix or investigation)", () => {
    const fixPacket = buildFixPacket();
    const fixPrompt = buildRepairPrompt({ packet: fixPacket });
    expect(fixPrompt).toContain("Packet type:");
    expect(fixPrompt).toContain("Packet type: fix");

    const investigationPacket = buildInvestigationPacket();
    const investigationPrompt = buildRepairPrompt({ packet: investigationPacket });
    expect(investigationPrompt).toContain("Packet type:");
    expect(investigationPrompt).toContain("Packet type: investigation");
  });

  it("includes the causal status and confidence", () => {
    const packet = buildFixPacket();
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("Causal status");
    expect(prompt).toContain(packet.causalStatus);
    expect(prompt).toContain("Confidence");
    expect(prompt).toContain(packet.confidence);
  });

  it("includes the observed symptom section", () => {
    const packet = buildFixPacket();
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("观察到的问题");
    expect(prompt).toContain(packet.observedSymptom);
  });

  it("includes the expected contract section", () => {
    const packet = buildFixPacket();
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("期望契约");
    expect(prompt).toContain(packet.expectedContract);
  });

  it("includes the reproduction command", () => {
    const packet = buildFixPacket();
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("复现命令");
    expect(prompt).toContain(packet.reproductionCommand);
  });

  it("includes evidence references when present", () => {
    const packet = buildFixPacket();
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("证据路径");
    expect(prompt).toContain("observations/scn-1.json");
    expect(prompt).toContain("abc123");
  });

  it("includes the investigation-only note when evidenceReferences is empty", () => {
    const packet = buildFixPacket({ evidenceReferences: [] });
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("（无证据引用；此 packet 仅作为 investigation 记录）");
  });

  it("includes candidate code surfaces with evidence level", () => {
    const packet = buildFixPacket();
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("建议修改范围");
    expect(prompt).toContain("surface-1");
    expect(prompt).toContain("model-router.ts");
    expect(prompt).toContain("Evidence level");
    expect(prompt).toContain("direct_component_evidence");
  });

  it("includes protected boundaries", () => {
    const packet = buildFixPacket();
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("Protected boundaries");
    expect(prompt).toContain("Proposal-Confirm State Machine");
  });

  it("includes non-goals", () => {
    const packet = buildFixPacket();
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("Non-goals");
    expect(prompt).toContain("不修改 frozen standards");
  });

  it("includes acceptance criteria as a numbered list", () => {
    const packet = buildFixPacket({
      acceptanceCriteria: [
        "修改后 hard grader 通过",
        "routing 测试全部通过",
      ],
    });
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("Acceptance criteria");
    expect(prompt).toContain("1. 修改后 hard grader 通过");
    expect(prompt).toContain("2. routing 测试全部通过");
  });

  it("includes verification commands (targeted + full)", () => {
    const packet = buildFixPacket();
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("Verification commands");
    expect(prompt).toContain("Targeted verification");
    expect(prompt).toContain("Full verification");
    expect(prompt).toContain("npm run test");
    // Full verification block contains the canonical commands
    expect(prompt).toContain("cd backend && .venv/bin/python -m pytest app/tests/ -q");
    expect(prompt).toContain("cd agent-bridge && npm run test -- --run");
    expect(prompt).toContain("cd frontend && npm run build");
  });

  it("includes the forbidden actions section", () => {
    const packet = buildFixPacket();
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("禁止行为");
  });

  it("includes the stale check section", () => {
    const packet = buildFixPacket();
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("Stale 检查");
    expect(prompt).toContain("Packet stale state");
  });

  it("includes counterfactual reference when packet.counterfactualRef is set", () => {
    const packet = buildFixPacket({ counterfactualRef: "cf-run-1" });
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("Counterfactual reference");
    expect(prompt).toContain("cf-run-1");
  });

  it("includes fault profile reference when packet.faultProfileRef is set", () => {
    const packet = buildFixPacket({ faultProfileRef: "fp-profile-1" });
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("Fault profile reference");
    expect(prompt).toContain("fp-profile-1");
  });

  it("includes cluster ID when packet.clusterId is set", () => {
    const packet = buildFixPacket({ clusterId: "cluster-abc" });
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("Cluster ID");
    expect(prompt).toContain("cluster-abc");
  });

  it("accepts targetAgent option (codex | claude-code | trae) without error", () => {
    const packet = buildFixPacket();
    for (const targetAgent of ["codex", "claude-code", "trae"] as const) {
      expect(() => buildRepairPrompt({ packet, targetAgent })).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// §2 Stale refusal invariant
// ---------------------------------------------------------------------------

describe("T46-4 repair prompt — stale refusal invariant", () => {
  it("promptRefusesStale returns true for a fresh-packet prompt", () => {
    const packet = buildFixPacket();
    const prompt = buildRepairPrompt({ packet });
    expect(promptRefusesStale(prompt)).toBe(true);
  });

  it("buildRepairPrompt throws on stale packet and the error message mentions 'stale'", () => {
    const packet = buildFixPacket({
      currentCodeFingerprint: {
        gitCommit: "different-commit-xyz",
        gitDirty: false,
        worktreeSha256: "different-worktree-sha",
      },
    });
    expect(packet.staleState).toBe("stale");
    try {
      buildRepairPrompt({ packet });
      throw new Error("expected buildRepairPrompt to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(EvaluationValidationError);
      expect((e as Error).message).toMatch(/stale/i);
    }
  });
});

// ---------------------------------------------------------------------------
// §3 Forbidden actions invariants
// ---------------------------------------------------------------------------

describe("T46-4 repair prompt — forbidden actions invariants", () => {
  it("promptForbidsFrozenStandardsModification returns true", () => {
    const packet = buildFixPacket();
    const prompt = buildRepairPrompt({ packet });
    expect(promptForbidsFrozenStandardsModification(prompt)).toBe(true);
  });

  it("promptForbidsAutoPushMergeClose returns true", () => {
    const packet = buildFixPacket();
    const prompt = buildRepairPrompt({ packet });
    expect(promptForbidsAutoPushMergeClose(prompt)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §4 verifyPromptContent
// ---------------------------------------------------------------------------

describe("T46-4 repair prompt — verifyPromptContent", () => {
  it("returns empty array for a clean prompt", () => {
    const packet = buildFixPacket();
    const prompt = buildRepairPrompt({ packet });
    const violations = verifyPromptContent(prompt);
    expect(violations).toEqual([]);
  });

  it("detects api_key patterns", () => {
    const violations = verifyPromptContent("config: api_key=abcdefghij");
    expect(violations.length).toBeGreaterThan(0);
  });

  it("detects PEM markers", () => {
    const violations = verifyPromptContent("-----BEGIN RSA PRIVATE KEY-----");
    expect(violations.length).toBeGreaterThan(0);
  });

  it("detects /tmp/ paths at start of line", () => {
    const violations = verifyPromptContent("/tmp/foo");
    expect(violations.length).toBeGreaterThan(0);
  });

  it("detects /var/folders/ paths", () => {
    const violations = verifyPromptContent("/var/folders/abc/file.json");
    expect(violations.length).toBeGreaterThan(0);
  });

  it("detects __hidden__ markers", () => {
    const violations = verifyPromptContent("data contains __hidden__ marker");
    expect(violations.length).toBeGreaterThan(0);
  });

  it("detects __oracle__ markers", () => {
    const violations = verifyPromptContent("leak from __oracle__ source");
    expect(violations.length).toBeGreaterThan(0);
  });

  it("detects <think> markers", () => {
    const violations = verifyPromptContent("model output <think>hidden reasoning</think>");
    expect(violations.length).toBeGreaterThan(0);
  });

  it("detects <reasoning> markers", () => {
    const violations = verifyPromptContent("model output <reasoning>hidden</reasoning>");
    expect(violations.length).toBeGreaterThan(0);
  });

  it("returns empty array for a clean multi-line prompt", () => {
    const prompt = [
      "# Repair Packet: rp-test",
      "",
      "## 观察到的问题",
      "",
      "这是测试症状，不含任何禁止内容。",
      "",
      "## 期望契约",
      "",
      "路由应进入预期模式。",
    ].join("\n");
    const violations = verifyPromptContent(prompt);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §5 Counterfactual/fault profile refs
// ---------------------------------------------------------------------------

describe("T46-4 repair prompt — counterfactual/fault profile refs", () => {
  it("includes 'Counterfactual reference' when counterfactualRef is set", () => {
    const packet = buildFixPacket({ counterfactualRef: "cf-run-xyz" });
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("Counterfactual reference");
  });

  it("includes 'Fault profile reference' when faultProfileRef is set", () => {
    const packet = buildFixPacket({ faultProfileRef: "fp-profile-xyz" });
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("Fault profile reference");
  });
});

// ---------------------------------------------------------------------------
// §6 Candidate regression governance in prompt
// ---------------------------------------------------------------------------

describe("T46-4 repair prompt — candidate regression governance", () => {
  it("includes 'Candidate regression governance' section when packet has candidateRegression", () => {
    const packet = buildFixPacket({
      candidateRegression: buildCandidateRegression(),
    });
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("Candidate regression governance");
  });

  it("mentions the regression ID when packet has candidateRegression", () => {
    const packet = buildFixPacket({
      candidateRegression: buildCandidateRegression({ regressionId: "cand-reg-xyz-123" }),
    });
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("cand-reg-xyz-123");
  });

  it("mentions the no-auto-promotion rule when packet has candidateRegression", () => {
    const packet = buildFixPacket({
      candidateRegression: buildCandidateRegression(),
    });
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("不得将此 regression 自动 promotion");
  });

  it("does NOT include 'Candidate regression governance' when packet has no candidateRegression", () => {
    const packet = buildFixPacket();
    expect(packet.candidateRegression).toBeUndefined();
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).not.toContain("Candidate regression governance");
  });
});
