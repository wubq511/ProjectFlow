/**
 * GET /health — Health check endpoint.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunContext } from "./utils.js";
import { sendJson } from "./utils.js";

export async function handleHealth(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _ctx: RunContext,
): Promise<void> {
  const appEnv = process.env.APP_ENV;
  if (appEnv === "evaluation") {
    const expectedNonce = process.env.EVALUATION_NONCE;
    const xEvaluationNonce = req.headers["x-evaluation-nonce"];
    if (!expectedNonce || xEvaluationNonce !== expectedNonce) {
      sendJson(res, 403, { error: "unauthorized", message: "无效的评估 Nonce" });
      return;
    }
  }

  sendJson(res, 200, {
    status: "ok",
    service: "agent-bridge",
    version: "0.1.0",
    uptime_s: Math.floor(process.uptime()),
    app_env: appEnv,
  });
}
