import { describe, expect, it } from "vitest";
import { exportTrajectory } from "../../src/evaluation/trajectory-exporter.js";
import { RELEASE_SCENARIOS, runScenarioEval, runRepeatedScenarioEval, type AgentScenario, type ObservationContext } from "../../src/evaluation/scenario-eval.js";
import { runModelCanary } from "../../src/evaluation/model-conformance.js";
import { createHttpPublicSeamRunner } from "../../src/evaluation/http-public-seam-runner.js";
import { createSkillIndex } from "../../src/skills/skill-index.js";
import { routeSkills } from "../../src/skills/skill-router.js";
import { mapPiEvent, type PiEvent } from "../../src/events/event-mapper.js";

const scenarios: AgentScenario[] = [{
  id: "status",
  prompt: "查看项目现状",
  expectedMode: "action",
  expectedSkill: "project-status",
  requiredEvidence: ["get_project_state"],
  maxLatencyMs: 100,
}];

const runner = async () => ({
  routedMode: "action" as const,
  selectedSkills: ["project-status"],
  evidence: ["get_project_state"],
  terminalStatus: "completed" as const,
  latencyMs: 10,
  inputTokens: 20,
  outputTokens: 10,
  cost: 0.01,
  outputPolicyPassed: true,
});

describe("operational Agent evaluation", () => {
  it("exports a redacted trajectory with usage and verifier evidence", () => {
    const trajectory = exportTrajectory("run-secret", [
      { type: "run.started", event_seq: 1, created_at: "2026-07-12T00:00:00Z", payload: { model: "mock:a" } },
      { type: "agent.status", event_seq: 2, created_at: "2026-07-12T00:00:01Z", payload: { usage: { input: 20, output: 10 }, cost: { total: 0.01 } } },
      { type: "verifier.completed", event_seq: 3, created_at: "2026-07-12T00:00:02Z", payload: { passed: true } },
      { type: "agent.completed", event_seq: 4, created_at: "2026-07-12T00:00:03Z", payload: {} },
    ]);
    expect(trajectory.runIdHash).not.toContain("run-secret");
    expect(trajectory.inputTokens).toBe(20);
    expect(trajectory.outputTokens).toBe(10);
    // Provider did not supply reasoning/cache — must be absent, not zero.
    expect(trajectory.reasoningTokens).toBeUndefined();
    expect(trajectory.cacheReadTokens).toBeUndefined();
    expect(trajectory.cacheWriteTokens).toBeUndefined();
    // Provider explicitly supplied cost.total=0.01 — must be present.
    expect(trajectory.totalCost).toBe(0.01);
    // No per-key cost breakdown supplied — must be absent.
    expect(trajectory.costBreakdown).toBeUndefined();
    expect(trajectory.latencyMs).toBe(3000);
    expect(trajectory.verifierPassed).toBe(true);
  });

  it("accumulates reasoning, cache and cost breakdown from events", () => {
    const trajectory = exportTrajectory("run-cache", [
      { type: "run.started", event_seq: 1, created_at: "2026-07-12T00:00:00Z", payload: {} },
      { type: "agent.status", event_seq: 2, created_at: "2026-07-12T00:00:01Z", payload: { usage: { input: 200, output: 50, reasoning: 30, cacheRead: 150, cacheWrite: 20 }, cost: { total: 0.008, input: 0.005, output: 0.003 } } },
      { type: "agent.status", event_seq: 3, created_at: "2026-07-12T00:00:02Z", payload: { usage: { input: 100, output: 20, cacheRead: 80 }, cost: { total: 0.004, input: 0.003, output: 0.001 } } },
      { type: "agent.completed", event_seq: 4, created_at: "2026-07-12T00:00:03Z", payload: {} },
    ]);
    expect(trajectory.inputTokens).toBe(300);
    expect(trajectory.outputTokens).toBe(70);
    expect(trajectory.reasoningTokens).toBe(30);
    expect(trajectory.cacheReadTokens).toBe(230);
    expect(trajectory.cacheWriteTokens).toBe(20);
    expect(trajectory.totalCost).toBe(0.012);
    expect(trajectory.costBreakdown).toEqual({ input: 0.008, output: 0.004 });
  });

  it("preserves explicit provider zero as measured zero, not absent", () => {
    const trajectory = exportTrajectory("run-explicit-zero", [
      { type: "run.started", event_seq: 1, created_at: "2026-07-12T00:00:00Z", payload: {} },
      { type: "agent.status", event_seq: 2, created_at: "2026-07-12T00:00:01Z", payload: { usage: { input: 100, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: { total: 0 } } },
      { type: "agent.completed", event_seq: 3, created_at: "2026-07-12T00:00:02Z", payload: {} },
    ]);
    // Provider explicitly reported 0 for all fields — must be present as 0, not absent.
    expect(trajectory.reasoningTokens).toBe(0);
    expect(trajectory.cacheReadTokens).toBe(0);
    expect(trajectory.cacheWriteTokens).toBe(0);
    expect(trajectory.totalCost).toBe(0);
  });

  it("computes routing, outcome, latency, token and cost gates", async () => {
    const report = await runScenarioEval("mock:a", scenarios, runner);
    expect(report.passed).toBe(true);
    expect(report.routingAccuracy).toBe(1);
    expect(report.outcomePassRate).toBe(1);
    expect(report.totalInputTokens).toBe(20);
    expect(report.totalCost).toBe(0.01);
  });

  it("requires distinct primary and fallback models", async () => {
    await expect(runModelCanary("mock:a", "mock:a", scenarios, runner)).rejects.toThrow("distinct");
  });

  it("passes only when both model configurations pass", async () => {
    const report = await runModelCanary("mock:a", "mock:b", scenarios, runner);
    expect(report.passed).toBe(true);
    expect(report.primary.model).toBe("mock:a");
    expect(report.fallback.model).toBe("mock:b");
  });

  it("measures the production HTTP/SSE seam", async () => {
    const fetchFn = async () => new Response([
      'event: status\ndata: {"phase":"planning","message":"正在理解你的需求...","run_id":"run-1","request_mode":"action","selected_skills":["project-status"]}',
      'event: tool\ndata: {"phase":"completed","tool_call_id":"tc-1","tool_name":"get_project_state"}',
      'event: done\ndata: {"run_id":"run-1","status":"completed","final_content":"完成","metrics":{"latency_ms":12,"input_tokens":30,"output_tokens":8,"total_cost":0.02}}',
    ].join("\n\n"), { status: 200 }) as Promise<Response>;
    const httpRunner = createHttpPublicSeamRunner({
      baseUrl: "http://sidecar.test",
      identity: { conversationId: "c", workspaceId: "w", projectId: "p", viewerUserId: "u", workspaceState: {} },
      fetchFn: fetchFn as typeof fetch,
    });
    const observation = await httpRunner(scenarios[0]!, "mock:a");
    expect(observation.selectedSkills).toEqual(["project-status"]);
    expect(observation.evidence).toEqual(["get_project_state"]);
    expect(observation.inputTokens).toBe(30);
    expect(observation.cost).toBe(0.02);
    expect(observation.outputPolicyPassed).toBe(true);
  });

  it("checks actual workspace IDs without treating normal snake_case terms as IDs", async () => {
    const fetchFn = async () => new Response([
      'event: status\ndata: {"run_id":"run-1","request_mode":"action","selected_skills":["assignment-planning"]}',
      'event: done\ndata: {"status":"completed","final_content":"project_management 建议正常","metrics":{}}',
    ].join("\n\n"), { status: 200 }) as Promise<Response>;
    const httpRunner = createHttpPublicSeamRunner({
      baseUrl: "http://sidecar.test",
      identity: {
        conversationId: "c",
        workspaceId: "w",
        projectId: "p",
        viewerUserId: "u",
        workspaceState: { project: { id: "project-secret-123" } },
      },
      fetchFn: fetchFn as typeof fetch,
    });
    const scenario: AgentScenario = {
      id: "privacy",
      prompt: "推荐分工",
      expectedMode: "action",
      requiredEvidence: [],
      forbidRawIds: true,
      maxLatencyMs: 100,
    };
    const safe = await httpRunner(scenario, "mock:a");
    expect(safe.outputPolicyPassed).toBe(true);

    const leakingFetch = async () => new Response([
      'event: status\ndata: {"run_id":"run-2","request_mode":"action","selected_skills":["assignment-planning"]}',
      'event: done\ndata: {"status":"completed","final_content":"project-secret-123","metrics":{}}',
    ].join("\n\n"), { status: 200 }) as Promise<Response>;
    const leakingRunner = createHttpPublicSeamRunner({
      baseUrl: "http://sidecar.test",
      identity: {
        conversationId: "c",
        workspaceId: "w",
        projectId: "p",
        viewerUserId: "u",
        workspaceState: { project: { id: "project-secret-123" } },
      },
      fetchFn: leakingFetch as typeof fetch,
    });
    const leaking = await leakingRunner(scenario, "mock:a");
    expect(leaking.outputPolicyPassed).toBe(false);
  });

  it("routes the release scenarios from intent rather than satisfied prerequisites", async () => {
    const index = await createSkillIndex();
    const workspaceState = { members: [{}], project: { direction_card: {}, stages: [{}], tasks: [{}] } };
    for (const scenario of RELEASE_SCENARIOS) {
      const result = routeSkills(index.getAll(), { userContent: scenario.prompt, workspaceState });
      expect(result.selected.map((skill) => skill.name)).toEqual(
        scenario.expectedSkill ? [scenario.expectedSkill] : [],
      );
    }
  });

  it("extracts token and cost telemetry from Pi message_end", () => {
    const event: PiEvent = {
      type: "message_end",
      message: { role: "assistant", usage: { input: 120, output: 30, cost: { total: 0.0042 } } },
    };
    const mapped = mapPiEvent(event, "run-1");
    expect(mapped.payload.usage).toEqual({ input: 120, output: 30 });
    expect(mapped.payload.cost).toEqual({ total: 0.0042 });
  });

  it("preserves reasoning and cache fields when provider supplies them", () => {
    const event: PiEvent = {
      type: "message_end",
      message: {
        role: "assistant",
        usage: {
          input: 200,
          output: 50,
          reasoning: 30,
          cacheRead: 150,
          cacheWrite: 20,
          cost: { total: 0.008, input: 0.005, output: 0.003 },
        },
      },
    };
    const mapped = mapPiEvent(event, "run-1");
    expect(mapped.payload.usage).toEqual({
      input: 200, output: 50, reasoning: 30, cacheRead: 150, cacheWrite: 20,
    });
    expect(mapped.payload.cost).toEqual({ total: 0.008, input: 0.005, output: 0.003 });
  });

  it("omits cache fields when provider does not supply them", () => {
    const event: PiEvent = {
      type: "message_end",
      message: { role: "assistant", usage: { input: 100, output: 20 } },
    };
    const mapped = mapPiEvent(event, "run-1");
    expect(mapped.payload.usage).toEqual({ input: 100, output: 20 });
    expect(mapped.payload.usage).not.toHaveProperty("reasoning");
    expect(mapped.payload.usage).not.toHaveProperty("cacheRead");
    expect(mapped.payload.usage).not.toHaveProperty("cacheWrite");
    expect(mapped.payload).not.toHaveProperty("cost");
  });

  it("omits usage when message has no usage object", () => {
    const event: PiEvent = {
      type: "message_end",
      message: { role: "assistant" },
    };
    const mapped = mapPiEvent(event, "run-1");
    expect(mapped.payload).not.toHaveProperty("usage");
    expect(mapped.payload).not.toHaveProperty("cost");
  });

  it("fails when no acceptable evidence exists or the output policy is violated", async () => {
    const guardedScenario: AgentScenario = {
      id: "guarded",
      prompt: "检查状态",
      expectedMode: "action",
      requiredEvidence: [],
      requiredAnyEvidence: ["get_workspace_state", "get_timeline_slice"],
      forbiddenOutputPatterns: [/raw-id/],
      maxLatencyMs: 100,
    };
    const report = await runScenarioEval("mock:a", [guardedScenario], async () => ({
      ...await runner(),
      evidence: [],
      outputPolicyPassed: false,
    }));
    expect(report.passed).toBe(false);
    expect(report.results[0]!.failures).toContain("outcome:any_evidence");
    expect(report.results[0]!.failures).toContain("outcome:output_policy");
  });

  it("parses cache and reasoning tokens from HTTP/SSE metrics", async () => {
    const fetchFn = async () => new Response([
      'event: status\ndata: {"phase":"planning","run_id":"run-cache","request_mode":"answer","selected_skills":[]}',
      'event: done\ndata: {"run_id":"run-cache","status":"completed","final_content":"ok","metrics":{"latency_ms":100,"input_tokens":500,"output_tokens":50,"reasoning_tokens":120,"cache_read_tokens":300,"cache_write_tokens":80,"total_cost":0.005}}',
    ].join("\n\n"), { status: 200 }) as Promise<Response>;
    const httpRunner = createHttpPublicSeamRunner({
      baseUrl: "http://sidecar.test",
      identity: { conversationId: "c", workspaceId: "w", projectId: "p", viewerUserId: "u", workspaceState: {} },
      fetchFn: fetchFn as typeof fetch,
    });
    const obs = await httpRunner({ id: "answer", prompt: "test", expectedMode: "answer", requiredEvidence: [], maxLatencyMs: 5000 }, "mock:a");
    expect(obs.reasoningTokens).toBe(120);
    expect(obs.cacheReadTokens).toBe(300);
    expect(obs.cacheWriteTokens).toBe(80);
    expect(obs.inputTokens).toBe(500);
    expect(obs.outputTokens).toBe(50);
    expect(obs.cost).toBe(0.005);
  });

  it("sets cache tokens to undefined when provider does not supply them", async () => {
    const fetchFn = async () => new Response([
      'event: status\ndata: {"phase":"planning","run_id":"run-nocache","request_mode":"answer","selected_skills":[]}',
      'event: done\ndata: {"run_id":"run-nocache","status":"completed","final_content":"ok","metrics":{"latency_ms":50,"input_tokens":100,"output_tokens":20,"total_cost":0.001}}',
    ].join("\n\n"), { status: 200 }) as Promise<Response>;
    const httpRunner = createHttpPublicSeamRunner({
      baseUrl: "http://sidecar.test",
      identity: { conversationId: "c", workspaceId: "w", projectId: "p", viewerUserId: "u", workspaceState: {} },
      fetchFn: fetchFn as typeof fetch,
    });
    const obs = await httpRunner({ id: "answer", prompt: "test", expectedMode: "answer", requiredEvidence: [], maxLatencyMs: 5000 }, "mock:a");
    expect(obs.reasoningTokens).toBeUndefined();
    expect(obs.cacheReadTokens).toBeUndefined();
    expect(obs.cacheWriteTokens).toBeUndefined();
  });

  it("runRepeatedScenarioEval aggregates per-scenario statistics", async () => {
    const wideLatencyScenario: AgentScenario = {
      id: "status",
      prompt: "查看项目现状",
      expectedMode: "action",
      expectedSkill: "project-status",
      requiredEvidence: ["get_project_state"],
      maxLatencyMs: 10_000,
    };
    let callCount = 0;
    const repeatRunner = async () => {
      callCount++;
      return {
        routedMode: "action" as const,
        selectedSkills: ["project-status"],
        evidence: ["get_project_state"],
        terminalStatus: "completed" as const,
        latencyMs: 100 + callCount * 10, // varying latency
        inputTokens: 200 + callCount * 5,
        outputTokens: 50,
        reasoningTokens: 30,
        cacheReadTokens: 150,
        cacheWriteTokens: 20,
        cost: 0.01 + callCount * 0.001,
        outputPolicyPassed: true,
      };
    };
    const report = await runRepeatedScenarioEval("mock:a", [wideLatencyScenario], repeatRunner, 3);
    expect(report.repeats).toBe(3);
    expect(report.results).toHaveLength(1);
    const result = report.results[0]!;
    expect(result.scenarioId).toBe("status");
    expect(result.passCount).toBe(3);
    expect(result.failCount).toBe(0);
    expect(result.passRate).toBe(1);
    expect(result.repeats).toHaveLength(3);
    expect(result.latency.count).toBe(3);
    expect(result.latency.min).toBe(110);
    expect(result.latency.max).toBe(130);
    expect(result.latency.stdDev).toBeGreaterThan(0);
    expect(result.inputTokens.count).toBe(3);
    expect(result.reasoningTokens).toBeDefined();
    expect(result.reasoningTokens!.count).toBe(3);
    expect(result.reasoningTokens!.mean).toBe(30);
    expect(result.cacheReadTokens).toBeDefined();
    expect(result.cacheReadTokens!.mean).toBe(150);
    expect(result.cacheWriteTokens).toBeDefined();
    expect(result.cacheWriteTokens!.mean).toBe(20);
    expect(result.cost.count).toBe(3);
    expect(callCount).toBe(3); // each scenario ran 3 times
  });

  it("runRepeatedScenarioEval reports partial pass when some repeats fail", async () => {
    let callCount = 0;
    const flakyRunner = async () => {
      callCount++;
      return {
        routedMode: "action" as const,
        selectedSkills: ["project-status"],
        evidence: callCount === 2 ? [] : ["get_project_state"], // fail on 2nd call
        terminalStatus: callCount === 2 ? "failed" as const : "completed" as const,
        latencyMs: 10,
        inputTokens: 20,
        outputTokens: 10,
        cost: 0.01,
        outputPolicyPassed: true,
      };
    };
    const report = await runRepeatedScenarioEval("mock:a", scenarios, flakyRunner, 3);
    expect(report.results[0]!.passCount).toBe(2);
    expect(report.results[0]!.failCount).toBe(1);
    expect(report.results[0]!.passRate).toBeCloseTo(2 / 3);
    expect(report.results[0]!.allOutcomePassed).toBe(false);
  });

  it("runRepeatedScenarioEval cache tokens absent when no repeat supplies them", async () => {
    const noCacheRunner = async () => ({
      routedMode: "action" as const,
      selectedSkills: ["project-status"],
      evidence: ["get_project_state"],
      terminalStatus: "completed" as const,
      latencyMs: 10,
      inputTokens: 20,
      outputTokens: 10,
      cost: 0.01,
      outputPolicyPassed: true,
    });
    const report = await runRepeatedScenarioEval("mock:a", scenarios, noCacheRunner, 3);
    expect(report.results[0]!.reasoningTokens).toBeUndefined();
    expect(report.results[0]!.cacheReadTokens).toBeUndefined();
    expect(report.results[0]!.cacheWriteTokens).toBeUndefined();
  });

  it("runModelCanary with repeats>1 uses repeated evaluation", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const countingRunner = async (_scenario: AgentScenario, model: string) => {
      if (model === "mock:a") primaryCalls++;
      else fallbackCalls++;
      return {
        routedMode: "action" as const,
        selectedSkills: ["project-status"],
        evidence: ["get_project_state"],
        terminalStatus: "completed" as const,
        latencyMs: 10,
        inputTokens: 20,
        outputTokens: 10,
        cost: 0.01,
        outputPolicyPassed: true,
      };
    };
    const report = await runModelCanary("mock:a", "mock:b", scenarios, countingRunner, 3);
    expect(report.passed).toBe(true);
    expect(primaryCalls).toBe(3); // 1 scenario × 3 repeats
    expect(fallbackCalls).toBe(3);
    // With repeats>1, report should contain RepeatedScenarioReport
    expect("repeats" in report.primary).toBe(true);
    expect((report.primary as any).repeats).toBe(3);
  });

  // ── Absent cost stays undefined through HTTP seam ──

  it("cost stays undefined when provider does not supply total_cost in SSE metrics", async () => {
    const fetchFn = async () => new Response([
      'event: status\ndata: {"phase":"planning","run_id":"run-nocost","request_mode":"answer","selected_skills":[]}',
      'event: done\ndata: {"run_id":"run-nocost","status":"completed","final_content":"ok","metrics":{"latency_ms":50,"input_tokens":100,"output_tokens":20}}',
    ].join("\n\n"), { status: 200 }) as Promise<Response>;
    const httpRunner = createHttpPublicSeamRunner({
      baseUrl: "http://sidecar.test",
      identity: { conversationId: "c", workspaceId: "w", projectId: "p", viewerUserId: "u", workspaceState: {} },
      fetchFn: fetchFn as typeof fetch,
    });
    const obs = await httpRunner({ id: "answer", prompt: "test", expectedMode: "answer", requiredEvidence: [], maxLatencyMs: 5000 }, "mock:a");
    // Provider-unknown cost must remain undefined, not synthetic zero.
    expect(obs.cost).toBeUndefined();
    expect(obs.reasoningTokens).toBeUndefined();
    expect(obs.cacheReadTokens).toBeUndefined();
    expect(obs.cacheWriteTokens).toBeUndefined();
  });

  it("one-pass report keeps unknown total cost absent and exposes privacy rate", async () => {
    const noCostRunner = async () => ({
      routedMode: "action" as const,
      selectedSkills: ["project-status"],
      evidence: ["get_project_state"],
      terminalStatus: "completed" as const,
      latencyMs: 10,
      inputTokens: 20,
      outputTokens: 10,
      outputPolicyPassed: true,
    });
    const report = await runScenarioEval("mock:a", scenarios, noCostRunner);
    expect(report.totalCost).toBeUndefined();
    expect(report.privacyPassRate).toBe(1);
    expect(report.privacyGate).toBe(true);
  });

  it("explicit provider zero cost stays zero, not absent", async () => {
    const fetchFn = async () => new Response([
      'event: status\ndata: {"phase":"planning","run_id":"run-zero","request_mode":"answer","selected_skills":[]}',
      'event: done\ndata: {"run_id":"run-zero","status":"completed","final_content":"ok","metrics":{"latency_ms":50,"input_tokens":100,"output_tokens":20,"reasoning_tokens":0,"cache_read_tokens":0,"cache_write_tokens":0,"total_cost":0}}',
    ].join("\n\n"), { status: 200 }) as Promise<Response>;
    const httpRunner = createHttpPublicSeamRunner({
      baseUrl: "http://sidecar.test",
      identity: { conversationId: "c", workspaceId: "w", projectId: "p", viewerUserId: "u", workspaceState: {} },
      fetchFn: fetchFn as typeof fetch,
    });
    const obs = await httpRunner({ id: "answer", prompt: "test", expectedMode: "answer", requiredEvidence: [], maxLatencyMs: 5000 }, "mock:a");
    // Explicit provider zero must remain as observed zero.
    expect(obs.cost).toBe(0);
    expect(obs.reasoningTokens).toBe(0);
    expect(obs.cacheReadTokens).toBe(0);
    expect(obs.cacheWriteTokens).toBe(0);
  });

  // ── Repeated report: absent metrics stay undefined, explicit zeros preserved ──

  it("repeated report preserves absent cost as undefined and explicit zero as zero", async () => {
    let callCount = 0;
    const mixedRunner = async () => {
      callCount++;
      return {
        routedMode: "action" as const,
        selectedSkills: ["project-status"],
        evidence: ["get_project_state"],
        terminalStatus: "completed" as const,
        latencyMs: 10,
        inputTokens: 20,
        outputTokens: 10,
        // First call: cost absent. Second call: explicit zero.
        cost: callCount === 1 ? undefined : 0,
        outputPolicyPassed: true,
      };
    };
    const report = await runRepeatedScenarioEval("mock:a", scenarios, mixedRunner, 2);
    const result = report.results[0]!;
    // Only 1 of 2 repeats supplied cost → coverage = 1.
    expect(result.metricCoverage.cost).toBe(1);
    // Cost stats computed over the 1 observation that supplied it.
    expect(result.cost).toBeDefined();
    expect(result.cost!.count).toBe(1);
    expect(result.cost!.min).toBe(0);
    expect(result.cost!.max).toBe(0);
    // Total cost sums only observed values: 0 (from repeat 2).
    expect(report.totalCost).toBe(0);
  });

  // ── Uncached input: only when both input + cache-read known ──

  it("computes uncached input only when cache-read is observed on every repeat", async () => {
    const withCacheRunner = async () => ({
      routedMode: "action" as const,
      selectedSkills: ["project-status"],
      evidence: ["get_project_state"],
      terminalStatus: "completed" as const,
      latencyMs: 10,
      inputTokens: 500,
      outputTokens: 50,
      cacheReadTokens: 300,
      cost: 0.01,
      outputPolicyPassed: true,
    });
    const report = await runRepeatedScenarioEval("mock:a", scenarios, withCacheRunner, 3);
    const result = report.results[0]!;
    // All repeats have cacheRead → uncachedInput defined.
    expect(result.uncachedInput).toBeDefined();
    expect(result.uncachedInput!.count).toBe(3);
    // 500 - 300 = 200 per repeat.
    expect(result.uncachedInput!.mean).toBe(200);
    expect(result.uncachedInput!.min).toBe(200);
  });

  it("uncached input computed over repeats where cache-read is observed", async () => {
    let callCount = 0;
    const partialCacheRunner = async () => {
      callCount++;
      return {
        routedMode: "action" as const,
        selectedSkills: ["project-status"],
        evidence: ["get_project_state"],
        terminalStatus: "completed" as const,
        latencyMs: 10,
        inputTokens: 500,
        outputTokens: 50,
        cacheReadTokens: callCount === 1 ? 300 : undefined,
        cost: 0.01,
        outputPolicyPassed: true,
      };
    };
    const report = await runRepeatedScenarioEval("mock:a", scenarios, partialCacheRunner, 2);
    const result = report.results[0]!;
    // 1 of 2 repeats has cacheRead → uncachedInput computed over that 1 observation.
    expect(result.uncachedInput).toBeDefined();
    expect(result.uncachedInput!.count).toBe(1);
    expect(result.uncachedInput!.mean).toBe(200); // 500 - 300 = 200
    expect(result.metricCoverage.cacheRead).toBe(1);
    expect(result.metricCoverage.uncachedInput).toBe(1);
  });

  it("uncached input never goes negative even with oversized cache-read", async () => {
    const oversizedCacheRunner = async () => ({
      routedMode: "action" as const,
      selectedSkills: ["project-status"],
      evidence: ["get_project_state"],
      terminalStatus: "completed" as const,
      latencyMs: 10,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 200, // More than input — provider anomaly.
      cost: 0.01,
      outputPolicyPassed: true,
    });
    const report = await runRepeatedScenarioEval("mock:a", scenarios, oversizedCacheRunner, 1);
    const result = report.results[0]!;
    expect(result.uncachedInput).toBeDefined();
    // 100 - 200 = -100 but clamped to max(0, ...) because provider counters
    // may use different scopes and negative uncached input is not meaningful.
    expect(result.uncachedInput!.min).toBe(0);
    expect(result.uncachedInput!.max).toBe(0);
    expect(result.metricCoverage.uncachedInput).toBe(1);
  });

  // ── Privacy pass counts/rates per scenario and top-level ──

  it("exposes privacy pass counts and rates per scenario and top-level", async () => {
    let callCount = 0;
    const privacyRunner = async () => {
      callCount++;
      return {
        routedMode: "action" as const,
        selectedSkills: ["project-status"],
        evidence: ["get_project_state"],
        terminalStatus: "completed" as const,
        latencyMs: 10,
        inputTokens: 20,
        outputTokens: 10,
        cost: 0.01,
        // Fail privacy on 2nd call.
        outputPolicyPassed: callCount !== 2,
      };
    };
    const report = await runRepeatedScenarioEval("mock:a", scenarios, privacyRunner, 3);
    const result = report.results[0]!;
    expect(result.privacyPassCount).toBe(2);
    expect(result.privacyPassRate).toBeCloseTo(2 / 3);
    expect(result.privacyAllPassed).toBe(false);
    // Top-level: observation-level privacy pass rate = 2/3 (2 of 3 observations passed).
    expect(report.privacyPassRate).toBeCloseTo(2 / 3);
    // Gate fails because 2/3 < 0.9.
    expect(report.privacyGate).toBe(false);
  });

  it("privacy gate passes when all scenarios pass all repeats", async () => {
    const report = await runRepeatedScenarioEval("mock:a", scenarios, runner, 3);
    expect(report.privacyPassRate).toBe(1);
    expect(report.privacyGate).toBe(true);
    expect(report.results[0]!.privacyAllPassed).toBe(true);
  });

  // ── Metric coverage counts ──

  it("tracks metric coverage counts showing how many repeats supplied each optional metric", async () => {
    let callCount = 0;
    const partialMetricsRunner = async () => {
      callCount++;
      return {
        routedMode: "action" as const,
        selectedSkills: ["project-status"],
        evidence: ["get_project_state"],
        terminalStatus: "completed" as const,
        latencyMs: 10,
        inputTokens: 20,
        outputTokens: 10,
        reasoningTokens: callCount <= 2 ? 30 : undefined,
        cacheReadTokens: callCount === 1 ? 150 : undefined,
        cacheWriteTokens: undefined,
        cost: 0.01,
        outputPolicyPassed: true,
      };
    };
    const report = await runRepeatedScenarioEval("mock:a", scenarios, partialMetricsRunner, 3);
    const result = report.results[0]!;
    expect(result.metricCoverage.reasoning).toBe(2);
    expect(result.metricCoverage.cacheRead).toBe(1);
    expect(result.metricCoverage.cacheWrite).toBe(0);
    expect(result.metricCoverage.cost).toBe(3);
    expect(result.metricCoverage.uncachedInput).toBe(1); // same as cacheRead
  });

  // ── Sequential model execution and isolation hook ──

  it("primary and fallback models execute sequentially, not in parallel", async () => {
    const executionOrder: string[] = [];
    const sequencingRunner = async (_scenario: AgentScenario, model: string) => {
      executionOrder.push(`start:${model}`);
      // Small delay to ensure parallel execution would interleave.
      await new Promise((r) => setTimeout(r, 5));
      executionOrder.push(`end:${model}`);
      return {
        routedMode: "action" as const,
        selectedSkills: ["project-status"],
        evidence: ["get_project_state"],
        terminalStatus: "completed" as const,
        latencyMs: 10,
        inputTokens: 20,
        outputTokens: 10,
        cost: 0.01,
        outputPolicyPassed: true,
      };
    };
    await runModelCanary("mock:a", "mock:b", scenarios, sequencingRunner, 1);
    // Sequential: primary fully completes before fallback starts.
    const primaryEnd = executionOrder.indexOf("end:mock:a");
    const fallbackStart = executionOrder.indexOf("start:mock:b");
    expect(primaryEnd).toBeLessThan(fallbackStart);
  });

  it("each scenario repeat invokes the isolation hook exactly once before the public run", async () => {
    const hookCalls: Array<{ scenario: string; model: string; repeat: number }> = [];
    const ctx: ObservationContext = {
      beforeObservation: async (scenario, model, repeatIndex) => {
        hookCalls.push({ scenario: scenario.id, model, repeat: repeatIndex });
      },
    };
    await runRepeatedScenarioEval("mock:a", scenarios, runner, 3, ctx);
    // 1 scenario × 3 repeats = 3 hook invocations.
    expect(hookCalls).toHaveLength(3);
    expect(hookCalls[0]!).toEqual({ scenario: "status", model: "mock:a", repeat: 0 });
    expect(hookCalls[1]!).toEqual({ scenario: "status", model: "mock:a", repeat: 1 });
    expect(hookCalls[2]!).toEqual({ scenario: "status", model: "mock:a", repeat: 2 });
  });

  it("runModelCanary passes ctx through to runRepeatedScenarioEval", async () => {
    const hookCalls: string[] = [];
    const ctx: ObservationContext = {
      beforeObservation: async (_scenario, model, _repeatIndex) => {
        hookCalls.push(model);
      },
    };
    await runModelCanary("mock:a", "mock:b", scenarios, runner, 2, ctx);
    // 1 scenario × 2 repeats × 2 models = 4 hook calls.
    expect(hookCalls).toHaveLength(4);
    // Sequential: primary hooks first, then fallback hooks.
    expect(hookCalls[0]).toBe("mock:a");
    expect(hookCalls[1]).toBe("mock:a");
    expect(hookCalls[2]).toBe("mock:b");
    expect(hookCalls[3]).toBe("mock:b");
  });

  it("fail closed if isolation hook provisioning fails", async () => {
    const ctx: ObservationContext = {
      beforeObservation: async () => {
        throw new Error("provisioning failed: fixture unavailable");
      },
    };
    await expect(
      runRepeatedScenarioEval("mock:a", scenarios, runner, 3, ctx),
    ).rejects.toThrow("provisioning failed: fixture unavailable");
  });

  it("fail closed on provisioning failure even for first repeat", async () => {
    const ctx: ObservationContext = {
      beforeObservation: async (_scenario, _model, repeatIndex) => {
        if (repeatIndex === 0) throw new Error("cannot provision fixture");
      },
    };
    await expect(
      runRepeatedScenarioEval("mock:a", scenarios, runner, 3, ctx),
    ).rejects.toThrow("cannot provision fixture");
  });

  // ── Repeated report: privacy is included in passed gate ──

  it("repeated report failed when privacy fails", async () => {
    const privacyFailRunner = async () => ({
      routedMode: "action" as const,
      selectedSkills: ["project-status"],
      evidence: ["get_project_state"],
      terminalStatus: "completed" as const,
      latencyMs: 10,
      inputTokens: 20,
      outputTokens: 10,
      cost: 0.01,
      outputPolicyPassed: false, // Privacy always fails.
    });
    const report = await runRepeatedScenarioEval("mock:a", scenarios, privacyFailRunner, 3);
    // Per-scenario diagnostics.
    expect(report.results[0]!.allRoutingPassed).toBe(true);
    expect(report.results[0]!.allOutcomePassed).toBe(false); // outcome includes outputPolicy
    expect(report.results[0]!.privacyAllPassed).toBe(false);
    // Observation-level: privacy 0/3, outcome 0/3 (outputPolicy fails → outcome fails).
    expect(report.privacyPassRate).toBe(0);
    expect(report.privacyGate).toBe(false);
    expect(report.outcomePassRate).toBe(0);
    expect(report.passed).toBe(false);
  });
});
