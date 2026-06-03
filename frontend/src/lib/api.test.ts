import { afterEach, describe, expect, it, vi } from "vitest";

import { getProjectState, rejectAgentProposal, runAgentNegotiate, runAssignment, startNegotiation } from "./api";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("frontend API layer", () => {
  it("rejects agent proposals with an explicit nullable reason body", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/agent-proposals/proposal-1/reject")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ reason: null });
        return jsonResponse({
          id: "proposal-1",
          project_id: "project-1",
          workspace_id: "workspace-1",
          proposal_type: "clarify",
          status: "rejected",
          agent_event_id: "event-1",
          payload: {},
          confirmed_by: null,
          confirmed_at: null,
          created_at: "2026-06-02T00:00:00Z",
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const proposal = await rejectAgentProposal("proposal-1");

    expect(proposal.status).toBe("rejected");
  });

  it("runs agent flows through the implemented workspace-scoped backend route", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/projects/project-1")) {
        return jsonResponse({
          id: "project-1",
          workspace_id: "workspace-1",
          name: "Demo",
          idea: "Demo",
          deadline: "2026-06-07",
          deliverables: "Demo",
          status: "active",
          current_stage_id: null,
          direction_card: null,
          created_by: "user-1",
          created_at: "2026-05-29T00:00:00Z",
          updated_at: "2026-05-29T00:00:00Z",
        });
      }
      if (url.endsWith("/agent/assign")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ workspace_id: "workspace-1" });
        return jsonResponse({
          event_type: "assign",
          status: "fallback",
          attempts: 2,
          used_fallback: true,
          output: {},
          created_ids: ["proposal-1"],
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await runAssignment("project-1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("calls agent negotiate endpoint with workspace_id in body", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/projects/project-1")) {
        return jsonResponse({
          id: "project-1",
          workspace_id: "workspace-1",
          name: "Demo",
          idea: "Demo",
          deadline: "2026-06-07",
          deliverables: "Demo",
          status: "active",
          current_stage_id: null,
          direction_card: null,
          created_by: "user-1",
          created_at: "2026-05-29T00:00:00Z",
          updated_at: "2026-05-29T00:00:00Z",
        });
      }
      if (url.endsWith("/agent/negotiate")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ workspace_id: "workspace-1" });
        return jsonResponse({
          event_type: "negotiate",
          status: "success",
          attempts: 1,
          used_fallback: false,
          output: { message: "协商建议" },
          created_ids: [],
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runAgentNegotiate("project-1");

    expect(result.event_type).toBe("negotiate");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("passes stage_id in assignment request body when provided", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/projects/project-1")) {
        return jsonResponse({
          id: "project-1",
          workspace_id: "workspace-1",
          name: "Demo",
          idea: "Demo",
          deadline: "2026-06-07",
          deliverables: "Demo",
          status: "active",
          current_stage_id: null,
          direction_card: null,
          created_by: "user-1",
          created_at: "2026-05-29T00:00:00Z",
          updated_at: "2026-05-29T00:00:00Z",
        });
      }
      if (url.endsWith("/agent/assign")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          workspace_id: "workspace-1",
          stage_id: "stage-pending",
        });
        return jsonResponse({
          event_type: "assign",
          status: "fallback",
          attempts: 2,
          used_fallback: true,
          output: {},
          created_ids: ["proposal-1"],
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await runAssignment("project-1", "stage-pending");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("starts assignment negotiation through the proposal-scoped backend route", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/assignment-proposals/proposal-1/negotiations")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          from_user_id: "user-mia",
          desired_task_id: "task-panel",
        });
        expect(String(init?.body)).not.toContain("agent_message");
        expect(String(init?.body)).not.toContain("current_owner_user_id");
        return jsonResponse({
          id: "negotiation-1",
          project_id: "project-1",
          stage_id: "stage-1",
          from_user_id: "user-mia",
          desired_task_id: "task-panel",
          current_owner_user_id: null,
          status: "pending",
          agent_message: "Mia 希望改做分工流程面板。",
          created_at: "2026-06-03T00:00:00Z",
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const negotiation = await startNegotiation(
      "project-1",
      "proposal-1",
      "user-mia",
      "task-panel",
    );

    expect(negotiation.agent_message).toBe("Mia 希望改做分工流程面板。");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("composes dashboard state from execution-loop endpoints", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/projects/project-1")) {
        return jsonResponse({
          id: "project-1",
          workspace_id: "workspace-1",
          name: "Demo",
          idea: "Demo",
          deadline: "2026-06-07",
          deliverables: "Demo",
          status: "active",
          current_stage_id: "stage-1",
          direction_card: null,
          created_by: "user-1",
          created_at: "2026-05-29T00:00:00Z",
          updated_at: "2026-05-29T00:00:00Z",
        });
      }
      if (url.endsWith("/workspaces/workspace-1")) {
        return jsonResponse({
          id: "workspace-1",
          name: "Workspace",
          owner_user_id: "user-1",
          description: null,
          created_at: "2026-05-29T00:00:00Z",
          updated_at: "2026-05-29T00:00:00Z",
        });
      }
      if (url.endsWith("/projects/project-1/resources")) return jsonResponse([]);
      if (url.endsWith("/projects/project-1/stages")) {
        return jsonResponse([
          {
            id: "stage-1",
            project_id: "project-1",
            name: "Build",
            goal: "Build demo",
            start_date: "2026-05-29",
            end_date: "2026-06-01",
            deliverable: "Demo",
            done_criteria: [],
            status: "active",
            order_index: 0,
          },
        ]);
      }
      if (url.endsWith("/projects/project-1/tasks")) return jsonResponse([]);
      if (url.endsWith("/users")) {
        return jsonResponse([
          {
            id: "user-1",
            display_name: "Lin",
            email: null,
            avatar_url: null,
            created_at: "2026-05-29T00:00:00Z",
          },
        ]);
      }
      if (url.endsWith("/workspaces/workspace-1/profiles")) return jsonResponse([]);
      if (url.includes("/agent-proposals?project_id=project-1")) return jsonResponse([]);
      if (url.endsWith("/projects/project-1/assignment-proposals")) return jsonResponse([]);
      if (url.endsWith("/projects/project-1/assignment-responses")) return jsonResponse([]);
      if (url.endsWith("/projects/project-1/assignment-negotiations")) return jsonResponse([]);
      if (url.endsWith("/projects/project-1/checkin-cycles")) return jsonResponse([]);
      if (url.endsWith("/projects/project-1/risks")) {
        return jsonResponse([
          {
            id: "risk-1",
            project_id: "project-1",
            stage_id: "stage-1",
            task_id: "task-1",
            type: "dependency",
            severity: "high",
            title: "后端联调阻塞",
            description: "接口阻塞前端联调。",
            evidence: [
              {
                source: "签到",
                detail: "Mia 报告 SQLite 外键约束报错",
                task_id: "task-1",
              },
            ],
            recommendation: "先排查外键写入顺序。",
            status: "open",
            created_by_agent: true,
            created_at: "2026-05-29T00:00:00Z",
          },
        ]);
      }
      if (url.endsWith("/projects/project-1/action-cards")) {
        return jsonResponse([
          {
            id: "card-1",
            project_id: "project-1",
            stage_id: "stage-1",
            user_id: null,
            task_id: null,
            type: "team_next_step",
            title: "Confirm demo",
            content: "Walk the flow.",
            reason: "Demo needs a stable path.",
            due_date: null,
            status: "active",
            created_by_agent: true,
            created_at: "2026-05-29T00:00:00Z",
          },
        ]);
      }
      if (url.endsWith("/projects/project-1/timeline")) return jsonResponse([]);
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const state = await getProjectState("project-1");

    expect(state.action_cards).toHaveLength(1);
    expect(state.action_cards[0].title).toBe("Confirm demo");
    expect(state.risks[0].evidence[0]).toEqual({
      "来源": "签到",
      "事实": "Mia 报告 SQLite 外键约束报错",
    });
    expect(JSON.stringify(state.risks[0].evidence[0])).not.toContain("task_id");
  });
});
