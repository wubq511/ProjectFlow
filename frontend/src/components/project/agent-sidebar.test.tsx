import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  AgentArtifact,
  AgentConversation,
  AgentSuggestion,
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
      created_by_agent: false,
      updated_at: "2026-06-01T00:00:00Z",
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
  it("sends suggestion clicks as user instructions", () => {
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

    expect(onSendMessage).toHaveBeenCalledWith("根据签到调整计划");
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

  it("renders backward-compatible string suggestions and sends them on click", () => {
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

    expect(onSendMessage).toHaveBeenCalledWith("旧格式建议");
  });

  it("disables suggestion buttons while pending conversation", () => {
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

    const retryButton = screen.getByRole("button", { name: "重新发送" });
    fireEvent.click(retryButton);

    expect(onSendMessage).toHaveBeenCalledWith("分析当前风险");
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

    const input = screen.getByPlaceholderText("告诉 Agent 你的具体要求...");
    fireEvent.change(input, { target: { value: "分析当前风险" } });

    // Shift+Enter should not send
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSendMessage).not.toHaveBeenCalled();

    // Plain Enter should send
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    expect(onSendMessage).toHaveBeenCalledTimes(1);
    expect(onSendMessage).toHaveBeenCalledWith("分析当前风险");
  });

  it("sends explicit executable instruction for fallback quick reply labeled '根据签到调整计划'", () => {
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

  it("sends explicit executable instruction for fallback quick reply labeled '生成下一步行动卡'", () => {
    const onSendMessage = vi.fn();

    render(
      <AgentSidebar
        state={baseProjectState}
        onRunAgent={vi.fn()}
        onSendMessage={onSendMessage}
      />
    );

    const button = screen.getByRole("button", { name: "生成下一步行动卡" });
    fireEvent.click(button);

    const sentInstruction = onSendMessage.mock.calls[0][0] as string;
    expect(sentInstruction).toContain("push");
    expect(sentInstruction).toContain("生成下一步行动卡");
    expect(sentInstruction).not.toBe("生成下一步行动卡");
  });

  it("sends explicit executable instruction for fallback quick reply labeled '分析当前风险'", () => {
    const onSendMessage = vi.fn();

    render(
      <AgentSidebar
        state={baseProjectState}
        onRunAgent={vi.fn()}
        onSendMessage={onSendMessage}
      />
    );

    const button = screen.getByRole("button", { name: "分析当前风险" });
    fireEvent.click(button);

    const sentInstruction = onSendMessage.mock.calls[0][0] as string;
    expect(sentInstruction).toContain("risk");
    expect(sentInstruction).toContain("分析当前风险");
    expect(sentInstruction).not.toBe("分析当前风险");
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

    const retryButton = screen.getByRole("button", { name: "重新发送" }) as HTMLButtonElement;
    expect(retryButton.disabled).toBe(true);
  });
});
