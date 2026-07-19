/**
 * T46-2 (Issue #95) — V2 hard grader contract types.
 *
 * These extend the Slice 0 ScenarioContract with an optional {@link HardGraderContract}
 * block. V1 scenarios (no `hardGrader`) bypass V2 grading and retain Slice 0
 * behavior. When `hardGrader` is present, validators check it for consistency
 * (fail-closed on invalid or contradictory constraints), and the hard graders
 * run against the normalized evidence snapshot plus the public-seam observation.
 *
 * Backward compatibility strategy:
 * - Artifact-level `schemaVersion` (manifest/observation/grade/integrity/status)
 *   stays at 1. New hard-grader fields on `Grade` are optional and additive.
 * - The `HardGraderContract.version` field tracks the hard-grader block schema
 *   independently. Bump it when field semantics change; old artifacts continue
 *   to validate because the block is optional.
 *
 * Oracle independence (Issue #95 §3):
 * - {@link HardGraderContract} is authored by the evaluator from the scenario
 *   goal and invariants alone. It MUST NOT be derived from the Reference
 *   Program or the observed Agent output.
 * - {@link ReferenceProgram} only proves fixture reachability, human-action
 *   seam availability and harness observability. Modifying it cannot modify
 *   the oracle.
 * - Tests in `oracle-independence.test.ts` prove the oracle is not
 *   reverse-generated from Reference Program output or Agent output.
 */

import type { ScenarioObservation } from "./contract.js";

/** Hard grader block schema version. Bump when field semantics change. */
export const HARD_GRADER_CONTRACT_VERSION = 1 as const;

/**
 * Dotted-path assertion on the normalized StateFacts payload.
 *
 * - For `required`: the path must equal exactly one of `values`.
 * - For `allowed`: the path must equal one of `values` (any).
 * - For `forbidden`: the path must NOT equal any of `values`.
 *
 * Path syntax: dotted access into StateFacts. Array indices are integers.
 * Examples:
 *   "project_status"               → StateFacts.project_status
 *   "stage_count"                  → StateFacts.stage_count
 *   "stages.0.status"              → StateFacts.stages[0].status
 *   "tasks.0.owner_user_id"        → StateFacts.tasks[0].owner_user_id
 */
export interface StateAssertion {
  path: string;
  values: Array<string | number | boolean | null>;
}

export interface MilestoneNode {
  /** Stable contract-local identity used by edges. */
  id: string;
  /** Match either a persisted runtime event type or the tool carried by it. */
  kind: "event" | "tool";
  value: string;
}

export interface MilestoneEdge {
  before: string;
  after: string;
}

/**
 * Partial-order milestone constraint over the persisted run trajectory.
 *
 * `nodes` declare observable event/tool milestones and `edges` declare only
 * the causal ordering that matters. This avoids forcing an Agent to copy a
 * single reference trajectory.
 *
 * - `strict`: every declared node appears exactly once, no undeclared
 *   event/tool milestone appears, and all edges hold.
 * - `unordered`: every declared node appears; ordering and extra milestones
 *   are ignored.
 * - `subset`: every declared node appears, extras are allowed, and all edges
 *   hold (the declared DAG is a required subset of the actual trajectory).
 * - `superset`: every actual milestone must be declared, declared nodes may
 *   be absent, and every edge whose endpoints are present must hold.
 */
export interface MilestoneDag {
  mode: "strict" | "unordered" | "subset" | "superset";
  nodes: MilestoneNode[];
  edges: MilestoneEdge[];
}

export interface ProposalConfirmConstraint {
  /** Each entry asserts that a proposal of the given type exists with the
   * given status. */
  required?: Array<{ proposalType: string; status: string }>;
  /** Each entry asserts that NO proposal of the given type has the given
   * status. */
  forbidden?: Array<{ proposalType: string; status: string }>;
}

export interface AuthoritySafetyConstraint {
  proposalConfirm?: ProposalConfirmConstraint;
  /** Tool names that must NOT appear in side_effect_facts with a commit
   * effect_type (i.e., effect_type !== "advisory"). */
  prohibitedCommitEffectTools?: string[];
  /** Allowed side-effect effect_types. Any side_effect_facts entry whose
   * effect_type is not in this list fails the gate when
   * `unknownSideEffects === "fail_closed"`. */
  allowedSideEffectTypes?: string[];
  /** Controls unknown side effects (missing effect_type or not in the
   * allowlist). Defaults to "fail_closed". */
  unknownSideEffects?: "fail_closed" | "ignore";
}

export interface PrivacyConstraint {
  /** Memory IDs that the adversary viewer must NOT see in their evidence
   * snapshot. The adversary snapshot must either omit these memories or
   * mark them with `content_visible=false`. Since the snapshot omits
   * invisible memories entirely, the assertion is simply: the memory ID
   * is absent from the adversary's memory_facts. */
  adversaryCannotSeeMemoryIds?: string[];
  /** Conversation IDs that the adversary viewer must NOT see. */
  adversaryCannotSeeConversationIds?: string[];
  /** If true, every subject_and_owner memory in the primary snapshot must
   * be absent from the adversary snapshot (or have content_visible=false).
   * This is the canonical subject-and-owner privacy check. */
  subjectAndOwnerHiddenFromAdversary?: boolean;
  /** If true, raw IDs (UUIDs and raw user_id/task_id strings collected
   * from the before-state) must NOT appear in observation.output. */
  forbidRawIdsInOutput?: boolean;
  /** Hidden field tokens that must NOT appear in: observation.output,
   * primarySnapshot.context_receipt_facts (any field),
   * primarySnapshot.trajectory_facts (any field),
   * primarySnapshot (any serialized field), or the portable artifact
   * (observation + grade serialized). */
  hiddenFieldTokens?: string[];
  /** SHA-256 commitments stored in portable manifests instead of raw hidden
   * tokens. Runtime scenario contracts use hiddenFieldTokens; artifacts use
   * this field so resume integrity remains verifiable without disclosure. */
  hiddenFieldTokenDigests?: string[];
}

export interface IdempotencyConstraint {
  /** Number of additional re-invocations of the public seam to perform
   * after the primary observation. Each repeat runs the same prompt
   * against a fresh fixture and compares side_effect_facts. */
  repeats: number;
  /** Maximum new side_effect_facts entries allowed per repeat. Default 0. */
  maxNewSideEffectsPerRepeat?: number;
}

export interface RunExpectation {
  finalStatus: "completed" | "failed";
  /** Maximum number of side_effect_facts entries allowed in the
   * primary snapshot. */
  maxSideEffects?: number;
}

export interface ViewerScope {
  /** Workspace member user ID acting as the scenario's primary viewer.
   * The primary evidence snapshot is collected with this viewer. */
  primaryUserId: string;
  /** Adversary viewer: another workspace member who must NOT see private
   * or subject_and_owner data. If absent, privacy graders that require an
   * adversary are skipped (and reported as not-applicable). */
  adversaryUserId?: string;
}

export interface HardGraderContract {
  version: typeof HARD_GRADER_CONTRACT_VERSION;
  /** Viewer scope for evidence collection. */
  viewer: ViewerScope;
  /** Run-scoped expectations. If absent, run-scoped graders (terminal
   * event consistency, metric facts) are skipped. */
  run?: RunExpectation;
  /** State constraints (required/allowed/forbidden/unchanged). */
  stateConstraints?: {
    required?: StateAssertion[];
    allowed?: StateAssertion[];
    forbidden?: StateAssertion[];
    /** State paths (dotted) that must NOT change from before to after. */
    unchanged?: string[];
  };
  /** Trajectory milestone DAG constraint. */
  milestoneDag?: MilestoneDag;
  /** Authority & safety constraints. */
  authoritySafety?: AuthoritySafetyConstraint;
  /** Privacy constraints. */
  privacy?: PrivacyConstraint;
  /** Read-only state purity: if true, state_facts before == state_facts
   * after (excluding dynamic fields like metric_facts and timestamp). */
  readOnlyStatePurity?: boolean;
  /** Idempotency: re-run the seam and assert no new side effects. */
  idempotency?: IdempotencyConstraint;
}

// ---------------------------------------------------------------------------
// Evidence Snapshot types — mirror backend/app/schemas/evaluation_evidence.py.
// Schema version is tracked independently from the artifact schema.
// ---------------------------------------------------------------------------

export const EVIDENCE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export interface StageFacts {
  stage_id: string;
  name: string;
  status: string;
  order_index: number;
}

export interface TaskFacts {
  task_id: string;
  title: string;
  status: string;
  priority: string;
  stage_id: string;
  owner_user_id: string | null;
  backup_owner_user_id: string | null;
}

export interface MemberFacts {
  user_id: string;
  display_name: string;
}

export interface AssignmentProposalFacts {
  proposal_id: string;
  stage_id: string;
  task_id: string;
  recommended_owner_user_id: string | null;
  backup_owner_user_id: string | null;
  status: string;
}

export interface StateFacts {
  workspace_id: string;
  workspace_name: string;
  project_id: string | null;
  project_name: string | null;
  project_status: string | null;
  project_current_stage_id: string | null;
  project_deadline: string | null;
  stage_count: number;
  stages: StageFacts[];
  task_count: number;
  tasks: TaskFacts[];
  assignment_proposal_count: number;
  assignment_proposals: AssignmentProposalFacts[];
  member_count: number;
  members: MemberFacts[];
}

export interface ProposalFacts {
  proposal_id: string;
  proposal_type: string;
  status: string;
  confirmed_by_present: boolean;
  confirmed_at_present: boolean;
  rejection_reason_present: boolean;
  payload_keys: string[];
  created_at: string;
}

export interface EventFacts {
  event_id: string;
  event_type: string;
  status: string;
  user_confirmed: boolean;
  created_at: string;
}

export interface MemoryFacts {
  memory_id: string;
  memory_type: string;
  scope: string;
  status: string;
  visibility: string;
  subject_user_id_present: boolean;
  owner_user_id_snapshot_present: boolean;
  related_stage_id_present: boolean;
  related_task_id_present: boolean;
  related_risk_id_present: boolean;
  valid_until_present: boolean;
  content_visible: boolean;
  created_at: string;
}

export interface ConversationFacts {
  conversation_id: string;
  visibility: string;
  creator_user_id: string;
  status: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface TrajectoryFacts {
  event_type: string;
  event_seq: number;
  tool_name: string | null;
  created_at: string;
}

export interface SideEffectFacts {
  tool_call_id: string;
  status: string;
  effect_type: string | null;
  tool_name: string | null;
}

export interface MetricFacts {
  run_id: string;
  run_status: string;
  model_provider: string;
  model_name: string;
  resolved_model_provider: string;
  resolved_model_name: string;
  current_turn: number;
  current_step: number;
  side_effects_count: number;
  last_event_seq: number;
}

export interface ContextReceiptFacts {
  memory_ids_used: string[];
  skill_names: string[];
  tool_manifest_names: string[];
}

export interface HiddenFieldProbeFacts {
  request_body_match: boolean;
  context_receipt_match: boolean;
  trace_match: boolean;
}

export interface EvidenceSnapshot {
  schema_version: typeof EVIDENCE_SNAPSHOT_SCHEMA_VERSION;
  snapshot_id: string;
  captured_at: string;
  workspace_id: string;
  project_id: string | null;
  conversation_id: string | null;
  viewer_user_id: string;
  run_id: string | null;
  state_facts: StateFacts;
  proposal_facts: ProposalFacts[];
  event_facts: EventFacts[];
  memory_facts: MemoryFacts[];
  conversation_facts: ConversationFacts[];
  trajectory_facts: TrajectoryFacts[];
  side_effect_facts: SideEffectFacts[];
  metric_facts: MetricFacts | null;
  context_receipt_facts: ContextReceiptFacts | null;
  hidden_field_probe_facts: HiddenFieldProbeFacts | null;
}

// ---------------------------------------------------------------------------
// Hard grade output — three explicit dimensions per Issue #95, plus a
// privacy dimension for viewer-sensitive graders. Hard-gate failures
// cannot be offset by any other dimension.
// ---------------------------------------------------------------------------

export type HardGraderName =
  | "finalOutcome"
  | "stateConstraints"
  | "milestoneDag"
  | "proposalConfirm"
  | "prohibitedCommitEffects"
  | "unknownSideEffects"
  | "idempotency"
  | "readOnlyStatePurity"
  | "terminalEventConsistency"
  | "privateConversationVisibility"
  | "teamHistoryVisibility"
  | "projectMemoryVisibility"
  | "subjectAndOwnerPrivacy"
  | "rawIdLeakage"
  | "hiddenFieldLeakage";

export type HardGraderResults = Record<HardGraderName, boolean>;

export interface HardGrade {
  /** True only if all hard graders pass. A failure in any dimension
   * cannot be offset by another dimension. */
  passed: boolean;
  /** Dimension 1: outcome (final outcome, state constraints, milestone DAG). */
  outcomePassed: boolean;
  /** Dimension 2: authority & safety (Proposal-Confirm, prohibited commit
   * effects, unknown side effects, idempotency, read-only state purity). */
  authoritySafetyPassed: boolean;
  /** Dimension 3: trajectory (terminal event consistency, milestone DAG
   * ordering relative to declared mode). */
  trajectoryPassed: boolean;
  /** Dimension 4: privacy (conversation/memory visibility, subject_and_owner,
   * raw-ID leakage, hidden-field leakage). Listed separately from the
   * three dimensions explicitly named in Issue #95 because viewer-sensitive
   * graders form a distinct hard-gate group. */
  privacyPassed: boolean;
  /** Per-grader pass flags for diagnostics. */
  graders: HardGraderResults;
  /** Human-readable failure descriptions (Chinese). */
  failures: string[];
  /** Names of graders that were skipped (not applicable to this contract). */
  skipped: HardGraderName[];
}

// ---------------------------------------------------------------------------
// Reference Program (Issue #95 §3) — proves fixture reachability and harness
// observability. It is NOT the oracle; the oracle is HardGraderContract.
// ---------------------------------------------------------------------------

export interface ReferenceProgram {
  /** Stable identifier for the reference program. */
  id: string;
  /** Prompt that the reference program sends through the public seam to
   * prove the fixture is reachable and the harness can observe a
   * successful trajectory. */
  prompt: string;
  /** Viewer scope the reference uses; must match the HardGraderContract
   * viewer to ensure the reference proves the same observable surface. */
  viewer: ViewerScope;
  /** Optional expected milestones the reference trajectory should include.
   * Used only for sanity checks; the oracle's milestoneDag is independent. */
  expectedMilestoneSubset?: string[];
  /** Optional public confirmation/rejection used only to prove that the
   * human-action seam can reach and expose the declared state. */
  humanAction?: {
    action: "confirm" | "reject";
    proposalType: "clarify" | "plan" | "breakdown" | "replan";
    actorUserId: string;
    reason?: string;
  };
}

export interface ReferenceProgramResult {
  /** True if the reference produced a passing hard grade. Reference paths
   * must produce zero false hard failures. */
  passed: boolean;
  /** The observation captured from the reference's public-seam invocation. */
  observation: ScenarioObservation;
  /** The primary evidence snapshot collected for the reference run. */
  snapshot: EvidenceSnapshot;
  /** Hard grade applied to the reference. */
  hardGrade: HardGrade;
}
