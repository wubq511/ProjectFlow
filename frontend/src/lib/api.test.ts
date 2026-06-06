import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getAgentConversation,
  getProjectState,
  rejectAgentProposal,
  runAgentNegotiate,
  runAssignment,
  sendAgentConversationMessage,
  startNegotiation,
} from "./api";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("frontend API layer", () => {
  it("loads the active project agent conversation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/projects/project-1/agent-conversation")) {
        return jsonResponse({
          id: "conversation-1",
          workspace_id: "workspace-1",
          project_id: "project-1",
          status: "active",
          summary: "",
          current_focus: "阶段计划",
          messages: [],
          created_at: "2026-06-06T00:00:00Z",
          updated_at: "2026-06-06T00:00:00Z",
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const conversation = await getAgentConversation("project-1");

    expect(conversation.current_focus).toBe("阶段计划");
  });

  it("sends natural language messages to the backend agent conversation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/agent/conversations/conversation-1/messages")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          content: "按三周节奏重新规划",
        });
        return jsonResponse({
          conversation: {
            id: "conversation-1",
            workspace_id: "workspace-1",
            project_id: "project-1",
            status: "active",
            summary: "",
            current_focus: "阶段计划",
            messages: [],
            created_at: "2026-06-06T00:00:00Z",
            updated_at: "2026-06-06T00:00:00Z",
          },
          user_message: {
            id: "message-user",
            conversation_id: "conversation-1",
            role: "user",
            content: "按三周节奏重新规划",
            structured_payload: {},
            linked_event_id: null,
            linked_proposal_id: null,
            created_at: "2026-06-06T00:00:00Z",
          },
          assistant_message: {
            id: "message-assistant",
            conversation_id: "conversation-1",
            role: "assistant",
            content: "阶段计划已生成，已放入待确认队列。",
            structured_payload: {},
            linked_event_id: "event-1",
            linked_proposal_id: "proposal-1",
            created_at: "2026-06-06T00:00:00Z",
          },
          run: {
            id: "run-1",
            conversation_id: "conversation-1",
            project_id: "project-1",
            user_instruction: "按三周节奏重新规划",
            selected_module: "plan",
            status: "proposal_created",
            model: "mock",
            attempts: 2,
            verifier_status: "passed",
            agent_event_id: "event-1",
            proposal_id: "proposal-1",
            created_at: "2026-06-06T00:00:00Z",
            completed_at: "2026-06-06T00:00:00Z",
          },
          turn_plan: null,
          next_suggestions: ["确认这个阶段计划"],
          suggestions: [
            {
              id: "suggestion-1",
              label: "确认这个阶段计划",
              user_instruction: "确认这个阶段计划",
              priority: "primary",
            },
          ],
          artifacts: [
            {
              id: "proposal-artifact-1",
              type: "proposal",
              status: "pending_confirmation",
              title: "阶段计划提案",
              summary: "三周阶段计划已生成。",
              rationale: "用户要求按三周节奏重新规划。",
              impact: ["确认后会更新阶段计划。"],
              linked_entity_ids: ["proposal-1"],
            },
          ],
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendAgentConversationMessage(
      "conversation-1",
      "按三周节奏重新规划",
    );

    expect(result.run?.selected_module).toBe("plan");
    expect(result.assistant_message.linked_proposal_id).toBe("proposal-1");
    expect(result.suggestions[0].user_instruction).toBe("确认这个阶段计划");
    expect(result.artifacts[0].type).toBe("proposal");
    expect(result.artifacts[0].linked_entity_ids).toEqual(["proposal-1"]);
  });

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
        expect(JSON.parse(String(init?.body))).toEqual({
          workspace_id: "workspace-1",
          project_id: "project-1",
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
        expect(JSON.parse(String(init?.body))).toEqual({
          workspace_id: "workspace-1",
          project_id: "project-1",
        });
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
          project_id: "project-1",
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

  it("falls back to next_suggestions when suggestions and artifacts are omitted", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/agent/conversations/conversation-1/messages")) {
        expect(init?.method).toBe("POST");
        return jsonResponse({
          conversation: {
            id: "conversation-1",
            workspace_id: "workspace-1",
            project_id: "project-1",
            status: "active",
            summary: "",
            current_focus: "阶段计划",
            messages: [],
            created_at: "2026-06-06T00:00:00Z",
            updated_at: "2026-06-06T00:00:00Z",
          },
          user_message: {
            id: "message-user",
            conversation_id: "conversation-1",
            role: "user",
            content: "按三周节奏重新规划",
            structured_payload: {},
            linked_event_id: null,
            linked_proposal_id: null,
            created_at: "2026-06-06T00:00:00Z",
          },
          assistant_message: {
            id: "message-assistant",
            conversation_id: "conversation-1",
            role: "assistant",
            content: "好的，我会按三周节奏重新规划。",
            structured_payload: {},
            linked_event_id: null,
            linked_proposal_id: null,
            created_at: "2026-06-06T00:00:00Z",
          },
          run: null,
          turn_plan: null,
          next_suggestions: ["确认这个阶段计划", "查看阶段详情", "调整时间范围", "跳过此步"],
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendAgentConversationMessage(
      "conversation-1",
      "按三周节奏重新规划",
    );

    expect(result.suggestions).toHaveLength(3);
    expect(result.suggestions[0].priority).toBe("primary");
    expect(result.suggestions[1].priority).toBe("secondary");
    expect(result.suggestions[2].priority).toBe("secondary");
    expect(result.suggestions[0].label).toBe("确认这个阶段计划");
    expect(result.suggestions[1].label).toBe("查看阶段详情");
    expect(result.suggestions[2].label).toBe("调整时间范围");
    expect(result.artifacts).toEqual([]);
    expect(result.next_suggestions).toEqual(["确认这个阶段计划", "查看阶段详情", "调整时间范围", "跳过此步"]);
  });

  it("falls back to next_suggestions when suggestions is empty and artifacts is omitted", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/agent/conversations/conversation-1/messages")) {
        expect(init?.method).toBe("POST");
        return jsonResponse({
          conversation: {
            id: "conversation-1",
            workspace_id: "workspace-1",
            project_id: "project-1",
            status: "active",
            summary: "",
            current_focus: "阶段计划",
            messages: [],
            created_at: "2026-06-06T00:00:00Z",
            updated_at: "2026-06-06T00:00:00Z",
          },
          user_message: {
            id: "message-user",
            conversation_id: "conversation-1",
            role: "user",
            content: "下一步怎么做",
            structured_payload: {},
            linked_event_id: null,
            linked_proposal_id: null,
            created_at: "2026-06-06T00:00:00Z",
          },
          assistant_message: {
            id: "message-assistant",
            conversation_id: "conversation-1",
            role: "assistant",
            content: "建议先确认阶段计划。",
            structured_payload: {},
            linked_event_id: null,
            linked_proposal_id: null,
            created_at: "2026-06-06T00:00:00Z",
          },
          run: null,
          turn_plan: null,
          next_suggestions: ["确认阶段计划", "查看风险分析"],
          suggestions: [],
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendAgentConversationMessage(
      "conversation-1",
      "下一步怎么做",
    );

    expect(result.suggestions).toHaveLength(2);
    expect(result.suggestions[0].label).toBe("确认阶段计划");
    expect(result.suggestions[1].label).toBe("查看风险分析");
    expect(result.artifacts).toEqual([]);
    expect(result.next_suggestions).toEqual(["确认阶段计划", "查看风险分析"]);
  });

  it("loads dashboard state from the aggregate project-state endpoint", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/projects/project-1/state")) {
        return jsonResponse({
          workspace: {
            id: "workspace-1",
            name: "Workspace",
            owner_user_id: "user-1",
            description: null,
            created_at: "2026-05-29T00:00:00Z",
            updated_at: "2026-05-29T00:00:00Z",
          },
          project: {
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
          },
          resources: [],
          members: [
            {
              id: "user-1",
              display_name: "Lin",
              email: null,
              avatar_url: null,
              created_at: "2026-05-29T00:00:00Z",
            },
          ],
          memberships: [
            {
              id: "membership-1",
              workspace_id: "workspace-1",
              user_id: "user-1",
              role: "owner",
              joined_at: "2026-05-29T00:00:00Z",
            },
          ],
          member_profiles: [],
          projects: [],
          stages: [],
          tasks: [],
          agent_proposals: [],
          assignment_proposals: [],
          assignment_responses: [],
          assignment_negotiations: [],
          checkins: [],
          risks: [
            {
              id: "risk-1",
              project_id: "project-1",
              stage_id: "stage-1",
              task_id: "task-1",
              type: "dependency",
              severity: "high",
              title: "后端联调阻塞",
              description: "接口阻塞前端联调。",
              evidence: {
                source: "签到",
                detail: "Mia 报告 SQLite 外键约束报错",
                task_id: "task-1",
              },
              recommendation: "先排查外键写入顺序。",
              status: "open",
              created_by_agent: true,
              created_at: "2026-05-29T00:00:00Z",
            },
          ],
          action_cards: [],
          timeline: [],
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const state = await getProjectState("project-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.workspace.workspace_id).toBe("workspace-1");
    expect(state.members[0].user_id).toBe("user-1");
    expect(state.risks[0].evidence[0]).toEqual({
      "来源": "签到",
      "事实": "Mia 报告 SQLite 外键约束报错",
    });
  });

  it("falls back to execution-loop endpoints when aggregate project state is missing", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/projects/project-1/state")) return jsonResponse({ detail: "Not found" }, 404);
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
      if (url.endsWith("/workspaces/workspace-1/projects")) {
        return jsonResponse([
          {
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
          },
        ]);
      }
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

    expect(state.projects).toHaveLength(1);
    expect(state.projects[0].id).toBe("project-1");
    expect(state.memberships).toEqual([
      {
        id: "workspace-1-user-1",
        workspace_id: "workspace-1",
        user_id: "user-1",
        role: "owner",
        joined_at: "2026-05-29T00:00:00Z",
      },
    ]);
    expect(state.action_cards).toHaveLength(1);
    expect(state.action_cards[0].title).toBe("Confirm demo");
    expect(state.risks[0].evidence[0]).toEqual({
      "来源": "签到",
      "事实": "Mia 报告 SQLite 外键约束报错",
    });
    expect(JSON.stringify(state.risks[0].evidence[0])).not.toContain("task_id");
  });
});
