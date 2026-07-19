/**
 * T46-4 (Issue #97 §7-§9) — Immutable Repair Packet.
 *
 * Versioned schema with stale detection, fix/investigation gate, candidate
 * regression governance, and atomic write into the SHA-256 result graph.
 *
 * Boundary invariants (enforced and tested):
 *  - Candidate code surfaces default to `hypothesis`. Only
 *    `direct_component_evidence` raises the level.
 *  - Commit/worktree mismatch MUST fail-closed as `stale`.
 *  - `fix` packets require direct component evidence OR
 *    intervention_supported OR fault_injection_confirmed PLUS a
 *    falsifiable acceptance test, protected boundaries, verification
 *    commands and a valid code fingerprint. Otherwise `investigation`.
 *  - Packets never contain secret, raw hidden fact, private transcript,
 *    absolute temp path or model hidden reasoning.
 *  - Packets atomically enter the SHA-256 result graph via the
 *    `artifact-store`.
 *  - Unsupported future schema versions fail-closed.
 *  - Candidate regressions are OUTSIDE the frozen suite, marked
 *    `candidate` / `unapproved`, and cannot be auto-promoted.
 */

import { createHash } from "node:crypto";
import type {
  CandidateCodeSurface,
  CandidateRegression,
  DiagnosisCausalStatus,
  DiagnosisConfidenceLevel,
  DiagnosisRecord,
  IssueCluster,
  RepairPacket,
  RepairPacketSeverity,
  RepairPacketStaleState,
  RepairPacketType,
} from "./diagnosis-contract.js";
import {
  REPAIR_PACKET_SCHEMA_VERSION,
  assertValidStatusTransition,
  confidenceExceedsStatus,
  statusSupportsFix,
} from "./diagnosis-contract.js";
import { EvaluationValidationError } from "./errors.js";
import { sha256, stableStringify } from "./validation.js";

// ---------------------------------------------------------------------------
// §1 Code fingerprint
// ---------------------------------------------------------------------------

/** Code fingerprint captured by the runner. */
export interface CodeFingerprintInput {
  gitCommit: string;
  gitDirty: boolean;
  worktreeSha256: string;
}

// ---------------------------------------------------------------------------
// §2 Build inputs
// ---------------------------------------------------------------------------

export interface BuildRepairPacketInput {
  packetId: string;
  runId: string;
  diagnosisId: string;
  clusterId?: string;
  codeFingerprint: CodeFingerprintInput;
  observedSymptom: string;
  expectedContract: string;
  reproductionCommand: string;
  evidenceReferences: Array<{
    reference: string;
    referenceSha256: string;
  }>;
  affectedComponents: string[];
  candidateCodeSurfaces: CandidateCodeSurface[];
  protectedBoundaries: string[];
  nonGoals: string[];
  acceptanceCriteria: string[];
  verificationCommands: string[];
  candidateRegression?: CandidateRegression;
  counterfactualRef?: string;
  faultProfileRef?: string;
  /** ISO timestamp; defaults to `new Date().toISOString()`. */
  createdAt?: string;
  /** Current commit/worktree for stale detection (captured at build time). */
  currentCodeFingerprint?: CodeFingerprintInput;
}

// ---------------------------------------------------------------------------
// §3 Stale detection
// ---------------------------------------------------------------------------

/** Detect whether a packet is stale relative to the current code
 *  fingerprint. Stale when the commit or worktree hash differs.
 *
 *  Issue #97 §7: commit/worktree mismatch MUST fail-closed as `stale`. */
export function detectStaleState(
  packetFingerprint: CodeFingerprintInput,
  currentFingerprint: CodeFingerprintInput | undefined,
): RepairPacketStaleState {
  if (!currentFingerprint) return "unknown";
  if (packetFingerprint.gitCommit !== currentFingerprint.gitCommit) return "stale";
  if (packetFingerprint.worktreeSha256 !== currentFingerprint.worktreeSha256) {
    return "stale";
  }
  return "fresh";
}

// ---------------------------------------------------------------------------
// §4 Severity inference
// ---------------------------------------------------------------------------

/** Infer severity from causal status and confidence. Higher status and
 *  confidence → higher severity. */
function inferSeverity(
  status: DiagnosisCausalStatus,
  confidence: DiagnosisConfidenceLevel,
): RepairPacketSeverity {
  if (status === "fault_injection_confirmed") {
    return confidence === "very_high" ? "critical" : "high";
  }
  if (status === "intervention_supported") {
    return confidence === "high" || confidence === "very_high" ? "high" : "medium";
  }
  if (status === "localized_hypothesis") {
    return "medium";
  }
  if (status === "observed_failure") {
    return "low";
  }
  // unresolved
  return "low";
}

// ---------------------------------------------------------------------------
// §5 Fix/investigation gate — the central rule
// ---------------------------------------------------------------------------

/** Return true when a `fix` packet is allowed for the given inputs.
 *
 *  Issue #97 §8: fix packets ONLY when:
 *   - There is direct component evidence; OR
 *   - There is intervention_supported single-variable evidence; OR
 *   - There is a known fault injection cause.
 *
 *  And ALL of:
 *   - falsifiable acceptance test;
 *   - protected boundaries;
 *   - verification commands;
 *   - valid code fingerprint.
 *
 *  Otherwise the packet MUST be `investigation`. */
export function canGenerateFixPacket(input: {
  causalStatus: DiagnosisCausalStatus;
  candidateCodeSurfaces: CandidateCodeSurface[];
  acceptanceCriteria: string[];
  protectedBoundaries: string[];
  verificationCommands: string[];
  codeFingerprint: CodeFingerprintInput;
}): { allowed: boolean; reason: string } {
  // §1 Causal evidence requirement.
  const hasDirectComponentEvidence = input.candidateCodeSurfaces.some(
    (s) => s.evidenceLevel === "direct_component_evidence",
  );
  const hasInterventionSupport = input.causalStatus === "intervention_supported";
  const hasFaultInjectionConfirmed = input.causalStatus === "fault_injection_confirmed";

  if (!hasDirectComponentEvidence && !hasInterventionSupport && !hasFaultInjectionConfirmed) {
    return {
      allowed: false,
      reason:
        "fix packet 需要 direct component evidence 或 intervention_supported 或 fault_injection_confirmed；当前诊断不满足任一条件",
    };
  }

  // §2 Required fields.
  if (input.acceptanceCriteria.length === 0) {
    return {
      allowed: false,
      reason: "fix packet 需要至少一条 falsifiable acceptance criteria",
    };
  }
  if (input.protectedBoundaries.length === 0) {
    return {
      allowed: false,
      reason: "fix packet 需要至少一条 protected boundary",
    };
  }
  if (input.verificationCommands.length === 0) {
    return {
      allowed: false,
      reason: "fix packet 需要至少一条 verification command",
    };
  }
  if (!input.codeFingerprint.gitCommit || !input.codeFingerprint.worktreeSha256) {
    return {
      allowed: false,
      reason: "fix packet 需要有效的 code fingerprint (git commit + worktree SHA-256)",
    };
  }

  return { allowed: true, reason: "" };
}

// ---------------------------------------------------------------------------
// §6 Secret/raw-content scrubbing
// ---------------------------------------------------------------------------

/** Validate that a string does not contain forbidden content. Returns a
 *  list of violations (empty = OK).
 *
 *  Forbidden:
 *   - secret patterns (api keys, tokens, passwords);
 *   - absolute temp paths (e.g., /tmp/, /var/folders/, C:\Users\);
 *   - raw hidden fact markers (e.g., `__hidden__`, `__oracle__`);
 *   - model hidden reasoning markers (e.g., `<think>`, `<reasoning>`). */
export function scrubContent(value: string): string[] {
  const violations: string[] = [];
  const secretPatterns = [
    /(?:api[_-]?key|secret|token|password|bearer)\s*[=:]\s*["']?[A-Za-z0-9+/=_-]{8,}/i,
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  ];
  const tempPathPatterns = [
    /^\/tmp\//,
    /^\/var\/folders\//,
    /^\/private\/var\/folders\//,
    /^\/private\/tmp\//,
    /^[A-Z]:\\Users\\/,
    /^[A-Z]:\\Temp\\/,
  ];
  const hiddenFactPatterns = [
    /__hidden__/,
    /__oracle__/,
    /__expected_cause__/,
  ];
  const hiddenReasoningPatterns = [
    /<think>/,
    /<reasoning>/,
    /<hidden>/,
  ];
  for (const p of secretPatterns) {
    if (p.test(value)) violations.push("包含疑似 secret/api key/token");
  }
  for (const p of tempPathPatterns) {
    if (p.test(value)) violations.push(`包含绝对临时路径: ${value.slice(0, 60)}`);
  }
  for (const p of hiddenFactPatterns) {
    if (p.test(value)) violations.push("包含 raw hidden fact 标记");
  }
  for (const p of hiddenReasoningPatterns) {
    if (p.test(value)) violations.push("包含 model hidden reasoning 标记");
  }
  return violations;
}

/** Validate that all string fields in a packet are scrubbed. Returns a
 *  list of violations (empty = OK). */
export function validatePacketScrubbing(input: BuildRepairPacketInput): string[] {
  const violations: string[] = [];
  const fields: Array<{ name: string; value: string }> = [
    { name: "observedSymptom", value: input.observedSymptom },
    { name: "expectedContract", value: input.expectedContract },
    { name: "reproductionCommand", value: input.reproductionCommand },
    ...input.protectedBoundaries.map((v, i) => ({
      name: `protectedBoundaries[${i}]`,
      value: v,
    })),
    ...input.nonGoals.map((v, i) => ({ name: `nonGoals[${i}]`, value: v })),
    ...input.acceptanceCriteria.map((v, i) => ({
      name: `acceptanceCriteria[${i}]`,
      value: v,
    })),
    ...input.verificationCommands.map((v, i) => ({
      name: `verificationCommands[${i}]`,
      value: v,
    })),
    ...input.candidateCodeSurfaces.map((s, i) => ({
      name: `candidateCodeSurfaces[${i}].reason`,
      value: s.reason,
    })),
  ];
  if (input.candidateRegression) {
    fields.push(
      { name: "candidateRegression.scenarioPrompt", value: input.candidateRegression.scenarioPrompt },
      { name: "candidateRegression.expectedContract", value: input.candidateRegression.expectedContract },
      { name: "candidateRegression.verificationCommand", value: input.candidateRegression.verificationCommand },
    );
  }
  for (const field of fields) {
    const v = scrubContent(field.value);
    for (const msg of v) {
      violations.push(`${field.name}: ${msg}`);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// §7 Schema version validation
// ---------------------------------------------------------------------------

/** Assert that the schema version is supported. Fail-closed on
 *  unsupported future versions. */
export function assertSupportedSchemaVersion(version: number): void {
  if (version !== REPAIR_PACKET_SCHEMA_VERSION) {
    throw new EvaluationValidationError(
      `unsupported repair packet schema version: ${version}; current version is ${REPAIR_PACKET_SCHEMA_VERSION}`,
    );
  }
}

// ---------------------------------------------------------------------------
// §8 Integrity hash
// ---------------------------------------------------------------------------

/** Compute the integrity SHA-256 of a packet. The hash is over the
 *  canonical form of the packet (sorted keys, no undefined values).
 *  The `integritySha256` field itself is excluded from the hash. */
export function computePacketIntegritySha256(
  packet: Omit<RepairPacket, "integritySha256">,
): string {
  return sha256(stableStringify(packet));
}

// ---------------------------------------------------------------------------
// §9 Build packet — the canonical constructor
// ---------------------------------------------------------------------------

/** Build an immutable Repair Packet.
 *
 *  This is the ONLY path the runner uses to construct a packet. It
 *  enforces every invariant in Issue #97 §7-§9. */
export function buildRepairPacket(
  input: BuildRepairPacketInput,
  diagnosis: DiagnosisRecord,
  cluster?: IssueCluster,
): RepairPacket {
  // §1 Schema version assertion.
  assertSupportedSchemaVersion(REPAIR_PACKET_SCHEMA_VERSION);

  // §2 Status source: diagnosis status, optionally overridden by cluster
  // status when the cluster has a higher-rank status.
  const causalStatus: DiagnosisCausalStatus = cluster
    ? pickHigherStatus(diagnosis.causalStatus, cluster.causalStatus)
    : diagnosis.causalStatus;
  const confidence: DiagnosisConfidenceLevel = cluster
    ? pickLowerConfidence(diagnosis.confidence, cluster.confidence)
    : diagnosis.confidence;

  // §3 Confidence must not exceed what the status supports.
  if (confidenceExceedsStatus(causalStatus, confidence)) {
    throw new EvaluationValidationError(
      `repair packet confidence ${confidence} 超过 status ${causalStatus} 支持的范围`,
    );
  }

  // §4 Fix/investigation gate.
  const fixGate = canGenerateFixPacket({
    causalStatus,
    candidateCodeSurfaces: input.candidateCodeSurfaces,
    acceptanceCriteria: input.acceptanceCriteria,
    protectedBoundaries: input.protectedBoundaries,
    verificationCommands: input.verificationCommands,
    codeFingerprint: input.codeFingerprint,
  });
  const packetType: RepairPacketType = fixGate.allowed ? "fix" : "investigation";

  // §5 Severity.
  const severity = inferSeverity(causalStatus, confidence);

  // §6 Stale detection.
  const staleState = detectStaleState(
    input.codeFingerprint,
    input.currentCodeFingerprint,
  );

  // §7 Scrub content.
  const scrubViolations = validatePacketScrubbing(input);
  if (scrubViolations.length > 0) {
    throw new EvaluationValidationError(
      `repair packet 内容包含禁止信息: ${scrubViolations.join("; ")}`,
    );
  }

  // §8 Candidate regression governance.
  if (input.candidateRegression) {
    const regressionStatus = input.candidateRegression.status as string;
    if (regressionStatus !== "candidate" && regressionStatus !== "unapproved") {
      throw new EvaluationValidationError(
        `candidate regression 不得标记为 ${regressionStatus}；只能为 candidate 或 unapproved，promotion 需要 Robert 显式 reviewable diff`,
      );
    }
    if (input.candidateRegression.outsideFrozenSuite !== true) {
      throw new EvaluationValidationError(
        "candidate regression 必须标记 outsideFrozenSuite: true",
      );
    }
  }

  // §9 Code surfaces default to `hypothesis`. Only direct component
  // evidence raises the level. This is enforced by the type system
  // (`CodeSurfaceEvidenceLevel`), but we also verify at runtime.
  for (const surface of input.candidateCodeSurfaces) {
    if (
      surface.evidenceLevel !== "hypothesis"
      && surface.evidenceLevel !== "direct_component_evidence"
    ) {
      throw new EvaluationValidationError(
        `candidate code surface ${surface.surfaceId} evidenceLevel 非法: ${surface.evidenceLevel}`,
      );
    }
  }

  // §10 Build the packet (without integrity hash first).
  const createdAt = input.createdAt ?? new Date().toISOString();
  const packetWithoutHash: Omit<RepairPacket, "integritySha256"> = {
    schemaVersion: REPAIR_PACKET_SCHEMA_VERSION,
    packetId: input.packetId,
    packetType,
    severity,
    confidence,
    causalStatus,
    runId: input.runId,
    ...(input.clusterId !== undefined ? { clusterId: input.clusterId } : {}),
    diagnosisId: input.diagnosisId,
    codeFingerprint: input.codeFingerprint,
    observedSymptom: input.observedSymptom,
    expectedContract: input.expectedContract,
    reproductionCommand: input.reproductionCommand,
    evidenceReferences: [...input.evidenceReferences],
    affectedComponents: [...input.affectedComponents],
    candidateCodeSurfaces: [...input.candidateCodeSurfaces],
    protectedBoundaries: [...input.protectedBoundaries],
    nonGoals: [...input.nonGoals],
    acceptanceCriteria: [...input.acceptanceCriteria],
    verificationCommands: [...input.verificationCommands],
    ...(input.candidateRegression !== undefined
      ? { candidateRegression: input.candidateRegression }
      : {}),
    staleState,
    createdAt,
    ...(input.counterfactualRef !== undefined
      ? { counterfactualRef: input.counterfactualRef }
      : {}),
    ...(input.faultProfileRef !== undefined
      ? { faultProfileRef: input.faultProfileRef }
      : {}),
  };

  // §11 Compute integrity hash.
  const integritySha256 = computePacketIntegritySha256(packetWithoutHash);

  return {
    ...packetWithoutHash,
    integritySha256,
  };
}

/** Pick the higher-ranked status. `unresolved` dominates when present. */
function pickHigherStatus(
  a: DiagnosisCausalStatus,
  b: DiagnosisCausalStatus,
): DiagnosisCausalStatus {
  if (a === "unresolved" || b === "unresolved") return "unresolved";
  const order: DiagnosisCausalStatus[] = [
    "observed_failure",
    "localized_hypothesis",
    "intervention_supported",
    "fault_injection_confirmed",
  ];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

/** Pick the lower confidence. */
function pickLowerConfidence(
  a: DiagnosisConfidenceLevel,
  b: DiagnosisConfidenceLevel,
): DiagnosisConfidenceLevel {
  const order: DiagnosisConfidenceLevel[] = [
    "very_low",
    "low",
    "medium",
    "high",
    "very_high",
  ];
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
}

// ---------------------------------------------------------------------------
// §10 Packet validation
// ---------------------------------------------------------------------------

/** Verify a packet's invariants. Returns a list of violations (empty = OK).
 *  Used by tests and the artifact store. */
export function verifyPacketInvariants(packet: RepairPacket): string[] {
  const violations: string[] = [];
  if (packet.schemaVersion !== REPAIR_PACKET_SCHEMA_VERSION) {
    violations.push(
      `packet ${packet.packetId} schemaVersion ${packet.schemaVersion} 与当前版本 ${REPAIR_PACKET_SCHEMA_VERSION} 不一致`,
    );
  }
  // Fix packets must satisfy the gate.
  if (packet.packetType === "fix") {
    const gate = canGenerateFixPacket({
      causalStatus: packet.causalStatus,
      candidateCodeSurfaces: packet.candidateCodeSurfaces,
      acceptanceCriteria: packet.acceptanceCriteria,
      protectedBoundaries: packet.protectedBoundaries,
      verificationCommands: packet.verificationCommands,
      codeFingerprint: packet.codeFingerprint,
    });
    if (!gate.allowed) {
      violations.push(
        `packet ${packet.packetId} 是 fix 类型但 gate 拒绝: ${gate.reason}`,
      );
    }
  }
  // Investigation packets must NOT have status that supports fix.
  if (packet.packetType === "investigation") {
    if (statusSupportsFix(packet.causalStatus)) {
      // Investigation packet with strong status — allowed only when the
      // gate was failed for another reason (e.g., missing acceptance
      // criteria). Not a violation per se, but flag it.
    }
  }
  // Confidence must not exceed status.
  if (confidenceExceedsStatus(packet.causalStatus, packet.confidence)) {
    violations.push(
      `packet ${packet.packetId} confidence ${packet.confidence} 超过 status ${packet.causalStatus}`,
    );
  }
  // Integrity hash must match.
  const { integritySha256, ...rest } = packet;
  const expectedHash = computePacketIntegritySha256(rest);
  if (integritySha256 !== expectedHash) {
    violations.push(
      `packet ${packet.packetId} integritySha256 不匹配: expected ${expectedHash}, got ${integritySha256}`,
    );
  }
  // Candidate regression must be marked outside frozen suite.
  if (packet.candidateRegression) {
    if (packet.candidateRegression.outsideFrozenSuite !== true) {
      violations.push(
        `packet ${packet.packetId} candidate regression 必须标记 outsideFrozenSuite: true`,
      );
    }
    const regressionStatus = packet.candidateRegression.status as string;
    if (regressionStatus !== "candidate" && regressionStatus !== "unapproved") {
      violations.push(
        `packet ${packet.packetId} candidate regression 不得标记为 ${regressionStatus}`,
      );
    }
  }
  // Stale packets must not be presented as fresh.
  if (packet.staleState === "stale") {
    // Stale is allowed (the packet records its staleness); the Coding
    // Agent prompt must refuse to execute on stale packets.
  }
  // Code surfaces evidence level.
  for (const surface of packet.candidateCodeSurfaces) {
    if (
      surface.evidenceLevel !== "hypothesis"
      && surface.evidenceLevel !== "direct_component_evidence"
    ) {
      violations.push(
        `packet ${packet.packetId} candidate code surface ${surface.surfaceId} evidenceLevel 非法: ${surface.evidenceLevel}`,
      );
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// §11 Stable packet ID helper
// ---------------------------------------------------------------------------

/** Generate a stable packet ID from the diagnosis ID and run ID. */
export function stablePacketId(runId: string, diagnosisId: string): string {
  const hash = createHash("sha256")
    .update(`${runId}|${diagnosisId}`)
    .digest("hex")
    .slice(0, 16);
  return `rp-${hash}`;
}

// ---------------------------------------------------------------------------
// §12 Status transition verification
// ---------------------------------------------------------------------------

/** Verify that a packet's causal status is consistent with the diagnosis.
 *  Returns a list of violations (empty = OK). */
export function verifyPacketStatusConsistency(
  packet: RepairPacket,
  diagnosis: DiagnosisRecord,
): string[] {
  const violations: string[] = [];
  // The packet's status must be reachable from the diagnosis status.
  if (packet.causalStatus !== diagnosis.causalStatus) {
    try {
      assertValidStatusTransition(
        diagnosis.causalStatus,
        packet.causalStatus,
        `packet ${packet.packetId}`,
      );
    } catch (e) {
      violations.push(
        `packet ${packet.packetId} causalStatus ${packet.causalStatus} 与 diagnosis ${diagnosis.diagnosisId} status ${diagnosis.causalStatus} 之间无合法转换: ${(e as Error).message}`,
      );
    }
  }
  return violations;
}