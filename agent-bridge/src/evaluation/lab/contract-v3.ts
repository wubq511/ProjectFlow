/**
 * T46-3 (Issue #96) — V3 evaluation contracts.
 *
 * Additive extension over Slice 0 (`contract.ts`) and Slice 1
 * (`contract-v2.ts`). The artifact `schemaVersion` stays at 1 and the hard
 * grader block `version` stays at 1; all V3 fields are OPTIONAL so existing
 * artifacts continue to validate. New modules own their own contract types
 * in this file so the Slice 0/1 surface remains stable for downstream
 * consumers and resume compatibility.
 *
 * Issue #96 acceptance criteria covered here:
 *  - deterministic multi-turn user controller (hidden facts/goals/refusals/
 *    allowed actions/conversation state/expected transitions)
 *  - simulator_error classification + frozen retry budget
 *  - attempt ledger (infrastructure_attempt vs agent_retry)
 *  - Skill evaluation (8 dimensions)
 *  - runtime reliability scenarios (11 fault classes)
 *  - reliability statistics (6 metrics + insufficient_evidence)
 *  - operational metrics per scenario and aggregate
 *  - candidate/baseline paired comparison isolation + alignment
 *  - Slice 1 exit gate (fail-closed, machine-readable)
 *
 * Boundary invariants (must hold across all V3 modules):
 *  - The user controller's hidden facts are evaluator-only. They MUST NOT
 *    appear in: SUT request body, evidence snapshot, observation, grade,
 *    report, manifest, portable artifact, or checksum manifest. The
 *    manifest stores only SHA-256 commitments (see {@link HiddenFactsDigests}).
 *  - simulator_error episodes are excluded from the Agent pass-rate
 *    denominator; they cannot be rewritten as Agent failures.
 *  - Attempt ledger is append-only. Each entry has a stable ID. The ledger
 *    cannot delete or overwrite a previous failure entry; recoveries are
 *    linked by `recoveredBy` pointers but the original entry remains.
 *  - Paired comparison sides MUST NOT share process, database, temp root,
 *    ports, nonce, instance identity, or artifact staging.
 *  - `model_drift_possible` MUST be set to true when resolved model
 *    identity cannot be confirmed; requested model is NEVER silently
 *    promoted to resolved model.
 *  - All reliability metrics carry explicit numerator/denominator/excluded/
 *    assumptions/sample_size so reports cannot confuse pass@k with pass^k
 *    or single-trial pass rate.
 *  - Slice 1 exit gate is fail-closed and does not depend on a semantic
 *    Judge. If any required condition is unverified, the gate fails.
 */

import type { ScenarioObservation, CostLedgerEntry } from "./contract.js";
import type { EvidenceSnapshot, HardGrade } from "./contract-v2.js";

/** V3 contract schema version. Bump when field semantics change. */
export const V3_CONTRACT_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// §1 Deterministic multi-turn user controller
// ---------------------------------------------------------------------------

/**
 * Stable, normalized facts the controller owns and protects. The optional
 * LLM phrasing function receives ONLY the public surface (the next user
 * message template and the controller's chosen action); it cannot read
 * hidden facts and cannot modify them.
 *
 * Hidden facts are evaluator-only. They are never serialized into the SUT
 * request body, evidence snapshot, observation, grade, report, manifest or
 * portable artifact.
 */
export interface HiddenControllerFacts {
  /** Stable identifier for the controller spec (used in artifacts). */
  id: string;
  /** Hidden facts the Agent is expected to discover or honor. Each value
   * is a stable string; the controller compares Agent output against these
   * tokens using exact match or a deterministic regex. */
  hiddenFacts: string[];
  /** User goals the controller is trying to achieve. Used to detect
   * goal drift (Agent steering the conversation away from the goal). */
  userGoals: string[];
  /** Topics the controller must refuse to engage with (e.g., asking for
   * raw database access). If the Agent requests a forbidden action, the
   * controller emits a refusal, not a leak. */
  refusals: string[];
  /** Actions the controller is allowed to take (e.g., confirm_plan,
   *    reject_replan). Anything outside this set triggers simulator_error. */
  allowedActions: string[];
  /** Expected conversation state transitions. Each transition declares the
   * required prior state, the trigger Agent behavior, and the resulting
   * state. Out-of-order or unexpected transitions are flagged. */
  expectedTransitions: ControllerTransition[];
  /** Sentinel tokens injected into hidden facts; used by hidden-field
   * leakage graders. Stored as digests in the artifact (see
   * {@link HiddenFactsDigests}). */
  hiddenSentinels?: string[];
}

export interface ControllerTransition {
  /** Stable identifier within the controller spec. */
  id: string;
  /** Required prior state. Empty string means "initial state". */
  fromState: string;
  /** State entered after this transition. */
  toState: string;
  /** Trigger that fires this transition. The controller picks the next
   * transition by matching AgentOutput against this trigger using a
   * deterministic predicate. */
  trigger: ControllerTrigger;
  /** Whether reaching this transition is required for the episode to
   * count as a successful goal completion. */
  required?: boolean;
}

export interface ControllerTrigger {
  /** Match strategy used by the deterministic predicate. */
  kind: "exact_phrase" | "regex" | "tool_call" | "proposal_status";
  /** Pattern string. For `exact_phrase`, the Agent output must contain
   * the phrase verbatim. For `regex`, the pattern is compiled with flags
   * "i". For `tool_call`, the value is a tool name. For
   * `proposal_status`, the value is `proposalType:status`. */
  value: string;
}

/**
 * Visible (non-hidden) controller state. The controller exposes this to
 * the optional LLM phrasing function so it can render a natural user
 * message. The phrasing function cannot mutate this state — it only
 * receives a snapshot and returns a string.
 */
export interface ControllerVisibleState {
  /** Current state name (matches a transition's toState). */
  currentState: string;
  /** Number of turns elapsed. */
  turn: number;
  /** The next action the controller has deterministically chosen. */
  nextAction: ControllerAction;
  /** Maximum remaining turns before the controller terminates. */
  remainingTurns: number;
}

export type ControllerAction =
  | { kind: "send_message"; template: string }
  | { kind: "confirm_proposal"; proposalType: string; reason?: string }
  | { kind: "reject_proposal"; proposalType: string; reason: string }
  | { kind: "end_conversation"; reason: string };

/** Result returned by the controller after each Agent turn. */
export interface ControllerTurnResult {
  /** The user message to send to the Agent on the next turn. Empty when
   * the controller has chosen a non-message action. */
  userMessage: string;
  /** The action the controller took. Drives the public-seam human action
   * seam when applicable. */
  action: ControllerAction;
  /** True when the episode has reached a terminal state (goal complete,
   * controller exhausted turns, or simulator_error). */
  terminal: boolean;
  /** Outcome classification for the episode (set on terminal turns). */
  outcome?: EpisodeOutcome;
  /** Simulator error classification when the episode must be excluded. */
  simulatorError?: SimulatorErrorType;
  /** Updated visible state for the next turn. */
  nextState: ControllerVisibleState;
  /** Digests of hidden sentinels checked against the Agent output this
   * turn. Raw tokens are never returned. */
  hiddenSentinelDigests?: string[];
  /** ISO 8601 timestamp recorded by the controller when this turn was
   *  produced. Uses the controller's injected clock so tests can make
   *  timestamps deterministic. Audit-only; does not affect grading. */
  turnTimestamp?: string;
}

export type EpisodeOutcome =
  | "goal_completed"
  | "goal_abandoned"
  | "max_turns_reached"
  | "user_refused"
  | "simulator_error";

// ---------------------------------------------------------------------------
// §2 Simulator integrity
// ---------------------------------------------------------------------------

/**
 * Classifier for invalid or leaking simulator episodes. Such episodes are
 * marked `simulator_error`, excluded from the Agent score denominator, and
 * retried only within the frozen {@link SIMULATOR_RETRY_BUDGET}.
 */
export type SimulatorErrorType =
  | "invalid_turn" // controller produced an invalid action
  | "out_of_scope" // Agent asked for something outside allowed_actions
  | "hidden_fact_leak" // Agent output contains a hidden sentinel
  | "goal_drift" // Agent steered conversation away from declared goal
  | "forbidden_action" // controller would have to take a forbidden action
  | "controller_state_corrupted" // state machine entered an unknown state
  | "phrasing_function_violation"; // LLM phrasing tried to mutate facts

/** Frozen retry budget for simulator_error episodes. Cannot be raised at
 * runtime. */
export const SIMULATOR_RETRY_BUDGET = 2 as const;

export interface SimulatorErrorRecord {
  /** Stable record ID (ledger entry). */
  recordId: string;
  /** Scenario ID the error occurred in. */
  scenarioId: string;
  /** Run ID the error occurred in (if applicable). */
  runId?: string;
  /** Error classification. */
  type: SimulatorErrorType;
  /** Turn number when the error was detected (for multi-turn episodes). */
  turn?: number;
  /** Human-readable explanation (Chinese). */
  message: string;
  /** ISO timestamp when the error was recorded. */
  recordedAt: string;
  /** Whether the episode was retried within the frozen budget. */
  retried: boolean;
  /** ID of the retry attempt, if any. */
  retryOfRecordId?: string;
}

// ---------------------------------------------------------------------------
// §3 Attempt and retry evidence model
// ---------------------------------------------------------------------------

export type AttemptType =
  | "infrastructure_attempt" // backend/sidecar spawn, network, sandbox
  | "agent_retry"; // Agent-internal retry (tool error recovery, etc.)

export type AttemptResult =
  | "succeeded"
  | "failed_agent"
  | "failed_infrastructure"
  | "failed_budget"
  | "cancelled"
  | "simulator_error";

export interface AttemptLedgerEntry {
  /** Stable attempt ID. Format: `${scenarioId}-${type}-${seq}`. */
  attemptId: string;
  /** Scenario ID this attempt belongs to. */
  scenarioId: string;
  /** Run ID this attempt belongs to. */
  runId?: string;
  /** Attempt type. */
  type: AttemptType;
  /** ISO timestamp when the attempt started. */
  startedAt: string;
  /** ISO timestamp when the attempt ended. */
  endedAt: string;
  /** Outcome of the attempt. */
  result: AttemptResult;
  /** Error category when the attempt failed. Free-form short string
   * drawn from a stable allowlist (e.g., "timeout", "connection_reset",
   * "invalid_tool_args", "partial_tool_result", "duplicate_terminal_event"). */
  errorCategory?: string;
  /** Human-readable error message (Chinese). */
  errorMessage?: string;
  /** When this attempt is a retry of a previous attempt, the previous
   * attempt's ID. The previous entry remains in the ledger; nothing is
   * overwritten. */
  retryOf?: string;
  /** When a later attempt recovers from this one, that attempt's ID.
   * This pointer is set when the recovery entry is appended; the
   * original failure entry is NOT modified otherwise. */
  recoveredBy?: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Token usage when known. */
  inputTokens?: number;
  outputTokens?: number;
  /** SUT cost in USD when known. */
  sutCostUsd?: number;
}

export interface AttemptLedger {
  /** All entries, in append order. Never mutated, never reordered. */
  entries: AttemptLedgerEntry[];
  /** Total attempts recorded. */
  total: number;
  /** Count by type. */
  byType: Record<AttemptType, number>;
  /** Count by result. */
  byResult: Record<AttemptResult, number>;
}

// ---------------------------------------------------------------------------
// §4 Skill evaluation
// ---------------------------------------------------------------------------

export type SkillEvalDimension =
  | "positive_trigger" // scenario should trigger this skill
  | "negative_trigger" // scenario should NOT trigger this skill
  | "prerequisites" // skill prerequisites must be satisfied
  | "allowed_tools" // skill must only use tools in its allowlist
  | "required_steps" // skill must perform its required steps (milestone DAG)
  | "forbidden_actions" // skill must NOT take forbidden actions
  | "fallback_behavior" // skill must produce a fallback on missing evidence
  | "output_usability"; // skill output must be usable (non-empty, valid schema)

export type SkillEvalResult = "pass" | "fail" | "skipped";

export interface SkillEvalDimensionResult {
  dimension: SkillEvalDimension;
  result: SkillEvalResult;
  /** Human-readable reason (Chinese). Required when result is "fail". */
  reason?: string;
  /** Evidence supporting the result (tool names, milestones, etc.). */
  evidence?: string[];
}

export interface SkillEvaluationContract {
  /** Stable contract ID (used in artifact). */
  id: string;
  /** Skill name being evaluated. Must match a registered Skill V2 name. */
  skillName: string;
  /** Scenario prompt that should trigger the skill (positive trigger). */
  positiveTriggerPrompt: string;
  /** Scenario prompts that should NOT trigger the skill. */
  negativeTriggerPrompts: string[];
  /** Required prerequisites (must be satisfied by the fixture state). */
  prerequisites: string[];
  /** Tools allowed for this skill (from Skill V2 metadata). */
  allowedTools: string[];
  /** Required trajectory milestones (tool calls or events). */
  requiredSteps: Array<{ kind: "event" | "tool"; value: string }>;
  /** Tools/actions the skill must NOT invoke. */
  forbiddenActions: string[];
  /** Whether fallback behavior is expected (e.g., when evidence is
   * missing, the skill should produce a structured fallback, not a
   * silent success). */
  expectsFallback?: boolean;
  /** Effect ceiling the skill must respect (from Skill V2 metadata). */
  effectCeiling?: "none" | "advisory_only" | "proposal_only" | "full";
}

export interface SkillEvaluationResult {
  contractId: string;
  skillName: string;
  /** True only if all non-skipped dimensions pass. */
  passed: boolean;
  /** Per-dimension results. */
  dimensions: SkillEvalDimensionResult[];
  /** The skills selected by the Agent for the positive trigger prompt. */
  selectedSkillsForPositive: string[];
  /** The skills selected by the Agent for each negative trigger prompt.
   *  Outer array aligns with `negativeObservations`; inner array is the
   *  per-observation selectedSkills list. */
  selectedSkillsForNegatives: string[][];
  /** Hard grade (if a hardGrader block was attached). */
  hardGrade?: HardGrade;
  /** Whether the skill violated its effect ceiling. */
  effectCeilingViolated: boolean;
  /** Aggregate failure reasons (Chinese). */
  failures: string[];
}

// ---------------------------------------------------------------------------
// §5 Runtime reliability scenarios
// ---------------------------------------------------------------------------

export type RuntimeFaultClass =
  | "timeout"
  | "infrastructure_retry"
  | "agent_internal_retry"
  | "invalid_tool_arguments"
  | "partial_tool_results"
  | "cancellation"
  | "checkpoint_resume"
  | "steering"
  | "idempotency"
  | "duplicate_terminal_event"
  | "contradictory_terminal_event";

export interface RuntimeFaultInjection {
  /** Stable fault ID (used in artifact). */
  faultId: string;
  /** Fault class. */
  faultClass: RuntimeFaultClass;
  /** Human-readable description (Chinese). */
  description: string;
  /** Deterministic injection seam. The runner reads this to decide how
   * to inject the fault (e.g., delay the response, return a partial
   * result, emit a duplicate terminal event). */
  seam: FaultInjectionSeam;
  /** Expected Agent behavior under this fault. */
  expectation: FaultExpectation;
}

export type FaultInjectionSeam =
  | { kind: "sse_event_delay"; eventPattern: string; delayMs: number }
  | { kind: "sse_event_drop"; eventPattern: string }
  | { kind: "sse_duplicate_terminal"; terminalEvent: string }
  | { kind: "sse_contradictory_terminal"; first: string; second: string }
  | { kind: "tool_call_invalid_args"; toolName: string }
  | { kind: "tool_call_partial_result"; toolName: string }
  | { kind: "cancel_signal"; afterMs: number }
  | { kind: "checkpoint_after_event"; eventPattern: string }
  | { kind: "steering_message"; afterMs: number; message: string }
  | { kind: "force_idempotency_repeat"; repeats: number };

export interface FaultExpectation {
  /** Expected final run status. */
  finalStatus: "completed" | "failed";
  /** Whether the Agent must NOT produce side effects under this fault. */
  requiresNoSideEffects?: boolean;
  /** Whether the Agent must preserve idempotency under this fault. */
  requiresIdempotency?: boolean;
  /** Whether the Agent must NOT emit a duplicate terminal event. */
  requiresDuplicateTerminalDetection?: boolean;
  /** Whether the Agent must NOT emit contradictory terminal events. */
  requiresContradictoryTerminalDetection?: boolean;
  /** Whether the Agent must recover via an internal retry. */
  requiresAgentRetry?: boolean;
  /** Whether the Agent must rely on infrastructure retry. */
  requiresInfrastructureRetry?: boolean;
}

// ---------------------------------------------------------------------------
// §6 Reliability statistics and reporting
// ---------------------------------------------------------------------------

export type ReliabilityMetricKind =
  | "observed_trial_pass_rate"
  | "empirical_all_k_reliability"
  | "pass_at_k"
  | "modeled_pass_k"
  | "all_invariant_pass"
  | "confidence_interval";

export interface ReliabilityMetric {
  kind: ReliabilityMetricKind;
  /** Computed value (0..1). null when insufficient evidence. */
  value: number | null;
  /** Numerator used to compute the value. */
  numerator: number;
  /** Denominator used to compute the value. */
  denominator: number;
  /** Number of trials excluded from this metric (simulator_error,
   *  infrastructure_error, skipped). */
  excluded: number;
  /** Assumptions underlying the metric (e.g., "i.i.d. trials",
   *  "pass probability p is constant"). */
  assumptions: string[];
  /** Sample size used. */
  sampleSize: number;
  /** Whether the metric has sufficient evidence to be reported. */
  sufficientEvidence: boolean;
  /** For confidence_interval: lower bound (0..1). */
  lowerBound?: number;
  /** For confidence_interval: upper bound (0..1). */
  upperBound?: number;
  /** For confidence_interval: confidence level (e.g., 0.95). */
  confidenceLevel?: number;
  /** For pass_at_k / modeled_pass_k: the k value. */
  k?: number;
}

export interface ReliabilityReport {
  /** All metrics, in declared order. */
  metrics: ReliabilityMetric[];
  /** True when sample size is too small to claim any statistical
   *  significance. demo/smoke presets must set this to true. */
  insufficientEvidence: boolean;
  /** True when the report is allowed to claim statistical significance
   *  (only the `full` preset with sufficient trials). */
  statisticalSignificanceClaimAllowed: boolean;
  /** Number of trials observed. */
  totalTrials: number;
  /** Number of trials excluded from the Agent score denominator. */
  excludedTrials: number;
  /** Per-scenario reliability metrics. */
  perScenario: Array<{ scenarioId: string; metrics: ReliabilityMetric[] }>;
}

// ---------------------------------------------------------------------------
// §7 Operational metrics
// ---------------------------------------------------------------------------

export interface OperationalMetrics {
  scenarioId?: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** ProjectFlow Agent / SUT cost in USD. Always separate from
   *  external Coding Agent cost. */
  sutCostUsd: number;
  /** Optional evaluator-model (Judge/Simulator) cost. Always separate
   *  from SUT cost. */
  evaluatorModelCostUsd?: number;
  /** External Coding Agent cost in USD (null when unknown). NEVER
   *  counted against the SUT cap. */
  codingAgentCostUsd: number | null;
  toolCalls: number;
  agentRetries: number;
  infrastructureAttempts: number;
  timeouts: number;
  skipped: number;
  excluded: number;
  simulatorErrors: number;
  infrastructureErrors: number;
}

export interface OperationalMetricsAggregate {
  perScenario: OperationalMetrics[];
  aggregate: OperationalMetrics;
  /** True when any paid SUT model was attempted without a frozen price
   *  table — must fail-closed and not silently run. */
  paidModelWithoutPriceTable: boolean;
}

// ---------------------------------------------------------------------------
// §8 Candidate/baseline paired comparison
// ---------------------------------------------------------------------------

export interface PairedComparisonSide {
  /** Side label. */
  label: "candidate" | "baseline";
  /** Absolute path to the isolated git worktree. */
  worktreePath: string;
  /** Backend port (isolated). */
  backendPort: number;
  /** Sidecar port (isolated). */
  sidecarPort: number;
  /** SHA-256 commitment of the evaluator-owned nonce. Raw credentials are
   * never portable artifact data. */
  nonceSha256: string;
  /** SHA-256 commitment of the evaluator-owned instance identity. */
  instanceIdSha256: string;
  /** Isolated SQLite database path. */
  databasePath: string;
  /** Isolated temp root. */
  tempRoot: string;
  /** Isolated artifact staging directory. */
  artifactStagingDir: string;
  /** Resolved model identity (provider:name reported by the sidecar
   *  after start). NEVER assumed from the requested model. */
  resolvedModel: ResolvedModelIdentity | null;
  /** Git commit at the worktree HEAD. */
  gitCommit: string;
  /** Worktree SHA-256 fingerprint (dirty state captured). */
  worktreeSha256: string;
}

export interface ResolvedModelIdentity {
  provider: string;
  name: string;
  /** How the identity was confirmed (e.g., "sidecar_health",
   *  "model_config_store"). */
  confirmedBy: string;
}

export interface PairedComparisonManifest {
  /** Stable manifest ID. */
  id: string;
  candidate: PairedComparisonSide;
  baseline: PairedComparisonSide;
  /** Aligned scenario manifest SHA-256 (both sides must match). */
  scenarioManifestSha256: string;
  /** Aligned seed manifest SHA-256 (both sides must match). */
  seedManifestSha256: string;
  /** Aligned frozen standards version (both sides must match). */
  frozenStandardsVersion: string;
  /** Aligned evaluator version (both sides must match). */
  evaluatorVersion: string;
  /** True when either side could not confirm resolved model identity.
   *  When true, the report MUST set `model_drift_possible: true` and
   *  cannot claim the two sides ran the same model. */
  modelDriftPossible: boolean;
  /** ISO timestamp when the manifest was generated. */
  generatedAt: string;
}

export interface PairedComparisonResult {
  manifest: PairedComparisonManifest;
  /** Per-scenario pass/fail on each side. */
  perScenario: Array<{
    scenarioId: string;
    candidatePassed: boolean;
    baselinePassed: boolean;
    delta: number; // candidate - baseline pass counts
  }>;
  /** Aggregate pass rate on each side. */
  candidatePassRate: number;
  baselinePassRate: number;
  /** True when candidate pass rate exceeds baseline by a non-trivial
   *  margin. False when insufficient evidence. */
  candidateWins: boolean;
  /** True when sample size is too small to claim a difference. */
  insufficientEvidence: boolean;
  /** Operational metrics per side. */
  candidateMetrics: OperationalMetrics;
  baselineMetrics: OperationalMetrics;
}

// ---------------------------------------------------------------------------
// §9 Slice 1 exit gate
// ---------------------------------------------------------------------------

export interface Slice1ExitGateReport {
  /** Stable report ID. */
  reportId: string;
  /** ISO timestamp when the gate was evaluated. */
  evaluatedAt: string;
  /** True only when ALL required conditions pass. */
  passed: boolean;
  /** Per-condition results. */
  conditions: Slice1ExitGateCondition[];
  /** Fail-closed reason when the gate did not pass (Chinese). */
  failureReason?: string;
}

export interface Slice1ExitGateCondition {
  /** Stable condition ID. */
  conditionId: Slice1ExitGateConditionId;
  /** Human-readable description (Chinese). */
  description: string;
  /** Whether the condition was satisfied. */
  passed: boolean;
  /** Evidence supporting the result (counts, hashes, etc.). */
  evidence: string[];
  /** Human-readable reason when the condition failed (Chinese). */
  failureReason?: string;
}

export type Slice1ExitGateConditionId =
  | "p0_mutations_detected"
  | "reference_zero_hard_false_failures"
  | "hidden_field_leakage_tests_pass"
  | "required_scenarios_not_skipped_or_excluded"
  | "evidence_graph_and_checksums_complete"
  | "no_semantic_judge_required";

// ---------------------------------------------------------------------------
// §10 Portable artifact surface for V3
// ---------------------------------------------------------------------------

/**
 * Digests of hidden controller facts. Stored in portable artifacts so
 * resume integrity remains verifiable without disclosing the raw facts.
 * Mirrors the Slice 1 `hiddenFieldTokenDigests` pattern.
 */
export interface HiddenFactsDigests {
  /** SHA-256 of each hidden fact, sorted. */
  hiddenFactsDigests: string[];
  /** SHA-256 of each user goal, sorted. */
  userGoalsDigests: string[];
  /** SHA-256 of each refusal, sorted. */
  refusalsDigests: string[];
  /** SHA-256 of each allowed action, sorted. */
  allowedActionsDigests: string[];
  /** SHA-256 of each hidden sentinel, sorted. */
  hiddenSentinelDigests: string[];
}

/** V3 evaluation artifact block. Stored as an additive extension to the
 *  Slice 0 `EvaluationArtifact`. All fields optional for backward
 *  compatibility. */
export interface EvaluationArtifactV3 {
  v3Version: typeof V3_CONTRACT_VERSION;
  /** Multi-turn episode observations, when the run exercised the
   *  deterministic user controller. */
  multiTurnEpisodes?: MultiTurnEpisodeRecord[];
  /** Attempt ledger for this run. */
  attemptLedger?: AttemptLedger;
  /** Skill evaluation results. */
  skillEvaluations?: SkillEvaluationResult[];
  /** Runtime reliability results. */
  runtimeReliability?: RuntimeReliabilityResult[];
  /** Reliability report. */
  reliabilityReport?: ReliabilityReport;
  /** Operational metrics aggregate. */
  operationalMetrics?: OperationalMetricsAggregate;
  /** Slice 1 exit gate report. */
  exitGateReport?: Slice1ExitGateReport;
  /** Hidden facts digests (no raw tokens). */
  hiddenFactsDigests?: HiddenFactsDigests;
  /** Per-scenario trials used by the reliability command. Exclusions are
   * explicit; consumers must not infer them from the final run status. */
  reliabilityTrials?: ReliabilityTrialRecord[];
  /** Actual evidence produced by mutation/reference/leakage acceptance
   * probes. The exit-gate command must consume this block and must never
   * substitute ordinary candidate grades as a proxy. */
  acceptanceEvidence?: Slice1AcceptanceEvidence;
}

export interface ReliabilityTrialRecord {
  scenarioId: string;
  passed: boolean;
  excluded: boolean;
  exclusionReason?: "simulator_error" | "infrastructure_error" | "skipped";
  allInvariantsPassed: boolean;
  repeatGroupId?: string;
  repeatIndex?: number;
}

export interface Slice1AcceptanceEvidence {
  p0Mutations: Array<{
    mutationId: string;
    detected: boolean;
    targets: string;
  }>;
  referencePrograms: Array<{
    programId: string;
    hardFalseFailures: number;
  }>;
  hiddenFieldLeakageTests: Array<{
    testName: string;
    passed: boolean;
  }>;
  semanticJudgeUsed: boolean;
}

export interface MultiTurnEpisodeRecord {
  scenarioId: string;
  /** Number of turns observed. */
  turns: number;
  /** Episode outcome. */
  outcome: EpisodeOutcome;
  /** Sentinel digests checked (no raw tokens). */
  hiddenSentinelDigests: string[];
  /** Whether a simulator_error was recorded for this episode. */
  hadSimulatorError: boolean;
  /** Final observation (Slice 0 schema). */
  finalObservation: ScenarioObservation;
  /** Final hard grade (if a hardGrader block was attached). */
  finalHardGrade?: HardGrade;
  /** Primary evidence snapshot at end of episode. */
  finalSnapshot?: EvidenceSnapshot;
}

export interface RuntimeReliabilityResult {
  faultId: string;
  faultClass: RuntimeFaultClass;
  passed: boolean;
  /** Operational metrics for this fault scenario. */
  metrics: OperationalMetrics;
  /** Hard grade (if a hardGrader block was attached). */
  hardGrade?: HardGrade;
  /** Failure reasons (Chinese). */
  failures: string[];
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export type { CostLedgerEntry };
