/**
 * PUT /config/models/:id/api-key — Set API key for a model configuration
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunContext } from "./utils.js";
import { sendJson } from "./utils.js";

export async function handleConfigApiKey(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  ctx: RunContext,
): Promise<void> {
  const id = params.id;
  if (!id) {
    sendJson(res, 400, { error: "validation_error", message: "缺少模型配置 ID" });
    return;
  }
  const bodyText = (req as IncomingMessage & { bodyText?: string }).bodyText ?? "";

  let body: { apiKey?: string };
  try {
    body = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { error: "parse_error", message: "JSON 解析失败" });
    return;
  }

  if (!body.apiKey || typeof body.apiKey !== "string") {
    sendJson(res, 400, { error: "validation_error", message: "apiKey 字段必填" });
    return;
  }

  // Length limit to prevent DoS
  if (body.apiKey.length > 512) {
    sendJson(res, 400, { error: "validation_error", message: "apiKey 长度不能超过 512 字符" });
    return;
  }

  // Check that the model config exists
  const entry = ctx.modelConfigStore.get(id);
  if (!entry) {
    sendJson(res, 404, { error: "not_found", message: `模型配置 ID "${id}" 不存在` });
    return;
  }

  // Write API key to .env via serial queue
  try {
    await ctx.dotenvWriter.setVar(entry.apiKeyEnvVar, body.apiKey);

    // Reload model config store to pick up the new env var
    await ctx.modelConfigStore.load();

    sendJson(res, 200, { id, apiKeyEnvVar: entry.apiKeyEnvVar, apiKeySet: true });
  } catch (err) {
    sendJson(res, 500, { error: "write_error", message: `写入 .env 失败: ${(err as Error).message}` });
  }
}
