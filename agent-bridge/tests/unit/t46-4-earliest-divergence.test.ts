/**
 * T46-4 (Issue #97 §2) — Earliest divergence localizer tests.
 *
 * Verifies:
 *  1. The localizer finds the first missing milestone.
 *  2. The localizer returns no divergence when the trajectory matches.
 *  3. The localizer NEVER auto-promotes to a root cause.
 *  4. The localizer returns a candidate range (multiple modules).
 *  5. The localizer's evidence record is marked `isHypothesis: true`.
 *  6. `divergenceImpliesLocalizedHypothesisOnly` returns true only when
 *     no counterfactual or fault profile evidence exists.
 *  7. `assertDivergenceDoesNotAutoPromote` rejects attempts to promote
 *     above localized_hypothesis using divergence alone.
 *  8. `narrowCandidateRange` returns a deterministic subset.
 *  9. `stableDivergenceId` produces stable IDs.
 */

import { describe, expect, it } from "vitest";
import {
  findEarliestDivergence,
  assertDivergenceDoesNotAutoPromote,
  divergenceImpliesLocalizedHypothesisOnly,
  narrowCandidateRange,
  stableDivergenceId,
  type TrajectoryEvent,
  type ExpectedMilestone,
} from "../../src/evaluation/lab/earliest-divergence.js";

function buildTrajectory(): TrajectoryEvent[] {
  return [
    { seq: 1, eventType: "agent.started", createdAt: "2026-07-20T00:00:00Z" },
    { seq: 2, eventType: "tool.call", toolName: "get_project_state", createdAt: "2026-07-20T00:00:01Z" },
    { seq: 3, eventType: "tool.completed", toolName: "get_project_state", createdAt: "2026-07-20T00:00:02Z" },
    { seq: 4, eventType: "agent.completed", createdAt: "2026-07-20T00:00:03Z" },
  ];
}

function buildExpectedMilestones(): ExpectedMilestone[] {
  return [
    { id: "m1", kind: "event", value: "agent.started" },
    { id: "m2", kind: "tool", value: "get_project_state" },
    { id: "m3", kind: "event", value: "agent.completed" },
  ];
}

describe("T46-4 earliest divergence — basic localization", () => {
  it("returns no divergence when the trajectory matches expected milestones", () => {
    const result = findEarliestDivergence({
      trajectory: buildTrajectory(),
      expectedMilestones: buildExpectedMilestones(),
      scenarioId: "scn-1",
      observationId: "obs-1",
    });
    expect(result.divergence).toBeNull();
    expect(result.evidence).toBeNull();
    expect(result.candidateRange).toEqual([]);
    expect(result.isHypothesis).toBe(false);
  });

  it("finds the earliest missing milestone", () => {
    // Remove agent.completed — the localizer should detect its absence
    // and report the actual event observed at that position instead.
    const trajectory = buildTrajectory().filter((e) => e.eventType !== "agent.completed");
    const result = findEarliestDivergence({
      trajectory,
      expectedMilestones: buildExpectedMilestones(),
      scenarioId: "scn-1",
      observationId: "obs-1",
    });
    expect(result.divergence).not.toBeNull();
    expect(result.divergence!.expectedMilestone).toBe("event:agent.completed");
    // The actual milestone is the event observed instead (or "<missing>"
    // when no event was observed at that sequence).
    expect(result.divergence!.actualMilestone).not.toBe("event:agent.completed");
  });

  it("marks the divergence as a HYPOTHESIS, not a confirmed cause", () => {
    const trajectory = buildTrajectory().filter((e) => e.eventType !== "agent.completed");
    const result = findEarliestDivergence({
      trajectory,
      expectedMilestones: buildExpectedMilestones(),
      scenarioId: "scn-1",
      observationId: "obs-1",
    });
    expect(result.divergence!.isHypothesis).toBe(true);
    expect(result.isHypothesis).toBe(true);
  });

  it("returns a candidate range with multiple modules", () => {
    const trajectory = buildTrajectory().filter((e) => e.eventType !== "agent.completed");
    const result = findEarliestDivergence({
      trajectory,
      expectedMilestones: buildExpectedMilestones(),
      scenarioId: "scn-1",
      observationId: "obs-1",
    });
    expect(result.candidateRange.length).toBeGreaterThan(1);
  });

  it("returns an evidence record referencing the observation", () => {
    const trajectory = buildTrajectory().filter((e) => e.eventType !== "agent.completed");
    const result = findEarliestDivergence({
      trajectory,
      expectedMilestones: buildExpectedMilestones(),
      scenarioId: "scn-1",
      observationId: "obs-1",
    });
    expect(result.evidence).not.toBeNull();
    expect(result.evidence!.kind).toBe("earliest_divergence");
    expect(result.evidence!.reference).toBe("observations/obs-1.json");
    expect(result.evidence!.facts!.is_hypothesis).toBe(true);
  });
});

describe("T46-4 earliest divergence — auto-promotion guard", () => {
  it("divergenceImpliesLocalizedHypothesisOnly is true when no other evidence", () => {
    const trajectory = buildTrajectory().filter((e) => e.eventType !== "agent.completed");
    const result = findEarliestDivergence({
      trajectory,
      expectedMilestones: buildExpectedMilestones(),
      scenarioId: "scn-1",
      observationId: "obs-1",
    });
    expect(
      divergenceImpliesLocalizedHypothesisOnly(
        result.divergence!,
        /* hasCounterfactualEvidence */ false,
        /* hasFaultProfileEvidence */ false,
      ),
    ).toBe(true);
  });

  it("divergenceImpliesLocalizedHypothesisOnly is false when counterfactual evidence exists", () => {
    const trajectory = buildTrajectory().filter((e) => e.eventType !== "agent.completed");
    const result = findEarliestDivergence({
      trajectory,
      expectedMilestones: buildExpectedMilestones(),
      scenarioId: "scn-1",
      observationId: "obs-1",
    });
    expect(
      divergenceImpliesLocalizedHypothesisOnly(
        result.divergence!,
        /* hasCounterfactualEvidence */ true,
        /* hasFaultProfileEvidence */ false,
      ),
    ).toBe(false);
  });

  it("assertDivergenceDoesNotAutoPromote refuses intervention_supported", () => {
    expect(() =>
      assertDivergenceDoesNotAutoPromote("observed_failure", "intervention_supported"),
    ).toThrow();
  });

  it("assertDivergenceDoesNotAutoPromote refuses fault_injection_confirmed", () => {
    expect(() =>
      assertDivergenceDoesNotAutoPromote("observed_failure", "fault_injection_confirmed"),
    ).toThrow();
  });

  it("assertDivergenceDoesNotAutoPromote allows observed_failure → localized_hypothesis", () => {
    expect(() =>
      assertDivergenceDoesNotAutoPromote("observed_failure", "localized_hypothesis"),
    ).not.toThrow();
  });
});

describe("T46-4 earliest divergence — narrow candidate range", () => {
  it("returns a deterministic subset based on symptom tokens", () => {
    const trajectory = buildTrajectory().filter((e) => e.eventType !== "agent.completed");
    const result = findEarliestDivergence({
      trajectory,
      expectedMilestones: buildExpectedMilestones(),
      scenarioId: "scn-1",
      observationId: "obs-1",
    });
    const narrowed = narrowCandidateRange(result.candidateRange, "event agent completed");
    expect(narrowed.length).toBeGreaterThan(0);
    expect(narrowed.length).toBeLessThanOrEqual(result.candidateRange.length);
  });

  it("returns the full range when the symptom has no extractable tokens", () => {
    const trajectory = buildTrajectory().filter((e) => e.eventType !== "agent.completed");
    const result = findEarliestDivergence({
      trajectory,
      expectedMilestones: buildExpectedMilestones(),
      scenarioId: "scn-1",
      observationId: "obs-1",
    });
    // An empty symptom string yields no tokens → full range returned.
    const narrowed = narrowCandidateRange(result.candidateRange, "");
    expect(narrowed.length).toBe(result.candidateRange.length);
  });

  it("returns an empty list when no candidate matches the symptom tokens", () => {
    const trajectory = buildTrajectory().filter((e) => e.eventType !== "agent.completed");
    const result = findEarliestDivergence({
      trajectory,
      expectedMilestones: buildExpectedMilestones(),
      scenarioId: "scn-1",
      observationId: "obs-1",
    });
    // Tokens extracted but no candidate matches → empty list.
    const narrowed = narrowCandidateRange(result.candidateRange, "zzz qqq xxx");
    expect(narrowed).toEqual([]);
  });
});

describe("T46-4 earliest divergence — stable ID", () => {
  it("produces the same ID for the same inputs", () => {
    const id1 = stableDivergenceId("obs-1", 5);
    const id2 = stableDivergenceId("obs-1", 5);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^div-/);
  });

  it("produces different IDs for different inputs", () => {
    const id1 = stableDivergenceId("obs-1", 5);
    const id2 = stableDivergenceId("obs-1", 6);
    expect(id1).not.toBe(id2);
  });
});