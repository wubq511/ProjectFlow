import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock window.matchMedia for prefers-reduced-motion detection in RunActivity
beforeEach(() => {
  if (typeof window !== "undefined" && !window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
  }
});

import type {
  AgentArtifact,
  AgentConversation,
  AgentStreamTurn,
  ArchivedAgentStreamTurn,
  AgentSuggestion,
  ModelConfigEntry,
  ProjectState,
} from "@/lib/types";
import { AgentSidebar } from "./agent-sidebar";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseProjectState: ProjectState = {
  workspace: {
    workspace_id: "ws-1",
    name: "测试工作区",
    owner_user_id: "user-1",
    description: null,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
  },
  project: {
    id: "proj-1",
    workspace_id: "ws-1",
    name: "测试项目",
    idea: "做一个测试项目",
    deadline: "2026-07-01",
    deliverables: "演示",
    status: "active",
    current_stage_id: "stage-1",
    direction_card: {
      problem: "测试问题",
      users: "测试用户",
      value: "测试价值",
      deliverables: [],
      boundaries: [],
      risks: [],
      suggested_questions: [],
    },
    created_by: "user-1",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
  },
  stages: [
    {
      id: "stage-1",
      project_id: "proj-1",
      name: "开发阶段",
      goal: "完成开发",
      start_date: "2026-06-01",
      end_date: "2026-06-14",
      deliverable: "可运行原型",
      done_criteria: ["核心功能可用"],
      order_index: 1,
      status: "active",
    },
  ],
  tasks: [
    {
      id: "task-1",
      project_id: "proj-1",
      stage_id: "stage-1",
      title: "后端 API 与数据模型",
      description: "实现核心 API",
      priority: "P0",
      status: "in_progress",
      due_date: "2026-06-14",
      estimated_hours: 8,
      dependency_ids: [],
      acceptance_criteria: [],
      can_cut: false,
      order_index: 0,
      created_by_agent: false,
      updated_at: "2026-06-03T00:00:00Z",
    },
  ],
  resources: [],
  members: [],
  memberships: [],
  member_profiles: [],
  projects: [],
  assignment_proposals: [
    {
      id: "ap-1",
      project_id: "proj-1",
      stage_id: "stage-1",
      task_id: "task-1",
      recommended_owner_user_id: "user-1",
      reason: "测试",
      status: "finalized" as const,
      created_by_agent: true,
      created_at: "2026-06-01T00:00:00Z",
    },
  ],
  assignment_responses: [],
  assignment_negotiations: [],
  agent_proposals: [],
  checkins: [],
  risks: [],
  action_cards: [],
  timeline: [],
};

const conversationFixture: AgentConversation = {
  id: "conv-1",
  workspace_id: "ws-1",
  project_id: "proj-1",
  status: "active",
  summary: "",
  current_focus: "执行推进",
  messages: [
    {
      id: "msg-1",
      conversation_id: "conv-1",
      role: "assistant",
      content: "现在最有效的是根据签到调整计划。",
      structured_payload: {},
      created_at: "2026-06-07T10:00:00Z",
    },
  ],
  created_at: "2026-06-07T00:00:00Z",
  updated_at: "2026-06-07T10:00:00Z",
};

const suggestionsFixture: AgentSuggestion[] = [
  {
    id: "suggestion-1",
    label: "根据签到调整计划",
    user_instruction: "根据签到调整计划",
    priority: "primary",
  },
  {
    id: "suggestion-2",
    label: "先解释风险来源",
    user_instruction: "先解释风险来源",
    priority: "secondary",
  },
];

const artifactsFixture: AgentArtifact[] = [
  {
    id: "proposal-artifact-1",
    type: "proposal",
    status: "pending_confirmation",
    title: "计划调整草案",
    summary: "建议把后端协助前置。",
    rationale: "签到显示后端阻塞。",
    impact: ["影响 3 个任务"],
    linked_entity_ids: ["proposal-1"],
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentSidebar", () => {
  it("keeps a cancelled partial turn visible after the next turn starts", async () => {
    const archivedTurn: ArchivedAgentStreamTurn = {
      turn: {
        clientTurnId: "turn-local-1",
        status: "cancelled",
        userMessage: {
          id: "turn-local-1", conversation_id: "conv-1", role: "user",
          content: "上一轮问题", structured_payload: {}, created_at: "2026-06-07T10:01:00Z",
        },
        blocks: {
          "1:0": { kind: "text", contentIndex: 0, messageSeq: 1, content: "上一轮部分回答", completed: false, order: 0 },
        },
        blockOrder: 1,
        thinkingOpen: false,
        thinkingWasAutoFolded: false,
        thinkingWasManuallyToggled: false,
        executionSteps: [],
        error: "已停止生成",
        finalContent: null,
        activities: [],
        runSummary: null,
        processStartedAt: null,
        processCompletedAt: null,
        processDurationMs: 0,
        streamSequence: 0,
        processAutoCollapsed: false,
        processExpanded: true,
        answerBuffer: "",
      },
    };

    render(
      <AgentSidebar
        state={baseProjectState}
        conversation={conversationFixture}
        archivedStreamTurns={[archivedTurn]}
        onRunAgent={vi.fn()}
      />
    );

    expect(screen.getByText("上一轮问题")).toBeTruthy();
    expect(await screen.findByText("上一轮部分回答")).toBeTruthy();
    expect(screen.getByText("已停止生成")).toBeTruthy();
  });

  it("does not duplicate an archived optimistic user message once the server message exists", () => {
    const userMessage = {
      id: "turn-local-1", conversation_id: "conv-1", role: "user" as const,
      content: "上一轮问题", structured_payload: {}, created_at: "2026-06-07T10:01:00Z",
    };
    const archivedTurn: ArchivedAgentStreamTurn = {
      turn: {
        clientTurnId: "turn-local-1", status: "failed", userMessage,
        blocks: {}, blockOrder: 0, thinkingOpen: false,
        thinkingWasAutoFolded: false, thinkingWasManuallyToggled: false,
        executionSteps: [], error: "生成失败", finalContent: null,
        activities: [], runSummary: null, processStartedAt: null,
        processCompletedAt: null, processDurationMs: 0, streamSequence: 0,
        processAutoCollapsed: false, processExpanded: true, answerBuffer: "",
      },
    };
    const conversation = {
      ...conversationFixture,
      messages: [...conversationFixture.messages, { ...userMessage, id: "server-user-1" }],
    };

    render(
      <AgentSidebar
        state={baseProjectState}
        conversation={conversation}
        archivedStreamTurns={[archivedTurn]}
        onRunAgent={vi.fn()}
      />
    );

    expect(screen.getAllByText("上一轮问题")).toHaveLength(1);
  });

  it.skip("sends suggestion clicks as user instructions", () => {
    const onSendMessage = vi.fn();

    render(
      <AgentSidebar
        state={baseProjectState}
        conversation={conversationFixture}
        conversationSuggestions={suggestionsFixture}
        onRunAgent={vi.fn()}
        onSendMessage={onSendMessage}
      />
    );

    const button = screen.getByRole("button", { name: "根据签到调整计划" });
    fireEvent.click(button);

    expect(onSendMessage).toHaveBeenCalledWith("根据签到调整计划", expect.not.objectContaining({ thinkingLevel: expect.anything() }));
  });

  it("shows pending instruction and run status while Agent is working", () => {
    render(
      <AgentSidebar
        state={baseProjectState}
        conversation={conversationFixture}
        pendingConversation
        pendingConversationInstruction="根据签到调整计划"
        onRunAgent={vi.fn()}
      />
    );

    expect(screen.getAllByText("根据签到调整计划").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Agent 正在处理")).toBeTruthy();
    expect(screen.getByText("读取项目状态")).toBeTruthy();
  });

  it("renders conversation artifacts with confirmation actions", () => {
    render(
      <AgentSidebar
        state={baseProjectState}
        conversation={conversationFixture}
        conversationArtifacts={artifactsFixture}
        onRunAgent={vi.fn()}
        onConfirmArtifact={vi.fn()}
      />
    );

    expect(screen.getByText("计划调整草案")).toBeTruthy();
    expect(screen.getByText("建议把后端协助前置。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "确认应用" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "继续修改" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "查看影响" })).toBeTruthy();
  });

  it("extracts artifacts from structured_payload", () => {
    const conversationWithPayload: AgentConversation = {
      ...conversationFixture,
      messages: [
        {
          id: "msg-payload",
          conversation_id: "conv-1",
          role: "assistant",
          content: "已生成建议。",
          structured_payload: {
            artifacts: [
              {
                id: "payload-art-1",
                type: "proposal",
                status: "pending_confirmation",
                title: "调整计划草案",
                summary: "建议重新分配任务。",
                rationale: "后端进度滞后。",
                impact: ["影响 2 个任务"],
                linked_entity_ids: ["task-1"],
              },
            ],
          },
          created_at: "2026-06-07T10:00:00Z",
        },
      ],
    };

    render(
      <AgentSidebar
        state={baseProjectState}
        conversation={conversationWithPayload}
        onRunAgent={vi.fn()}
        onConfirmArtifact={vi.fn()}
      />
    );

    expect(screen.getByText("调整计划草案")).toBeTruthy();
    expect(screen.getByText("建议重新分配任务。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "确认应用" })).toBeTruthy();
  });

  it("filters out artifacts with invalid type or status", () => {
    const conversationWithMalformed: AgentConversation = {
      ...conversationFixture,
      messages: [
        {
          id: "msg-malformed",
          conversation_id: "conv-1",
          role: "assistant",
          content: "包含非法数据。",
          structured_payload: {
            artifacts: [
              {
                id: "bad-art-1",
                type: "proposal",
                status: "bogus",
                title: "应该被过滤",
                summary: "这个不该出现。",
                rationale: "原因",
                impact: [],
                linked_entity_ids: [],
              },
              {
                id: "good-art-1",
                type: "proposal",
                status: "pending_confirmation",
                title: "正常建议",
                summary: "这个应该渲染。",
                rationale: "理由",
                impact: [],
                linked_entity_ids: [],
              },
            ],
          },
          created_at: "2026-06-07T10:00:00Z",
        },
      ],
    };

    render(
      <AgentSidebar
        state={baseProjectState}
        conversation={conversationWithMalformed}
        onRunAgent={vi.fn()}
        onConfirmArtifact={vi.fn()}
      />
    );

    expect(screen.queryByText("应该被过滤")).toBeNull();
    expect(screen.getByText("正常建议")).toBeTruthy();
  });

  it.skip("renders backward-compatible string suggestions and sends them on click", () => {
    const onSendMessage = vi.fn();

    render(
      <AgentSidebar
        state={baseProjectState}
        conversation={conversationFixture}
        conversationSuggestions={["旧格式建议", "第二个旧格式建议"]}
        onRunAgent={vi.fn()}
        onSendMessage={onSendMessage}
      />
    );

    const button = screen.getByRole("button", { name: "旧格式建议" });
    fireEvent.click(button);

    expect(onSendMessage).toHaveBeenCalledWith("旧格式建议", expect.not.objectContaining({ thinkingLevel: expect.anything() }));
  });

  it.skip("disables suggestion buttons while pending conversation", () => {
    render(
      <AgentSidebar
        state={baseProjectState}
        conversation={conversationFixture}
        conversationSuggestions={suggestionsFixture}
        pendingConversation
        onRunAgent={vi.fn()}
        onSendMessage={vi.fn()}
      />
    );

    const button = screen.getByRole("button", { name: "根据签到调整计划" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("renders conversationError with retry button when instruction is pending", () => {
    const onSendMessage = vi.fn();

    render(
      <AgentSidebar
        state={baseProjectState}
        conversation={conversationFixture}
        conversationError="这次没有生成可用结果"
        pendingConversationInstruction="分析当前风险"
        onRunAgent={vi.fn()}
        onSendMessage={onSendMessage}
      />
    );

    expect(screen.getByText("Agent 暂时没有完成这次处理")).toBeTruthy();
    expect(screen.getByText("这次没有生成可用结果")).toBeTruthy();

    const retryButton = screen.getByText("重新发送");
    fireEvent.click(retryButton);

    expect(onSendMessage).toHaveBeenCalledWith("分析当前风险", expect.not.objectContaining({ thinkingLevel: expect.anything() }));
  });

  it("disables artifact action buttons while pending conversation", () => {
    render(
      <AgentSidebar
        state={baseProjectState}
        conversation={conversationFixture}
        conversationArtifacts={artifactsFixture}
        pendingConversation
        onRunAgent={vi.fn()}
        onConfirmArtifact={vi.fn()}
      />
    );

    const confirmButton = screen.getByRole("button", { name: "确认应用" }) as HTMLButtonElement;
    const reviseButton = screen.getByRole("button", { name: "继续修改" }) as HTMLButtonElement;
    const inspectButton = screen.getByRole("button", { name: "查看影响" }) as HTMLButtonElement;

    expect(confirmButton.disabled).toBe(true);
    expect(reviseButton.disabled).toBe(true);
    expect(inspectButton.disabled).toBe(true);
  });

  it("sends composer text with Enter and keeps Shift Enter for multiline input", () => {
    const onSendMessage = vi.fn();
    render(
      <AgentSidebar
        state={baseProjectState}
        conversation={conversationFixture}
        conversationSuggestions={suggestionsFixture}
        onRunAgent={vi.fn()}
        onSendMessage={onSendMessage}
      />
    );

    const input = screen.getByPlaceholderText(/告诉 Agent 你想推进什么/);
    fireEvent.change(input, { target: { value: "分析当前风险" } });

    // Shift+Enter should not send
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSendMessage).not.toHaveBeenCalled();

    // Plain Enter should send
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    expect(onSendMessage).toHaveBeenCalledTimes(1);
    expect(onSendMessage).toHaveBeenCalledWith("分析当前风险", expect.not.objectContaining({ thinkingLevel: expect.anything() }));
  });

  it.skip("sends explicit executable instruction for fallback quick reply labeled '根据签到调整计划'", () => {
    const onSendMessage = vi.fn();

    render(
      <AgentSidebar
        state={baseProjectState}
        onRunAgent={vi.fn()}
        onSendMessage={onSendMessage}
      />
    );

    const button = screen.getByRole("button", { name: "根据签到调整计划" });
    fireEvent.click(button);

    const sentInstruction = onSendMessage.mock.calls[0][0] as string;
    expect(sentInstruction).toContain("replan");
    expect(sentInstruction).toContain("根据签到调整计划");
    expect(sentInstruction).not.toBe("根据签到调整计划");
  });

  it.skip("sends explicit executable instruction for fallback quick reply labeled '生成下一步行动卡'", () => {
    const onSendMessage = vi.fn();

    render(
      <AgentSidebar
        state={baseProjectState}
        onRunAgent={vi.fn()}
        onSendMessage={onSendMessage}
      />
    );

    const buttons = screen.getAllByRole("button", { name: "生成下一步行动卡" });
    fireEvent.click(buttons[0]);

    const sentInstruction = onSendMessage.mock.calls[0][0] as string;
    expect(sentInstruction).toContain("push");
    expect(sentInstruction).toContain("生成下一步行动卡");
    expect(sentInstruction).not.toBe("生成下一步行动卡");
  });

  it.skip("sends explicit executable instruction for fallback quick reply labeled '分析当前风险'", () => {
    const onSendMessage = vi.fn();

    render(
      <AgentSidebar
        state={baseProjectState}
        onRunAgent={vi.fn()}
        onSendMessage={onSendMessage}
      />
    );

    const buttons = screen.getAllByRole("button", { name: "分析当前风险" });
    fireEvent.click(buttons[0]);

    const sentInstruction = onSendMessage.mock.calls[0][0] as string;
    expect(sentInstruction).toContain("risk");
    expect(sentInstruction).toContain("分析当前风险");
    expect(sentInstruction).not.toBe("分析当前风险");
  });

  it("shows display label instead of raw replan instruction in user message bubble", () => {
    const conversationWithReplan: AgentConversation = {
      ...conversationFixture,
      messages: [
        ...conversationFixture.messages,
        {
          id: "msg-user-replan",
          conversation_id: "conv-1",
          role: "user",
          content: "请执行 replan 模块：根据签到结果调整项目计划。用户点击了快捷回复「根据签到调整计划」，请直接运行 replan 模块生成计划调整草案。",
          structured_payload: {},
          created_at: "2026-06-07T10:01:00Z",
        },
      ],
    };

    render(
      <AgentSidebar
        state={baseProjectState}
        conversation={conversationWithReplan}
        onRunAgent={vi.fn()}
      />
    );

    expect(screen.getAllByText("根据签到调整计划").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/请执行 replan 模块/)).toBeNull();
  });

  it("shows display label instead of raw replan instruction in pending user bubble", () => {
    render(
      <AgentSidebar
        state={baseProjectState}
        conversation={conversationFixture}
        pendingConversation
        pendingConversationInstruction="请执行 replan 模块：根据签到结果调整项目计划。用户点击了快捷回复「根据签到调整计划」，请直接运行 replan 模块生成计划调整草案。"
        onRunAgent={vi.fn()}
      />
    );

    expect(screen.getAllByText("根据签到调整计划").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/请执行 replan 模块/)).toBeNull();
  });

  it("disables error retry button while pending conversation", () => {
    render(
      <AgentSidebar
        state={baseProjectState}
        conversation={conversationFixture}
        conversationError="这次没有生成可用结果"
        pendingConversationInstruction="分析当前风险"
        pendingConversation
        onRunAgent={vi.fn()}
        onSendMessage={vi.fn()}
      />
    );

    const retryButton = screen.getByText("重新发送") as HTMLButtonElement;
    expect(retryButton.disabled).toBe(true);
  });

  it("confirmed proposal artifact is filtered out of visible list", () => {
    const stateWithConfirmedProposal: ProjectState = {
      ...baseProjectState,
      agent_proposals: [
        {
          id: "proposal-1",
          project_id: "proj-1",
          workspace_id: "ws-1",
          proposal_type: "replan",
          status: "confirmed",
          agent_event_id: "event-1",
          payload: {},
          confirmed_by: "user-1",
          confirmed_at: "2026-06-07T10:00:00Z",
          created_at: "2026-06-07T09:00:00Z",
        },
      ],
    };

    const conversationWithPayload: AgentConversation = {
      ...conversationFixture,
      messages: [
        {
          id: "msg-payload",
          conversation_id: "conv-1",
          role: "assistant",
          content: "已生成建议。",
          structured_payload: {
            artifacts: [
              {
                id: "payload-art-1",
                type: "proposal",
                status: "pending_confirmation",
                title: "调整计划草案",
                summary: "建议重新分配任务。",
                rationale: "后端进度滞后。",
                impact: ["影响 2 个任务"],
                linked_entity_ids: ["proposal-1"],
              },
            ],
          },
          created_at: "2026-06-07T10:00:00Z",
        },
      ],
    };

    render(
      <AgentSidebar
        state={stateWithConfirmedProposal}
        conversation={conversationWithPayload}
        onRunAgent={vi.fn()}
        onConfirmArtifact={vi.fn()}
      />
    );

    // Component filters out confirmed artifacts from visible list
    expect(screen.queryByText("调整计划草案")).toBeNull();
    expect(screen.queryByRole("button", { name: "确认应用" })).toBeNull();
  });

  it("sends no invalid thinking override when model does not support selected level", () => {
    // Simulates the scenario: user selected a thinking level, then switches to a
    // model whose supportedThinkingLevels does not include it. The component
    // validates the level before sending and omits unsupported overrides.
    const onSendMessage = vi.fn();
    const onRunAgent = vi.fn();

    render(
      <AgentSidebar
        state={baseProjectState}
        conversation={conversationFixture}
        onRunAgent={onRunAgent}
        onSendMessage={onSendMessage}
      />
    );

    // The sidebar correctly omits thinkingLevel from message options when
    // no model config is loaded (thinking unsupported).
    const input = screen.getByPlaceholderText(/告诉 Agent 你想推进什么/);
    fireEvent.change(input, { target: { value: "根据签到调整计划" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

    expect(onSendMessage).toHaveBeenCalledWith(
      "根据签到调整计划",
      expect.not.objectContaining({ thinkingLevel: expect.anything() }),
    );
  });

  it("renders Composer outside the scrollable message area", () => {
    const { container } = render(
      <AgentSidebar
        state={baseProjectState}
        conversation={conversationFixture}
        onRunAgent={vi.fn()}
        onSendMessage={vi.fn()}
      />
    );

    // The sidebar content container should be a flex column
    const sidebarContent = container.querySelector("#agent-sidebar-content");
    expect(sidebarContent).toBeTruthy();
    expect(sidebarContent!.className).toContain("flex");
    expect(sidebarContent!.className).toContain("flex-col");

    // The scroll area should have overflow-y-auto and min-h-0
    const scrollArea = sidebarContent!.querySelector(".overflow-y-auto");
    expect(scrollArea).toBeTruthy();
    expect(scrollArea!.className).toContain("min-h-0");

    // The Composer container should be a sibling of the scroll area, not inside it
    const composer = screen.getByPlaceholderText(/告诉 Agent 你想推进什么/);
    const composerContainer = composer.closest("[data-tour='composer']");
    expect(composerContainer).toBeTruthy();

    // Composer's parent should NOT be inside the scroll area
    expect(scrollArea!.contains(composerContainer!)).toBe(false);
    // But it should be inside the sidebar content container
    expect(sidebarContent!.contains(composerContainer!)).toBe(true);
  });

  it("keeps Composer visible when scrolling message area", () => {
    const { container } = render(
      <AgentSidebar
        state={baseProjectState}
        conversation={conversationFixture}
        onRunAgent={vi.fn()}
        onSendMessage={vi.fn()}
      />
    );

    // The Composer container should have shrink-0 to stay fixed at bottom
    const composerContainer = container.querySelector("[data-tour='composer']");
    expect(composerContainer).toBeTruthy();
    expect(composerContainer!.className).toContain("shrink-0");
  });

  it("dismissed proposal artifact is filtered out of visible list", () => {
    const stateWithRejectedProposal: ProjectState = {
      ...baseProjectState,
      agent_proposals: [
        {
          id: "proposal-1",
          project_id: "proj-1",
          workspace_id: "ws-1",
          proposal_type: "replan",
          status: "rejected",
          agent_event_id: "event-1",
          payload: {},
          confirmed_by: null,
          confirmed_at: null,
          rejection_reason: "不需要调整",
          created_at: "2026-06-07T09:00:00Z",
        },
      ],
    };

    const conversationWithPayload: AgentConversation = {
      ...conversationFixture,
      messages: [
        {
          id: "msg-payload",
          conversation_id: "conv-1",
          role: "assistant",
          content: "已生成建议。",
          structured_payload: {
            artifacts: [
              {
                id: "payload-art-1",
                type: "proposal",
                status: "pending_confirmation",
                title: "调整计划草案",
                summary: "建议重新分配任务。",
                rationale: "后端进度滞后。",
                impact: ["影响 2 个任务"],
                linked_entity_ids: ["proposal-1"],
              },
            ],
          },
          created_at: "2026-06-07T10:00:00Z",
        },
      ],
    };

    render(
      <AgentSidebar
        state={stateWithRejectedProposal}
        conversation={conversationWithPayload}
        onRunAgent={vi.fn()}
        onConfirmArtifact={vi.fn()}
      />
    );

    // Component filters out dismissed artifacts from visible list
    expect(screen.queryByText("调整计划草案")).toBeNull();
    expect(screen.queryByRole("button", { name: "确认应用" })).toBeNull();
  });

  describe("auto-scroll on streamTurn activity updates", () => {
    function makeStreamTurn(activities: Array<{ id: string; kind: string; label?: string; content?: string; status?: string }>) {
      return {
        clientTurnId: "turn-scroll-test",
        status: "executing" as const,
        userMessage: null,
        blocks: {},
        blockOrder: 0,
        thinkingOpen: false,
        thinkingWasAutoFolded: false,
        thinkingWasManuallyToggled: false,
        executionSteps: [],
        error: null,
        finalContent: null,
        activities: activities as AgentStreamTurn["activities"],
        runSummary: null,
        processStartedAt: null,
        processCompletedAt: null,
        processDurationMs: 0,
        streamSequence: 0,
        processAutoCollapsed: false,
        processExpanded: true,
        answerBuffer: "",
      };
    }

    it("scrolls to bottom when activities update and user is near bottom", () => {
      const initialTurn = makeStreamTurn([]);
      const { rerender } = render(
        <AgentSidebar
          state={baseProjectState}
          conversation={conversationFixture}
          streamTurn={initialTurn}
          onRunAgent={vi.fn()}
        />,
      );

      // Mock scroll metrics so the scroll container has real dimensions
      const scrollEl = document.querySelector(".overflow-y-auto") as HTMLElement;
      expect(scrollEl).toBeTruthy();
      vi.spyOn(scrollEl, "scrollHeight", "get").mockReturnValue(2000);
      vi.spyOn(scrollEl, "clientHeight", "get").mockReturnValue(500);
      // Default isNearBottomRef is true (no scroll event fired yet)

      // Re-render with new activities
      const updatedTurn = makeStreamTurn([
        { id: "a1", kind: "tool", label: "读取项目状态", status: "completed" },
        { id: "a2", kind: "progress", content: "正在分析签到数据" },
      ]);
      rerender(
        <AgentSidebar
          state={baseProjectState}
          conversation={conversationFixture}
          streamTurn={updatedTurn}
          onRunAgent={vi.fn()}
        />,
      );

      // Near bottom → auto-scroll fires
      expect(scrollEl.scrollTop).toBe(2000);
    });

    it("does not force scroll when user has scrolled away from bottom", () => {
      const initialTurn = makeStreamTurn([]);
      const { rerender } = render(
        <AgentSidebar
          state={baseProjectState}
          conversation={conversationFixture}
          streamTurn={initialTurn}
          onRunAgent={vi.fn()}
        />,
      );

      const scrollEl = document.querySelector(".overflow-y-auto") as HTMLElement;
      vi.spyOn(scrollEl, "scrollHeight", "get").mockReturnValue(2000);
      vi.spyOn(scrollEl, "clientHeight", "get").mockReturnValue(500);

      // Simulate user scrolling up — scrollTop=200 → distance=2000-200-500=1300 > 120
      scrollEl.scrollTop = 200;
      fireEvent.scroll(scrollEl);
      // isNearBottomRef is now false

      // Re-render with new activities
      const updatedTurn = makeStreamTurn([
        { id: "a1", kind: "tool", label: "读取项目状态", status: "completed" },
        { id: "a2", kind: "progress", content: "正在分析签到数据" },
      ]);
      rerender(
        <AgentSidebar
          state={baseProjectState}
          conversation={conversationFixture}
          streamTurn={updatedTurn}
          onRunAgent={vi.fn()}
        />,
      );

      // User scrolled up → scrollTop unchanged
      expect(scrollEl.scrollTop).toBe(200);
    });
  });
});
