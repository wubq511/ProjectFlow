import { describe, expect, it } from "vitest";
import { exportTrajectory } from "../../src/evaluation/trajectory-exporter.js";
import { RELEASE_SCENARIOS, runScenarioEval, type AgentScenario } from "../../src/evaluation/scenario-eval.js";
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
    expect(trajectory.latencyMs).toBe(3000);
    expect(trajectory.verifierPassed).toBe(true);
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
});
