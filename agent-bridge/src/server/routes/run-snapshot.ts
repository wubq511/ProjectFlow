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
    sendJson(res, 200, snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, message.includes("404") ? 404 : 502, {
      error: "snapshot_failed",
      message: message.includes("404") ? "运行不存在" : "暂时无法读取运行状态",
    });
  }
}
