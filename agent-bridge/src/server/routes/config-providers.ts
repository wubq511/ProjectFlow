/**
 * GET /config/providers/:provider/models — List Pi SDK catalog models for a provider
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunContext } from "./utils.js";
import { sendJson } from "./utils.js";
import { getProviderCatalogModels } from "@/runtime/pi-runtime.js";

export async function handleConfigProviderModels(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  _ctx: RunContext,
): Promise<void> {
  const provider = params.provider;
  if (!provider) {
    sendJson(res, 400, { error: "validation_error", message: "缺少 provider 参数" });
    return;
  }

  try {
    const models = await getProviderCatalogModels(provider);
    sendJson(res, 200, { provider, models });
  } catch (err) {
    sendJson(res, 400, { error: "provider_error", message: `无法加载 provider "${provider}": ${(err as Error).message}` });
  }
}
