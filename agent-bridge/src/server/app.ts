/**
 * HTTP server for the agent bridge sidecar.
 * Routes: POST /runs, GET /runs/:id, POST /runs/:id/cancel, GET /health
 *         GET/POST/PUT/DELETE /config/models, PUT /config/models/:id/api-key,
 *         POST /config/reload, GET /config/providers/:provider/models
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { SidecarConfig } from "./config.js";
import { sendJson } from "./routes/utils.js";
import { handleStartRun } from "./routes/start-run.js";
import { handleStartRunStream } from "./routes/start-run-stream.js";
import { handleGetRun } from "./routes/get-run.js";
import { handleCancelRun } from "./routes/cancel-run.js";
import { handleResumeRun } from "./routes/resume-run.js";
import { handleSteering } from "./routes/steering.js";
import { handleRunSnapshot } from "./routes/run-snapshot.js";
import { handleListTools } from "./routes/list-tools.js";
import { handleHealth } from "./routes/health.js";
import { handleConfigModelsList, handleConfigModelsAdd, handleConfigModelsUpdate, handleConfigModelsDelete } from "./routes/config-models.js";
import { handleConfigApiKey } from "./routes/config-api-key.js";
import { handleConfigReload } from "./routes/config-reload.js";
import { handleConfigProviderModels } from "./routes/config-providers.js";
import { getSessionStore } from "@/runtime/session-store.js";
import { FastapiClient } from "@/tools/fastapi-client.js";
import { ToolRegistry } from "@/tools/registry.js";
import { registerMockTools } from "@/tools/mock-tools.js";
import { registerDefaultTools } from "@/tools/register-defaults.js";
import { EventStream } from "@/events/stream.js";
import { ModelConfigStore, type CatalogValidator } from "@/config/model-config-store.js";
import { getProviderCatalogModels } from "@/runtime/pi-runtime.js";
import { DotEnvWriter } from "@/config/dotenv-writer.js";
import { ModelRouter } from "@/runtime/model-router.js";
import { SkillLoader } from "@/skills/skill-loader.js";
import { getSkillIndex } from "@/skills/skill-index.js";
import type { RunContext } from "./routes/utils.js";

type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, ctx: RunContext) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

function compileRoute(method: string, path: string, handler: RouteHandler): Route {
  const paramNames: string[] = [];
  const patternStr = path.replace(/:(\w+)/g, (_match, name) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  return { method, pattern: new RegExp(`^${patternStr}$`), paramNames, handler };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export interface ServerContext {
  modelConfigStore: ModelConfigStore;
  dotenvWriter: DotEnvWriter;
  modelRouter: ModelRouter;
  reloadDotEnv: () => Promise<void>;
}

export function createServer(config: SidecarConfig, serverCtx?: Partial<ServerContext>): Server {
  // Build shared context — no secrets exposed on req
  const sessionStore = getSessionStore();
  const fastapiClient = new FastapiClient({
    baseUrl: config.fastapiBaseUrl,
    serviceToken: config.serviceToken,
  });
  const toolRegistry = new ToolRegistry();
  if (config.defaultModelProvider === "mock") {
    registerMockTools(toolRegistry);
  }
  registerDefaultTools(toolRegistry, fastapiClient);
  const stream = new EventStream();

  // Catalog validator: resolves model against Pi SDK catalog to derive capabilities
  const catalogValidator: CatalogValidator = async (provider, name) => {
    const models = await getProviderCatalogModels(provider);
    const found = models.find((m) => m.id === name || m.name === name);
    if (!found) return null;
    return {
      id: found.id,
      name: found.name,
      reasoning: found.reasoning,
      input: found.input,
      contextWindow: found.contextWindow,
      maxTokens: found.maxTokens,
      thinkingLevelMap: found.thinkingLevelMap,
    };
  };

  // Model config infrastructure
  const modelConfigStore = serverCtx?.modelConfigStore ?? new ModelConfigStore({
    filePath: config.modelConfigsPath,
    catalogValidator,
  });
  const dotenvWriter = serverCtx?.dotenvWriter ?? new DotEnvWriter({
    filePath: config.dotenvPath,
  });
  const modelRouter = serverCtx?.modelRouter ?? new ModelRouter(modelConfigStore);

  const skillLoader = new SkillLoader();

  const ctx: RunContext = {
    config,
    sessionStore,
    fastapiClient,
    toolRegistry,
    stream,
    modelRouter,
    modelConfigStore,
    dotenvWriter,
    reloadDotEnv: serverCtx?.reloadDotEnv ?? (async () => { await modelConfigStore.load(); }),
    skillLoader,
    skillIndex: getSkillIndex(),
  };

  const routes: Route[] = [
    // Run management
    compileRoute("POST", "/runs", handleStartRun),
    compileRoute("POST", "/runs/stream", handleStartRunStream),
    compileRoute("GET", "/runs/:runId", handleGetRun),
    compileRoute("GET", "/runs/:runId/snapshot", handleRunSnapshot),
    compileRoute("POST", "/runs/:runId/cancel", handleCancelRun),
    compileRoute("POST", "/runs/:runId/resume", handleResumeRun),
    compileRoute("POST", "/runs/:runId/steering", handleSteering),
    compileRoute("GET", "/tools/list", handleListTools),
    compileRoute("GET", "/health", handleHealth),

    // Model configuration
    compileRoute("GET", "/config/models", handleConfigModelsList),
    compileRoute("POST", "/config/models", handleConfigModelsAdd),
    compileRoute("PUT", "/config/models/:id", handleConfigModelsUpdate),
    compileRoute("DELETE", "/config/models/:id", handleConfigModelsDelete),

    // API key management
    compileRoute("PUT", "/config/models/:id/api-key", handleConfigApiKey),

    // Config reload
    compileRoute("POST", "/config/reload", handleConfigReload),

    // Provider catalog
    compileRoute("GET", "/config/providers/:provider/models", handleConfigProviderModels),
  ];

  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS headers for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    for (const route of routes) {
      if (req.method !== route.method) continue;
      const match = url.pathname.match(route.pattern);
      if (!match) continue;

      const params: Record<string, string> = {};
      for (let i = 0; i < route.paramNames.length; i++) {
        params[route.paramNames[i]!] = match[i + 1]!;
      }

      try {
        // Attach body reader for POST/PUT requests
        if (req.method === "POST" || req.method === "PUT") {
          (req as IncomingMessage & { bodyText?: string }).bodyText = await readBody(req);
        }
        await route.handler(req, res, params, ctx);
      } catch (err: unknown) {
        console.error(`[agent-bridge] error in ${route.method} ${url.pathname}:`, err);
        const errRec = typeof err === "object" && err !== null ? err as Record<string, unknown> : null;
        if (
          errRec &&
          errRec.name === "FastapiError" &&
          typeof errRec.status === "number" &&
          errRec.status >= 400 && errRec.status < 600
        ) {
          const message = typeof errRec.body === "string" ? errRec.body : JSON.stringify(errRec.body);
          sendJson(res, errRec.status, { error: "fastapi_error", message });
        } else {
          sendJson(res, 500, { error: "internal_error", message: "服务器内部错误" });
        }
      }
      return;
    }

    sendJson(res, 404, { error: "not_found", message: `未找到路由: ${req.method} ${url.pathname}` });
  });

  return server;
}
