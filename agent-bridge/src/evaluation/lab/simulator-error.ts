/**
 * T46-3 (Issue #96 §2) — Simulator integrity.
 *
 * Invalid, out-of-bounds, or hidden-fact-leaking simulator episodes are
 * classified as `simulator_error`. Such episodes:
 *  - MUST NOT enter the Agent score denominator.
 *  - MUST NOT be recorded as Agent failures.
 *  - Can be retried only within the frozen {@link SIMULATOR_RETRY_BUDGET}.
 *  - MUST be reported separately with attempt count, exclusion reason,
 *    and final status.
 *  - MUST NOT be rewritten as success by retry.
 *
 * The frozen budget constant lives in `contract-v3.ts` so artifacts and
 * tests share a single source of truth.
 */

import type {
  AttemptLedger,
  AttemptLedgerEntry,
  AttemptResult,
  SimulatorErrorRecord,
  SimulatorErrorType,
} from "./contract-v3.js";
import { SIMULATOR_RETRY_BUDGET } from "./contract-v3.js";

/** Classification input. */
export interface ClassifySimulatorErrorInput {
  type: SimulatorErrorType;
  scenarioId: string;
  runId?: string;
  turn?: number;
  message: string;
  /** ISO timestamp; defaults to `new Date().toISOString()`. */
  recordedAt?: string;
}

/** Classify a simulator error and produce a stable record. */
export function classifySimulatorError(
  input: ClassifySimulatorErrorInput,
): SimulatorErrorRecord {
  return {
    recordId: makeRecordId(input.scenarioId, input.type, input.recordedAt ?? new Date().toISOString()),
    scenarioId: input.scenarioId,
    runId: input.runId,
    type: input.type,
    turn: input.turn,
    message: input.message,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    retried: false,
  };
}

/** Mark a record as retried and return a NEW record (immutably). The
 *  original record is NOT mutated; the caller appends the new record to
 *  the ledger. */
export function markRetried(
  original: SimulatorErrorRecord,
  retryRecordId: string,
): SimulatorErrorRecord {
  return {
    ...original,
    retried: true,
    retryOfRecordId: retryRecordId,
  };
}

/** Check whether a scenario has exhausted its simulator retry budget. */
export function retryBudgetExhausted(
  records: SimulatorErrorRecord[],
  scenarioId: string,
): boolean {
  const scenarioRecords = records.filter((r) => r.scenarioId === scenarioId);
  return scenarioRecords.length >= SIMULATOR_RETRY_BUDGET;
}

/** Filter simulator_error episodes out of the Agent score denominator.
 *  Returns the indices of trials that count toward the denominator. */
export function scoreDenominatorTrials<T extends { simulatorError?: SimulatorErrorType }>(
  trials: T[],
): T[] {
  return trials.filter((t) => t.simulatorError === undefined);
}

/** Aggregate simulator errors by type. */
export function aggregateSimulatorErrors(
  records: SimulatorErrorRecord[],
): Record<SimulatorErrorType, number> {
  const result: Record<SimulatorErrorType, number> = {
    invalid_turn: 0,
    out_of_scope: 0,
    hidden_fact_leak: 0,
    goal_drift: 0,
    forbidden_action: 0,
    controller_state_corrupted: 0,
    phrasing_function_violation: 0,
  };
  for (const record of records) {
    result[record.type] += 1;
  }
  return result;
}

/** Convert a simulator error to an attempt ledger entry. */
export function simulatorErrorToAttempt(
  record: SimulatorErrorRecord,
  startedAt: string,
  endedAt: string,
): AttemptLedgerEntry {
  return {
    attemptId: `sim-${record.recordId}`,
    scenarioId: record.scenarioId,
    runId: record.runId,
    type: "infrastructure_attempt",
    startedAt,
    endedAt,
    result: "simulator_error",
    errorCategory: record.type,
    errorMessage: record.message,
    durationMs: new Date(endedAt).getTime() - new Date(startedAt).getTime(),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeRecordId(scenarioId: string, type: SimulatorErrorType, recordedAt: string): string {
  // Stable ID: scenarioId + type + timestamp hash. Avoids collisions
  // when the same scenario has multiple errors of the same type within
  // the same millisecond (extremely unlikely but possible).
  const hash = simpleHash(`${scenarioId}|${type}|${recordedAt}`);
  return `${scenarioId}-${type}-${hash}`;
}

function simpleHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

/** Re-export the frozen budget for tests. */
export { SIMULATOR_RETRY_BUDGET };

/** Type guard: is this attempt result a simulator error? */
export function isSimulatorErrorResult(result: AttemptResult): boolean {
  return result === "simulator_error";
}

/** Type guard: is this attempt result an infrastructure failure? */
export function isInfrastructureFailureResult(result: AttemptResult): boolean {
  return result === "failed_infrastructure" || result === "failed_budget";
}

/** Compute the Agent score denominator excluding simulator errors and
 *  infrastructure failures, while preserving a record of what was
 *  excluded. Returns both the filtered list and the exclusion summary. */
export function computeDenominatorWithExclusions<
  T extends { simulatorError?: SimulatorErrorType; infrastructureError?: boolean },
>(trials: T[]): {
  denominator: T[];
  excluded: T[];
  exclusionsByReason: Record<string, number>;
} {
  const denominator: T[] = [];
  const excluded: T[] = [];
  const exclusionsByReason: Record<string, number> = {};
  for (const trial of trials) {
    if (trial.simulatorError !== undefined) {
      excluded.push(trial);
      exclusionsByReason[`simulator_error:${trial.simulatorError}`] =
        (exclusionsByReason[`simulator_error:${trial.simulatorError}`] ?? 0) + 1;
    } else if (trial.infrastructureError) {
      excluded.push(trial);
      exclusionsByReason["infrastructure_error"] = (exclusionsByReason["infrastructure_error"] ?? 0) + 1;
    } else {
      denominator.push(trial);
    }
  }
  return { denominator, excluded, exclusionsByReason };
}

/** Compute the simulator error summary for an attempt ledger. */
export function simulatorErrorSummary(ledger: AttemptLedger): {
  total: number;
  byType: Partial<Record<SimulatorErrorType, number>>;
  retryRate: number;
  budgetExhausted: boolean;
} {
  const simulatorEntries = ledger.entries.filter((e) => e.result === "simulator_error");
  const byType: Partial<Record<SimulatorErrorType, number>> = {};
  for (const entry of simulatorEntries) {
    if (entry.errorCategory) {
      byType[entry.errorCategory as SimulatorErrorType] =
        (byType[entry.errorCategory as SimulatorErrorType] ?? 0) + 1;
    }
  }
  const retried = simulatorEntries.filter((e) => e.retryOf !== undefined).length;
  return {
    total: simulatorEntries.length,
    byType,
    retryRate: simulatorEntries.length > 0 ? retried / simulatorEntries.length : 0,
    budgetExhausted: simulatorEntries.length >= SIMULATOR_RETRY_BUDGET,
  };
}
