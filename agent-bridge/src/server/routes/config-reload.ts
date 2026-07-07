/**
 * POST /config/reload — Reload model-configs.json and .env from disk
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunContext } from "./utils.js";
import { sendJson } from "./utils.js";

export async function handleConfigReload(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  ctx: RunContext,
): Promise<void> {
  try {
    // Re-read .env into process.env, then reload the model config store
    await ctx.reloadDotEnv();

    const entries = ctx.modelConfigStore.listWire();
    sendJson(res, 200, { reloaded: true, modelCount: entries.length });
  } catch (err) {
    sendJson(res, 500, { error: "reload_error", message: `重新加载失败: ${(err as Error).message}` });
  }
}
