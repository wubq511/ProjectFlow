/**
 * T46-4 (Issue #97) — Diagnosis and Repair Packet contracts.
 *
 * Additive extension over Slice 0 (`contract.ts`), Slice 1 (`contract-v2.ts`)
 * and Slice 1 multi-turn (`contract-v3.ts`). All V4 fields are OPTIONAL on
 * existing artifacts so Slice 0/1 artifacts continue to validate.
 *
 * Issue #97 acceptance criteria covered here:
 *  - Frozen diagnosis statuses (5 exactly — no synonymous additions).
 *  - Earliest divergence narrows the search but never auto-promotes to
 *    root cause.
 *  - Evaluator-owned fault profiles covering 8 categories.
 *  - Single-variable counterfactual with paired manifest and unchanged
 *    factors.
 *  - Known-fault RCA benchmark with 5 metrics scored by a deterministic
 *    oracle (the diagnosis implementation never defines its own expected
 *    cause).
 *  - Issue clustering by shared cause evidence (not text similarity).
 *  - Immutable Repair Packet schema with stale detection, fix/investigation
 *    gate, candidate regression governance and copy-ready Coding Agent
 *    prompt.
 *
 * Boundary invariants (must hold across all V4 modules):
 *  - The 5 frozen statuses are the ONLY allowed causal status values.
 *    No near-synonyms (e.g., "confirmed", "suspected") may be added.
 *  - Earliest divergence is a HYPOTHESIS, never automatically a root cause.
 *    Promotion to `intervention_supported` requires a single-variable
 *    counterfactual that changed exactly one declared factor.
 *  - Fault profiles live ONLY in evaluator-owned isolation. They MUST NOT:
 *      - be exposed as model-callable tools;
 *      - edit the user worktree or development database;
 *      - be enabled outside evaluation auth (nonce, instance identity,
 *        path containment);
 *      - be self-graded by the implementation under test.
 *  - Counterfactuals MUST record `changedFactor` and `unchangedFactors`
 *    and MUST refuse to promote to `intervention_supported` when more
 *    than one factor changed or resolved model identity cannot be
 *    confirmed.
 *  - The RCA benchmark oracle is declared by an independent evaluator
 *    contract. The diagnosis implementation cannot define its own
 *    expected cause.
 *  - Clustering merges observations ONLY when shared cause evidence
 *    exists. Same symptom + different evidence MUST NOT merge.
 *  - Repair Packets:
 *      - candidate code surfaces default to `hypothesis`; only direct
 *        component evidence raises the level;
 *      - commit/worktree mismatch MUST fail-closed as `stale`;
 *      - `fix` packets require direct component evidence OR
 *        intervention_supported OR fault_injection_confirmed PLUS a
 *        falsifiable acceptance test, protected boundaries, verification
 *        commands and a valid code fingerprint; otherwise `investigation`;
 *      - packets never contain secret, raw hidden fact, private
 *        transcript, absolute temp path or model hidden reasoning;
 *      - packets atomically enter the SHA-256 result graph;
 *      - unsupported future schema versions fail-closed.
 *  - Candidate regressions live OUTSIDE the frozen suite, are explicitly
 *    marked `candidate` / `unapproved`, and cannot be auto-promoted by
 *    any eval, diagnosis or Coding Agent.
 */

// ---------------------------------------------------------------------------
// §1 Frozen diagnosis statuses
// ---------------------------------------------------------------------------

/**
 * The frozen causal status ladder. Exactly these 5 values are allowed.
 * Adding a synonymous status (e.g., "confirmed", "suspected",
 * "likely_cause") is forbidden by contract.
 *
 * Promotion rules (enforced by `assertValidStatusTransition`):
 *  - `observed_failure` → `localized_hypothesis`: evidence narrows the
 *    candidate range to one or a few modules.
 *  - `localized_hypothesis` → `intervention_supported`: a single-variable
 *    counterfactual changed exactly one declared factor and the result
 *    changed accordingly.
 *  - `localized_hypothesis` → `fault_injection_confirmed`: an
 *    evaluator-owned fault profile with the same declared root cause was
 *    reproduced and the diagnosis matched it.
 *  - `unresolved` is terminal for a given observation when evidence
 *    conflicts or multi-factor alternatives cannot be separated.
 *
 * `earliest_divergence` narrows the search but NEVER auto-promotes to
 * any status above `localized_hypothesis` on its own.
 */
export type DiagnosisCausalStatus =
  | "observed_failure"
  | "localized_hypothesis"
  | "intervention_supported"
  | "fault_injection_confirmed"
  | "unresolved";

/** All allowed statuses. Used by validators to reject synonymous additions. */
export const FROZEN_DIAGNOSIS_STATUSES: readonly DiagnosisCausalStatus[] = [
  "observed_failure",
  "localized_hypothesis",
  "intervention_supported",
  "fault_injection_confirmed",
  "unresolved",
] as const;

/** Repair packet type. `fix` requires the stronger causal-evidence rule;
 *  otherwise the packet MUST be `investigation`. */
export type RepairPacketType = "fix" | "investigation";

/** Confidence level reported alongside a diagnosis. Must be consistent
 *  with the evidence level; the benchmark penalises inconsistency. */
export type DiagnosisConfidenceLevel =
  | "very_low"
  | "low"
  | "medium"
  | "high"
  | "very_high";

// ---------------------------------------------------------------------------
// §2 Evidence records
// ---------------------------------------------------------------------------

/** The kind of evidence supporting a hypothesis. Ordered by strength. */
export type EvidenceKind =
  // A deterministic grader reported a contract violation.
  | "hard_grader_failure"
  // An assertion on the normalized evidence snapshot failed.
  | "state_constraint_violation"
  // A privacy/authority grader reported a leak or commit-effect violation.
  | "privacy_or_authority_violation"
  // The trajectory milestone DAG was violated.
  | "trajectory_violation"
  // The earliest divergence localizer found a candidate range.
  | "earliest_divergence"
  // A single-variable counterfactual changed the outcome.
  | "counterfactual_intervention"
  // An evaluator-owned fault profile with the same declared root cause
  // was reproduced.
  | "fault_profile_reproduced"
  // A code surface was identified by direct component evidence (e.g.,
  // a stack trace, an effect_type mismatch, a manifest violation).
  | "direct_component_evidence"
  // An observation that does not support any hypothesis (used for
  // `unresolved` records).
  | "conflicting_evidence";

/** A single piece of evidence linked to a hypothesis. */
export interface EvidenceRecord {
  /** Stable evidence ID (unique within a diagnosis record). */
  evidenceId: string;
  /** Kind of evidence. */
  kind: EvidenceKind;
  /** Human-readable summary (Chinese). */
  summary: string;
  /** Artifact-relative path or stable reference (no absolute temp paths,
   *  no secrets, no raw hidden facts). Example: `observations/<id>.json`,
   *  `grades/<id>.json`, `repair-packets/<packet-id>.json`. */
  reference: string;
  /** Optional SHA-256 of the referenced artifact for tamper-evidence. */
  referenceSha256?: string;
  /** Optional additional deterministic facts (e.g., grader name, failed
   *  assertion path, fault profile id). Never contains raw hidden
   *  facts, secrets, or full transcripts. */
  facts?: Record<string, string | number | boolean | null>;
}

// ---------------------------------------------------------------------------
// §3 Code surface evidence
// ---------------------------------------------------------------------------

/** Evidence level for a candidate code surface. `hypothesis` is the
 *  default; only `direct_component_evidence` raises confidence. */
export type CodeSurfaceEvidenceLevel = "hypothesis" | "direct_component_evidence";

/** A candidate code surface suggested for repair exploration. */
export interface CandidateCodeSurface {
  /** Stable surface ID (unique within a packet). */
  surfaceId: string;
  /** Component or module name (e.g., `hard-graders.ts`,
   *  `runtime-faults.ts:evaluateFaultBehavior`). */
  component: string;
  /** Human-readable reason this surface was suggested (Chinese). */
  reason: string;
  /** Evidence level. Defaults to `hypothesis`; only direct component
   *  evidence raises it. */
  evidenceLevel: CodeSurfaceEvidenceLevel;
  /** Evidence records supporting this surface. */
  evidence: string[]; // references to EvidenceRecord.evidenceId
}

// ---------------------------------------------------------------------------
// §4 Hypothesis and diagnosis records
// ---------------------------------------------------------------------------

/** A candidate root-cause hypothesis for an observation. */
export interface HypothesisRecord {
  /** Stable hypothesis ID (unique within a diagnosis record). */
  hypothesisId: string;
  /** Human-readable candidate cause (Chinese). */
  candidateCause: string;
  /** Causal status of this hypothesis. */
  status: DiagnosisCausalStatus;
  /** Evidence records supporting this hypothesis. */
  supportingEvidence: string[]; // references to EvidenceRecord.evidenceId
  /** Evidence records contradicting this hypothesis. */
  contradictingEvidence: string[]; // references to EvidenceRecord.evidenceId
  /** Code surfaces suggested by this hypothesis. */
  candidateCodeSurfaces: CandidateCodeSurface[];
  /** Optional excluded alternatives (other hypotheses that were
   *  considered and rejected, with reason). */
  excludedAlternatives?: Array<{
    alternativeCause: string;
    rejectionReason: string;
  }>;
  /** Optional earliest divergence info that narrowed this hypothesis. */
  earliestDivergence?: EarliestDivergenceRecord;
  /** Optional counterfactual reference that promoted this hypothesis. */
  counterfactualRef?: string;
  /** Optional fault profile reference that confirmed this hypothesis. */
  faultProfileRef?: string;
}

/** Earliest divergence record. Narrows the search but never auto-promotes. */
export interface EarliestDivergenceRecord {
  /** Stable record ID. */
  divergenceId: string;
  /** Sequence (event_seq or turn) at which divergence was observed. */
  observedAtSeq: number;
  /** The expected milestone/event at that point. */
  expectedMilestone: string;
  /** The actual milestone/event observed. */
  actualMilestone: string;
  /** Candidate modules/components that could explain the divergence. */
  candidateRange: string[];
  /** Human-readable note (Chinese). */
  note: string;
  /** Explicit warning that this is a HYPOTHESIS, not a confirmed cause. */
  isHypothesis: true;
}

/** A diagnosis record for a single observation. */
export interface DiagnosisRecord {
  /** Stable diagnosis ID (unique within a run). */
  diagnosisId: string;
  /** Run ID this diagnosis belongs to. */
  runId: string;
  /** Scenario ID being diagnosed. */
  scenarioId: string;
  /** Observation ID (artifact-relative path or stable identifier). */
  observationId: string;
  /** The observed symptom (Chinese). */
  observedSymptom: string;
  /** The expected contract (Chinese). */
  expectedContract: string;
  /** Final causal status of this diagnosis. */
  causalStatus: DiagnosisCausalStatus;
  /** Confidence level reported. */
  confidence: DiagnosisConfidenceLevel;
  /** All evidence records referenced by hypotheses. */
  evidence: EvidenceRecord[];
  /** All hypotheses considered. */
  hypotheses: HypothesisRecord[];
  /** Whether the diagnosis was auto-generated from a fault profile
   *  (used by the RCA benchmark). */
  fromFaultProfile?: boolean;
  /** ISO timestamp. */
  createdAt: string;
  /** Optional reproduction command (no secrets, no absolute paths). */
  reproductionCommand?: string;
  /** Optional reference to the counterfactual run that supported
   *  promotion to `intervention_supported`. */
  counterfactualRunRef?: string;
  /** Optional reference to the fault profile that confirmed the cause. */
  faultProfileRef?: string;
}

// ---------------------------------------------------------------------------
// §5 Fault profiles (evaluator-owned)
// ---------------------------------------------------------------------------

/** The 8 required fault profile categories. Exactly these 8 are allowed. */
export type FaultProfileCategory =
  | "routing"
  | "context"
  | "skill"
  | "tool_schema_or_result"
  | "policy_or_effect_boundary"
  | "privacy_or_visibility"
  | "proposal_evidence"
  | "terminal_events";

export const FAULT_PROFILE_CATEGORIES: readonly FaultProfileCategory[] = [
  "routing",
  "context",
  "skill",
  "tool_schema_or_result",
  "policy_or_effect_boundary",
  "privacy_or_visibility",
  "proposal_evidence",
  "terminal_events",
] as const;

/** The independently-declared expected root cause for a fault profile.
 *  This is the oracle. The diagnosis implementation cannot define its own
 *  expected cause — it can only propose hypotheses that the oracle scores.
 *
 *  Boundary: the expected cause is declared in the fault profile, which
 *  is part of the evaluator-owned contract. It is NEVER sent to the SUT
 *  and NEVER exposed as a model-callable tool. */
export interface FaultProfileExpectedCause {
  /** Stable expected cause ID. */
  causeId: string;
  /** Category. */
  category: FaultProfileCategory;
  /** Human-readable expected root cause (Chinese). */
  expectedCause: string;
  /** Deterministic matcher: a diagnosis hypothesis whose
   *  `candidateCause` matches this predicate is counted as a correct
   *  attribution. */
  matcher: FaultProfileCauseMatcher;
}

/** Deterministic matcher for scoring a hypothesis against an expected cause. */
export interface FaultProfileCauseMatcher {
  /** Match strategy. */
  kind: "exact_token" | "regex" | "component_path";
  /** Pattern. For `exact_token`, the hypothesis candidateCause must
   *  contain the token verbatim. For `regex`, the pattern is compiled
   *  with flags "i". For `component_path`, the hypothesis must include
   *  a candidate code surface whose `component` matches the pattern. */
  pattern: string;
}

/** An evaluator-owned fault profile. */
export interface FaultProfile {
  /** Stable profile ID. */
  profileId: string;
  /** Category. */
  category: FaultProfileCategory;
  /** Human-readable description (Chinese). */
  description: string;
  /** Independent oracle: the expected root cause. */
  expectedCause: FaultProfileExpectedCause;
  /** How the fault is injected (evaluator-owned seam only). */
  injection: FaultProfileInjection;
  /** The observable symptom the diagnosis should see. */
  symptom: {
    /** Human-readable symptom (Chinese). */
    description: string;
    /** Deterministic predicate the diagnosis observation must satisfy. */
    expectedContract: string;
  };
  /** Whether this profile is part of the RCA benchmark. */
  benchmarkRelevant: boolean;
  /** Confusable neighbour profiles (used to test false attribution). */
  confusableNeighbours?: string[];
}

/** Injection seam for a fault profile. Evaluator-owned only. */
export type FaultProfileInjection =
  // Routing: the runner reroutes the request to the wrong mode/skill.
  | { kind: "routing_mismatch"; expectedMode: string; actualMode: string }
  // Context: the context receipt omits a required memory or skill.
  | { kind: "context_omission"; omittedField: string }
  // Skill: a skill trigger fails or a forbidden skill is selected.
  | { kind: "skill_trigger_failure"; expectedSkill: string; actualSkill: string }
  // Tool schema/result: a tool returns an invalid schema or partial result.
  | { kind: "tool_schema_violation"; toolName: string; violation: string }
  | { kind: "tool_result_corruption"; toolName: string; corruption: string }
  // Policy/effect boundary: a commit effect bypasses proposal-confirm.
  | { kind: "effect_boundary_bypass"; toolName: string; bypassedBoundary: string }
  // Privacy/visibility: a private record leaks to an adversary viewer.
  | { kind: "privacy_leak"; leakKind: "private_conversation" | "subject_and_owner_memory" | "raw_id"; leakedToViewer: string }
  // Proposal evidence: a proposal is confirmed without pending evidence.
  | { kind: "proposal_evidence_missing"; proposalType: string; missingField: string }
  // Terminal events: a duplicate or contradictory terminal event.
  | { kind: "duplicate_terminal"; terminalEvent: string }
  | { kind: "contradictory_terminal"; first: string; second: string };

// ---------------------------------------------------------------------------
// §6 Counterfactual records
// ---------------------------------------------------------------------------

/** A single-variable counterfactual run. */
export interface CounterfactualRecord {
  /** Stable counterfactual ID. */
  counterfactualId: string;
  /** Run ID of the baseline observation. */
  baselineRunId: string;
  /** Run ID of the intervention observation. */
  interventionRunId: string;
  /** The single factor that was changed. */
  changedFactor: CounterfactualFactor;
  /** Factors that were explicitly held unchanged. */
  unchangedFactors: CounterfactualFactor[];
  /** Whether the resolved model identity was confirmed on both sides. */
  resolvedModelConfirmed: boolean;
  /** Whether model drift is possible (unconfirmed or different models). */
  modelDriftPossible: boolean;
  /** The paired manifest SHA-256 (proves alignment). */
  pairedManifestSha256: string;
  /** Baseline observation outcome. */
  baselineOutcome: CounterfactualOutcome;
  /** Intervention observation outcome. */
  interventionOutcome: CounterfactualOutcome;
  /** Whether the intervention changed the outcome (supports causality). */
  outcomeChanged: boolean;
  /** Whether this counterfactual supports promotion to
   *  `intervention_supported`. Only true when exactly one factor changed,
   *  resolved model is confirmed, no drift, and outcome changed. */
  supportsIntervention: boolean;
  /** ISO timestamp. */
  createdAt: string;
  /** Reason when `supportsIntervention` is false (Chinese). */
  rejectionReason?: string;
}

/** A declared counterfactual factor. */
export interface CounterfactualFactor {
  /** Factor name (e.g., `routing_mode`, `context_skill`, `tool_result`,
   *  `model`). */
  name: string;
  /** Baseline value (deterministic identifier, no secrets). */
  baselineValue: string;
  /** Intervention value (deterministic identifier, no secrets). */
  interventionValue: string;
}

export interface CounterfactualOutcome {
  /** Scenario ID. */
  scenarioId: string;
  /** Final status. */
  finalStatus: "completed" | "failed" | "blocked";
  /** Hard grade passed. */
  hardGradePassed: boolean;
  /** Side effect count. */
  sideEffectCount: number;
  /** SHA-256 of the observation artifact. */
  observationSha256: string;
}

// ---------------------------------------------------------------------------
// §7 RCA benchmark records
// ---------------------------------------------------------------------------

/** A single benchmark sample: a fault profile + the diagnosis produced. */
export interface RcaBenchmarkSample {
  /** Stable sample ID. */
  sampleId: string;
  /** Fault profile ID used. */
  faultProfileId: string;
  /** Expected cause ID. */
  expectedCauseId: string;
  /** Diagnosis hypothesis proposed (top-k). */
  proposedCauses: Array<{
    causeId: string;
    candidateCause: string;
    confidence: DiagnosisConfidenceLevel;
    matchedExpected: boolean;
  }>;
  /** Whether the top-1 hypothesis matched the expected cause. */
  top1Correct: boolean;
  /** Whether any of the top-3 hypotheses matched the expected cause. */
  top3Correct: boolean;
  /** Whether the diagnosis was `unresolved` or evidence insufficient
   *  (used to test the "evidence insufficient" sample class). */
  unresolvedReported: boolean;
  /** Whether the diagnosis was a false attribution (confident but
   *  wrong). */
  falseAttribution: boolean;
  /** Whether the diagnosis reported sufficient evidence. */
  evidenceComplete: boolean;
  /** Sample class. */
  sampleClass: "correct_attribution" | "confusable_neighbour" | "unresolved_or_insufficient";
}

/** The RCA benchmark report. */
export interface RcaBenchmarkReport {
  /** Stable report ID. */
  reportId: string;
  /** ISO timestamp. */
  evaluatedAt: string;
  /** Total samples. */
  totalSamples: number;
  /** RCA top-1 accuracy. */
  top1Accuracy: number;
  /** RCA top-3 recall. */
  top3Recall: number;
  /** False attribution rate. */
  falseAttributionRate: number;
  /** Evidence completeness (fraction of samples with complete evidence). */
  evidenceCompleteness: number;
  /** Confidence calibration: fraction of samples where confidence level
   *  matches evidence level (i.e., high confidence only when
   *  intervention_supported or fault_injection_confirmed). */
  confidenceCalibration: number;
  /** Per-sample results. */
  samples: RcaBenchmarkSample[];
  /** Whether the benchmark passed its gates. */
  passed: boolean;
  /** Failure reasons (Chinese) when not passed. */
  failureReasons: string[];
}

// ---------------------------------------------------------------------------
// §8 Issue clustering
// ---------------------------------------------------------------------------

/** A cluster of observations sharing a cause. */
export interface IssueCluster {
  /** Stable cluster ID. */
  clusterId: string;
  /** Run ID this cluster belongs to. */
  runId: string;
  /** Shared cause evidence (the reason these observations were merged). */
  sharedCauseEvidence: string[]; // references to EvidenceRecord.evidenceId
  /** Human-readable shared cause (Chinese). */
  sharedCause: string;
  /** Member observations (scenario IDs + observation IDs). */
  members: Array<{
    scenarioId: string;
    observationId: string;
    diagnosisId: string;
  }>;
  /** Observations that were considered but refused merge, with reason. */
  refusedMerge: Array<{
    scenarioId: string;
    observationId: string;
    refusalReason: string;
  }>;
  /** ISO timestamp. */
  createdAt: string;
  /** Cluster confidence (lowest confidence among members). */
  confidence: DiagnosisConfidenceLevel;
  /** Final causal status (highest status among members, with `unresolved`
   *  dominating when present). */
  causalStatus: DiagnosisCausalStatus;
}

// ---------------------------------------------------------------------------
// §9 Repair Packet
// ---------------------------------------------------------------------------

/** Repair packet schema version. Bump when field semantics change. */
export const REPAIR_PACKET_SCHEMA_VERSION = 1 as const;

/** Packet severity. */
export type RepairPacketSeverity = "low" | "medium" | "high" | "critical";

/** Staleness state of a packet. */
export type RepairPacketStaleState = "fresh" | "stale" | "unknown";

/** A candidate regression case attached to a repair packet. Always
 *  marked `candidate` / `unapproved` — never auto-promoted. */
export interface CandidateRegression {
  /** Stable regression ID. */
  regressionId: string;
  /** Scenario prompt (Chinese). */
  scenarioPrompt: string;
  /** Expected contract (Chinese). */
  expectedContract: string;
  /** Verification command (no secrets, no absolute paths). */
  verificationCommand: string;
  /** Status — always `candidate` or `unapproved`. Never `approved`. */
  status: "candidate" | "unapproved";
  /** Explicit warning that this regression is NOT in the frozen suite. */
  outsideFrozenSuite: true;
}

/** Immutable Repair Packet. */
export interface RepairPacket {
  /** Schema version. */
  schemaVersion: typeof REPAIR_PACKET_SCHEMA_VERSION;
  /** Stable packet ID (unique within a run). */
  packetId: string;
  /** Packet type. `fix` requires the stronger causal-evidence rule. */
  packetType: RepairPacketType;
  /** Severity. */
  severity: RepairPacketSeverity;
  /** Confidence level. */
  confidence: DiagnosisConfidenceLevel;
  /** Causal status. */
  causalStatus: DiagnosisCausalStatus;
  /** Run ID this packet belongs to. */
  runId: string;
  /** Cluster ID this packet belongs to (if applicable). */
  clusterId?: string;
  /** Diagnosis ID this packet was generated from. */
  diagnosisId: string;
  /** Code fingerprint (commit, dirty, worktree hash). */
  codeFingerprint: {
    gitCommit: string;
    gitDirty: boolean;
    worktreeSha256: string;
  };
  /** Observed symptom (Chinese). */
  observedSymptom: string;
  /** Expected contract (Chinese). */
  expectedContract: string;
  /** Reproduction command (no secrets, no absolute paths). */
  reproductionCommand: string;
  /** Immutable evidence references (artifact-relative paths + SHA-256). */
  evidenceReferences: Array<{
    reference: string;
    referenceSha256: string;
  }>;
  /** Affected components. */
  affectedComponents: string[];
  /** Candidate code surfaces. */
  candidateCodeSurfaces: CandidateCodeSurface[];
  /** Protected boundaries (must NOT be weakened by the Coding Agent). */
  protectedBoundaries: string[];
  /** Non-goals (must NOT be touched by the Coding Agent). */
  nonGoals: string[];
  /** Falsifiable acceptance criteria. */
  acceptanceCriteria: string[];
  /** Verification commands (no secrets, no absolute paths). */
  verificationCommands: string[];
  /** Candidate regression case (always outside the frozen suite). */
  candidateRegression?: CandidateRegression;
  /** Stale state. `stale` when commit/worktree mismatch. */
  staleState: RepairPacketStaleState;
  /** ISO timestamp. */
  createdAt: string;
  /** Integrity hash — SHA-256 of the packet's canonical form. */
  integritySha256: string;
  /** Optional counterfactual reference. */
  counterfactualRef?: string;
  /** Optional fault profile reference. */
  faultProfileRef?: string;
}

// ---------------------------------------------------------------------------
// §10 Portable artifact surface for V4
// ---------------------------------------------------------------------------

/** V4 evaluation artifact block. Stored as an additive extension to the
 *  Slice 0 `EvaluationArtifact`. All fields optional for backward
 *  compatibility. */
export interface EvaluationArtifactV4 {
  v4Version: typeof V4_CONTRACT_VERSION;
  /** Diagnosis records produced for this run. */
  diagnoses?: DiagnosisRecord[];
  /** Counterfactual records produced for this run. */
  counterfactuals?: CounterfactualRecord[];
  /** Issue clusters produced for this run. */
  issueClusters?: IssueCluster[];
  /** Repair packets produced for this run (summaries only; full packets
   *  live in `repair-packets/<packet-id>.json`). */
  repairPacketSummaries?: Array<{
    packetId: string;
    packetType: RepairPacketType;
    causalStatus: DiagnosisCausalStatus;
    confidence: DiagnosisConfidenceLevel;
    integritySha256: string;
    artifactPath: string;
  }>;
  /** RCA benchmark report (when the run was a benchmark run). */
  rcaBenchmarkReport?: RcaBenchmarkReport;
}

export const V4_CONTRACT_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// §11 Status transition validation
// ---------------------------------------------------------------------------

/** Assert that a status transition is valid. Throws on invalid transitions.
 *
 *  Valid promotions:
 *   - observed_failure → localized_hypothesis
 *   - localized_hypothesis → intervention_supported
 *   - localized_hypothesis → fault_injection_confirmed
 *   - observed_failure → unresolved
 *   - localized_hypothesis → unresolved
 *   - intervention_supported → unresolved (when new evidence contradicts)
 *
 *  Forbidden:
 *   - Skipping levels (e.g., observed_failure → intervention_supported)
 *     without going through localized_hypothesis.
 *   - Downgrading from a confirmed status.
 *   - Auto-promoting from earliest_divergence to any status above
 *     localized_hypothesis.
 */
export function assertValidStatusTransition(
  from: DiagnosisCausalStatus,
  to: DiagnosisCausalStatus,
  reason: string,
): void {
  if (from === to) {
    throw new Error(`诊断状态转换无效: ${from} → ${to} (无变化; ${reason})`);
  }
  const valid: Record<DiagnosisCausalStatus, DiagnosisCausalStatus[]> = {
    observed_failure: ["localized_hypothesis", "unresolved"],
    localized_hypothesis: [
      "intervention_supported",
      "fault_injection_confirmed",
      "unresolved",
    ],
    intervention_supported: ["unresolved"],
    fault_injection_confirmed: [], // terminal
    unresolved: [], // terminal
  };
  if (!valid[from].includes(to)) {
    throw new Error(
      `诊断状态转换无效: ${from} → ${to} (reason: ${reason}); earliest_divergence 不能自动升级为根因`,
    );
  }
}

/** Assert that the causal status is one of the frozen 5. */
export function assertFrozenStatus(status: string): asserts status is DiagnosisCausalStatus {
  if (!FROZEN_DIAGNOSIS_STATUSES.includes(status as DiagnosisCausalStatus)) {
    throw new Error(
      `非法诊断状态: ${status}; 只允许 ${FROZEN_DIAGNOSIS_STATUSES.join(", ")}。禁止新增近义词。`,
    );
  }
}

/** Return true if a status is terminal (cannot be promoted further). */
export function isTerminalStatus(status: DiagnosisCausalStatus): boolean {
  return status === "fault_injection_confirmed" || status === "unresolved";
}

/** Return true if a status represents sufficient causal evidence to
 *  support a `fix` packet (when combined with a falsifiable acceptance
 *  test, protected boundaries, verification commands and a valid code
 *  fingerprint). */
export function statusSupportsFix(status: DiagnosisCausalStatus): boolean {
  return (
    status === "intervention_supported"
    || status === "fault_injection_confirmed"
  );
}

/** Map a causal status to the minimum allowed confidence level. The
 *  benchmark uses this to penalise confidence that exceeds what the
 *  evidence supports. */
export function minimumConfidenceForStatus(
  status: DiagnosisCausalStatus,
): DiagnosisConfidenceLevel {
  switch (status) {
    case "observed_failure":
      return "very_low";
    case "localized_hypothesis":
      return "low";
    case "intervention_supported":
      return "medium";
    case "fault_injection_confirmed":
      return "high";
    case "unresolved":
      return "very_low";
  }
}

/** Return true if `confidence` is at least `minimum` (ordered). */
export function confidenceAtLeast(
  confidence: DiagnosisConfidenceLevel,
  minimum: DiagnosisConfidenceLevel,
): boolean {
  const order: DiagnosisConfidenceLevel[] = [
    "very_low",
    "low",
    "medium",
    "high",
    "very_high",
  ];
  return order.indexOf(confidence) >= order.indexOf(minimum);
}

/** Return true if `confidence` exceeds what the status supports. Used
 *  by the benchmark to penalise over-confidence. */
export function confidenceExceedsStatus(
  status: DiagnosisCausalStatus,
  confidence: DiagnosisConfidenceLevel,
): boolean {
  const order: DiagnosisConfidenceLevel[] = [
    "very_low",
    "low",
    "medium",
    "high",
    "very_high",
  ];
  const maxForStatus: Record<DiagnosisCausalStatus, DiagnosisConfidenceLevel> = {
    observed_failure: "low",
    localized_hypothesis: "medium",
    intervention_supported: "high",
    fault_injection_confirmed: "very_high",
    unresolved: "low",
  };
  return order.indexOf(confidence) > order.indexOf(maxForStatus[status]);
}
