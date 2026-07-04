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

  if (!run) {
    sendJson(res, 404, { error: "not_found", message: `运行 ${runId} 未找到` });
    return;
  }

  // Parse optional reason from body
  try {
    const bodyText = (req as IncomingMessage & { bodyText?: string }).bodyText;
    if (bodyText) {
      const body = JSON.parse(bodyText);
      if (typeof body.reason === "string") {
        // reason stored for future use
      }
    }
  } catch {
    // ignore parse errors
  }

  // Transition to cancelling
  const cancelableStatuses = ["created", "context_building", "model_streaming", "tool_preparing", "tool_running", "persisting_tool_result"];
  if (cancelableStatuses.includes(run.status)) {
    run.status = "cancelling";
    run.updatedAt = new Date().toISOString();
    // TODO: Signal the runtime loop via AbortController
  }

  sendJson(res, 200, {
    run_id: run.runId,
    status: run.status,
    cancelled: run.status === "cancelling",
  });
}
