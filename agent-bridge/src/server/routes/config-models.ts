/**
 * GET /config/models — List all model configurations
 * POST /config/models — Add a new model configuration
 * PUT /config/models/:id — Update a model configuration
 * DELETE /config/models/:id — Delete a model configuration
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunContext } from "./utils.js";
import { sendJson, readJsonBody } from "./utils.js";
import type { ModelConfigEntry } from "@/types/model-config.js";

export async function handleConfigModelsList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  ctx: RunContext,
): Promise<void> {
  const entries = ctx.modelConfigStore.listWire();
  sendJson(res, 200, { models: entries });
}

export async function handleConfigModelsAdd(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  ctx: RunContext,
): Promise<void> {
  const bodyText = (req as IncomingMessage & { bodyText?: string }).bodyText ?? "";
  const parsed = readJsonBody<ModelConfigEntry>(res, bodyText, validateModelConfigEntry);
  if (!parsed) return;

  try {
    const entry = await ctx.modelConfigStore.add(parsed);
    sendJson(res, 201, ctx.modelConfigStore.listWire().find((e) => e.id === entry.id));
  } catch (err) {
    sendJson(res, 400, { error: "validation_error", message: (err as Error).message });
  }
}

export async function handleConfigModelsUpdate(
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

  let patch: Partial<ModelConfigEntry>;
  try {
    const raw = JSON.parse(bodyText);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      sendJson(res, 400, { error: "validation_error", message: "请求体必须是 JSON 对象" });
      return;
    }
    // Only allow known fields through
    const allowed = new Set(["id", "provider", "name", "displayName", "baseUrl", "baseUrlEnvVar", "apiKeyEnvVar", "isDefault", "capabilities"]);
    patch = {};
    for (const [k, v] of Object.entries(raw)) {
      if (allowed.has(k)) {
        (patch as Record<string, unknown>)[k] = v;
      }
    }
  } catch {
    sendJson(res, 400, { error: "parse_error", message: "JSON 解析失败" });
    return;
  }

  try {
    const entry = await ctx.modelConfigStore.update(id, patch);
    sendJson(res, 200, ctx.modelConfigStore.listWire().find((e) => e.id === entry.id));
  } catch (err) {
    sendJson(res, 400, { error: "validation_error", message: (err as Error).message });
  }
}

export async function handleConfigModelsDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  ctx: RunContext,
): Promise<void> {
  const id = params.id;
  if (!id) {
    sendJson(res, 400, { error: "validation_error", message: "缺少模型配置 ID" });
    return;
  }

  try {
    await ctx.modelConfigStore.delete(id);
    sendJson(res, 200, { deleted: id });
  } catch (err) {
    sendJson(res, 404, { error: "not_found", message: (err as Error).message });
  }
}

function validateModelConfigEntry(data: unknown): ModelConfigEntry | null {
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;

  if (typeof obj.id !== "string" || !obj.id) return null;
  if (typeof obj.provider !== "string" || !obj.provider) return null;
  if (typeof obj.name !== "string" || !obj.name) return null;
  if (typeof obj.displayName !== "string" || !obj.displayName) return null;
  if (typeof obj.apiKeyEnvVar !== "string") return null;
  if (typeof obj.isDefault !== "boolean") return null;

  const caps = obj.capabilities;
  if (!caps || typeof caps !== "object" || typeof (caps as any).thinking !== "boolean" || typeof (caps as any).vision !== "boolean") {
    return null;
  }

  return {
    id: obj.id,
    provider: obj.provider,
    name: obj.name,
    displayName: obj.displayName,
    baseUrl: typeof obj.baseUrl === "string" ? obj.baseUrl : undefined,
    baseUrlEnvVar: typeof obj.baseUrlEnvVar === "string" ? obj.baseUrlEnvVar : undefined,
    apiKeyEnvVar: obj.apiKeyEnvVar,
    isDefault: obj.isDefault,
    capabilities: { thinking: (caps as any).thinking, vision: (caps as any).vision },
  };
}
