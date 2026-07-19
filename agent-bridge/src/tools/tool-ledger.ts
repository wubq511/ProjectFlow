/**
 * ToolLedger — durable tool execution records via FastAPI events.
 *
 * Each tool call attempt is recorded as an event through the existing
 * FastAPI appendEvents API. No new tables needed.
 *
 * The ledger can be replayed from events to reconstruct execution history.
 *
 * @see docs/T43/ProjectFlow_Agent_Capability_Maturity_Spec.md §Phase 5
 */

import type { ToolLedgerEntry } from "./tool-executor.js";
import type { FastapiClient } from "./fastapi-client.js";
import type { EventStream } from "@/events/stream.js";
import type { RuntimeEventType } from "@/types/runtime-event.js";
import { buildRuntimeEvent } from "@/events/event-mapper.js";
import type { AgentRunState } from "@/types/run-state.js";
import type { RunCheckpoint } from "@/runtime/checkpoint.js";

/**
 * Persist a ToolLedger entry as a durable event via FastAPI appendEvents.
 */
export async function persistLedgerEntry(
  entry: ToolLedgerEntry,
  runState: AgentRunState,
  fastapiClient: FastapiClient,
  _stream: EventStream,
  traceIncludeSensitiveData: boolean,
): Promise<void> {
  const eventType: RuntimeEventType = "tool.ledger_entry";

  const payload: Record<string, unknown> = {
    logical_call_id: entry.logicalCallId,
    run_id: entry.runId,
    tool_call_id: entry.toolCallId,
    tool_name: entry.toolName,
    tool_version: entry.toolVersion,
    manifest_version: entry.manifestVersion,
    attempt: entry.attempt,
    policy_decision: entry.policyDecision,
    policy_reason: entry.policyReason,
    input_hash: entry.inputHash,
    idempotency_key: entry.idempotencyKey,
    result_status: entry.resultStatus,
    side_effect_status: entry.sideEffectStatus,
    error_code: entry.errorCode,
    reconciliation_status: entry.reconciliationStatus,
    started_at: entry.startedAt,
    completed_at: entry.completedAt,
    duration_ms: entry.durationMs,
  };

  const event = buildRuntimeEvent(
    {
      type: eventType,
      payload: { run_id: runState.runId, ...payload },
    },
    runState,
    {
      orderingHint: runState.lastEventSeq + 1,
      includeSensitiveData: traceIncludeSensitiveData,
    },
  );

  const appendResponse = await fastapiClient.appendEvents(runState.runId, {
    idempotency_key: `${event.clientEventId}:ledger:v1`,
    expected_state_version: runState.stateVersion,
    events: [{
      client_event_id: event.clientEventId ?? `${runState.runId}:${runState.lastEventSeq + 1}:tool.ledger_entry`,
      type: eventType,
      ordering_hint: runState.lastEventSeq + 1,
      payload: event.payload,
    }],
  });

  // Update event sequence and state version
  if (appendResponse.events.length > 0) {
    const maxSeq = Math.max(...appendResponse.events.map((e) => e.event_seq));
    runState.lastEventSeq = Math.max(runState.lastEventSeq, maxSeq);
  }
  runState.stateVersion = appendResponse.state_version;
}

/**
 * Replay ledger entries from persisted events.
 * Filters events of type tool.ledger_entry and reconstructs ToolLedgerEntry[].
 */
export function replayLedgerFromEvents(
  events: Array<{ type: string; payload: Record<string, unknown> }>,
): ToolLedgerEntry[] {
  return events
    .filter((e) => e.type === "tool.ledger_entry")
    .map((e) => {
      const p = e.payload;
      return {
        logicalCallId: p.logical_call_id as string ?? "",
        runId: p.run_id as string ?? "",
        toolCallId: p.tool_call_id as string ?? "",
        toolName: p.tool_name as string ?? "",
        toolVersion: p.tool_version as number ?? 1,
        manifestVersion: p.manifest_version as number ?? 1,
        attempt: p.attempt as number ?? 1,
        policyDecision: p.policy_decision as string ?? "",
        policyReason: p.policy_reason as string ?? "",
        inputHash: p.input_hash as string ?? "",
        idempotencyKey: p.idempotency_key as string ?? "",
        resultStatus: p.result_status as any,
        sideEffectStatus: p.side_effect_status as string,
        errorCode: p.error_code as any,
        reconciliationStatus: p.reconciliation_status as any ?? "none",
        startedAt: p.started_at as string ?? "",
        completedAt: p.completed_at as string,
        durationMs: p.duration_ms as number,
      };
    });
}

/**
 * Get tool evidence for RunPlan step verification.
 * Returns ledger entries where the tool executed successfully.
 */
export function getToolEvidence(
  ledger: ToolLedgerEntry[],
  toolName: string,
  runId?: string,
): ToolLedgerEntry[] {
  return ledger.filter((e) =>
    e.toolName === toolName &&
    e.resultStatus === "success" &&
    (!runId || e.runId === runId),
  );
}

/**
 * Check if a tool had any unknown side effects in the ledger.
 */
export function hasUnknownSideEffects(
  ledger: ToolLedgerEntry[],
  runId?: string,
): boolean {
  return ledger.some((e) =>
    e.sideEffectStatus === "unknown" &&
    (!runId || e.runId === runId),
  );
}

/**
 * Persist a checkpoint as a durable event via FastAPI appendEvents.
 */
export async function persistCheckpoint(
  checkpoint: RunCheckpoint,
  runState: AgentRunState,
  fastapiClient: FastapiClient,
  traceIncludeSensitiveData: boolean,
): Promise<void> {
  const eventType: RuntimeEventType = "checkpoint.saved";

  const event = buildRuntimeEvent(
    {
      type: eventType,
      payload: { run_id: runState.runId, checkpoint },
    },
    runState,
    {
      orderingHint: runState.lastEventSeq + 1,
      includeSensitiveData: traceIncludeSensitiveData,
    },
  );

  const request = {
    idempotency_key: `${event.clientEventId}:checkpoint:v1`,
    expected_state_version: runState.stateVersion,
    events: [{
      client_event_id: event.clientEventId ?? `${runState.runId}:${runState.lastEventSeq + 1}:checkpoint.saved`,
      type: eventType,
      ordering_hint: runState.lastEventSeq + 1,
      payload: event.payload,
    }],
  };
  let appendResponse;
  try {
    appendResponse = await fastapiClient.appendEvents(runState.runId, request);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("409")) throw error;
    const snapshot = await fastapiClient.getRunSnapshot(runState.runId);
    runState.stateVersion = typeof snapshot.state_version === "number"
      ? snapshot.state_version
      : runState.stateVersion;
    runState.lastEventSeq = typeof snapshot.last_event_seq === "number"
      ? Math.max(runState.lastEventSeq, snapshot.last_event_seq)
      : runState.lastEventSeq;
    appendResponse = await fastapiClient.appendEvents(runState.runId, {
      ...request,
      expected_state_version: runState.stateVersion,
      events: request.events.map((item) => ({ ...item, ordering_hint: runState.lastEventSeq + 1 })),
    });
  }

  if (appendResponse.events.length > 0) {
    const maxSeq = Math.max(...appendResponse.events.map((e) => e.event_seq));
    runState.lastEventSeq = Math.max(runState.lastEventSeq, maxSeq);
  }
  runState.stateVersion = appendResponse.state_version;
}

/**
 * Persist a steering event as a durable event via FastAPI appendEvents.
 */
export async function persistSteeringEvent(
  steeringType: "steering.queued" | "steering.consumed",
  runState: AgentRunState,
  fastapiClient: FastapiClient,
  payload: Record<string, unknown>,
  traceIncludeSensitiveData: boolean,
): Promise<void> {
  const eventType: RuntimeEventType = steeringType;

  const event = buildRuntimeEvent(
    {
      type: eventType,
      payload: { run_id: runState.runId, ...payload },
    },
    runState,
    {
      orderingHint: runState.lastEventSeq + 1,
      includeSensitiveData: traceIncludeSensitiveData,
    },
  );

  const appendResponse = await fastapiClient.appendEvents(runState.runId, {
    idempotency_key: `${event.clientEventId}:steering:v1`,
    expected_state_version: runState.stateVersion,
    events: [{
      client_event_id: event.clientEventId ?? `${runState.runId}:${runState.lastEventSeq + 1}:${steeringType}`,
      type: eventType,
      ordering_hint: runState.lastEventSeq + 1,
      payload: event.payload,
    }],
  });

  if (appendResponse.events.length > 0) {
    const maxSeq = Math.max(...appendResponse.events.map((e) => e.event_seq));
    runState.lastEventSeq = Math.max(runState.lastEventSeq, maxSeq);
  }
  runState.stateVersion = appendResponse.state_version;
}
