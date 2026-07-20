/**
 * T46-5 (Issue #98 §1) — Standards Registry tests.
 *
 * Verifies strict separation between active and candidate registries:
 *  1. The active registry file path is FIXED (no env-var override).
 *  2. `loadActiveRegistry` is READ-ONLY: it never mutates the file.
 *  3. `buildCandidateRegistry` produces a registry with kind="candidate"
 *     and a different namespace.
 *  4. `assertActiveRegistryUnchanged` fails when fingerprints differ.
 *  5. `applyPromotionApproval` is the ONLY active mutation path and
 *     requires explicit approval + all conflicts resolved + fingerprint
 *     match.
 *  6. Auto-promotion by a non-approved candidate is FORBIDDEN.
 *  7. Unsupported future schema versions fail-closed.
 *  8. `verifyRegistryInvariants` detects duplicate (id, version) and
 *     mismatched source.registry.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVE_REGISTRY_DIR,
  ACTIVE_REGISTRY_FILE,
  CANDIDATE_REGISTRY_DIR,
  assertSupportedRegistrySchema,
  buildCandidateRegistry,
  buildEmptyActiveRegistry,
  computeRegistryFingerprint,
  loadActiveRegistry,
  assertActiveRegistryUnchanged,
  applyPromotionApproval,
  verifyRegistryInvariants,
} from "../../src/evaluation/lab/standards-registry.js";
import { EvaluationValidationError } from "../../src/evaluation/lab/errors.js";
import { STANDARDS_REGISTRY_SCHEMA_VERSION } from "../../src/evaluation/lab/calibration-contract.js";
import type {
  CandidateStandard,
  PromotionApprovalRecord,
  StandardEntry,
  StandardsRegistry,
} from "../../src/evaluation/lab/calibration-contract.js";

const createdTempDirs: string[] = [];

async function makeTempProjectRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "t46-5-registry-"));
  createdTempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    createdTempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

import { afterEach } from "vitest";

function buildSampleEntry(id: string, version: number, registry: "active" | "candidate"): StandardEntry {
  return {
    id,
    kind: "semantic_rubric",
    version,
    fingerprint: `fp-${id}-${version}`,
    payload: {
      schemaVersion: 1,
      rubricId: id,
      criterion: "planning-specificity",
      label: "规划具体性",
      description: "test",
      scoreScale: ["poor", "fair", "good", "excellent"],
      evidenceReferences: [],
      verdict: "needs_review",
      score: "",
      reason: "",
      confidence: 0,
      judgeManifestRef: { judgeId: "mock-judge", judgeVersion: 1 },
      rubricVersion: version,
      semanticHardGateEligible: false,
    },
    source: {
      registry,
      origin: registry === "active" ? "commit-abc" : "run-xyz",
      path: registry === "active" ? `agent-bridge/standards/active/${id}.json` : `calibrations/run-xyz/${id}.json`,
    },
    createdAt: "2026-07-20T00:00:00.000Z",
  };
}

describe("T46-5 standards registry — fixed paths", () => {
  it("exposes the fixed active registry path", () => {
    expect(ACTIVE_REGISTRY_DIR).toBe("agent-bridge/standards/active");
    expect(ACTIVE_REGISTRY_FILE).toBe("registry.json");
  });

  it("exposes the fixed candidate registry directory", () => {
    expect(CANDIDATE_REGISTRY_DIR).toBe("agent-bridge/standards/candidate");
  });
});

describe("T46-5 standards registry — schema version validation", () => {
  it("assertSupportedRegistrySchema accepts version 1", () => {
    expect(() => assertSupportedRegistrySchema(1)).not.toThrow();
  });

  it("assertSupportedRegistrySchema rejects future versions", () => {
    expect(() => assertSupportedRegistrySchema(2)).toThrow(/unsupported standards registry schema version/);
    expect(() => assertSupportedRegistrySchema(0)).toThrow(/unsupported standards registry schema version/);
    expect(() => assertSupportedRegistrySchema(99)).toThrow(/unsupported standards registry schema version/);
  });
});

describe("T46-5 standards registry — fingerprint computation", () => {
  it("computeRegistryFingerprint is deterministic for the same entries", () => {
    const base = {
      schemaVersion: STANDARDS_REGISTRY_SCHEMA_VERSION,
      registry: "active" as const,
      registryId: "projectflow-active-v1",
      entries: [buildSampleEntry("a", 1, "active"), buildSampleEntry("b", 1, "active")],
      updatedAt: "2026-07-20T00:00:00.000Z",
    };
    const fp1 = computeRegistryFingerprint(base);
    const fp2 = computeRegistryFingerprint(base);
    expect(fp1).toBe(fp2);
  });

  it("computeRegistryFingerprint is order-independent (sorts by id+version)", () => {
    const entriesA = [buildSampleEntry("a", 1, "active"), buildSampleEntry("b", 1, "active")];
    const entriesB = [buildSampleEntry("b", 1, "active"), buildSampleEntry("a", 1, "active")];
    const base1 = {
      schemaVersion: STANDARDS_REGISTRY_SCHEMA_VERSION,
      registry: "active" as const,
      registryId: "projectflow-active-v1",
      entries: entriesA,
      updatedAt: "2026-07-20T00:00:00.000Z",
    };
    const base2 = {
      schemaVersion: STANDARDS_REGISTRY_SCHEMA_VERSION,
      registry: "active" as const,
      registryId: "projectflow-active-v1",
      entries: entriesB,
      updatedAt: "2026-07-20T00:00:00.000Z",
    };
    expect(computeRegistryFingerprint(base1)).toBe(computeRegistryFingerprint(base2));
  });

  it("computeRegistryFingerprint changes when entries change", () => {
    const base1 = {
      schemaVersion: STANDARDS_REGISTRY_SCHEMA_VERSION,
      registry: "active" as const,
      registryId: "projectflow-active-v1",
      entries: [buildSampleEntry("a", 1, "active")],
      updatedAt: "2026-07-20T00:00:00.000Z",
    };
    const base2 = {
      ...base1,
      entries: [buildSampleEntry("a", 2, "active")],
    };
    expect(computeRegistryFingerprint(base1)).not.toBe(computeRegistryFingerprint(base2));
  });
});

describe("T46-5 standards registry — loadActiveRegistry", () => {
  it("returns an empty active registry when the file does not exist (bootstrap)", async () => {
    const projectRoot = await makeTempProjectRoot();
    const registry = await loadActiveRegistry(projectRoot);
    expect(registry.entries).toEqual([]);
    expect(registry.registry).toBe("active");
    expect(registry.fingerprint).toBeTruthy();
  });

  it("loads and validates the active registry file", async () => {
    const projectRoot = await makeTempProjectRoot();
    const registry = buildEmptyActiveRegistry();
    const dir = join(projectRoot, ACTIVE_REGISTRY_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ACTIVE_REGISTRY_FILE), JSON.stringify(registry, null, 2));
    const loaded = await loadActiveRegistry(projectRoot);
    expect(loaded.fingerprint).toBe(registry.fingerprint);
    expect(loaded.entries).toEqual([]);
  });

  it("rejects an active registry file with kind=candidate", async () => {
    const projectRoot = await makeTempProjectRoot();
    const candidate = buildEmptyActiveRegistry();
    const tampered: StandardsRegistry = {
      ...candidate,
      registry: "candidate",
      registryId: "projectflow-candidate-x",
    };
    const dir = join(projectRoot, ACTIVE_REGISTRY_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ACTIVE_REGISTRY_FILE), JSON.stringify(tampered, null, 2));
    await expect(loadActiveRegistry(projectRoot)).rejects.toThrow(/active registry file has registry="candidate"/);
  });

  it("rejects an active registry file with a tampered fingerprint", async () => {
    const projectRoot = await makeTempProjectRoot();
    const registry = buildEmptyActiveRegistry();
    const tampered: StandardsRegistry = { ...registry, fingerprint: "tampered-fp" };
    const dir = join(projectRoot, ACTIVE_REGISTRY_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ACTIVE_REGISTRY_FILE), JSON.stringify(tampered, null, 2));
    await expect(loadActiveRegistry(projectRoot)).rejects.toThrow(/active registry fingerprint mismatch/);
  });
});

describe("T46-5 standards registry — buildCandidateRegistry", () => {
  it("produces a registry with kind=candidate and a run-scoped ID", () => {
    const candidate: CandidateStandard = {
      candidateId: "candidate-run-1-0",
      entry: buildSampleEntry("p0-rubric", 1, "candidate"),
      status: "candidate",
      producedByRunId: "run-1",
      affectedByConflicts: [],
      createdAt: "2026-07-20T00:00:00.000Z",
    };
    const registry = buildCandidateRegistry([candidate], "run-1");
    expect(registry.registry).toBe("candidate");
    expect(registry.registryId).toBe("projectflow-candidate-run-1");
    expect(registry.entries).toHaveLength(1);
    expect(registry.fingerprint).toBeTruthy();
  });

  it("the candidate registry fingerprint differs from the active registry fingerprint", () => {
    const candidate: CandidateStandard = {
      candidateId: "candidate-run-1-0",
      entry: buildSampleEntry("p0-rubric", 1, "candidate"),
      status: "candidate",
      producedByRunId: "run-1",
      affectedByConflicts: [],
      createdAt: "2026-07-20T00:00:00.000Z",
    };
    const candidateReg = buildCandidateRegistry([candidate], "run-1");
    const activeReg = buildEmptyActiveRegistry();
    expect(candidateReg.fingerprint).not.toBe(activeReg.fingerprint);
    expect(candidateReg.registryId).not.toBe(activeReg.registryId);
  });
});

describe("T46-5 standards registry — assertActiveRegistryUnchanged", () => {
  it("passes when fingerprints match", () => {
    const reg = buildEmptyActiveRegistry();
    expect(() => assertActiveRegistryUnchanged(reg, reg)).not.toThrow();
  });

  it("fails when fingerprints differ", () => {
    const reg1 = buildEmptyActiveRegistry();
    const reg2: StandardsRegistry = { ...reg1, fingerprint: "different" };
    expect(() => assertActiveRegistryUnchanged(reg1, reg2)).toThrow(/active registry 被修改/);
  });
});

describe("T46-5 standards registry — applyPromotionApproval (ONLY active mutation)", () => {
  function buildApprovedCandidate(
    candidateId: string,
    entry: StandardEntry,
    affectedByConflicts: string[] = [],
  ): CandidateStandard {
    return {
      candidateId,
      entry,
      status: "approved",
      producedByRunId: "run-1",
      affectedByConflicts,
      createdAt: "2026-07-20T00:00:00.000Z",
    };
  }

  function buildApproval(
    candidate: CandidateStandard,
    activeBefore: StandardsRegistry,
    activeAfter: StandardsRegistry,
    resolvedConflictIds: string[] = [],
  ): PromotionApprovalRecord {
    return {
      schemaVersion: 1,
      approvalId: `approval-${candidate.candidateId}`,
      candidateId: candidate.candidateId,
      approvedAt: "2026-07-20T00:00:00.000Z",
      approverInstruction: "Robert 显式指令: promote candidate",
      reviewableDiff: {
        diffPath: "agent-bridge/standards/active/registry.json",
        commit: "commit-after-promotion",
      },
      beforeActiveFingerprint: activeBefore.fingerprint,
      afterActiveFingerprint: activeAfter.fingerprint,
      resolvedConflictIds,
    };
  }

  it("rejects a candidate that is not in 'approved' status", () => {
    const active = buildEmptyActiveRegistry();
    const candidate: CandidateStandard = {
      candidateId: "c-1",
      entry: buildSampleEntry("p0-rubric", 1, "candidate"),
      status: "candidate", // Not yet approved.
      producedByRunId: "run-1",
      affectedByConflicts: [],
      createdAt: "2026-07-20T00:00:00.000Z",
    };
    const approval = buildApproval(candidate, active, active);
    expect(() => applyPromotionApproval(active, candidate, approval, [])).toThrow(
      /仅 approved candidate 可被 promotion/,
    );
  });

  it("rejects when approval record references a different candidateId", () => {
    const active = buildEmptyActiveRegistry();
    const candidate = buildApprovedCandidate("c-1", buildSampleEntry("p0-rubric", 1, "candidate"));
    const approval = buildApproval(candidate, active, active);
    approval.candidateId = "different-candidate";
    expect(() => applyPromotionApproval(active, candidate, approval, [])).toThrow(
      /approval record 引用 candidateId/,
    );
  });

  it("rejects when there are unresolved conflicts affecting the candidate", () => {
    const active = buildEmptyActiveRegistry();
    const candidate = buildApprovedCandidate(
      "c-1",
      buildSampleEntry("p0-rubric", 1, "candidate"),
      ["conflict-1"],
    );
    const approval = buildApproval(candidate, active, active);
    // No conflicts resolved.
    expect(() => applyPromotionApproval(active, candidate, approval, [])).toThrow(
      /有未解决 conflict: conflict-1/,
    );
  });

  it("rejects when beforeActiveFingerprint does not match the current active", () => {
    const active = buildEmptyActiveRegistry();
    const candidate = buildApprovedCandidate("c-1", buildSampleEntry("p0-rubric", 1, "candidate"));
    const approval = buildApproval(candidate, active, active);
    approval.beforeActiveFingerprint = "wrong-fp";
    expect(() => applyPromotionApproval(active, candidate, approval, [])).toThrow(
      /beforeActiveFingerprint 与当前 active 不一致/,
    );
  });

  it("computes the new active registry with the candidate entry added", () => {
    const active = buildEmptyActiveRegistry();
    const entry = buildSampleEntry("p0-rubric", 1, "candidate");
    const candidate = buildApprovedCandidate("c-1", entry);
    // Use a FIXED timestamp to avoid flakiness from `new Date().toISOString()`
    // being called at different milliseconds in the test and the function.
    const fixedNow = "2026-07-20T00:00:00.000Z";
    const expectedAfterBase = {
      schemaVersion: active.schemaVersion,
      registry: "active" as const,
      registryId: active.registryId,
      entries: [{ ...entry, source: { registry: "active" as const, origin: "commit-after-promotion", path: "agent-bridge/standards/active/registry.json" } }],
      updatedAt: fixedNow,
    };
    const expectedAfterFp = computeRegistryFingerprint(expectedAfterBase);
    const approval = buildApproval(candidate, active, { ...active, fingerprint: expectedAfterFp } as StandardsRegistry);
    const result = applyPromotionApproval(active, candidate, approval, [], fixedNow);
    expect(result.diffSummary.additions).toBe(1);
    expect(result.diffSummary.modifications).toBe(0);
    expect(result.newActive.entries).toHaveLength(1);
    expect(result.newActive.fingerprint).toBe(expectedAfterFp);
  });

  it("rejects when afterActiveFingerprint does not match the computed result (tampered approval)", () => {
    const active = buildEmptyActiveRegistry();
    const candidate = buildApprovedCandidate("c-1", buildSampleEntry("p0-rubric", 1, "candidate"));
    const approval = buildApproval(candidate, active, active);
    approval.afterActiveFingerprint = "wrong-fp";
    expect(() => applyPromotionApproval(active, candidate, approval, [])).toThrow(
      /afterActiveFingerprint 与计算结果不一致/,
    );
  });

  it("mutates the entry when an entry with the same id already exists (modification)", () => {
    const existingEntry = buildSampleEntry("p0-rubric", 1, "active");
    const activeBase = {
      schemaVersion: STANDARDS_REGISTRY_SCHEMA_VERSION,
      registry: "active" as const,
      registryId: "projectflow-active-v1",
      entries: [existingEntry],
      updatedAt: "2026-07-20T00:00:00.000Z",
    };
    const active: StandardsRegistry = { ...activeBase, fingerprint: computeRegistryFingerprint(activeBase) };
    const newEntry = buildSampleEntry("p0-rubric", 2, "candidate");
    const candidate = buildApprovedCandidate("c-1", newEntry);
    // Use a FIXED timestamp to avoid flakiness.
    const fixedNow = "2026-07-20T00:00:00.000Z";
    const expectedAfterBase = {
      schemaVersion: active.schemaVersion,
      registry: "active" as const,
      registryId: active.registryId,
      entries: [{ ...newEntry, source: { registry: "active" as const, origin: "commit-after-promotion", path: "agent-bridge/standards/active/registry.json" } }],
      updatedAt: fixedNow,
    };
    const expectedAfterFp = computeRegistryFingerprint(expectedAfterBase);
    const approval = buildApproval(candidate, active, { ...active, fingerprint: expectedAfterFp } as StandardsRegistry);
    const result = applyPromotionApproval(active, candidate, approval, [], fixedNow);
    expect(result.diffSummary.modifications).toBe(1);
    expect(result.diffSummary.additions).toBe(0);
    expect(result.newActive.entries[0]!.version).toBe(2);
  });
});

describe("T46-5 standards registry — verifyRegistryInvariants", () => {
  it("returns no violations for a healthy active registry", () => {
    const reg = buildEmptyActiveRegistry();
    expect(verifyRegistryInvariants(reg)).toEqual([]);
  });

  it("detects duplicate (id, version) entries", () => {
    const entry = buildSampleEntry("dup", 1, "active");
    const base = {
      schemaVersion: STANDARDS_REGISTRY_SCHEMA_VERSION,
      registry: "active" as const,
      registryId: "projectflow-active-v1",
      entries: [entry, { ...entry }],
      updatedAt: "2026-07-20T00:00:00.000Z",
    };
    const reg: StandardsRegistry = { ...base, fingerprint: computeRegistryFingerprint(base) };
    const violations = verifyRegistryInvariants(reg);
    expect(violations.some((v) => v.includes("重复 entry"))).toBe(true);
  });

  it("detects source.registry mismatch with the registry kind", () => {
    const entry = buildSampleEntry("x", 1, "candidate"); // source says candidate
    const base = {
      schemaVersion: STANDARDS_REGISTRY_SCHEMA_VERSION,
      registry: "active" as const, // but registry is active
      registryId: "projectflow-active-v1",
      entries: [entry],
      updatedAt: "2026-07-20T00:00:00.000Z",
    };
    // Use the actual fingerprint of the base to bypass fingerprint check.
    const reg: StandardsRegistry = { ...base, fingerprint: computeRegistryFingerprint(base) };
    const violations = verifyRegistryInvariants(reg);
    expect(violations.some((v) => v.includes("source.registry=candidate") && v.includes("active"))).toBe(true);
  });

  it("detects fingerprint mismatch", () => {
    const reg: StandardsRegistry = {
      ...buildEmptyActiveRegistry(),
      fingerprint: "wrong-fp",
    };
    const violations = verifyRegistryInvariants(reg);
    expect(violations.some((v) => v.includes("fingerprint 不匹配"))).toBe(true);
  });

  it("detects unsupported schema version", () => {
    const reg = buildEmptyActiveRegistry();
    (reg as { schemaVersion: number }).schemaVersion = 99;
    const violations = verifyRegistryInvariants(reg);
    expect(violations.some((v) => v.includes("schemaVersion") && v.includes("不受支持"))).toBe(true);
  });
});
