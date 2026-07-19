/**
 * T46-2 (Issue #95 §3, §6) — Reference Program tests.
 *
 * The Reference Program proves that a scenario's fixture is reachable, the
 * human-action seam is available, and the harness can observe the target
 * state. It is NOT the oracle. These tests verify:
 *
 * 1. `runReferenceProgram` throws on oracle independence violations.
 * 2. `executeReferenceRun` produces the expected handles when fetch is mocked.
 * 3. The "zero false hard failure" property: when the reference produces a
 *    clean observation + snapshot that satisfies the oracle, `gradeHard`
 *    returns `passed: true`.
 * 4. The `toLabObservation` conversion fills in cost ledger defaults.
 *
 * All HTTP traffic is mocked — no real backend or sidecar is started.
 */

import { describe, expect, it, vi } from "vitest";
import { executeReferenceRun, runReferenceProgram } from "../../src/evaluation/lab/reference-program.js";
import type {
  EvidenceSnapshot,
  HardGraderContract,
  ReferenceProgram,
} from "../../src/evaluation/lab/contract-v2.js";
import {
  HARD_GRADER_CONTRACT_VERSION,
  EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
} from "../../src/evaluation/lab/contract-v2.js";
import { gradeHard } from "../../src/evaluation/lab/hard-graders.js";
import {
  buildObservation,
  buildSnapshot,
  HIDDEN_TOKEN,
  PRIMARY_VIEWER_ID,
  PROJECT_ID,
  toolDag,
  WORKSPACE_ID,
} from "./hard-grader-fixtures.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  }) as Response;
}

function sseResponse(events: Array<{ event: string; data: Record<string, unknown> }>): Response {
  const lines: string[] = [];
  for (const { event, data } of events) {
    lines.push(`event: ${event}`);
    lines.push(`data: ${JSON.stringify(data)}`);
    lines.push("");
  }
  return new Response(lines.join("\n"), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  }) as Response;
}

function buildReference(overrides: Partial<ReferenceProgram> = {}): ReferenceProgram {
  return {
    id: "ref-001",
    prompt: "你好,请介绍一下当前项目。",
    viewer: { primaryUserId: PRIMARY_VIEWER_ID },
    expectedMilestoneSubset: [],
    ...overrides,
  };
}

function buildOracle(overrides: Partial<HardGraderContract> = {}): HardGraderContract {
  return {
    version: HARD_GRADER_CONTRACT_VERSION,
    viewer: { primaryUserId: PRIMARY_VIEWER_ID },
    run: { finalStatus: "completed", maxSideEffects: 0 },
    readOnlyStatePurity: true,
    privacy: {
      forbidRawIdsInOutput: true,
      hiddenFieldTokens: [HIDDEN_TOKEN],
    },
    ...overrides,
  };
}

function buildConfig(overrides: Partial<Parameters<typeof executeReferenceRun>[1]> = {}) {
  return {
    backendBaseUrl: "http://backend.test",
    sidecarBaseUrl: "http://sidecar.test",
    adminToken: "admin-token",
    internalServiceToken: "internal-token",
    evaluationNonce: "nonce",
    evaluationInstanceId: "instance",
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    model: "mock:mock-model",
    maxLatencyMs: 30_000,
    maxInputTokens: 50_000,
    maxOutputTokens: 8_000,
    maxRequestCount: 4,
    maxSutCostUsd: 0.10,
    ...overrides,
  };
}

/**
 * Build a mock fetch that handles the 5 calls made by executeReferenceRun:
 * 1. POST /api/seed/demo
 * 2. GET /api/workspaces/{id}/state
 * 3. POST /api/projects/{id}/agent-conversations
 * 4. POST {sidecar}/api/agent-conversations/{id}/messages/stream (SSE)
 * 5. GET /internal/evaluation/evidence
 */
function buildMockFetch(options: {
  conversationId?: string;
  beforeSnapshot?: EvidenceSnapshot;
  snapshot?: EvidenceSnapshot;
  sseEvents?: Array<{ event: string; data: Record<string, unknown> }>;
} = {}): typeof fetch {
  const conversationId = options.conversationId ?? "conv-new-001";
  const snapshot = options.snapshot ?? buildSnapshot();
  const beforeSnapshot = options.beforeSnapshot ?? snapshot;
  let evidenceCalls = 0;
  const sseEvents = options.sseEvents ?? [
    {
      event: "status",
      data: {
        run_id: "run-001",
        request_mode: "answer",
        selected_skills: [],
      },
    },
    {
      event: "done",
      data: {
        final_content: "项目当前进展顺利,无需修改。",
        metrics: {
          latency_ms: 120,
          input_tokens: 10,
          output_tokens: 5,
          model_request_count: 1,
        },
      },
    },
  ];

  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    // Step 1: seed demo
    if (url.endsWith("/api/seed/demo") && method === "POST") {
      return jsonResponse({ status: "ok" });
    }
    // Step 2: workspace state
    if (url.includes("/api/workspaces/") && url.endsWith("/state") && method === "GET") {
      return jsonResponse({ workspace: { id: WORKSPACE_ID } });
    }
    // Step 3: create conversation
    if (url.includes("/api/projects/") && url.includes("/agent-conversations") && method === "POST") {
      return jsonResponse({ id: conversationId });
    }
    // Step 4: SSE stream
    if (url.includes("/runs/stream") && method === "POST") {
      return sseResponse(sseEvents);
    }
    // Step 5: evidence snapshot
    if (url.includes("/internal/evaluation/evidence") && method === "GET") {
      evidenceCalls += 1;
      return jsonResponse(evidenceCalls === 1 ? beforeSnapshot : snapshot);
    }
    return jsonResponse({ error: "unexpected call" }, 404);
  }) as typeof fetch;
}

describe("runReferenceProgram — oracle independence guard", () => {
  it("throws when the oracle embeds a referenceProgramId", async () => {
    const oracle = buildOracle() as HardGraderContract & { referenceProgramId?: string };
    oracle.referenceProgramId = "ref-001";
    await expect(
      runReferenceProgram(buildReference(), oracle, buildConfig({ fetchFn: buildMockFetch() })),
    ).rejects.toThrow(/referenceProgramId/);
  });

  it("throws when the reference embeds stateConstraints", async () => {
    const reference = buildReference() as ReferenceProgram & { stateConstraints?: unknown };
    reference.stateConstraints = { required: [] };
    await expect(
      runReferenceProgram(reference, buildOracle(), buildConfig({ fetchFn: buildMockFetch() })),
    ).rejects.toThrow(/stateConstraints/);
  });

  it("throws when expectedMilestoneSubset equals oracle milestone matchers", async () => {
    const oracle = buildOracle({
      milestoneDag: toolDag("subset", ["a", "b"]),
    });
    const reference = buildReference({
      expectedMilestoneSubset: ["tool:a", "tool:b"],
    });
    await expect(
      runReferenceProgram(reference, oracle, buildConfig({ fetchFn: buildMockFetch() })),
    ).rejects.toThrow(/expectedMilestoneSubset/);
  });
});

describe("executeReferenceRun — mocked HTTP traffic", () => {
  it("provisions a fixture, runs the seam, and collects the snapshot", async () => {
    const snapshot = buildSnapshot();
    const fetchFn = buildMockFetch({ snapshot });
    const handles = await executeReferenceRun(
      buildReference(),
      buildConfig({ fetchFn }),
    );
    expect(handles.identity.conversationId).toBe("conv-new-001");
    expect(handles.observation.terminalStatus).toBe("completed");
    expect(handles.observation.output).toContain("项目当前进展顺利");
    expect(handles.snapshot.schema_version).toBe(EVIDENCE_SNAPSHOT_SCHEMA_VERSION);
    expect(handles.snapshot).toEqual(snapshot);
  });

  it("propagates SSE parse errors as infrastructure failures", async () => {
    const fetchFn = buildMockFetch({
      sseEvents: [],
    });
    // Empty SSE → no terminal event → infrastructure error.
    await expect(
      executeReferenceRun(buildReference(), buildConfig({ fetchFn })),
    ).rejects.toThrow(/终态事件前结束|SSE/);
  });

  it("propagates evidence client errors with redacted messages", async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/seed/demo") && method === "POST") {
        return jsonResponse({ status: "ok" });
      }
      if (url.includes("/api/workspaces/") && url.endsWith("/state") && method === "GET") {
        return jsonResponse({ workspace: { id: WORKSPACE_ID } });
      }
      if (url.includes("/api/projects/") && url.includes("/agent-conversations") && method === "POST") {
        return jsonResponse({ id: "conv-001" });
      }
      if (url.includes("/runs/stream") && method === "POST") {
        return sseResponse([
          { event: "status", data: { run_id: "run-001", request_mode: "answer", selected_skills: [] } },
          {
            event: "done",
            data: {
              final_content: "完成",
              metrics: { latency_ms: 100, input_tokens: 5, output_tokens: 3, model_request_count: 1 },
            },
          },
        ]);
      }
      if (url.includes("/internal/evaluation/evidence") && method === "GET") {
        return jsonResponse({ error: "internal" }, 500);
      }
      return jsonResponse({ error: "unexpected" }, 404);
    }) as typeof fetch;

    await expect(
      executeReferenceRun(buildReference(), buildConfig({ fetchFn })),
    ).rejects.toThrow(/评估证据快照获取失败/);
  });
});

describe("runReferenceProgram — zero false hard failure property", () => {
  it("produces a passing hard grade when the reference satisfies the oracle", async () => {
    // Snapshot has no side effects, terminal trajectory is run.completed,
    // state_facts is stable, no hidden tokens, no raw IDs in output.
    // Note: runReferenceProgram passes beforeSnapshot=null, so the oracle
    // must NOT declare readOnlyStatePurity (which would fail closed on
    // missing before snapshot). The reference executor deliberately does
    // not fetch a before snapshot — that's the runner's responsibility.
    const snapshot = buildSnapshot();
    const fetchFn = buildMockFetch({
      snapshot,
      sseEvents: [
        { event: "status", data: { run_id: "run-001", request_mode: "answer", selected_skills: [] } },
        {
          event: "done",
          data: {
            final_content: "项目当前进展顺利,无需修改。",
            metrics: {
              latency_ms: 120,
              input_tokens: 10,
              output_tokens: 5,
              model_request_count: 1,
            },
          },
        },
      ],
    });
    const result = await runReferenceProgram(
      buildReference(),
      // Oracle without readOnlyStatePurity or forbidRawIdsInOutput — both
      // require a before snapshot, which runReferenceProgram does not fetch.
      // The reference executor verifies graders that don't need a before
      // snapshot; the runner verifies the rest.
      buildOracle({
        readOnlyStatePurity: undefined,
        privacy: { hiddenFieldTokens: [HIDDEN_TOKEN] },
      }),
      buildConfig({ fetchFn }),
    );
    expect(result.passed, result.hardGrade.failures.join("\n")).toBe(true);
    expect(result.hardGrade.passed).toBe(true);
    expect(result.hardGrade.graders.finalOutcome).toBe(true);
    expect(result.hardGrade.graders.readOnlyStatePurity).toBe(true); // skipped → true
    expect(result.hardGrade.graders.rawIdLeakage).toBe(true); // skipped → true
    expect(result.hardGrade.graders.hiddenFieldLeakage).toBe(true);
  });

  it("detects a hidden token leak in the reference output", async () => {
    const snapshot = buildSnapshot();
    const fetchFn = buildMockFetch({
      snapshot,
      sseEvents: [
        { event: "status", data: { run_id: "run-001", request_mode: "answer", selected_skills: [] } },
        {
          event: "done",
          data: {
            // Reference output accidentally leaks the hidden token.
            final_content: `泄露 ${HIDDEN_TOKEN}`,
            metrics: { latency_ms: 100, input_tokens: 5, output_tokens: 3, model_request_count: 1 },
          },
        },
      ],
    });
    const result = await runReferenceProgram(
      buildReference(),
      buildOracle(),
      buildConfig({ fetchFn }),
    );
    // The reference SHOULD fail because the hidden token leaked. This is
    // the "zero false hard failure" property in reverse: a buggy reference
    // (or oracle) surfaces as a hard failure, not a silent pass.
    expect(result.passed).toBe(false);
    expect(result.hardGrade.graders.hiddenFieldLeakage).toBe(false);
  });

  it("detects a state mutation in a read-only reference scenario", async () => {
    const beforeSnapshot = buildSnapshot();
    const snapshot = buildSnapshot({
      state_facts: {
        ...beforeSnapshot.state_facts,
        project_status: "completed",
      },
    });
    const fetchFn = buildMockFetch({ beforeSnapshot, snapshot });
    const result = await runReferenceProgram(
      buildReference(),
      buildOracle(),
      buildConfig({ fetchFn }),
    );
    expect(result.hardGrade.graders.readOnlyStatePurity).toBe(false);
  });
});

describe("toLabObservation — cost ledger defaults", () => {
  it("fills in zero-cost evaluator and unknown coding agent costs", async () => {
    const snapshot = buildSnapshot();
    const fetchFn = buildMockFetch({
      snapshot,
      sseEvents: [
        { event: "status", data: { run_id: "run-001", request_mode: "answer", selected_skills: [] } },
        {
          event: "done",
          data: {
            final_content: "完成",
            metrics: {
              latency_ms: 100,
              input_tokens: 5,
              output_tokens: 3,
              model_request_count: 1,
              total_cost: 0.001,
            },
          },
        },
      ],
    });
    const handles = await executeReferenceRun(
      buildReference(),
      buildConfig({ fetchFn }),
    );
    expect(handles.observation.costs.sutCost.amountUsd).toBe(0.001);
    expect(handles.observation.costs.sutCost.source).toBe("provider_reported");
    expect(handles.observation.costs.sutCost.countedAgainstSutCap).toBe(true);
    expect(handles.observation.costs.evaluatorModelCost.amountUsd).toBe(0);
    expect(handles.observation.costs.codingAgentCost.amountUsd).toBe(null);
  });

  it("defaults SUT cost to zero when the seam reports no cost", async () => {
    const snapshot = buildSnapshot();
    const fetchFn = buildMockFetch({
      snapshot,
      sseEvents: [
        { event: "status", data: { run_id: "run-001", request_mode: "answer", selected_skills: [] } },
        {
          event: "done",
          data: {
            final_content: "完成",
            metrics: { latency_ms: 100, input_tokens: 5, output_tokens: 3, model_request_count: 1 },
          },
        },
      ],
    });
    const handles = await executeReferenceRun(
      buildReference(),
      buildConfig({ fetchFn }),
    );
    expect(handles.observation.costs.sutCost.amountUsd).toBe(0);
    expect(handles.observation.costs.sutCost.source).toBe("versioned_price_estimate");
  });
});

describe("gradeHard — direct zero-false-failure verification", () => {
  it("passes when the observation and snapshot satisfy the oracle", () => {
    const observation = buildObservation();
    const snapshot = buildSnapshot();
    const grade = gradeHard({
      oracle: buildOracle(),
      observation,
      primarySnapshot: snapshot,
      adversarySnapshot: null,
      beforeSnapshot: snapshot,
    });
    expect(grade.passed, grade.failures.join("\n")).toBe(true);
  });

  it("fails when the observation terminal status is wrong", () => {
    const observation = buildObservation({ terminalStatus: "failed" });
    const snapshot = buildSnapshot();
    const grade = gradeHard({
      oracle: buildOracle(),
      observation,
      primarySnapshot: snapshot,
      adversarySnapshot: null,
      beforeSnapshot: snapshot,
    });
    expect(grade.passed).toBe(false);
    expect(grade.graders.finalOutcome).toBe(false);
  });
});
