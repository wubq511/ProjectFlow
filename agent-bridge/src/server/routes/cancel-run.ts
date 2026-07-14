/**
 * POST /runs/:runId/cancel — Cancel a running agent run.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunContext } from "./utils.js";
import { sendJson } from "./utils.js";

export async function handleCancelRun(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  ctx: RunContext,
): Promise<void> {
  const runId = params.runId ?? "";
  const run = ctx.sessionStore.get(runId);

  // Parse optional reason from body
  let reason = "user_cancelled";
  try {
    const bodyText = (req as IncomingMessage & { bodyText?: string }).bodyText;
    if (bodyText) {
      const body = JSON.parse(bodyText);
      if (typeof body.reason === "string" && body.reason.trim()) {
        reason = body.reason;
      }
    }
  } catch {
    // ignore parse errors
  }

  // Propagate to backend FIRST. If backend fails, do not pretend cancellation succeeded.
  let backendStatus: string | undefined;
  try {
    const backendResp = await ctx.fastapiClient.cancelRun(runId, reason);
    backendStatus = backendResp.status;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[agent-bridge] backend cancelRun failed for ${runId}: ${message}`);
    sendJson(res, 502, { error: "backend_cancel_failed", message });
    return;
  }

  // Update local run state so the runtime loop can detect an explicit cancellation
  // versus a steering-induced abort.
  if (run) {
    const cancelableStatuses = ["created", "context_building", "model_streaming", "tool_preparing", "tool_running", "persisting_tool_result"];
    if (cancelableStatuses.includes(run.status)) {
      run.status = "cancelling";
      run.updatedAt = new Date().toISOString();
    }
    ctx.sessionStore.abort(runId, reason);
  }

  sendJson(res, 200, {
    run_id: runId,
    status: backendStatus ?? "cancelling",
    cancelled: backendStatus === "cancelled" || backendStatus === "cancelling",
  });
}
