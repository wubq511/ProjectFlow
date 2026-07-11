"use client";

import { useCallback, useReducer, useRef } from "react";
import type {
  StreamContentEvent,
  StreamTurnStatus,
  StreamBlock,
  ExecutionStep,
  AgentStreamTurn,
  AgentConversationMessage,
  AgentConversationTurn,
} from "./types";

// ---------------------------------------------------------------------------
// Reducer actions
// ---------------------------------------------------------------------------

type StreamTurnAction =
  | { type: "RESET" }
  | { type: "CONNECTING"; clientTurnId: string; userMessage: AgentConversationMessage }
  | { type: "THINKING_START"; contentIndex: number; messageSeq: number }
  | { type: "THINKING_DELTA"; contentIndex: number; messageSeq: number; content: string }
  | { type: "THINKING_END"; contentIndex: number; messageSeq: number }
  | { type: "TEXT_START"; contentIndex: number; messageSeq: number }
  | { type: "TEXT_DELTA"; contentIndex: number; messageSeq: number; content: string }
  | { type: "TEXT_END"; contentIndex: number; messageSeq: number }
  | { type: "TOOL_STARTED"; tool_name: string; tool_call_id?: string; label: string }
  | { type: "TOOL_COMPLETED"; tool_name: string; tool_call_id?: string }
  | { type: "TOOL_FAILED"; tool_name: string; tool_call_id?: string }
  | { type: "TOOL_BLOCKED"; tool_name: string; tool_call_id?: string; label?: string }
  | { type: "DONE"; finalContent: string; thinkingContent: string; executionSteps: ExecutionStep[] }
  | { type: "ERROR"; message: string }
  | { type: "CANCEL" }
  | { type: "DISCONNECT" }
  | { type: "TOGGLE_THINKING" };

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export function createInitialTurn(): AgentStreamTurn {
  return {
    clientTurnId: "",
    status: "idle",
    userMessage: null,
    blocks: {},
    blockOrder: 0,
    thinkingOpen: false,
    thinkingWasAutoFolded: false,
    thinkingWasManuallyToggled: false,
    executionSteps: [],
    error: null,
    finalContent: null,
  };
}

// ---------------------------------------------------------------------------
// Composite block key: `${messageSeq}:${contentIndex}`
// ---------------------------------------------------------------------------

function blockKey(messageSeq: number, contentIndex: number): string {
  return `${messageSeq}:${contentIndex}`;
}

// ---------------------------------------------------------------------------
// Reducer (exported for testing)
// ---------------------------------------------------------------------------

export function streamTurnReducer(state: AgentStreamTurn, action: StreamTurnAction): AgentStreamTurn {
  switch (action.type) {
    case "RESET":
      return createInitialTurn();

    case "CONNECTING":
      return {
        ...createInitialTurn(),
        clientTurnId: action.clientTurnId,
        status: "connecting",
        userMessage: action.userMessage,
      };

    case "THINKING_START": {
      const key = blockKey(action.messageSeq, action.contentIndex);
      const order = state.blockOrder;
      const block: StreamBlock = { kind: "thinking", contentIndex: action.contentIndex, messageSeq: action.messageSeq, content: "", completed: false, order };
      // Only auto-expand thinking when in connecting/thinking phase.
      // Late THINKING_START during answering/executing should not re-open the folded area.
      const shouldOpen = state.status === "connecting" || state.status === "thinking";
      return {
        ...state,
        status: state.status === "connecting" ? "thinking" : state.status,
        blocks: { ...state.blocks, [key]: block },
        blockOrder: order + 1,
        thinkingOpen: shouldOpen ? true : state.thinkingOpen,
      };
    }

    case "THINKING_DELTA": {
      const key = blockKey(action.messageSeq, action.contentIndex);
      const existing = state.blocks[key];
      // Lazy init: if provider didn't send thinking_start, create the block
      if (!existing) {
        const initState: AgentStreamTurn = {
          ...state,
          status: state.status === "connecting" ? "thinking" : state.status,
          blocks: {
            ...state.blocks,
            [key]: { kind: "thinking", contentIndex: action.contentIndex, messageSeq: action.messageSeq, content: "", completed: false, order: state.blockOrder },
          },
          blockOrder: state.blockOrder + 1,
          thinkingOpen: state.status === "connecting" || state.status === "thinking" ? true : state.thinkingOpen,
        };
        return streamTurnReducer(initState, action);
      }
      if (existing.kind !== "thinking") return state;
      return {
        ...state,
        status: state.status === "connecting" ? "thinking" : state.status,
        blocks: {
          ...state.blocks,
          [key]: { ...existing, content: existing.content + action.content },
        },
        thinkingOpen: state.status === "connecting" ? true : state.thinkingOpen,
      };
    }

    case "THINKING_END": {
      const key = blockKey(action.messageSeq, action.contentIndex);
      const existing = state.blocks[key];
      if (!existing || existing.kind !== "thinking") return state;
      const updatedBlocks = { ...state.blocks, [key]: { ...existing, completed: true } };
      // Auto-fold if all thinking blocks are complete and user hasn't manually toggled
      const allThinkingComplete = Object.values(updatedBlocks)
        .filter((b) => b.kind === "thinking")
        .every((b) => b.completed);
      const shouldAutoFold = allThinkingComplete && !state.thinkingWasManuallyToggled;
      return {
        ...state,
        blocks: updatedBlocks,
        thinkingOpen: shouldAutoFold ? false : state.thinkingOpen,
      };
    }

    case "TEXT_START": {
      const key = blockKey(action.messageSeq, action.contentIndex);
      const order = state.blockOrder;
      const block: StreamBlock = { kind: "text", contentIndex: action.contentIndex, messageSeq: action.messageSeq, content: "", completed: false, order };
      // First text start → answering + auto-fold thinking (one-time, ALWAYS folds even if manually toggled)
      const isFirstText = !Object.values(state.blocks).some((b) => b.kind === "text");
      return {
        ...state,
        status: "answering",
        blocks: { ...state.blocks, [key]: block },
        blockOrder: order + 1,
        // One-time auto-fold on first answer start — overrides manual toggle
        thinkingOpen: isFirstText && !state.thinkingWasAutoFolded
          ? false
          : state.thinkingOpen,
        thinkingWasAutoFolded: isFirstText ? true : state.thinkingWasAutoFolded,
      };
    }

    case "TEXT_DELTA": {
      const key = blockKey(action.messageSeq, action.contentIndex);
      const existing = state.blocks[key];
      // Lazy init: if provider didn't send text_start, create the block
      if (!existing) {
        const isFirstText = !Object.values(state.blocks).some((b) => b.kind === "text");
        const initState: AgentStreamTurn = {
          ...state,
          status: "answering",
          blocks: {
            ...state.blocks,
            [key]: { kind: "text", contentIndex: action.contentIndex, messageSeq: action.messageSeq, content: "", completed: false, order: state.blockOrder },
          },
          blockOrder: state.blockOrder + 1,
          // Apply same auto-fold logic as TEXT_START when lazy-init creates the first text block
          thinkingOpen: isFirstText && !state.thinkingWasAutoFolded
            ? false
            : state.thinkingOpen,
          thinkingWasAutoFolded: isFirstText ? true : state.thinkingWasAutoFolded,
        };
        return streamTurnReducer(initState, action);
      }
      if (existing.kind !== "text") return state;
      return {
        ...state,
        status: "answering",
        blocks: {
          ...state.blocks,
          [key]: { ...existing, content: existing.content + action.content },
        },
      };
    }

    case "TEXT_END": {
      const key = blockKey(action.messageSeq, action.contentIndex);
      const existing = state.blocks[key];
      if (!existing || existing.kind !== "text") return state;
      return {
        ...state,
        blocks: { ...state.blocks, [key]: { ...existing, completed: true } },
      };
    }

    case "TOOL_STARTED":
      return {
        ...state,
        status: "executing",
        executionSteps: [...state.executionSteps, {
          tool_name: action.tool_name,
          tool_call_id: action.tool_call_id,
          status: "started",
          label: action.label,
        }],
      };

    case "TOOL_COMPLETED": {
      const steps = updateStep(state.executionSteps, action.tool_call_id, action.tool_name, "completed");
      return { ...state, executionSteps: steps };
    }

    case "TOOL_FAILED": {
      const steps = updateStep(state.executionSteps, action.tool_call_id, action.tool_name, "failed");
      return { ...state, executionSteps: steps };
    }

    case "TOOL_BLOCKED": {
      // Check if there's a matching started step to update
      const hasMatchingStarted = state.executionSteps.some((step) => {
        if (step.status !== "started") return false;
        if (action.tool_call_id && step.tool_call_id === action.tool_call_id) return true;
        if (!action.tool_call_id && action.tool_name && step.tool_name === action.tool_name) return true;
        return false;
      });
      if (hasMatchingStarted) {
        const steps = updateStep(state.executionSteps, action.tool_call_id, action.tool_name, "blocked");
        return { ...state, executionSteps: steps };
      }
      // No matching started step — append standalone blocked entry (policy_block without tool_call_id)
      return {
        ...state,
        executionSteps: [...state.executionSteps, {
          tool_name: action.tool_name,
          tool_call_id: action.tool_call_id,
          status: "blocked" as const,
          label: action.label ?? "执行项目操作",
        }],
      };
    }

    case "DONE": {
      const hasThinkingBlock = Object.values(state.blocks).some((block) => block.kind === "thinking");
      const blocks = !hasThinkingBlock && action.thinkingContent
        ? {
            ...state.blocks,
            "done:thinking": {
              kind: "thinking" as const,
              contentIndex: -1,
              messageSeq: -1,
              content: action.thinkingContent,
              completed: true,
              order: state.blockOrder,
            },
          }
        : state.blocks;
      return {
        ...state,
        status: "completed",
        blocks,
        blockOrder: blocks === state.blocks ? state.blockOrder : state.blockOrder + 1,
        finalContent: action.finalContent,
        executionSteps: action.executionSteps.length > 0 ? action.executionSteps : state.executionSteps,
        thinkingOpen: false, // Fold on completion
        error: null,
      };
    }

    case "ERROR":
      return {
        ...state,
        status: "failed",
        error: action.message,
      };

    case "CANCEL":
      return {
        ...state,
        status: "cancelled",
        error: "已停止生成",
      };

    case "DISCONNECT":
      return {
        ...state,
        status: "disconnected",
        error: "连接意外中断，可重试",
      };

    case "TOGGLE_THINKING":
      return {
        ...state,
        thinkingOpen: !state.thinkingOpen,
        thinkingWasManuallyToggled: true,
      };

    default:
      return state;
  }
}

function updateStep(
  steps: ExecutionStep[],
  toolCallId: string | undefined,
  toolName: string,
  newStatus: "completed" | "failed" | "blocked",
): ExecutionStep[] {
  return steps.map((step, idx) => {
    if (step.status !== "started") return step;
    if (toolCallId && step.tool_call_id === toolCallId) return { ...step, status: newStatus };
    if (!toolCallId && step.tool_name === toolName) {
      // Find the last matching started step by name
      const lastIdx = steps.reduce((acc, s, i) => (s.tool_name === toolName && s.status === "started" ? i : acc), -1);
      return idx === lastIdx ? { ...step, status: newStatus } : step;
    }
    return step;
  });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAgentStreamTurn() {
  const [turn, dispatch] = useReducer(
    streamTurnReducer,
    createInitialTurn(),
  );

  const dispatchContentEvent = useCallback((event: StreamContentEvent) => {
    const seq = event.message_seq ?? 0;
    switch (event.kind) {
      case "thinking":
        switch (event.phase) {
          case "start": dispatch({ type: "THINKING_START", contentIndex: event.content_index, messageSeq: seq }); break;
          case "delta": dispatch({ type: "THINKING_DELTA", contentIndex: event.content_index, messageSeq: seq, content: event.content }); break;
          case "end": dispatch({ type: "THINKING_END", contentIndex: event.content_index, messageSeq: seq }); break;
        }
        break;
      case "text":
        switch (event.phase) {
          case "start": dispatch({ type: "TEXT_START", contentIndex: event.content_index, messageSeq: seq }); break;
          case "delta": dispatch({ type: "TEXT_DELTA", contentIndex: event.content_index, messageSeq: seq, content: event.content }); break;
          case "end": dispatch({ type: "TEXT_END", contentIndex: event.content_index, messageSeq: seq }); break;
        }
        break;
    }
  }, []);

  const reset = useCallback(() => {
    dispatch({ type: "RESET" });
  }, []);

  const startConnecting = useCallback((clientTurnId: string, userMessage: AgentConversationMessage) => {
    dispatch({ type: "CONNECTING", clientTurnId, userMessage });
  }, []);

  const toolStarted = useCallback((tool_name: string, tool_call_id?: string, label?: string) => {
    dispatch({ type: "TOOL_STARTED", tool_name, tool_call_id, label: label ?? "执行项目操作" });
  }, []);

  const toolCompleted = useCallback((tool_name: string, tool_call_id?: string) => {
    dispatch({ type: "TOOL_COMPLETED", tool_name, tool_call_id });
  }, []);

  const toolFailed = useCallback((tool_name: string, tool_call_id?: string) => {
    dispatch({ type: "TOOL_FAILED", tool_name, tool_call_id });
  }, []);

  const toolBlocked = useCallback((tool_name: string, tool_call_id?: string, label?: string) => {
    dispatch({ type: "TOOL_BLOCKED", tool_name, tool_call_id, label });
  }, []);

  const done = useCallback((finalContent: string, thinkingContent: string, executionSteps: ExecutionStep[]) => {
    dispatch({ type: "DONE", finalContent, thinkingContent, executionSteps });
  }, []);

  const error = useCallback((message: string) => {
    dispatch({ type: "ERROR", message });
  }, []);

  const cancel = useCallback(() => {
    dispatch({ type: "CANCEL" });
  }, []);

  const disconnect = useCallback(() => {
    dispatch({ type: "DISCONNECT" });
  }, []);

  const toggleThinking = useCallback(() => {
    dispatch({ type: "TOGGLE_THINKING" });
  }, []);

  // Derived: is the turn actively streaming?
  const isStreaming = turn.status !== "idle" && turn.status !== "completed" && turn.status !== "failed" && turn.status !== "cancelled" && turn.status !== "disconnected";

  // Derived: aggregated thinking content from all thinking blocks
  const thinkingContent = Object.values(turn.blocks)
    .filter((b) => b.kind === "thinking")
    .sort((a, b) => a.order - b.order)
    .map((b) => b.content)
    .join("");

  // Derived: aggregated answer content from all text blocks
  const answerContent = Object.values(turn.blocks)
    .filter((b) => b.kind === "text")
    .sort((a, b) => a.order - b.order)
    .map((b) => b.content)
    .join("");

  // Derived: has any thinking content?
  const hasThinking = Object.values(turn.blocks).some((b) => b.kind === "thinking" && b.content.length > 0);

  return {
    turn,
    dispatch,
    dispatchContentEvent,
    reset,
    startConnecting,
    toolStarted,
    toolCompleted,
    toolFailed,
    toolBlocked,
    done,
    error,
    cancel,
    disconnect,
    toggleThinking,
    isStreaming,
    thinkingContent,
    answerContent,
    hasThinking,
  };
}

// Export action type for testing
export type { StreamTurnAction };
