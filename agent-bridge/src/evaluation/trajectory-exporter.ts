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
  totalCost: number;
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
  let totalCost = 0;
  let model: string | undefined;
  let terminalType: string | undefined;
  let verifierPassed: boolean | undefined;

  const steps = ordered.map((event, index): TrajectoryStep => {
    const payload = event.payload ?? {};
    const usage = nestedRecord(payload.usage);
    const cost = nestedRecord(payload.cost);
    inputTokens += numberField(usage.input) || numberField(usage.input_tokens);
    outputTokens += numberField(usage.output) || numberField(usage.output_tokens);
    totalCost += numberField(cost.total);
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
    totalCost,
    ...(terminalType ? { terminalType } : {}),
    ...(verifierPassed !== undefined ? { verifierPassed } : {}),
    steps,
  };
}
