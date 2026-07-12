/**
 * POST /runs/:runId/steering — Append a steering event to a run.
 *
 * Steering events are queued and consumed at the next loop boundary.
 * Uses client_message_id for idempotency.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunContext } from "./utils.js";
import { sendJson, readJsonBody } from "./utils.js";

interface SteeringRequest {
  steering_type: "constraint" | "correction" | "plan_change" | "clarification_answer" | "approval_response" | "cancel";
  content: string;
  client_message_id: string;
  metadata?: Record<string, unknown>;
}

function parseSteeringRequest(data: unknown): SteeringRequest | null {
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.steering_type !== "string") return null;
  if (typeof obj.content !== "string") return null;
  if (typeof obj.client_message_id !== "string") return null;
  return obj as unknown as SteeringRequest;
}

export async function handleSteering(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  ctx: RunContext,
): Promise<void> {
  const runId = params.runId;
  if (!runId) {
    sendJson(res, 400, { error: "missing_run_id", message: "缺少 run ID" });
    return;
  }

  const bodyText = (req as IncomingMessage & { bodyText?: string }).bodyText ?? "";
  const parsed = readJsonBody(res, bodyText, parseSteeringRequest);
  if (!parsed) return;

  // Cancel type: forward to cancel endpoint
  if (parsed.steering_type === "cancel") {
    try {
      await ctx.fastapiClient.cancelRun(runId, parsed.content || "用户取消");
      sendJson(res, 200, { run_id: runId, steering_seq: 0, accepted: true, message: "已取消" });
    } catch (err) {
      sendJson(res, 500, { error: "cancel_failed", message: "取消失败" });
    }
    return;
  }

  // Other steering types: forward to FastAPI
  try {
    const result = await ctx.fastapiClient.appendSteering(
      runId,
      parsed.steering_type,
      parsed.content,
      parsed.client_message_id,
      parsed.metadata,
    );
    sendJson(res, 200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("404") || message.includes("not found")) {
      sendJson(res, 404, { error: "run_not_found", message: "运行不存在" });
    } else if (message.includes("already") || message.includes("已")) {
      sendJson(res, 409, { error: "run_terminal", message: "运行已终止" });
    } else {
      sendJson(res, 500, { error: "steering_failed", message: `发送失败: ${message}` });
    }
  }
}
