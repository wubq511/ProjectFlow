/**
 * Sidecar configuration — loaded from environment variables.
 * No secrets are logged or persisted by the sidecar.
 */

import { resolve } from "node:path";

export interface SidecarConfig {
  /** Sidecar listen host */
  host: string;
  /** Sidecar listen port */
  port: number;
  /** FastAPI base URL (e.g. http://localhost:8000) */
  fastapiBaseUrl: string;
  /** Service-to-service auth token for FastAPI internal endpoints */
  serviceToken: string;
  /** Default model provider */
  defaultModelProvider: string;
  /** Default model name */
  defaultModelName: string;
  /** Path to model-configs.json */
  modelConfigsPath: string;
  /** Path to .env file */
  dotenvPath: string;
  /** Run-level defaults */
  defaults: {
    maxSteps: number;
    maxToolCalls: number;
    timeoutMs: number;
    maxOutputTokens: number;
    maxToolResultBytes: number;
  };
  /** Debug mode: include sensitive data in traces */
  traceIncludeSensitiveData: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): SidecarConfig {
  return {
    host: env.AGENT_BRIDGE_HOST ?? "127.0.0.1",
    port: parseInt(env.AGENT_BRIDGE_PORT ?? "4000", 10),
    fastapiBaseUrl: env.FASTAPI_BASE_URL ?? "http://localhost:8000",
    serviceToken: env.INTERNAL_SERVICE_TOKEN ?? env.SERVICE_TOKEN ?? "",
    defaultModelProvider: env.DEFAULT_MODEL_PROVIDER ?? "mock",
    defaultModelName: env.DEFAULT_MODEL_NAME ?? "mock-model",
    modelConfigsPath: env.MODEL_CONFIGS_PATH ?? resolve(import.meta.dirname ?? process.cwd(), "../../model-configs.json"),
    dotenvPath: env.DOTENV_PATH ?? resolve(import.meta.dirname ?? process.cwd(), "../../.env"),
    defaults: {
      maxSteps: parseInt(env.MAX_STEPS ?? "8", 10),
      maxToolCalls: parseInt(env.MAX_TOOL_CALLS ?? "6", 10),
      timeoutMs: parseInt(env.RUN_TIMEOUT_MS ?? "180000", 10),
      maxOutputTokens: parseInt(env.MAX_OUTPUT_TOKENS ?? "4096", 10),
      maxToolResultBytes: parseInt(env.MAX_TOOL_RESULT_BYTES ?? "32768", 10),
    },
    traceIncludeSensitiveData: env.TRACE_INCLUDE_SENSITIVE_DATA === "true",
  };
}
