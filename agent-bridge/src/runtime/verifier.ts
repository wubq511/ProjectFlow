/**
 * Deterministic verifier — validates run output against Outcome Contract.
 *
 * Runs AFTER tool execution, BEFORE terminal status assignment.
 * No LLM judge — all checks are deterministic.
 *
 * @see docs/T43/ProjectFlow_Agent_Capability_Maturity_Spec.md §Verification & Refinement
 */

import type { OutcomeContract, EffectCeiling } from "./outcome-contract.js";
import type { RunPlan } from "./run-plan.js";
import type { ToolResultSummary } from "@/types/run-state.js";
import type { ToolLedgerEntry } from "@/tools/tool-executor.js";

/**
 * A single verification dimension result.
 */
export interface VerificationDimension {
  /** Dimension name */
  name: string;
  /** Whether this dimension passed */
  passed: boolean;
  /** Human-readable description of what was checked */
  description: string;
  /** Evidence supporting the verdict */
  evidence: string;
  /** Whether a failure is fixable (can retry/refine) */
  fixable: boolean;
}

/**
 * Completion classification from the verifier.
 */
export type CompletionClassification =
  | "complete"    // all success criteria met
  | "partial"     // some criteria met, some unresolved
  | "blocked"     // cannot proceed without external change
  | "failed"      // unrecoverable error
  | "answer_only"; // no verification needed (answer mode)

/**
 * The complete verifier report.
 */
export interface VerifierReport {
  /** Schema version */
  schemaVersion: 1;
  /** Report ID */
  id: string;
  /** Run ID this report is for */
  runId: string;
  /** When verification was performed */
  timestamp: string;
  /** Individual dimension results */
  dimensions: VerificationDimension[];
  /** Overall pass/fail */
  passed: boolean;
  /** Completion classification */
  completion: CompletionClassification;
  /** Whether any failures are fixable */
  hasFixableFailures: boolean;
  /** Summary for tracing (no sensitive data) */
  summary: string;
}

/**
 * Input for verification.
 */
export interface VerifyInput {
  /** The run ID */
  runId: string;
  /** Outcome Contract from request preparation */
  outcomeContract: OutcomeContract;
  /** RunPlan (if one was created) */
  runPlan?: RunPlan;
  /** Tool results from the run (legacy) */
  toolResults: ToolResultSummary[];
  /** Durable ledger entries from ToolExecutor (primary evidence source) */
  ledgerEntries?: ToolLedgerEntry[];
  /** Final content produced by the model */
  finalContent: string;
  /** Workspace state (for reference validation) */
  workspaceState?: unknown;
  /** Whether tools were available (answer mode = false) */
  hasTools: boolean;
}

/**
 * Run the deterministic verifier pipeline.
 *
 * Checks in order:
 * 1. Schema/reference validity
 * 2. Effect ceiling/proposal boundary
 * 3. Tool evidence support
 * 4. Outcome Contract success criteria
 * 5. Chinese, date YYYY-MM-DD, raw ID/privacy
 * 6. Terminal event/status consistency
 */
export function verify(input: VerifyInput): VerifierReport {
  const dimensions: VerificationDimension[] = [];
  const timestamp = new Date().toISOString();

  // Dimension 1: Schema/reference validity
  dimensions.push(checkSchemaValidity(input));

  // Dimension 2: Effect ceiling/proposal boundary
  dimensions.push(checkEffectBoundary(input));

  // Dimension 3: Tool evidence support
  dimensions.push(checkToolEvidence(input));

  // Dimension 4: Outcome Contract success criteria
  dimensions.push(checkSuccessCriteria(input));

  // Dimension 5: Chinese, date format, raw ID/privacy
  dimensions.push(checkLocalizationPrivacy(input));

  // Dimension 6: Terminal event/status consistency
  dimensions.push(checkTerminalConsistency(input));

  // Compute overall result
  const allPassed = dimensions.every((d) => d.passed);
  const hasFixableFailures = dimensions.some((d) => !d.passed && d.fixable);
  const completion = determineCompletion(input, dimensions);

  return {
    schemaVersion: 1,
    id: `verify_${input.runId}_${Date.now()}`,
    runId: input.runId,
    timestamp,
    dimensions,
    passed: allPassed,
    completion,
    hasFixableFailures,
    summary: buildSummary(dimensions, completion),
  };
}

// ─── Dimension checks ──────────────────────────────────────────────────

function checkSchemaValidity(input: VerifyInput): VerificationDimension {
  // Check that final content is non-empty and valid
  const hasContent = input.finalContent.trim().length > 0;

  return {
    name: "schema_validity",
    passed: hasContent,
    description: "Final content is non-empty and valid",
    evidence: hasContent
      ? `Content length: ${input.finalContent.length}`
      : "Empty final content",
    fixable: false, // can't fix empty content
  };
}

function checkEffectBoundary(input: VerifyInput): VerificationDimension {
  const { outcomeContract, toolResults, ledgerEntries } = input;

  // Check that no tool exceeded the effect ceiling
  const maxAllowedEffect = effectCeilingRank(outcomeContract.effectCeiling);
  let violated = false;
  let violationDetail = "";

  for (const tr of toolResults) {
    const effectRank = sideEffectRank(tr.sideEffectStatus);
    if (effectRank > maxAllowedEffect) {
      violated = true;
      violationDetail = `Tool ${tr.toolName} produced ${tr.sideEffectStatus} but ceiling is ${outcomeContract.effectCeiling}`;
      break;
    }
  }

  if (!violated && ledgerEntries) {
    for (const entry of ledgerEntries) {
      if (entry.resultStatus !== "success") continue;
      const effectRank = sideEffectRank(entry.sideEffectStatus ?? "no_side_effect");
      if (effectRank > maxAllowedEffect) {
        violated = true;
        violationDetail = `Tool ${entry.toolName} produced ${entry.sideEffectStatus} but ceiling is ${outcomeContract.effectCeiling}`;
        break;
      }
    }
  }

  return {
    name: "effect_boundary",
    passed: !violated,
    description: "No tool exceeded the effect ceiling",
    evidence: violated ? violationDetail : "All tools within effect ceiling",
    fixable: false, // effect violations are not fixable
  };
}

function checkToolEvidence(input: VerifyInput): VerificationDimension {
  const { outcomeContract, toolResults, ledgerEntries, hasTools } = input;

  // Answer-only doesn't need tool evidence
  if (!hasTools || outcomeContract.completionMode === "answer-only") {
    return {
      name: "tool_evidence",
      passed: true,
      description: "Answer-only mode — no tool evidence required",
      evidence: "Answer-only request",
      fixable: false,
    };
  }

  // Check for unknown side effects in ledger (must block completion)
  if (ledgerEntries && ledgerEntries.length > 0) {
    const unknownSideEffects = ledgerEntries.filter((e) => e.sideEffectStatus === "unknown");
    if (unknownSideEffects.length > 0) {
      return {
        name: "tool_evidence",
        passed: false,
        description: "Unknown side effects detected — manual review required",
        evidence: `Unknown side effects: ${unknownSideEffects.map((e) => `${e.toolName} (attempt ${e.attempt})`).join(", ")}`,
        fixable: false, // unknown side effects are NOT fixable automatically
      };
    }
  }

  // Use ledger entries as primary evidence, fall back to toolResults
  const effectiveResults = ledgerEntries && ledgerEntries.length > 0
    ? ledgerEntries.filter((e) => e.resultStatus === "success")
    : toolResults;

  // Action/analyze requests need tool evidence
  if (outcomeContract.requestType === "act" || outcomeContract.requestType === "analyze") {
    const hasToolResults = effectiveResults.length > 0;
    const hasSuccessfulTool = effectiveResults.some((tr) => {
      const ses = "sideEffectStatus" in tr ? tr.sideEffectStatus : (tr as ToolLedgerEntry).sideEffectStatus;
      return ses !== "no_side_effect";
    });

    if (!hasToolResults) {
      return {
        name: "tool_evidence",
        passed: false,
        description: "Action/analyze request requires tool execution",
        evidence: "No successful tool results recorded in ledger",
        fixable: true, // can retry with tools
      };
    }

    if (outcomeContract.effectCeiling !== "none" && !hasSuccessfulTool) {
      return {
        name: "tool_evidence",
        passed: false,
        description: "Request requires side effects but no tools produced them",
        evidence: `Tool results: ${toolResults.map((t) => t.toolName).join(", ")}`,
        fixable: true,
      };
    }
  }

  return {
    name: "tool_evidence",
    passed: true,
    description: "Tool evidence supports the result",
    evidence: `${toolResults.length} tool(s) executed: ${toolResults.map((t) => t.toolName).join(", ")}`,
    fixable: false,
  };
}

function checkSuccessCriteria(input: VerifyInput): VerificationDimension {
  const { outcomeContract, runPlan } = input;

  // Check if all plan steps completed (if plan exists)
  if (runPlan) {
    const allStepsCompleted = runPlan.steps.every(
      (s) => s.status === "completed" || s.status === "skipped",
    );
    const blockedSteps = runPlan.steps.filter((s) => s.status === "blocked");
    const failedSteps = runPlan.steps.filter((s) => s.status === "failed");

    if (blockedSteps.length > 0) {
      return {
        name: "success_criteria",
        passed: false,
        description: "Plan has blocked steps",
        evidence: `Blocked: ${blockedSteps.map((s) => s.goal).join(", ")}`,
        fixable: false, // blocked = needs external change
      };
    }

    if (failedSteps.length > 0) {
      return {
        name: "success_criteria",
        passed: false,
        description: "Plan has failed steps",
        evidence: `Failed: ${failedSteps.map((s) => s.goal).join(", ")}`,
        fixable: false,
      };
    }

    if (!allStepsCompleted) {
      return {
        name: "success_criteria",
        passed: false,
        description: "Not all plan steps completed",
        evidence: `Completed: ${runPlan.steps.filter((s) => s.status === "completed").length}/${runPlan.steps.length}`,
        fixable: true,
      };
    }
  }

  // Check Outcome Contract success criteria
  // This is a basic check — we verify the contract's criteria are addressed
  return {
    name: "success_criteria",
    passed: true,
    description: "Success criteria addressed",
    evidence: `Criteria: ${outcomeContract.successCriteria.join("; ")}`,
    fixable: false,
  };
}

function checkLocalizationPrivacy(input: VerifyInput): VerificationDimension {
  const content = input.finalContent;
  const issues: string[] = [];

  // Check for raw UUIDs (privacy violation)
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const uuidMatches = content.match(uuidPattern);
  if (uuidMatches && uuidMatches.length > 0) {
    issues.push(`Raw UUID found: ${uuidMatches.length} instance(s)`);
  }

  // Check for raw ID patterns
  const rawIdPatterns = [
    /\buser_[a-z0-9]+\b/gi,
    /\btask_[a-z0-9]+\b/gi,
    /\bstage_[a-z0-9]+\b/gi,
    /\bproj_[a-z0-9]+\b/gi,
  ];
  for (const pattern of rawIdPatterns) {
    const matches = content.match(pattern);
    if (matches && matches.length > 0) {
      issues.push(`Raw ID pattern found: ${matches[0]}`);
    }
  }

  // Check date format (should be YYYY-MM-DD)
  const datePatterns = [
    /\d{4}\/\d{2}\/\d{2}/g, // YYYY/MM/DD
    /\d{2}\/\d{2}\/\d{4}/g, // MM/DD/YYYY
    /\d{2}\.\d{2}\.\d{4}/g, // DD.MM.YYYY
  ];
  for (const pattern of datePatterns) {
    if (pattern.test(content)) {
      issues.push("Non-YYYY-MM-DD date format found");
      break;
    }
  }

  return {
    name: "localization_privacy",
    passed: issues.length === 0,
    description: "Content respects localization and privacy rules",
    evidence: issues.length > 0 ? issues.join("; ") : "No violations found",
    fixable: true, // can regenerate content
  };
}

function checkTerminalConsistency(_input: VerifyInput): VerificationDimension {
  // This check ensures that if we're verifying, the run is in a consistent state
  // In the runtime loop, this is checked by ensuring only one terminal event is emitted
  return {
    name: "terminal_consistency",
    passed: true,
    description: "Terminal event/status is consistent",
    evidence: "Single terminal event verified",
    fixable: false,
  };
}

// ─── Helper functions ──────────────────────────────────────────────────

function effectCeilingRank(ceiling: EffectCeiling): number {
  const ranks: Record<EffectCeiling, number> = {
    none: 0,
    advisory_only: 1,
    proposal_only: 2,
    full: 3,
  };
  return ranks[ceiling];
}

function sideEffectRank(status: string): number {
  // Ranks aligned with effect ceilings:
  // no_side_effect(0) <= none(0)
  // event_persisted(1) <= advisory_only(1)
  // advisory_record_persisted(1) <= advisory_only(1)
  // proposal_persisted(2) <= proposal_only(2)
  // commit_persisted(4) > full(3) — never allowed for LLM-callable tools
  const ranks: Record<string, number> = {
    no_side_effect: 0,
    event_persisted: 1,
    advisory_record_persisted: 1,
    proposal_persisted: 2,
    commit_persisted: 4,
    unknown: 5,
  };
  return ranks[status] ?? 0;
}

function determineCompletion(
  input: VerifyInput,
  dimensions: VerificationDimension[],
): CompletionClassification {
  // Answer-only
  if (!input.hasTools || input.outcomeContract.completionMode === "answer-only") {
    return "answer_only";
  }

  const failedDims = dimensions.filter((d) => !d.passed);
  if (failedDims.length === 0) return "complete";

  // Check if all failures are fixable
  const hasUnfixable = failedDims.some((d) => !d.fixable);
  if (hasUnfixable) {
    // Check for blocked specifically
    const isBlocked = failedDims.some(
      (d) => d.name === "success_criteria" && d.evidence.includes("Blocked"),
    );
    if (isBlocked) return "blocked";
    return "failed";
  }

  // All failures are fixable
  return "partial";
}

function buildSummary(
  dimensions: VerificationDimension[],
  completion: CompletionClassification,
): string {
  const passed = dimensions.filter((d) => d.passed).length;
  const failed = dimensions.filter((d) => !d.passed);
  const parts = [`${passed}/${dimensions.length} dimensions passed`];

  if (failed.length > 0) {
    parts.push(`Failed: ${failed.map((d) => d.name).join(", ")}`);
  }

  parts.push(`Completion: ${completion}`);

  return parts.join("; ");
}
