/**
 * GET /health — Health check endpoint.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunContext } from "./utils.js";
import { sendJson } from "./utils.js";
import { isEvaluationRequestAuthorized } from "../evaluation-auth.js";

export async function handleHealth(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  ctx: RunContext,
): Promise<void> {
  const appEnv = process.env.APP_ENV;
  if (appEnv === "evaluation") {
    if (!isEvaluationRequestAuthorized(req.headers)) {
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
    ...(appEnv === "evaluation"
      ? {
          evaluation_instance_id: process.env.EVALUATION_INSTANCE_ID,
          resolved_model: {
            provider: ctx.config.defaultModelProvider,
            name: ctx.config.defaultModelName,
            confirmed_by: "sidecar_health",
          },
        }
      : {}),
  });
}
