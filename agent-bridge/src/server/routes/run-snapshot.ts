import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunContext } from "./utils.js";
import { sendJson } from "./utils.js";

/** Browser-safe proxy for the durable FastAPI run snapshot. */
export async function handleRunSnapshot(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  ctx: RunContext,
): Promise<void> {
  const runId = params.runId;
  if (!runId) {
    sendJson(res, 400, { error: "missing_run_id", message: "缺少 run ID" });
    return;
  }
  try {
    const snapshot = await ctx.fastapiClient.getRunSnapshot(runId);
    const rawCheckpoint = snapshot.latest_checkpoint;
    const checkpoint = rawCheckpoint && typeof rawCheckpoint === "object"
      ? rawCheckpoint as Record<string, unknown>
      : undefined;
    const rawWorkState = checkpoint?.workState ?? checkpoint?.work_state;
    const workState = rawWorkState && typeof rawWorkState === "object"
      ? rawWorkState as Record<string, unknown>
      : undefined;
    const recentEvents = Array.isArray(snapshot.recent_events)
      ? snapshot.recent_events.flatMap((event) => {
        if (!event || typeof event !== "object") return [];
        const record = event as Record<string, unknown>;
        if (record.type !== "work_state.changed") return [];
        const payload = record.payload && typeof record.payload === "object"
          ? record.payload as Record<string, unknown>
          : {};
        return [{
          type: "work_state.changed",
          payload: {
            status: payload.status,
            version: payload.version,
            reason: payload.reason,
          },
          created_at: record.created_at,
        }];
      })
      : [];
    sendJson(res, 200, {
      run_id: snapshot.run_id,
      status: snapshot.status,
      current_turn: snapshot.current_turn,
      current_step: snapshot.current_step,
      last_event_seq: snapshot.last_event_seq,
      state_version: snapshot.state_version,
      created_at: snapshot.created_at,
      updated_at: snapshot.updated_at,
      completed_at: snapshot.completed_at,
      latest_checkpoint: workState ? { workState: {
        status: workState.status,
        version: workState.version,
        reason: workState.reason,
      } } : null,
      recent_events: recentEvents,
      unconsumed_steering: Array.isArray(snapshot.unconsumed_steering) ? snapshot.unconsumed_steering : [],
      consumed_steering: Array.isArray(snapshot.consumed_steering) ? snapshot.consumed_steering : [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, message.includes("404") ? 404 : 502, {
      error: "snapshot_failed",
      message: message.includes("404") ? "运行不存在" : "暂时无法读取运行状态",
    });
  }
}
