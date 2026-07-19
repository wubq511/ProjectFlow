/**
 * T46-4 (Issue #97 §2) — Earliest divergence localizer.
 *
 * The earliest divergence narrows the search for a root cause but NEVER
 * automatically becomes a root cause. It is a HYPOTHESIS, not a confirmed
 * cause.
 *
 * Boundary invariants (enforced and tested):
 *  - The localizer returns a record with `isHypothesis: true`. It CANNOT
 *    set `causalStatus` on a diagnosis. The diagnosis runner is the only
 *    path that can promote a status, and only via the
 *    `assertValidStatusTransition` gate.
 *  - The localizer does not produce a fix packet. Fix packets require
 *    direct component evidence, intervention support, or a known injected
 *    cause (Issue #97 §8).
 *  - When multiple factors cannot be separated, the diagnosis MUST remain
 *    `localized_hypothesis` or `unresolved`. The localizer reports all
 *    candidate modules without ranking them as the single root cause.
 *  - Each status promotion MUST record the corresponding evidence. The
 *    localizer records the divergence as evidence of kind
 *    `earliest_divergence`; the diagnosis runner attaches it to a
 *    hypothesis.
 */

import { createHash } from "node:crypto";
import type {
  DiagnosisCausalStatus,
  EarliestDivergenceRecord,
  EvidenceRecord,
} from "./diagnosis-contract.js";

// ---------------------------------------------------------------------------
// §1 Input — observed trajectory vs expected milestone DAG
// ---------------------------------------------------------------------------

export interface TrajectoryEvent {
  /** Sequence number from `AgentRunEvent.event_seq`. */
  seq: number;
  /** Event type (e.g., `agent.completed`, `tool.completed`,
   *  `proposal_confirmation.confirmed`). */
  eventType: string;
  /** Tool name carried by the event (when applicable). */
  toolName?: string;
  /** ISO timestamp. */
  createdAt: string;
}

export interface ExpectedMilestone {
  /** Stable milestone ID. */
  id: string;
  /** Match kind. */
  kind: "event" | "tool";
  /** Value to match against `eventType` (for `event`) or `toolName`
   *  (for `tool`). */
  value: string;
  /** Minimum expected sequence (inclusive). Defaults to 0. */
  minSeq?: number;
  /** Maximum expected sequence (inclusive). Defaults to +∞. */
  maxSeq?: number;
}

export interface EarliestDivergenceInput {
  /** Observed trajectory events, sorted by `seq` ascending. */
  trajectory: TrajectoryEvent[];
  /** Expected milestones (from the scenario contract's milestoneDag). */
  expectedMilestones: ExpectedMilestone[];
  /** Scenario ID (for evidence record referencing). */
  scenarioId: string;
  /** Observation ID (for evidence record referencing). */
  observationId: string;
}

// ---------------------------------------------------------------------------
// §2 Output — divergence record + supporting evidence
// ---------------------------------------------------------------------------

export interface EarliestDivergenceResult {
  /** The divergence record. Null when no divergence was found (i.e.,
   *  the trajectory matches the expected milestones in order). */
  divergence: EarliestDivergenceRecord | null;
  /** Evidence record referencing the divergence. Null when no divergence. */
  evidence: EvidenceRecord | null;
  /** Candidate modules that could explain the divergence. Empty when
   *  no divergence was found. */
  candidateRange: string[];
  /** Explicit warning that the divergence is a HYPOTHESIS. Always true
   *  when `divergence` is non-null. */
  isHypothesis: boolean;
}

// ---------------------------------------------------------------------------
// §3 Localizer — pure function, deterministic
// ---------------------------------------------------------------------------

/** Find the earliest divergence between the observed trajectory and the
 *  expected milestones.
 *
 *  The localizer walks the expected milestones in declared order and
 *  checks that each one appears in the trajectory at or after the
 *  previous milestone's sequence. The FIRST milestone that fails this
 *  check is the earliest divergence.
 *
 *  When a divergence is found, the localizer:
 *   - Records the expected vs actual milestone at that sequence.
 *   - Lists candidate modules that could explain the divergence.
 *   - Marks the result as a HYPOTHESIS (never a confirmed cause).
 *   - Does NOT promote any diagnosis status.
 */
export function findEarliestDivergence(
  input: EarliestDivergenceInput,
): EarliestDivergenceResult {
  if (input.trajectory.length === 0 && input.expectedMilestones.length === 0) {
    return { divergence: null, evidence: null, candidateRange: [], isHypothesis: false };
  }
  // Sort trajectory by seq (defensive; the caller should already sort).
  const trajectory = [...input.trajectory].sort((a, b) => a.seq - b.seq);
  let cursorSeq = 0;
  for (let index = 0; index < input.expectedMilestones.length; index += 1) {
    const milestone = input.expectedMilestones[index]!;
    const minSeq = Math.max(cursorSeq, milestone.minSeq ?? 0);
    const maxSeq = milestone.maxSeq ?? Number.POSITIVE_INFINITY;
    const found = trajectory.find((event) => {
      if (event.seq < minSeq || event.seq > maxSeq) return false;
      return milestone.kind === "event"
        ? event.eventType === milestone.value
        : event.toolName === milestone.value;
    });
    if (!found) {
      // Divergence: expected milestone missing at this position.
      const actual = trajectory.find((event) => event.seq >= minSeq && event.seq <= maxSeq);
      const candidateRange = candidateModulesForDivergence(milestone, actual ?? null);
      const divergence: EarliestDivergenceRecord = {
        divergenceId: `div-${input.scenarioId}-${index}`,
        observedAtSeq: minSeq,
        expectedMilestone: `${milestone.kind}:${milestone.value}`,
        actualMilestone: actual
          ? `${actual.eventType}${actual.toolName ? `/${actual.toolName}` : ""}`
          : "<missing>",
        candidateRange,
        note: `期望里程碑 ${milestone.value} 在 seq=${minSeq} 未观察到；这是缩小搜索范围的假设，不是确认根因`,
        isHypothesis: true,
      };
      const evidence: EvidenceRecord = {
        evidenceId: `evid-div-${input.scenarioId}-${index}`,
        kind: "earliest_divergence",
        summary: `最早偏离点：期望 ${milestone.value}（seq=${minSeq}），实际 ${divergence.actualMilestone}`,
        reference: `observations/${input.observationId}.json`,
        facts: {
          expected_milestone: milestone.value,
          expected_kind: milestone.kind,
          actual_milestone: divergence.actualMilestone,
          observed_at_seq: minSeq,
          is_hypothesis: true,
        },
      };
      return {
        divergence,
        evidence,
        candidateRange,
        isHypothesis: true,
      };
    }
    cursorSeq = found.seq + 1;
  }
  return { divergence: null, evidence: null, candidateRange: [], isHypothesis: false };
}

// ---------------------------------------------------------------------------
// §4 Candidate module lookup
// ---------------------------------------------------------------------------

/** Map a missing milestone to candidate modules that could explain its
 *  absence. This is a deterministic, evaluator-owned lookup table — it
 *  does NOT call the SUT, does NOT edit code, and does NOT promote any
 *  diagnosis status.
 *
 *  The candidate list is intentionally broad: the localizer's job is to
 *  NARROW the search, not to pinpoint the root cause. Promotion requires
 *  counterfactual or fault-profile evidence (Issue #97 §4, §5). */
function candidateModulesForDivergence(
  expected: ExpectedMilestone,
  actual: TrajectoryEvent | null,
): string[] {
  const candidates: string[] = [];
  // Always include the runtime routing layer as a candidate.
  candidates.push("model-router.ts");
  candidates.push("context-builder.ts");
  // If the expected milestone was a tool call, the tool registry or
  // projectflow-tools could be responsible.
  if (expected.kind === "tool") {
    candidates.push("tools/registry.ts");
    candidates.push("tools/projectflow-tools.ts");
    candidates.push("tools/fastapi-client.ts");
  }
  // If the expected milestone was an event, the event-mapper or runtime
  // loop could be responsible.
  if (expected.kind === "event") {
    candidates.push("events/event-mapper.ts");
    candidates.push("runtime/pi-runtime.ts");
    if (expected.value.startsWith("proposal_confirmation")) {
      candidates.push("backend proposal-confirm service");
    }
    if (expected.value === "agent.completed" || expected.value === "agent.failed") {
      candidates.push("events/event-mapper.ts:stopReason mapping");
    }
  }
  // If an actual event was observed instead of the expected one, the
  // skill selector or policy engine could be responsible.
  if (actual && actual.eventType !== expected.value) {
    candidates.push("skills/skill-selector.ts");
    candidates.push("policy/policy-engine.ts");
  }
  // Deduplicate while preserving order.
  return [...new Set(candidates)];
}

// ---------------------------------------------------------------------------
// §5 Hypothesis promotion guard
// ---------------------------------------------------------------------------

/** Assert that an earliest divergence record is NOT used to auto-promote
 *  a diagnosis status. This is the explicit guard against the A-06
 *  attack from the pre-implementation adversarial review.
 *
 *  Allowed: observed_failure → localized_hypothesis (the divergence
 *  narrows the search).
 *  Forbidden: localized_hypothesis → intervention_supported (requires a
 *  single-variable counterfactual, not a divergence).
 *  Forbidden: localized_hypothesis → fault_injection_confirmed (requires
 *  an evaluator-owned fault profile, not a divergence).
 */
export function assertDivergenceDoesNotAutoPromote(
  from: DiagnosisCausalStatus,
  to: DiagnosisCausalStatus,
): void {
  if (from === "observed_failure" && to === "localized_hypothesis") {
    return; // allowed
  }
  if (to === "localized_hypothesis" && from === "observed_failure") {
    return; // allowed (defensive duplicate check)
  }
  throw new Error(
    `earliest divergence 不能自动升级诊断状态: ${from} → ${to}；升级需要 counterfactual 或 fault profile 证据`,
  );
}

/** Return true when a divergence record should keep the diagnosis at
 *  `localized_hypothesis` (i.e., the divergence is the strongest
 *  evidence available, no counterfactual or fault profile was used). */
export function divergenceImpliesLocalizedHypothesisOnly(
  divergence: EarliestDivergenceRecord,
  hasCounterfactualEvidence: boolean,
  hasFaultProfileEvidence: boolean,
): boolean {
  if (hasCounterfactualEvidence || hasFaultProfileEvidence) return false;
  return divergence.isHypothesis === true;
}

// ---------------------------------------------------------------------------
// §4 Hypothesis narrowing helper
// ---------------------------------------------------------------------------

/** Narrow a candidate-range list to the modules that plausibly contain
 *  the divergence cause. This is a deterministic filter: it keeps only
 *  candidates whose names intersect with the expected milestone's
 *  namespace.
 *
 *  Narrowing does NOT promote — it only reduces the candidate set. The
 *  output is still a `localized_hypothesis`, not an
 *  `intervention_supported` or `fault_injection_confirmed` cause. */
export function narrowCandidateRange(
  candidates: string[],
  expectedMilestone: string,
): string[] {
  if (candidates.length === 0) return [];
  // Extract namespace tokens from the expected milestone (e.g.,
  // `context.receipt.memory_ids_used` → {"context", "receipt", "memory"}).
  const tokens = new Set(
    expectedMilestone
      .toLowerCase()
      .split(/[.\s_/-]+/)
      .filter((t) => t.length >= 3 && !["the", "and", "for", "with"].includes(t)),
  );
  if (tokens.size === 0) return [...candidates];
  return candidates.filter((c) => {
    const lower = c.toLowerCase();
    for (const token of tokens) {
      if (lower.includes(token)) return true;
    }
    return false;
  });
}

/** Build a stable divergence ID from the observation and sequence. */
export function stableDivergenceId(
  observationId: string,
  observedAtSeq: number,
): string {
  const hash = createHash("sha256")
    .update(`${observationId}|${observedAtSeq}`)
    .digest("hex")
    .slice(0, 16);
  return `div-${hash}`;
}