import { describe, it, expect } from "vitest";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { findFreePort, IsolatedProcessPair } from "../../src/evaluation/lab/isolation.js";
import { gradeObservation, containsRawId, verifyStatePurity } from "../../src/evaluation/lab/grader.js";
import { runEvaluation } from "../../src/evaluation/lab/runner.js";
import type { ScenarioContract, ScenarioObservation } from "../../src/evaluation/lab/contract.js";

describe("Evaluation Lab - Contracts & Grader", () => {
  it("containsRawId detects UUIDs and state IDs correctly", () => {
    const state = { project: { id: "proj-secret-777", name: "Project X" } };
    expect(containsRawId("This is secret proj-secret-777", state)).toBe(true);
    expect(containsRawId("Safe output description", state)).toBe(false);
    expect(containsRawId("Matches uuid 123e4567-e89b-12d3-a456-426614174000", state)).toBe(true);
  });

  it("verifyStatePurity detects changes except dynamic fields", () => {
    const before = { tasks: [{ id: "t1", status: "not_started" }], timeline: ["t1"] };
    const afterSame = { tasks: [{ id: "t1", status: "not_started" }], timeline: ["t2"] }; // timeline is ignored
    const afterChanged = { tasks: [{ id: "t1", status: "in_progress" }] };

    expect(verifyStatePurity(before, afterSame)).toBe(true);
    expect(verifyStatePurity(before, afterChanged)).toBe(false);
  });

  it("gradeObservation grades scenarios correctly", () => {
    const scenario: ScenarioContract = {
      schemaVersion: 1,
      scenarioId: "test-scen",
      prompt: "test prompt",
      expectedMode: "answer",
      maxLatencyMs: 5000,
      forbidRawIds: true,
    };

    const goodObs: ScenarioObservation = {
      schemaVersion: 1,
      scenarioId: "test-scen",
      timestamp: new Date().toISOString(),
      routedMode: "answer",
      selectedSkills: [],
      evidence: [],
      terminalStatus: "completed",
      latencyMs: 120,
      inputTokens: 10,
      outputTokens: 5,
      output: "All safe outputs",
    };

    const state = { project: { id: "secret-id" } };
    const grade = gradeObservation(scenario, goodObs, state, state);
    expect(grade.passed).toBe(true);

    // Mismatched mode
    const badObs: ScenarioObservation = {
      ...goodObs,
      routedMode: "action",
    };
    const badGrade = gradeObservation(scenario, badObs, state, state);
    expect(badGrade.passed).toBe(false);
    expect(badGrade.failures.join("")).toContain("routing_mismatch");
  });
});

describe("Evaluation Lab - Port Finding", () => {
  it("finds a free local loopback port", async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(1024);
  });
});

describe("Evaluation Lab - IsolatedProcessPair Integration", () => {
  it("starts and stops healthy processes inside a temp root", async () => {
    const projectRoot = resolve(import.meta.dirname ?? process.cwd(), "../../../");
    const pair = new IsolatedProcessPair();
    try {
      await pair.start(projectRoot);
      expect(pair.nonce).toBeDefined();
      expect(pair.tempRoot).toBeDefined();
      expect(existsSync(pair.tempRoot)).toBe(true);
      expect(existsSync(join(pair.tempRoot, "uploads"))).toBe(true);
      expect(pair.backendPort).toBeGreaterThan(0);
      expect(pair.sidecarPort).toBeGreaterThan(0);

      // Verify health check response
      const res = await fetch(`${pair.backendUrl}/api/health`);
      expect(res.ok).toBe(true);
      const data = await res.json() as any;
      expect(data.evaluation_nonce).toBe(pair.nonce);
      expect(data.app_env).toBe("evaluation");
      
      const sidecarRes = await fetch(`${pair.sidecarUrl}/health`);
      expect(sidecarRes.ok).toBe(true);
      const sidecarData = await sidecarRes.json() as any;
      expect(sidecarData.evaluation_nonce).toBe(pair.nonce);
      expect(sidecarData.app_env).toBe("evaluation");
    } finally {
      await pair.destroy();
    }
  }, 25000); // 25s timeout for process spawning
});
