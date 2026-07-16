/**
 * GET /health — Health check endpoint.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunContext } from "./utils.js";
import { sendJson } from "./utils.js";

export async function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _ctx: RunContext,
): Promise<void> {
  sendJson(res, 200, {
    status: "ok",
    service: "agent-bridge",
    version: "0.1.0",
    uptime_s: Math.floor(process.uptime()),
    app_env: process.env.APP_ENV,
    evaluation_nonce: process.env.EVALUATION_NONCE,
  });
}
