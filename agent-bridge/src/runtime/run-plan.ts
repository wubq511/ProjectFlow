/**
 * RunPlan — structured execution plan for non-trivial agent runs.
 *
 * Only created when:
 * - Two or more dependent actions needed
 * - Side effects present
 * - Multiple tools required
 * - Verification needed
 * - User explicitly requests a plan
 *
 * Simple answer-only queries do NOT get a ceremonial plan.
 *
 * Persisted via event payload (additive draft, no new DB table).
 *
 * @see docs/T43/ProjectFlow_Agent_Capability_Maturity_Spec.md §RunPlan
 */

import type { OutcomeContract } from "./outcome-contract.js";

/**
 * Status of a single plan step.
 */
export type PlanStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked"
  | "skipped";

/**
 * Failure policy for a plan step.
 */
export type FailurePolicy =
  | "retry"       // retry up to maxAttempts
  | "skip"        // skip this step, continue plan
  | "abort"       // abort the entire plan
  | "ask_user";   // ask user for guidance;

/**
 * A single step in the RunPlan.
 */
export interface PlanStep {
  /** Unique step ID (within this plan) */
  id: string;
  /** What this step aims to achieve (user-safe, no chain-of-thought) */
  goal: string;
  /** Step IDs that must complete before this step */
  dependencies: string[];
  /** Allowed tools for this step */
  allowedTools: string[];
  /** Expected observation type (for verification) */
  expectedObservation?: string;
  /** Completion criteria (deterministic check) */
  completionCriteria: string[];
  /** Current status */
  status: PlanStepStatus;
  /** Number of execution attempts */
  attemptCount: number;
  /** Maximum attempts before failure policy kicks in */
  maxAttempts: number;
  /** What to do on failure */
  failurePolicy: FailurePolicy;
  /** Human-readable progress message (user-safe) */
  progressMessage?: string;
}

/**
 * The complete RunPlan for a run.
 */
export interface RunPlan {
  /** Schema version */
  schemaVersion: 1;
  /** Plan ID */
  id: string;
  /** Why this plan was created */
  rationale: string;
  /** Ordered steps */
  steps: PlanStep[];
  /** Current step index */
  currentStepIndex: number;
  /** When the plan was created */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
}

/**
 * Decision: should we create a plan for this request?
 *
 * Returns true if the request needs structured planning.
 */
export function shouldCreatePlan(
  outcomeContract: OutcomeContract,
  userContent: string,
): boolean {
  // Answer-only never gets a plan
  if (outcomeContract.requestType === "answer") return false;
  if (outcomeContract.completionMode === "answer-only") return false;

  // Clarify doesn't need a plan
  if (outcomeContract.requestType === "clarify") return false;

  // Review doesn't need a plan
  if (outcomeContract.requestType === "review") return false;

  // Act with side effects needs a plan
  if (outcomeContract.effectCeiling !== "none") return true;

  // Analyze with verification needs a plan
  if (outcomeContract.verificationLevel !== "none") return true;

  // Check for explicit planning keywords
  if (/计划|规划|步骤|流程|方案/.test(userContent)) return true;

  return false;
}

/**
 * Create a simple plan for an action request.
 * This is a minimal plan — the runtime may refine it.
 */
export function createSimplePlan(
  planId: string,
  outcomeContract: OutcomeContract,
  allowedTools: string[],
): RunPlan {
  const now = new Date().toISOString();

  // Create a single "execute action" step
  const step: PlanStep = {
    id: "step-1",
    goal: outcomeContract.normalizedGoal,
    dependencies: [],
    allowedTools,
    completionCriteria: outcomeContract.successCriteria,
    status: "pending",
    attemptCount: 0,
    maxAttempts: 3,
    failurePolicy: "abort",
  };

  return {
    schemaVersion: 1,
    id: planId,
    rationale: `Auto-generated plan for ${outcomeContract.requestType} request`,
    steps: [step],
    currentStepIndex: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Create a multi-step plan for a complex action request.
 */
export function createMultiStepPlan(
  planId: string,
  outcomeContract: OutcomeContract,
  skillSteps: Array<{ goal: string; tools: string[]; dependencies?: string[] }>,
): RunPlan {
  const now = new Date().toISOString();

  const steps: PlanStep[] = skillSteps.map((ss, i) => ({
    id: `step-${i + 1}`,
    goal: ss.goal,
    dependencies: ss.dependencies ?? (i > 0 ? [`step-${i}`] : []),
    allowedTools: ss.tools,
    completionCriteria: i === skillSteps.length - 1
      ? outcomeContract.successCriteria
      : [`Step "${ss.goal}" completed`],
    status: "pending" as PlanStepStatus,
    attemptCount: 0,
    maxAttempts: 3,
    failurePolicy: i === skillSteps.length - 1 ? "abort" as FailurePolicy : "skip" as FailurePolicy,
  }));

  return {
    schemaVersion: 1,
    id: planId,
    rationale: `Multi-step plan for ${outcomeContract.requestType}: ${outcomeContract.normalizedGoal.slice(0, 100)}`,
    steps,
    currentStepIndex: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Advance the plan to the next step.
 * Returns the updated plan or null if no more steps.
 */
export function advancePlanStep(plan: RunPlan): RunPlan | null {
  const currentStep = plan.steps[plan.currentStepIndex];
  if (!currentStep) return null;

  // Mark current step as completed
  currentStep.status = "completed";

  // Find next pending step
  const nextIndex = plan.steps.findIndex((s, i) =>
    i > plan.currentStepIndex && s.status === "pending",
  );

  if (nextIndex === -1) return null; // No more steps

  return {
    ...plan,
    currentStepIndex: nextIndex,
    steps: plan.steps.map((s, i) =>
      i === plan.currentStepIndex ? { ...s, status: "completed" as const } : s,
    ),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Mark a plan step as failed and apply failure policy.
 */
export function failPlanStep(
  plan: RunPlan,
  stepId: string,
  reason: string,
): { plan: RunPlan; action: "retry" | "skip" | "abort" | "ask_user" } {
  const stepIndex = plan.steps.findIndex((s) => s.id === stepId);
  if (stepIndex === -1) {
    return { plan, action: "abort" };
  }

  const step = plan.steps[stepIndex]!;
  const newAttemptCount = step.attemptCount + 1;
  const shouldApplyPolicy = newAttemptCount >= step.maxAttempts;

  const updatedStep: PlanStep = {
    ...step,
    attemptCount: newAttemptCount,
    status: shouldApplyPolicy
      ? (step.failurePolicy === "skip" ? "skipped" : "failed")
      : "pending", // retry
    progressMessage: reason,
  };

  const updatedPlan: RunPlan = {
    ...plan,
    steps: plan.steps.map((s, i) => i === stepIndex ? updatedStep : s),
    updatedAt: new Date().toISOString(),
  };

  return {
    plan: updatedPlan,
    action: shouldApplyPolicy ? step.failurePolicy : "retry",
  };
}

/**
 * Get the current step from a plan.
 */
export function getCurrentStep(plan: RunPlan): PlanStep | undefined {
  return plan.steps[plan.currentStepIndex];
}

/**
 * Get user-safe progress summary (no chain-of-thought).
 */
export function getPlanProgress(plan: RunPlan): {
  current: number;
  total: number;
  currentGoal: string;
  status: string;
} {
  const completed = plan.steps.filter((s) => s.status === "completed").length;
  const current = plan.steps[plan.currentStepIndex];

  return {
    current: completed + 1,
    total: plan.steps.length,
    currentGoal: current?.goal ?? "完成",
    status: current?.status ?? "completed",
  };
}
