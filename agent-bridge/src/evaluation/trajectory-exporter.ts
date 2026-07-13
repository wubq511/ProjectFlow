import { hashValue } from "@/utils/hash.js";

export interface PersistedRunEvent {
  type: string;
  event_seq?: number;
  created_at?: string;
  payload?: Record<string, unknown>;
}

export interface TrajectoryStep {
  seq: number;
  type: string;
  at?: string;
  tool?: string;
  status?: string;
  durationMs?: number;
  evidenceHash: string;
}

export interface RunTrajectory {
  schemaVersion: 1;
  runIdHash: string;
  model?: string;
  startedAt?: string;
  completedAt?: string;
  latencyMs?: number;
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported reasoning tokens. Absent when the provider did not supply this field. */
  reasoningTokens?: number;
  /** Provider-reported cache read tokens. Absent when the provider did not supply this field. */
  cacheReadTokens?: number;
  /** Provider-reported cache write tokens. Absent when the provider did not supply this field. */
  cacheWriteTokens?: number;
  /** Provider-reported total cost. Absent when the provider did not supply cost data. */
  totalCost?: number;
  /** Provider-supplied cost breakdown (e.g. { input: ..., output: ... }). Absent when the provider did not supply cost data. */
  costBreakdown?: Record<string, number>;
  terminalType?: string;
  verifierPassed?: boolean;
  steps: TrajectoryStep[];
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Export a bounded, redacted trajectory suitable for eval artifacts. */
export function exportTrajectory(runId: string, events: PersistedRunEvent[]): RunTrajectory {
  const ordered = [...events].sort((a, b) => (a.event_seq ?? 0) - (b.event_seq ?? 0));
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalCost = 0;
  const costBreakdown: Record<string, number> = {};
  // Track whether the provider actually supplied each optional telemetry field.
  // This distinguishes "provider reported 0" from "provider did not report at all".
  let observedReasoning = false;
  let observedCacheRead = false;
  let observedCacheWrite = false;
  let observedCost = false;
  let observedCostBreakdown = false;
  let model: string | undefined;
  let terminalType: string | undefined;
  let verifierPassed: boolean | undefined;

  const steps = ordered.map((event, index): TrajectoryStep => {
    const payload = event.payload ?? {};
    const usage = nestedRecord(payload.usage);
    const cost = nestedRecord(payload.cost);
    inputTokens += numberField(usage.input) || numberField(usage.input_tokens);
    outputTokens += numberField(usage.output) || numberField(usage.output_tokens);
    const r = numberField(usage.reasoning) || numberField(usage.reasoning_tokens);
    if (r || usage.reasoning !== undefined || usage.reasoning_tokens !== undefined) {
      observedReasoning = true;
      reasoningTokens += r;
    }
    const cr = numberField(usage.cacheRead) || numberField(usage.cache_read_tokens);
    if (cr || usage.cacheRead !== undefined || usage.cache_read_tokens !== undefined) {
      observedCacheRead = true;
      cacheReadTokens += cr;
    }
    const cw = numberField(usage.cacheWrite) || numberField(usage.cache_write_tokens);
    if (cw || usage.cacheWrite !== undefined || usage.cache_write_tokens !== undefined) {
      observedCacheWrite = true;
      cacheWriteTokens += cw;
    }
    const ct = numberField(cost.total);
    if (ct || cost.total !== undefined) {
      observedCost = true;
      totalCost += ct;
    }
    // Accumulate per-key cost breakdown (skip "total" — already tracked above).
    for (const [k, v] of Object.entries(cost)) {
      if (k !== "total" && typeof v === "number") {
        observedCostBreakdown = true;
        costBreakdown[k] = (costBreakdown[k] ?? 0) + v;
      }
    }
    if (typeof payload.model === "string") model = payload.model;
    if (event.type === "verifier.completed" && typeof payload.passed === "boolean") {
      verifierPassed = payload.passed;
    }
    if (["agent.completed", "agent.failed", "run.cancelled", "run.failed", "run.completed"].includes(event.type)) {
      terminalType = event.type;
    }
    return {
      seq: event.event_seq ?? index + 1,
      type: event.type,
      ...(event.created_at ? { at: event.created_at } : {}),
      ...(typeof payload.tool_name === "string" ? { tool: payload.tool_name } : {}),
      ...(typeof payload.status === "string" ? { status: payload.status } : {}),
      ...(typeof payload.duration_ms === "number" ? { durationMs: payload.duration_ms } : {}),
      evidenceHash: hashValue({ type: event.type, payload }),
    };
  });

  const startedAt = ordered.find((event) => event.created_at)?.created_at;
  const completedAt = [...ordered].reverse().find((event) => event.created_at)?.created_at;
  const latencyMs = startedAt && completedAt
    ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
    : undefined;

  return {
    schemaVersion: 1,
    runIdHash: hashValue(runId),
    ...(model ? { model } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    inputTokens,
    outputTokens,
    ...(observedReasoning ? { reasoningTokens } : {}),
    ...(observedCacheRead ? { cacheReadTokens } : {}),
    ...(observedCacheWrite ? { cacheWriteTokens } : {}),
    ...(observedCost ? { totalCost } : {}),
    ...(observedCostBreakdown ? { costBreakdown } : {}),
    ...(terminalType ? { terminalType } : {}),
    ...(verifierPassed !== undefined ? { verifierPassed } : {}),
    steps,
  };
}
