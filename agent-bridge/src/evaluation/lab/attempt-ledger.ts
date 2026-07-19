/**
 * T46-3 (Issue #96 §5) — Append-only attempt ledger.
 *
 * Infrastructure attempts and Agent-internal retries are tracked as two
 * distinct record types. The ledger is APPEND-ONLY:
 *  - Each attempt has a stable ID (`${scenarioId}-${type}-${seq}`).
 *  - Each entry has: stable ID, type, start/end time, result, error
 *    category, scenario/run association, and recovery relationships.
 *  - Recovery is recorded via `recoveredBy` pointer on the original
 *    entry; the original failure entry is NEVER deleted or overwritten.
 *  - Aggregation cannot keep only "final success"; the ledger is the
 *    source of truth for retry counts, infrastructure attempts, and
 *    failure-to-recovery chains.
 *
 * The ledger type lives in `contract-v3.ts` so artifacts and tests
 * share a single source of truth. This module owns the construction and
 * invariant enforcement.
 */

import type {
  AttemptLedger,
  AttemptLedgerEntry,
  AttemptResult,
  AttemptType,
} from "./contract-v3.js";

export interface AttemptRecorder {
  /** Append a new attempt entry. Returns the new entry's ID. */
  record(input: RecordAttemptInput): AttemptLedgerEntry;
  /** Mark an existing attempt as recovered by a later attempt. The
   *  original entry is NOT removed; only its `recoveredBy` pointer is
   *  set. Returns the updated ledger. Throws if the original entry
   *  does not exist. */
  markRecovered(originalAttemptId: string, recoveredByAttemptId: string): void;
  /** Snapshot the current ledger. The returned object is a deep copy
   *  so callers cannot mutate the internal state. */
  snapshot(): AttemptLedger;
  /** Check if an attempt ID exists. */
  has(attemptId: string): boolean;
}

export interface RecordAttemptInput {
  scenarioId: string;
  runId?: string;
  type: AttemptType;
  startedAt: string;
  endedAt: string;
  result: AttemptResult;
  errorCategory?: string;
  errorMessage?: string;
  retryOf?: string;
  inputTokens?: number;
  outputTokens?: number;
  sutCostUsd?: number;
}

/** Create a new append-only attempt ledger. */
export function createAttemptLedger(): AttemptRecorder {
  const entries: AttemptLedgerEntry[] = [];
  const byId = new Map<string, AttemptLedgerEntry>();
  const byScenarioType = new Map<string, number>();

  const nextSeq = (scenarioId: string, type: AttemptType): number => {
    const key = `${scenarioId}:${type}`;
    const seq = byScenarioType.get(key) ?? 0;
    byScenarioType.set(key, seq + 1);
    return seq;
  };

  return {
    record(input) {
      const seq = nextSeq(input.scenarioId, input.type);
      const attemptId = `${input.scenarioId}-${input.type}-${seq}`;
      if (byId.has(attemptId)) {
        throw new Error(`attempt ID 冲突: ${attemptId}`);
      }
      const entry: AttemptLedgerEntry = {
        attemptId,
        scenarioId: input.scenarioId,
        runId: input.runId,
        type: input.type,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        result: input.result,
        ...(input.errorCategory !== undefined ? { errorCategory: input.errorCategory } : {}),
        ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
        ...(input.retryOf !== undefined ? { retryOf: input.retryOf } : {}),
        durationMs:
          new Date(input.endedAt).getTime() - new Date(input.startedAt).getTime(),
        ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
        ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
        ...(input.sutCostUsd !== undefined ? { sutCostUsd: input.sutCostUsd } : {}),
      };
      entries.push(entry);
      byId.set(attemptId, entry);
      // If this is a SUCCESSFUL retry, link the original entry's
      // `recoveredBy`. We only set `recoveredBy` on successful retries
      // because `recoveredBy` semantically means "this failure was
      // recovered by X" — a failed retry does NOT recover the original.
      // We also refuse to overwrite an existing `recoveredBy` pointer:
      // if the original was already recovered by a prior successful
      // retry, a later retry MUST NOT erase that recovery relationship.
      // This enforces the "retry cannot erase prior failure evidence"
      // boundary from Issue #96 §5.
      if (input.retryOf && input.result === "succeeded") {
        const original = byId.get(input.retryOf);
        if (original) {
          if (original.recoveredBy && original.recoveredBy !== attemptId) {
            throw new Error(
              `attempt ${input.retryOf} 已被 ${original.recoveredBy} 标记为已恢复，拒绝覆盖（防止 retry 抹除先前恢复证据）`,
            );
          }
          byId.set(input.retryOf, { ...original, recoveredBy: attemptId });
        }
      }
      return entry;
    },

    markRecovered(originalAttemptId, recoveredByAttemptId) {
      const original = byId.get(originalAttemptId);
      if (!original) {
        throw new Error(`attempt ${originalAttemptId} 不存在，无法标记恢复关系`);
      }
      if (!byId.has(recoveredByAttemptId)) {
        throw new Error(`attempt ${recoveredByAttemptId} 不存在，无法作为恢复方`);
      }
      if (original.recoveredBy && original.recoveredBy !== recoveredByAttemptId) {
        throw new Error(
          `attempt ${originalAttemptId} 已被 ${original.recoveredBy} 标记为已恢复，拒绝覆盖`,
        );
      }
      byId.set(originalAttemptId, { ...original, recoveredBy: recoveredByAttemptId });
    },

    snapshot() {
      // Merge the map view (which has recoveredBy pointers) with the
      // array view (which preserves historical append order). The
      // array order is authoritative; the map provides the latest
      // recoveredBy pointer for each entry.
      // Deep-copy each entry so callers cannot mutate internal state
      // by modifying the returned snapshot.
      const merged = entries.map((entry) => {
        const latest = byId.get(entry.attemptId);
        return { ...(latest ?? entry) };
      });
      return aggregateLedger(merged);
    },

    has(attemptId) {
      return byId.has(attemptId);
    },
  };
}

/** Aggregate a list of entries into an {@link AttemptLedger}. */
export function aggregateLedger(entries: AttemptLedgerEntry[]): AttemptLedger {
  const byType: Record<AttemptType, number> = {
    infrastructure_attempt: 0,
    agent_retry: 0,
  };
  const byResult: Record<AttemptResult, number> = {
    succeeded: 0,
    failed_agent: 0,
    failed_infrastructure: 0,
    failed_budget: 0,
    cancelled: 0,
    simulator_error: 0,
  };
  for (const entry of entries) {
    byType[entry.type] += 1;
    byResult[entry.result] += 1;
  }
  return {
    entries: [...entries],
    total: entries.length,
    byType,
    byResult,
  };
}

/** Verify ledger invariants. Returns a list of violations (empty = OK). */
export function verifyLedgerInvariants(ledger: AttemptLedger): string[] {
  const violations: string[] = [];
  const seenIds = new Set<string>();
  for (const entry of ledger.entries) {
    if (seenIds.has(entry.attemptId)) {
      violations.push(`重复 attempt ID: ${entry.attemptId}`);
    }
    seenIds.add(entry.attemptId);
    if (entry.durationMs < 0) {
      violations.push(`attempt ${entry.attemptId} durationMs 为负数`);
    }
    if (entry.retryOf && !seenIds.has(entry.retryOf)) {
      // retryOf may reference a later entry if the ledger was filtered;
      // for a complete ledger, the original MUST appear before the retry.
      violations.push(
        `attempt ${entry.attemptId} 引用未知或被过滤的 retryOf ${entry.retryOf}`,
      );
    }
    if (entry.recoveredBy && !seenIds.has(entry.recoveredBy)) {
      // recoveredBy is set via markRecovered; if the recovering entry
      // is not in the ledger, the pointer is dangling.
      violations.push(
        `attempt ${entry.attemptId} 的 recoveredBy 指向未知 attempt ${entry.recoveredBy}`,
      );
    }
    if (entry.result === "simulator_error" && !entry.errorCategory) {
      violations.push(
        `attempt ${entry.attemptId} 为 simulator_error 但缺少 errorCategory`,
      );
    }
  }
  return violations;
}

/** Compute retry counts per scenario. */
export function retryCounts(ledger: AttemptLedger): Record<string, {
  infrastructureAttempts: number;
  agentRetries: number;
  total: number;
}> {
  const result: Record<string, {
    infrastructureAttempts: number;
    agentRetries: number;
    total: number;
  }> = {};
  for (const entry of ledger.entries) {
    if (!result[entry.scenarioId]) {
      result[entry.scenarioId] = { infrastructureAttempts: 0, agentRetries: 0, total: 0 };
    }
    if (entry.type === "infrastructure_attempt") {
      result[entry.scenarioId]!.infrastructureAttempts += 1;
    } else if (entry.type === "agent_retry") {
      result[entry.scenarioId]!.agentRetries += 1;
    }
    result[entry.scenarioId]!.total += 1;
  }
  return result;
}

/** Return true if any entry in the ledger was a failure that was later
 *  recovered. Used to verify "earlier failures are preserved". */
export function hasRecoveredFailures(ledger: AttemptLedger): boolean {
  return ledger.entries.some((e) => e.recoveredBy !== undefined && e.result !== "succeeded");
}

/** Return the chain of attempts for a scenario, in append order. */
export function attemptChain(ledger: AttemptLedger, scenarioId: string): AttemptLedgerEntry[] {
  return ledger.entries.filter((e) => e.scenarioId === scenarioId);
}