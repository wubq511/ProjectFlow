/**
 * Regression tests for ChatMessage output-channel fix.
 *
 * Bug: thinkingContent heuristic showed raw tool JSON in a fold.
 * Fix: thinking_content and execution_steps from structured_payload are shown
 * in collapsed folds. Raw tool JSON is never visible.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { ChatMessage } from "./ChatMessage";
import type { AgentStreamTurn } from "@/lib/types";

// Mock framer-motion to avoid animation issues in tests
vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => {
      return <div {...props}>{children}</div>;
    },
  },
  AnimatePresence: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

// Mock MarkdownContent
vi.mock("./MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

// Mock StreamingText to track when it's used
vi.mock("./StreamingText", () => ({
  StreamingText: ({ buffer, isStreaming }: { buffer: string; isStreaming?: boolean }) => (
    <div data-testid="streaming-text" data-streaming={String(isStreaming)}>{buffer}</div>
  ),
}));

// Mock MessageActions
vi.mock("./MessageActions", () => ({
  MessageActions: () => <div data-testid="message-actions" />,
}));

function makeAssistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    conversation_id: "conv-1",
    role: "assistant" as const,
    content: "这是最终回答内容。",
    structured_payload: {},
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("ChatMessage output-channel fix", () => {
  describe("final answer rendering", () => {
    it("renders message.content as final answer", () => {
      const message = makeAssistantMessage({ content: "项目方向已明确。" });
      render(<ChatMessage message={message} />);
      expect(screen.getByText("项目方向已明确。")).toBeTruthy();
    });

    it("does not render raw tool JSON in content", () => {
      const message = makeAssistantMessage({
        content: "根据分析，建议进入阶段规划。",
      });
      render(<ChatMessage message={message} />);
      const markdown = screen.getByTestId("markdown");
      expect(markdown.textContent).not.toContain("toolCall");
      expect(markdown.textContent).not.toContain("get_project_state");
    });
  });

  describe("thinking_content not visible (compat only)", () => {
    it("thinking_content is NOT rendered even when present (spec #10)", () => {
      const message = makeAssistantMessage({
        structured_payload: { thinking_content: "让我分析一下项目状态..." },
      });
      render(<ChatMessage message={message} />);
      // thinking_content is persisted for compat but NOT visible
      expect(screen.queryByText("思考过程")).toBeNull();
      expect(screen.queryByText("让我分析一下项目状态...")).toBeNull();
    });

    it("no thinking fold when thinking_content is empty", () => {
      const message = makeAssistantMessage({ structured_payload: { thinking_content: "" } });
      render(<ChatMessage message={message} />);
      expect(screen.queryByText("思考过程")).toBeNull();
    });

    it("no thinking fold when thinking_content is missing", () => {
      const message = makeAssistantMessage({ structured_payload: {} });
      render(<ChatMessage message={message} />);
      expect(screen.queryByText("思考过程")).toBeNull();
    });
  });

  describe("execution_steps fold", () => {
    it("shows execution steps fold when steps exist", () => {
      const steps = [
        { tool_name: "get_project_state", status: "completed", label: "调用get_project_state" },
        { tool_name: "create_risk", status: "completed", label: "调用create_risk" },
      ];
      const message = makeAssistantMessage({
        structured_payload: { execution_steps: steps },
      });
      render(<ChatMessage message={message} />);
      expect(screen.getByText("执行过程")).toBeTruthy();
      expect(screen.getByText("2 步")).toBeTruthy();
    });

    it("fold is collapsed by default", () => {
      const steps = [
        { tool_name: "get_project_state", status: "completed", label: "调用get_project_state" },
      ];
      const message = makeAssistantMessage({
        structured_payload: { execution_steps: steps },
      });
      render(<ChatMessage message={message} />);
      expect(screen.queryByText("调用get_project_state")).toBeNull();
    });

    it("fold expands on click", () => {
      const steps = [
        { tool_name: "get_project_state", status: "completed", label: "调用get_project_state" },
      ];
      const message = makeAssistantMessage({
        structured_payload: { execution_steps: steps },
      });
      render(<ChatMessage message={message} />);
      fireEvent.click(screen.getByText("执行过程"));
      expect(screen.getByText("调用get_project_state")).toBeTruthy();
    });

    it("no fold when no execution_steps", () => {
      const message = makeAssistantMessage({ structured_payload: {} });
      render(<ChatMessage message={message} />);
      expect(screen.queryByText("执行过程")).toBeNull();
    });

    it("no fold when execution_steps is empty array", () => {
      const message = makeAssistantMessage({
        structured_payload: { execution_steps: [] },
      });
      render(<ChatMessage message={message} />);
      expect(screen.queryByText("执行过程")).toBeNull();
    });
  });

  describe("both folds together", () => {
    it("execution fold renders; thinking_content is NOT visible (compat only)", () => {
      const message = makeAssistantMessage({
        content: "最终回答",
        structured_payload: {
          thinking_content: "思考内容",
          execution_steps: [{ tool_name: "get_project_state", status: "completed", label: "调用get_project_state" }],
        },
      });
      render(<ChatMessage message={message} />);
      // thinking_content is NOT visible (spec #10)
      expect(screen.queryByText("思考过程")).toBeNull();
      // Execution steps still render
      expect(screen.getByText("执行过程")).toBeTruthy();
      expect(screen.getByText("最终回答")).toBeTruthy();
    });
  });

  describe("raw JSON absence", () => {
    it("content does not contain toolcall delta JSON", () => {
      const steps = [
        { tool_name: "get_workspace_state", status: "completed", label: "调用get_workspace_state" },
      ];
      const message = makeAssistantMessage({
        content: "已完成分析。",
        structured_payload: { execution_steps: steps },
      });
      render(<ChatMessage message={message} />);
      const markdown = screen.getByTestId("markdown");
      expect(markdown.textContent).toBe("已完成分析。");
      expect(markdown.textContent).not.toContain("{");
    });
  });

  describe("persisted folds render after reload", () => {
    it("execution_steps from structured_payload survive reload; thinking_content is NOT visible (compat only)", () => {
      const steps = [
        { tool_name: "get_project_state", status: "completed", label: "调用get_project_state" },
        { tool_name: "generate_plan_proposal", status: "completed", label: "调用generate_plan_proposal" },
        { tool_name: "create_risk", status: "failed", label: "调用create_risk" },
      ];
      const message = makeAssistantMessage({
        content: "最终回答",
        structured_payload: {
          next_suggestions: ["下一步做什么？"],
          suggestions: [],
          thinking_content: "让我先查看项目状态...",
          execution_steps: steps,
        },
      });
      render(<ChatMessage message={message} />);
      // thinking_content is persisted for compat but NOT rendered (spec #10)
      expect(screen.queryByText("思考过程")).toBeNull();
      expect(screen.queryByText("让我先查看项目状态...")).toBeNull();
      // Execution steps still render
      expect(screen.getByText("3 步")).toBeTruthy();
      fireEvent.click(screen.getByText("执行过程"));
      expect(screen.getByText("调用get_project_state")).toBeTruthy();
    });
  });

  describe("user messages unaffected", () => {
    it("user messages do not show thinking or execution folds", () => {
      const message = {
        id: "msg-user",
        conversation_id: "conv-1",
        role: "user" as const,
        content: "请帮我分析项目",
        structured_payload: {},
        created_at: new Date().toISOString(),
      };
      render(<ChatMessage message={message} />);
      expect(screen.queryByText("思考过程")).toBeNull();
      expect(screen.queryByText("执行过程")).toBeNull();
      expect(screen.getByText("请帮我分析项目")).toBeTruthy();
    });

    it("renders slash command chip without placeholder for default instruction", () => {
      const message = {
        id: "msg-user-slash",
        conversation_id: "conv-1",
        role: "user" as const,
        content: "请执行 clarify 模块",
        structured_payload: { slash_command: "clarify" },
        created_at: new Date().toISOString(),
      };
      render(<ChatMessage message={message} />);
      expect(screen.getByText("方向澄清")).toBeTruthy();
      // No extra body was typed, so only the chip is shown.
      expect(screen.queryByText("补充上下文...")).toBeNull();
      expect(screen.queryByText("请执行 clarify 模块")).toBeNull();
    });

    it("renders slash command chip plus typed body when additional text exists", () => {
      const message = {
        id: "msg-user-slash-body",
        conversation_id: "conv-1",
        role: "user" as const,
        content: "帮我聚焦目标",
        structured_payload: { slash_command: "clarify" },
        created_at: new Date().toISOString(),
      };
      render(<ChatMessage message={message} />);
      expect(screen.getByText("方向澄清")).toBeTruthy();
      expect(screen.getByText("帮我聚焦目标")).toBeTruthy();
    });

    it("falls back to plain text for unknown slash_command", () => {
      const message = {
        id: "msg-user-unknown",
        conversation_id: "conv-1",
        role: "user" as const,
        content: "普通消息",
        structured_payload: { slash_command: "unknown" },
        created_at: new Date().toISOString(),
      };
      render(<ChatMessage message={message} />);
      expect(screen.getByText("普通消息")).toBeTruthy();
    });
  });

  describe("Fix 6: StreamingText preservation for completed turns", () => {
    function makeStreamTurn(overrides: Partial<AgentStreamTurn>): AgentStreamTurn {
      return {
        clientTurnId: "turn-1",
        status: "completed",
        userMessage: null,
        blocks: {},
        blockOrder: 0,
        thinkingOpen: false,
        thinkingWasAutoFolded: false,
        thinkingWasManuallyToggled: false,
        executionSteps: [],
        error: null,
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
        ...overrides,
      };
    }

    it("uses StreamingText when streamTurn has answerBuffer, even with status=completed", () => {
      const message = makeAssistantMessage({ content: "最终回答" });
      const streamTurn = makeStreamTurn({
        status: "completed",
        answerBuffer: "这是渐进显示的回答内容",
        finalContent: "这是渐进显示的回答内容",
      });
      render(<ChatMessage message={message} streamTurn={streamTurn} isLast={false} />);
      // Should use StreamingText, not MarkdownContent
      expect(screen.getByTestId("streaming-text")).toBeTruthy();
      expect(screen.getByTestId("streaming-text").textContent).toBe("这是渐进显示的回答内容");
      // isStreaming should be false for completed status
      expect(screen.getByTestId("streaming-text").getAttribute("data-streaming")).toBe("false");
    });

    it("uses StreamingText with isStreaming=true when status is answering", () => {
      const message = makeAssistantMessage({ content: "" });
      const streamTurn = makeStreamTurn({
        status: "answering",
        answerBuffer: "正在流式输出",
      });
      render(<ChatMessage message={message} streamTurn={streamTurn} isLast={false} />);
      expect(screen.getByTestId("streaming-text")).toBeTruthy();
      expect(screen.getByTestId("streaming-text").getAttribute("data-streaming")).toBe("true");
    });

    it("uses MarkdownContent for persisted messages (no streamTurn)", () => {
      const message = makeAssistantMessage({ content: "已保存的回答" });
      render(<ChatMessage message={message} />);
      expect(screen.getByTestId("markdown")).toBeTruthy();
      expect(screen.getByTestId("markdown").textContent).toBe("已保存的回答");
      expect(screen.queryByTestId("streaming-text")).toBeNull();
    });

    it("uses MarkdownContent when streamTurn has empty answerBuffer", () => {
      const message = makeAssistantMessage({ content: "最终回答" });
      const streamTurn = makeStreamTurn({
        status: "completed",
        answerBuffer: "",
        finalContent: "最终回答",
      });
      render(<ChatMessage message={message} streamTurn={streamTurn} isLast={false} />);
      // Empty answerBuffer → falls through to MarkdownContent
      expect(screen.getByTestId("markdown")).toBeTruthy();
    });
  });
});
