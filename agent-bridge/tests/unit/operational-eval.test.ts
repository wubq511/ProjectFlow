import { describe, expect, it } from "vitest";
import { exportTrajectory } from "../../src/evaluation/trajectory-exporter.js";
import { runScenarioEval, type AgentScenario } from "../../src/evaluation/scenario-eval.js";
import { runModelCanary } from "../../src/evaluation/model-conformance.js";
import { createHttpPublicSeamRunner } from "../../src/evaluation/http-public-seam-runner.js";

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
  });
});
