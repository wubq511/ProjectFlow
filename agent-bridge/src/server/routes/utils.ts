/**
 * Shared utilities for route handlers.
 */

import type { ServerResponse } from "node:http";
import type { SidecarConfig } from "../config.js";
import type { SessionStore } from "@/runtime/session-store.js";
import type { FastapiClient } from "@/tools/fastapi-client.js";
import type { ToolRegistry } from "@/tools/registry.js";
import type { EventStream } from "@/events/stream.js";
import type { ModelRouter } from "@/runtime/model-router.js";
import type { ModelConfigStore } from "@/config/model-config-store.js";
import type { DotEnvWriter } from "@/config/dotenv-writer.js";
import type { SkillLoader } from "@/skills/skill-loader.js";

/** Shared context passed to all route handlers — no secrets exposed on req. */
export interface RunContext {
  config: SidecarConfig;
  sessionStore: SessionStore;
  fastapiClient: FastapiClient;
  toolRegistry: ToolRegistry;
  stream: EventStream;
  modelRouter: ModelRouter;
  modelConfigStore: ModelConfigStore;
  dotenvWriter: DotEnvWriter;
  /** Reload .env from disk into process.env, then reload model config store */
  reloadDotEnv: () => Promise<void>;
  /** Load SKILL.md content by skill name */
  skillLoader: SkillLoader;
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function readJsonBody<T>(
  res: ServerResponse,
  bodyText: string,
  parser: (data: unknown) => T | null,
): T | null {
  try {
    const data = JSON.parse(bodyText);
    const result = parser(data);
    if (result === null) {
      sendJson(res, 400, { error: "validation_error", message: "请求体格式无效" });
      return null;
    }
    return result;
  } catch {
    sendJson(res, 400, { error: "parse_error", message: "JSON 解析失败" });
    return null;
  }
}
