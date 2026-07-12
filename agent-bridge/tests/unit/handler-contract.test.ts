/**
 * Handler contract tests — verifies both /runs and /runs/stream routes
 * enforce skill resolution BEFORE any durable/HTTP effects.
 *
 * Tests real handler functions with injected dependencies, not resolver simulations.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SkillIndex } from "../../src/skills/skill-index.js";
import { SkillLoader } from "../../src/skills/skill-loader.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { EventStream } from "../../src/events/stream.js";
import { SessionStore } from "../../src/runtime/session-store.js";
import { ModelRouter } from "../../src/runtime/model-router.js";
import type { RunContext } from "../../src/server/routes/utils.js";
import type { SidecarConfig } from "../../src/server/config.js";
import type { FastapiClient } from "../../src/tools/fastapi-client.js";
import type { ModelConfigStore } from "../../src/config/model-config-store.js";
import type { DotEnvWriter } from "../../src/config/dotenv-writer.js";

/** Create a temp SkillIndex with one valid skill. */
async function createTestIndex(): Promise<SkillIndex> {
  const dir = await mkdtemp(join(tmpdir(), "projectflow-handler-"));
  const skillDir = join(dir, "project-planning");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `---
name: project-planning
description: 当需要阶段计划时触发
allowed-tools:
  - get_workspace_state
---

# Body
`);
  const index = new SkillIndex({ skillsDir: dir });
  await index.load();
  return index;
}

function makeConfig(): SidecarConfig {
  return {
    host: "127.0.0.1",
    port: 4000,
    fastapiBaseUrl: "http://localhost:8000",
    serviceToken: "test-token",
    defaultModelProvider: "mock",
    defaultModelName: "mock-model",
    modelConfigsPath: "/nonexistent",
    dotenvPath: "/nonexistent",
    defaults: { maxSteps: 8, maxToolCalls: 6, timeoutMs: 180000, maxOutputTokens: 4096, maxToolResultBytes: 32768 },
    traceIncludeSensitiveData: false,
  };
}

function makeMockFastapiClient(): FastapiClient & { startRunCalls: unknown[] } {
  const client = {
    startRunCalls: [] as unknown[],
    startRun: vi.fn(async (body: unknown) => {
      client.startRunCalls.push(body);
      return { run_id: "run_test_1", memory_context: null };
    }),
    appendEvents: vi.fn(async () => ({
      state_version: 1,
      events: [],
      tool_results: [],
    })),
    callTool: vi.fn(async () => ({})),
  };
  return client as unknown as FastapiClient & { startRunCalls: unknown[] };
}

function makeMockReq(body: unknown): IncomingMessage {
  const bodyText = JSON.stringify(body);
  return { bodyText } as unknown as IncomingMessage;
}

function makeMockRes(): ServerResponse & { written: { status: number; body: string }[] } {
  const written: { status: number; body: string }[] = [];
  let statusCode = 0;
  const chunks: string[] = [];

  const res = {
    written,
    writeHead: (status: number) => { statusCode = status; },
    write: (chunk: string) => { chunks.push(chunk); },
    end: (data?: string) => {
      if (data) chunks.push(data);
      written.push({ status: statusCode, body: chunks.join("") });
    },
  };
  return res as unknown as ServerResponse & { written: { status: number; body: string }[] };
}

async function createRunContext(
  skillIndex: SkillIndex,
  fastapiClient: FastapiClient,
  skillLoader?: SkillLoader,
): Promise<RunContext> {
  const mockStore = {
    list: () => [],
    listWire: () => [],
    get: () => undefined,
    getValid: () => undefined,
    getDefault: () => undefined,
    load: async () => {},
    add: async () => { throw new Error("not implemented"); },
    update: async () => { throw new Error("not implemented"); },
    delete: async () => { throw new Error("not implemented"); },
    persist: async () => {},
  } as unknown as ModelConfigStore;

  return {
    config: makeConfig(),
    sessionStore: new SessionStore(),
    fastapiClient,
    toolRegistry: new ToolRegistry(),
    stream: new EventStream(),
    modelRouter: new ModelRouter(mockStore),
    modelConfigStore: mockStore,
    dotenvWriter: { writeKey: async () => {} } as unknown as DotEnvWriter,
    reloadDotEnv: async () => {},
    skillLoader: skillLoader ?? new SkillLoader(),
    skillIndex,
  };
}

function validRunBody(skill?: string) {
  return {
    conversation_id: "conv_1",
    workspace_id: "ws_1",
    project_id: "proj_1",
    user_content: "测试",
    runtime_config: {
      model: { provider: "mock", name: "mock-model" },
      ...(skill ? { skill } : {}),
    },
  };
}

// ── /runs handler tests ────────────────────────────────────────────────

describe("POST /runs handler contract", () => {
  it("returns 400 for unknown skill, does NOT call startRun", async () => {
    const { handleStartRun } = await import("../../src/server/routes/start-run.js");
    const index = await createTestIndex();
    const fastapiClient = makeMockFastapiClient();
    const ctx = await createRunContext(index, fastapiClient);
    const req = makeMockReq(validRunBody("nonexistent-skill"));
    const res = makeMockRes();

    await handleStartRun(req, res, {}, ctx);

    expect(res.written.length).toBeGreaterThan(0);
    expect(res.written[0]!.status).toBe(400);
    expect(res.written[0]!.body).toContain("invalid_skill");
    expect(fastapiClient.startRun).not.toHaveBeenCalled();
    expect(ctx.sessionStore.get("run_test_1")).toBeUndefined();
  });

  it("returns 500 on skill loader failure, does NOT call startRun", async () => {
    const { handleStartRun } = await import("../../src/server/routes/start-run.js");
    const index = await createTestIndex();
    const fastapiClient = makeMockFastapiClient();

    // Create a SkillLoader that throws on loadSkill
    const failingLoader = new SkillLoader();
    const origLoadSkill = failingLoader.loadSkill.bind(failingLoader);
    failingLoader.loadSkill = async () => { throw new Error("disk read error"); };

    const ctx = await createRunContext(index, fastapiClient, failingLoader);
    const req = makeMockReq(validRunBody("project-planning"));
    const res = makeMockRes();

    await handleStartRun(req, res, {}, ctx);

    expect(res.written.length).toBeGreaterThan(0);
    expect(res.written[0]!.status).toBe(500);
    expect(res.written[0]!.body).toContain("skill_load_error");
    expect(fastapiClient.startRun).not.toHaveBeenCalled();
  });

  it("proceeds with answer mode when no skill specified", async () => {
    const { handleStartRun } = await import("../../src/server/routes/start-run.js");
    const index = await createTestIndex();
    const fastapiClient = makeMockFastapiClient();
    const ctx = await createRunContext(index, fastapiClient);
    const req = makeMockReq(validRunBody());
    const res = makeMockRes();

    await handleStartRun(req, res, {}, ctx);

    expect(res.written.length).toBeGreaterThan(0);
    expect(res.written[0]!.status).toBe(200);
    expect(fastapiClient.startRun).toHaveBeenCalledOnce();
    expect(ctx.sessionStore.get("run_test_1")).toBeDefined();
  });

  it("proceeds with action mode when valid skill specified", async () => {
    const { handleStartRun } = await import("../../src/server/routes/start-run.js");
    const index = await createTestIndex();
    const fastapiClient = makeMockFastapiClient();
    const ctx = await createRunContext(index, fastapiClient);
    const req = makeMockReq(validRunBody("project-planning"));
    const res = makeMockRes();

    await handleStartRun(req, res, {}, ctx);

    expect(res.written.length).toBeGreaterThan(0);
    expect(res.written[0]!.status).toBe(200);
    expect(fastapiClient.startRun).toHaveBeenCalledOnce();
    expect(ctx.sessionStore.get("run_test_1")).toBeDefined();
  });
});

// ── /runs/stream handler tests ─────────────────────────────────────────

describe("POST /runs/stream handler contract", () => {
  it("returns 400 for unknown skill, does NOT write SSE headers or call startRun", async () => {
    const { handleStartRunStream } = await import("../../src/server/routes/start-run-stream.js");
    const index = await createTestIndex();
    const fastapiClient = makeMockFastapiClient();
    const ctx = await createRunContext(index, fastapiClient);
    const req = makeMockReq(validRunBody("nonexistent-skill"));
    const res = makeMockRes();

    await handleStartRunStream(req, res, {}, ctx);

    // Should get JSON 400, NOT SSE 200
    expect(res.written.length).toBeGreaterThan(0);
    expect(res.written[0]!.status).toBe(400);
    expect(res.written[0]!.body).toContain("invalid_skill");
    expect(fastapiClient.startRun).not.toHaveBeenCalled();
  });

  it("returns 500 on skill loader failure, does NOT write SSE headers or call startRun", async () => {
    const { handleStartRunStream } = await import("../../src/server/routes/start-run-stream.js");
    const index = await createTestIndex();
    const fastapiClient = makeMockFastapiClient();

    const failingLoader = new SkillLoader();
    failingLoader.loadSkill = async () => { throw new Error("disk read error"); };

    const ctx = await createRunContext(index, fastapiClient, failingLoader);
    const req = makeMockReq(validRunBody("project-planning"));
    const res = makeMockRes();

    await handleStartRunStream(req, res, {}, ctx);

    expect(res.written.length).toBeGreaterThan(0);
    expect(res.written[0]!.status).toBe(500);
    expect(res.written[0]!.body).toContain("skill_load_error");
    expect(fastapiClient.startRun).not.toHaveBeenCalled();
  });
});
