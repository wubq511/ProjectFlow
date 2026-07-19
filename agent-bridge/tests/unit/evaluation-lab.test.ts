import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EvaluationArtifactStore } from "../../src/evaluation/lab/artifact-store.js";
import { EvaluationBudgetError } from "../../src/evaluation/lab/errors.js";
import type { Grade, RunManifest, ScenarioContract, ScenarioObservation } from "../../src/evaluation/lab/contract.js";
import { createHttpPublicSeamRunner, parseSse } from "../../src/evaluation/http-public-seam-runner.js";
import { gradeObservation, containsRawId, verifyStatePurity } from "../../src/evaluation/lab/grader.js";
import {
  findFreePort,
  buildIsolatedChildEnv,
  IsolatedProcessPair,
  isExpectedEvaluationIdentity,
} from "../../src/evaluation/lab/isolation.js";
import {
  SLICE_0_SMOKE_BUDGET,
  SLICE_0_SMOKE_SCENARIOS,
  SMOKE_V2_BUDGET,
  SMOKE_V2_REFERENCE_PROGRAMS,
  SMOKE_V2_SCENARIOS,
} from "../../src/evaluation/lab/presets.js";
import { buildBudgetCheckpoint, runEvaluation } from "../../src/evaluation/lab/runner.js";
import { runReferenceProgram } from "../../src/evaluation/lab/reference-program.js";
import { buildProvenance, validateEvaluationConfig } from "../../src/evaluation/lab/validation.js";
import { findEvaluatorBudgetFailure, readEvaluatorBudget } from "../../src/server/routes/start-run-stream.js";

const projectRoot = resolve(import.meta.dirname ?? process.cwd(), "../../../");
const createdRunDirs: string[] = [];

afterEach(async () => {
  await Promise.all(createdRunDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function knownZeroCosts(): ScenarioObservation["costs"] {
  return {
    sutCost: { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: true },
    evaluatorModelCost: { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: false },
    codingAgentCost: { amountUsd: null, source: "unknown", countedAgainstSutCap: false },
  };
}

describe("Evaluation Lab contracts and grader", () => {
  it("detects raw IDs and state mutations", () => {
    const state = { project: { id: "proj-secret-777", name: "Project X" } };
    expect(containsRawId("This is secret proj-secret-777", state)).toBe(true);
    expect(containsRawId("Safe output description", state)).toBe(false);
    expect(containsRawId("Matches uuid 123e4567-e89b-12d3-a456-426614174000", state)).toBe(true);

    const before = { tasks: [{ id: "t1", status: "not_started" }], timeline: ["t1"] };
    const same = { tasks: [{ id: "t1", status: "not_started" }], timeline: ["t2"] };
    const changed = { tasks: [{ id: "t1", status: "in_progress" }] };
    expect(verifyStatePurity(before, same)).toBe(true);
    expect(verifyStatePurity(before, changed)).toBe(false);
  });

  it("keeps external Coding Agent cost separate and rejects unknown SUT cost", () => {
    const scenario: ScenarioContract = {
      schemaVersion: 1,
      scenarioId: "test-scenario",
      visible: { prompt: "test prompt" },
      hidden: {
        expectedMode: "answer",
        maxLatencyMs: 5_000,
        forbidRawIds: true,
        tokenBudget: { maxInputTokens: 100, maxOutputTokens: 100 },
        maxRequestCount: 2,
      },
    };
    const observation: ScenarioObservation = {
      schemaVersion: 1,
      scenarioId: scenario.scenarioId,
      timestamp: new Date().toISOString(),
      routedMode: "answer",
      selectedSkills: [],
      evidence: [],
      terminalStatus: "completed",
      latencyMs: 120,
      inputTokens: 10,
      outputTokens: 5,
      requestCount: 1,
      costs: knownZeroCosts(),
      output: "安全输出",
    };
    const state = { project: { id: "secret-id" } };
    expect(gradeObservation(scenario, observation, state, state).passed).toBe(true);

    const unknownSut = {
      ...observation,
      costs: {
        ...observation.costs,
        sutCost: { amountUsd: null, source: "unknown", countedAgainstSutCap: true } as const,
      },
    };
    const grade = gradeObservation(scenario, unknownSut, state, state);
    expect(grade.passed).toBe(false);
    expect(grade.budgetPassed).toBe(false);
  });
});

describe("Evaluation Lab validation", () => {
  it("accepts the repository mock model and refuses unbounded paid models", async () => {
    const valid = await validateEvaluationConfig({
      projectRoot,
      model: "mock:mock-model",
      scenarios: SLICE_0_SMOKE_SCENARIOS,
      budget: SLICE_0_SMOKE_BUDGET,
    });
    expect(valid.valid).toBe(true);

    const paid = await validateEvaluationConfig({
      projectRoot,
      model: "deepseek:deepseek-v4-flash",
      scenarios: SLICE_0_SMOKE_SCENARIOS,
      budget: SLICE_0_SMOKE_BUDGET,
    });
    expect(paid.valid).toBe(false);
    expect(paid.errors.some((error) => error.code === "paid_model_unbounded")).toBe(true);
  });
});

describe("Evaluation Lab public seam boundary", () => {
  const identity = {
    conversationId: "conversation-visible",
    workspaceId: "workspace-visible",
    projectId: "project-visible",
    viewerUserId: "viewer-visible",
    workspaceState: { project: { name: "公开项目" } },
  };

  it("fails closed on malformed SSE instead of grading a silent regression", async () => {
    expect(() => parseSse("event: done\ndata: {broken-json}\n\n")).toThrow(/SSE data JSON 无效/);
    const runner = createHttpPublicSeamRunner({
      baseUrl: "http://127.0.0.1:1",
      identity,
      fetchFn: async () => new Response("event: done\ndata: {broken-json}\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    });
    await expect(runner({
      id: "malformed-sse",
      prompt: "公开提示",
      expectedMode: "answer",
      requiredEvidence: [],
      maxLatencyMs: 1_000,
    }, "mock:mock-model")).rejects.toThrow(/SSE data JSON 无效/);
  });

  it("treats a valid but truncated SSE stream as infrastructure failure", async () => {
    const runner = createHttpPublicSeamRunner({
      baseUrl: "http://127.0.0.1:1",
      identity,
      fetchFn: async () => new Response(
        'event: status\ndata: {"run_id":"run","request_mode":"answer","selected_skills":[]}\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    });
    await expect(runner({
      id: "truncated-sse",
      prompt: "公开提示",
      expectedMode: "answer",
      requiredEvidence: [],
      maxLatencyMs: 1_000,
    }, "mock:mock-model")).rejects.toThrow(/终态事件前结束/);
  });

  it("sends only visible scenario input and preserves measured budget evidence", async () => {
    const hiddenSentinel = "HIDDEN-JUDGE-SENTINEL";
    let requestBody = "";
    const runner = createHttpPublicSeamRunner({
      baseUrl: "http://127.0.0.1:1",
      identity,
      evaluationAuth: { nonce: "nonce", instanceId: "instance" },
      fetchFn: async (_input, init) => {
        requestBody = String(init?.body ?? "");
        const sse = [
          'event: status\ndata: {"run_id":"run","request_mode":"answer","selected_skills":[]}',
          'event: evaluation_budget_exceeded\ndata: {"message":"输入 Token 超限","metrics":{"latency_ms":42,"input_tokens":123,"output_tokens":7,"model_request_count":2,"total_cost":0.03}}',
          "",
        ].join("\n\n");
        return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const scenario = {
      id: "hidden-boundary",
      prompt: "只允许发送的公开提示",
      expectedMode: "answer" as const,
      expectedSkill: hiddenSentinel,
      requiredEvidence: [hiddenSentinel],
      forbiddenOutputPatterns: [new RegExp(hiddenSentinel)],
      maxLatencyMs: 1_000,
      maxInputTokens: 100,
      maxOutputTokens: 100,
      maxRequestCount: 2,
      maxSutCostUsd: 0.10,
    };
    let budgetError: EvaluationBudgetError | undefined;
    try {
      await runner(scenario, "mock:mock-model");
    } catch (error) {
      budgetError = error as EvaluationBudgetError;
    }
    expect(requestBody).toContain("只允许发送的公开提示");
    expect(requestBody).not.toContain(hiddenSentinel);
    expect(budgetError).toBeInstanceOf(EvaluationBudgetError);
    expect(budgetError?.usage).toMatchObject({
      latencyMs: 42,
      inputTokens: 123,
      outputTokens: 7,
      requestCount: 2,
      cost: 0.03,
    });

    const contract: ScenarioContract = {
      schemaVersion: 1,
      scenarioId: scenario.id,
      visible: { prompt: scenario.prompt },
      hidden: {
        expectedMode: "answer",
        maxLatencyMs: 1_000,
        tokenBudget: { maxInputTokens: 100, maxOutputTokens: 100 },
        maxRequestCount: 2,
      },
    };
    const checkpoint = buildBudgetCheckpoint(contract, budgetError!);
    expect(checkpoint.observation.inputTokens).toBe(123);
    expect(checkpoint.observation.outputTokens).toBe(7);
    expect(checkpoint.observation.requestCount).toBe(2);
    expect(checkpoint.observation.costs.sutCost.amountUsd).toBe(0.03);
  });

  it("accepts evaluator ceilings only for the matching isolated instance", () => {
    const raw = {
      max_input_tokens: 100,
      max_output_tokens: 50,
      max_request_count: 2,
      max_cost_usd: 0.10,
    };
    const env = {
      APP_ENV: "evaluation",
      EVALUATION_NONCE: "nonce",
      EVALUATION_INSTANCE_ID: "instance",
    };
    expect(readEvaluatorBudget({}, raw, env).error?.status).toBe(403);
    const accepted = readEvaluatorBudget({
      "x-evaluation-nonce": "nonce",
      "x-evaluation-instance-id": "instance",
    }, raw, env);
    expect(accepted.error).toBeUndefined();
    expect(findEvaluatorBudgetFailure(accepted.budget, {
      inputTokens: 101,
      outputTokens: 7,
      requestCount: 1,
      cost: 0.03,
    })).toContain("输入 Token 101");
  });
});

describe("Evaluation Lab isolation", () => {
  it("rejects development and production health payloads", () => {
    expect(isExpectedEvaluationIdentity(
      { app_env: "development", service: "agent-bridge", evaluation_instance_id: "instance" },
      "agent-bridge",
      "instance",
    )).toBe(false);
    expect(isExpectedEvaluationIdentity(
      { app_env: "production", service: "agent-bridge", evaluation_instance_id: "instance" },
      "agent-bridge",
      "instance",
    )).toBe(false);
  });

  it.each(["development", "production"])(
    "does not inherit %s targets or provider credentials",
    (appEnv) => {
      const isolated = buildIsolatedChildEnv({
        PATH: "/trusted/bin",
        APP_ENV: appEnv,
        DATABASE_URL: `sqlite:////known-${appEnv}.sqlite`,
        FASTAPI_BASE_URL: `https://${appEnv}.example.invalid`,
        DEEPSEEK_API_KEY: "secret",
        INTERNAL_SERVICE_TOKEN: "production-token",
      });
      expect(isolated.PATH).toBe("/trusted/bin");
      expect(isolated.APP_ENV).toBeUndefined();
      expect(isolated.DATABASE_URL).toBeUndefined();
      expect(isolated.FASTAPI_BASE_URL).toBeUndefined();
      expect(isolated.DEEPSEEK_API_KEY).toBeUndefined();
      expect(isolated.INTERNAL_SERVICE_TOKEN).toBeUndefined();
    },
  );

  it("finds a free local loopback port", async () => {
    expect(await findFreePort()).toBeGreaterThan(1024);
  });

  it("starts an evaluator-owned pair with matching instance identity", async () => {
    const pair = new IsolatedProcessPair();
    try {
      await pair.start(projectRoot);
      expect(existsSync(pair.tempRoot)).toBe(true);
      expect(existsSync(join(pair.tempRoot, "uploads"))).toBe(true);
      expect(existsSync(join(pair.tempRoot, "model-configs.json"))).toBe(true);

      const missingIdentity = await fetch(`${pair.backendUrl}/api/health`, {
        headers: { "X-Evaluation-Nonce": pair.nonce },
      });
      expect(missingIdentity.status).toBe(403);

      for (const [url, service] of [
        [`${pair.backendUrl}/api/health`, "projectflow-backend"],
        [`${pair.sidecarUrl}/health`, "agent-bridge"],
      ] as const) {
        const response = await fetch(url, {
          headers: {
            "X-Evaluation-Nonce": pair.nonce,
            "X-Evaluation-Instance-Id": pair.instanceId,
          },
        });
        expect(response.ok).toBe(true);
        const data = await response.json() as Record<string, unknown>;
        expect(data.service).toBe(service);
        expect(data.evaluation_instance_id).toBe(pair.instanceId);
      }
    } finally {
      await pair.destroy();
    }
    expect(existsSync(pair.tempRoot)).toBe(false);
  }, 25_000);

  it("does not accept a nonce and identity from a previous evaluator instance", async () => {
    const first = new IsolatedProcessPair();
    await first.start(projectRoot);
    const stale = { nonce: first.nonce, instanceId: first.instanceId };
    await first.destroy();

    const second = new IsolatedProcessPair();
    try {
      await second.start(projectRoot);
      const response = await fetch(`${second.backendUrl}/api/health`, {
        headers: {
          "X-Evaluation-Nonce": stale.nonce,
          "X-Evaluation-Instance-Id": stale.instanceId,
        },
      });
      expect(response.status).toBe(403);
    } finally {
      await second.destroy();
    }
  }, 30_000);
});

describe("Evaluation Lab immutable end-to-end loop", () => {
  it("resumes only checkpoint pairs committed by their checksum marker", async () => {
    const runId = `checkpoint_${Date.now()}`;
    const runDir = join(projectRoot, "agent-bridge", "artifacts", runId);
    const firstTemp = await mkdtemp(join(tmpdir(), "eval-store-first-"));
    const secondTemp = await mkdtemp(join(tmpdir(), "eval-store-second-"));
    createdRunDirs.push(runDir, firstTemp, secondTemp);
    const manifest: RunManifest = {
      schemaVersion: 1,
      runId,
      preset: "smoke",
      model: "mock:mock-model",
      createdAt: new Date().toISOString(),
      scenarios: SLICE_0_SMOKE_SCENARIOS,
      budget: SLICE_0_SMOKE_BUDGET,
      provenance: await buildProvenance({ projectRoot, scenarios: SLICE_0_SMOKE_SCENARIOS }),
    };
    const scenario = SLICE_0_SMOKE_SCENARIOS[0]!;
    const observation: ScenarioObservation = {
      schemaVersion: 1,
      scenarioId: scenario.scenarioId,
      timestamp: new Date().toISOString(),
      routedMode: "answer",
      selectedSkills: [],
      evidence: [],
      terminalStatus: "completed",
      latencyMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      requestCount: 1,
      costs: knownZeroCosts(),
      output: "完成",
    };
    const grade: Grade = {
      schemaVersion: 1,
      scenarioId: scenario.scenarioId,
      passed: true,
      routingPassed: true,
      outcomePassed: true,
      latencyPassed: true,
      privacyPassed: true,
      budgetPassed: true,
      failures: [],
    };

    const firstStore = new EvaluationArtifactStore(projectRoot, runId, firstTemp);
    await firstStore.initialize(manifest, false);
    await firstStore.publishCheckpoint(observation, grade);
    await firstStore.releaseLock();

    const resumedStore = new EvaluationArtifactStore(projectRoot, runId, secondTemp);
    const resumed = await resumedStore.initialize(manifest, true);
    expect(resumed.observations.get(scenario.scenarioId)).toEqual(observation);
    expect(resumed.grades.get(scenario.scenarioId)).toEqual(grade);
    await resumedStore.releaseLock();
  });

  it("rejects unsupported future schemas before treating artifacts as V1", async () => {
    const runId = `future_schema_${Date.now()}`;
    const runDir = join(projectRoot, "agent-bridge", "artifacts", runId);
    const temp = await mkdtemp(join(tmpdir(), "eval-store-future-"));
    createdRunDirs.push(runDir, temp);
    const store = new EvaluationArtifactStore(projectRoot, runId, temp);
    await store.writeStatus("running", []);
    const statusPath = join(runDir, "status.json");
    const status = JSON.parse(await readFile(statusPath, "utf-8"));
    status.schemaVersion = 2;
    await writeFile(statusPath, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    await expect(store.readStatus()).rejects.toThrow(/schemaVersion 2 不受支持/);
  });

  it("rejects a pre-created run directory symlink before publishing evidence", async () => {
    const runId = `symlink_escape_${Date.now()}`;
    const runDir = join(projectRoot, "agent-bridge", "artifacts", runId);
    const outside = await mkdtemp(join(tmpdir(), "eval-artifact-outside-"));
    const evaluatorTemp = await mkdtemp(join(tmpdir(), "eval-store-symlink-"));
    createdRunDirs.push(runDir, outside, evaluatorTemp);
    await mkdir(join(projectRoot, "agent-bridge", "artifacts"), { recursive: true });
    await symlink(outside, runDir);
    const manifest: RunManifest = {
      schemaVersion: 1,
      runId,
      preset: "smoke",
      model: "mock:mock-model",
      createdAt: new Date().toISOString(),
      scenarios: SLICE_0_SMOKE_SCENARIOS,
      budget: SLICE_0_SMOKE_BUDGET,
      provenance: await buildProvenance({ projectRoot, scenarios: SLICE_0_SMOKE_SCENARIOS }),
    };
    const store = new EvaluationArtifactStore(projectRoot, runId, evaluatorTemp);
    await expect(store.initialize(manifest, false)).rejects.toThrow(/符号链接/);
    expect(existsSync(join(outside, "manifest.json"))).toBe(false);
  });

  it("publishes partial evidence when wall-time budget is exhausted", async () => {
    const runId = `budget_${Date.now()}`;
    const runDir = join(projectRoot, "agent-bridge", "artifacts", runId);
    createdRunDirs.push(runDir);
    const scenario: ScenarioContract = {
      ...SLICE_0_SMOKE_SCENARIOS[0]!,
      hidden: {
        ...SLICE_0_SMOKE_SCENARIOS[0]!.hidden,
        maxLatencyMs: 1,
      },
    };
    const report = await runEvaluation({
      projectRoot,
      runId,
      preset: "smoke",
      model: "mock:mock-model",
      scenarios: [scenario],
      budget: { ...SLICE_0_SMOKE_BUDGET, maxWallTimeMs: 1 },
      resume: false,
    });
    expect(report.status).toBe("partial_budget");
    expect(report.grades[0]?.budgetPassed).toBe(false);
    expect(report.integrityRootSha256).toMatch(/^[a-f0-9]{64}$/);
  }, 25_000);

  it("runs T43 smoke, verifies hashes, resumes idempotently, and detects tampering", async () => {
    const runId = `test_run_${Date.now()}`;
    const runDir = join(projectRoot, "agent-bridge", "artifacts", runId);
    createdRunDirs.push(runDir);

    const report = await runEvaluation({
      projectRoot,
      runId,
      preset: "smoke",
      model: "mock:mock-model",
      scenarios: SLICE_0_SMOKE_SCENARIOS,
      budget: SLICE_0_SMOKE_BUDGET,
      resume: false,
    });

    expect(report.status).toBe("completed");
    expect(report.summary.passedCount).toBe(1);
    expect(report.summary.sutCost.amountUsd).toBe(0);
    expect(report.summary.codingAgentCost.amountUsd).toBeNull();
    expect(report.integrityRootSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(join(runDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(runDir, "integrity.json"))).toBe(true);
    expect((await stat(runDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(runDir, "manifest.json"))).mode & 0o777).toBe(0o400);

    const resumed = await runEvaluation({
      projectRoot,
      runId,
      preset: "smoke",
      model: "mock:mock-model",
      scenarios: SLICE_0_SMOKE_SCENARIOS,
      budget: SLICE_0_SMOKE_BUDGET,
      resume: true,
    });
    expect(resumed.integrityRootSha256).toBe(report.integrityRootSha256);

    const integrityPath = join(runDir, "integrity.json");
    const integrityRaw = await readFile(integrityPath, "utf-8");
    const futureIntegrity = JSON.parse(integrityRaw);
    futureIntegrity.schemaVersion = 2;
    await chmod(integrityPath, 0o600);
    await writeFile(integrityPath, `${JSON.stringify(futureIntegrity, null, 2)}\n`, "utf-8");
    const futureStore = new EvaluationArtifactStore(projectRoot, runId, tmpdir());
    await expect(futureStore.readVerifiedArtifact()).rejects.toThrow(/schemaVersion 2 不受支持/);
    await writeFile(integrityPath, integrityRaw, "utf-8");
    await chmod(integrityPath, 0o400);

    const observationPath = join(runDir, "observations", "answer-no-tool.json");
    await chmod(observationPath, 0o644);
    const observation = JSON.parse(await readFile(observationPath, "utf-8"));
    observation.output = "tampered";
    await writeFile(observationPath, JSON.stringify(observation), "utf-8");
    const store = new EvaluationArtifactStore(projectRoot, runId, tmpdir());
    await expect(store.readVerifiedArtifact()).rejects.toThrow(/哈希校验失败/);
  }, 35_000);

  it("runs Slice 1 public behavior plus confirm/reject seams without leaking hidden fields", async () => {
    const runId = `hard_domain_${Date.now()}`;
    const runDir = join(projectRoot, "agent-bridge", "artifacts", runId);
    createdRunDirs.push(runDir);
    const report = await runEvaluation({
      projectRoot,
      runId,
      preset: "smoke-v2",
      model: "mock:mock-model",
      scenarios: SMOKE_V2_SCENARIOS,
      budget: SMOKE_V2_BUDGET,
      resume: false,
    });
    expect(report.status).toBe("completed");
    expect(report.summary).toMatchObject({ passedCount: 3, failedCount: 0, passRate: 1 });
    expect(report.grades.every((grade) => grade.hardGrade?.passed === true)).toBe(true);
    const manifest = await readFile(join(runDir, "manifest.json"), "utf-8");
    expect(manifest).not.toContain("HIDDEN_GOAL_TOKEN_T46_2_DO_NOT_LEAK");
    expect(manifest).toContain("hiddenFieldTokenDigests");
    expect(await readFile(join(runDir, "report.json"), "utf-8"))
      .not.toContain("HIDDEN_GOAL_TOKEN_T46_2_DO_NOT_LEAK");
  }, 35_000);

  it("runs a real isolated reference path with zero false hard failures", async () => {
    const pair = new IsolatedProcessPair();
    await pair.start(projectRoot, "mock:mock-model");
    try {
      for (const scenario of SMOKE_V2_SCENARIOS) {
        if (!scenario.hardGrader) throw new Error("smoke-v2 oracle missing");
        const reference = SMOKE_V2_REFERENCE_PROGRAMS[scenario.scenarioId];
        if (!reference) throw new Error(`smoke-v2 reference missing: ${scenario.scenarioId}`);
        const result = await runReferenceProgram(reference, scenario.hardGrader, {
          backendBaseUrl: pair.backendUrl,
          sidecarBaseUrl: pair.sidecarUrl,
          adminToken: pair.adminToken,
          internalServiceToken: pair.internalServiceToken,
          evaluationNonce: pair.nonce,
          evaluationInstanceId: pair.instanceId,
          workspaceId: "demo-workspace-001",
          projectId: "demo-project-001",
          model: "mock:mock-model",
          maxLatencyMs: scenario.hidden.maxLatencyMs,
          maxInputTokens: scenario.hidden.tokenBudget.maxInputTokens,
          maxOutputTokens: scenario.hidden.tokenBudget.maxOutputTokens,
          maxRequestCount: scenario.hidden.maxRequestCount,
          maxSutCostUsd: 0.10,
        });
        expect(result.passed, result.hardGrade.failures.join("\n")).toBe(true);
      }
    } finally {
      await pair.destroy();
    }
  }, 35_000);
});
