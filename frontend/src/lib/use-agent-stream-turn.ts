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
  RunActivityItem,
  RunSummary,
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
  | { type: "DONE"; finalContent: string; thinkingContent: string; executionSteps: ExecutionStep[]; activities?: RunActivityItem[]; runSummary?: RunSummary | null }
  | { type: "ERROR"; message: string }
  | { type: "CANCEL" }
  | { type: "DISCONNECT" }
  | { type: "TOGGLE_THINKING" }
  | { type: "PROCESS_STARTED"; startedAt: string; streamSequence: number }
  | { type: "PROCESS_DELTA"; activityId: string; content: string; streamSequence: number }
  | { type: "ACTIVITY"; data: RunActivityItem; streamSequence: number }
  | { type: "PROCESS_COMPLETED"; completedAt: string; processingDurationMs: number; streamSequence: number }
  | { type: "ANSWER_STARTED"; startedAt: string; streamSequence: number }
  | { type: "ANSWER_DELTA"; content: string; streamSequence: number };

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
    activities: [],
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
      // Text blocks during process phase are commentary (sidecar routes pre-tool text
      // as progress). Only ANSWER_STARTED/ANSWER_DELTA transition to answering.
      // First text start → auto-fold thinking (one-time, ALWAYS folds even if manually toggled)
      const isFirstText = !Object.values(state.blocks).some((b) => b.kind === "text");
      return {
        ...state,
        blocks: { ...state.blocks, [key]: block },
        blockOrder: order + 1,
        // One-time auto-fold on first text — overrides manual toggle
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
        activities: action.activities && action.activities.length > 0 ? action.activities : state.activities,
        runSummary: action.runSummary ?? state.runSummary,
        thinkingOpen: false, // Fold on completion
        error: null,
      };
    }

    case "PROCESS_STARTED":
      return {
        ...state,
        status: "thinking",
        processStartedAt: action.startedAt,
        thinkingOpen: true,
        streamSequence: action.streamSequence,
      };

    case "PROCESS_DELTA": {
      const existingIdx = state.activities.findIndex(
        (act) => act.id === action.activityId && act.kind === "progress",
      );
      let updatedActivities: RunActivityItem[];
      if (existingIdx >= 0) {
        // Append to existing progress activity
        updatedActivities = state.activities.map((act, i) =>
          i === existingIdx && act.kind === "progress"
            ? { ...act, content: act.content + action.content }
            : act,
        );
      } else {
        // Create new progress activity
        const newActivity: RunActivityItem = {
          id: action.activityId,
          sequence: state.activities.length + 1,
          created_at: new Date().toISOString(),
          kind: "progress",
          content: action.content,
        };
        updatedActivities = [...state.activities, newActivity];
      }
      return {
        ...state,
        activities: updatedActivities,
        streamSequence: action.streamSequence,
      };
    }

    case "ACTIVITY": {
      const existingIdx = state.activities.findIndex((act) => act.id === action.data.id);
      // Insert in sequence order — activities arrive in order from sidecar,
      // so appending is correct. Only re-sort if updating an existing item.
      const updatedActivities = existingIdx >= 0
        ? state.activities.map((act, i) => (i === existingIdx ? action.data : act))
        : [...state.activities, action.data];

      let updatedSteps = state.executionSteps;
      if (action.data.kind === "tool") {
        const toolAct = action.data;
        if (toolAct.status === "running") {
          const stepExists = state.executionSteps.some((s) => s.tool_call_id === toolAct.tool_call_id);
          if (!stepExists) {
            updatedSteps = [...state.executionSteps, {
              tool_name: toolAct.tool_name,
              tool_call_id: toolAct.tool_call_id,
              status: "started",
              label: toolAct.label.replace(/^正在/, ""),
            }];
          }
        } else if (toolAct.status === "completed" || toolAct.status === "failed" || toolAct.status === "blocked") {
          updatedSteps = updateStep(state.executionSteps, toolAct.tool_call_id, toolAct.tool_name, toolAct.status);
        }
      }

      return {
        ...state,
        activities: updatedActivities,
        executionSteps: updatedSteps,
        streamSequence: action.streamSequence,
      };
    }

    case "PROCESS_COMPLETED": {
      // Idempotent: already collapsed, only update timestamps
      if (state.processAutoCollapsed) {
        return {
          ...state,
          processCompletedAt: action.completedAt,
          processDurationMs: action.processingDurationMs,
          streamSequence: action.streamSequence,
        };
      }
      // First time: unconditionally collapse process, regardless of manual toggle.
      // User can reopen via TOGGLE_THINKING after this point.
      return {
        ...state,
        processCompletedAt: action.completedAt,
        processDurationMs: action.processingDurationMs,
        thinkingOpen: false,
        thinkingWasAutoFolded: true,
        processAutoCollapsed: true,
        processExpanded: false,
        streamSequence: action.streamSequence,
      };
    }

    case "ANSWER_STARTED":
      return {
        ...state,
        status: "answering",
        streamSequence: action.streamSequence,
      };

    case "ANSWER_DELTA":
      return {
        ...state,
        status: "answering",
        answerBuffer: state.answerBuffer + action.content,
        streamSequence: action.streamSequence,
      };

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
        processExpanded: !state.processExpanded,
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

  const done = useCallback((finalContent: string, thinkingContent: string, executionSteps: ExecutionStep[], activities?: RunActivityItem[], runSummary?: RunSummary | null) => {
    dispatch({ type: "DONE", finalContent, thinkingContent, executionSteps, activities, runSummary });
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

  const processStarted = useCallback((startedAt: string, streamSequence: number) => {
    dispatch({ type: "PROCESS_STARTED", startedAt, streamSequence });
  }, []);

  const processDelta = useCallback((activityId: string, content: string, streamSequence: number) => {
    dispatch({ type: "PROCESS_DELTA", activityId, content, streamSequence });
  }, []);

  const activity = useCallback((data: RunActivityItem, streamSequence: number) => {
    dispatch({ type: "ACTIVITY", data, streamSequence });
  }, []);

  const processCompleted = useCallback((completedAt: string, processingDurationMs: number, streamSequence: number) => {
    dispatch({ type: "PROCESS_COMPLETED", completedAt, processingDurationMs, streamSequence });
  }, []);

  const answerStarted = useCallback((startedAt: string, streamSequence: number) => {
    dispatch({ type: "ANSWER_STARTED", startedAt, streamSequence });
  }, []);

  const answerDelta = useCallback((content: string, streamSequence: number) => {
    dispatch({ type: "ANSWER_DELTA", content, streamSequence });
  }, []);

  // Derived: is the turn actively streaming?
  const isStreaming = turn.status !== "idle" && turn.status !== "completed" && turn.status !== "failed" && turn.status !== "cancelled" && turn.status !== "disconnected";

  // Derived: aggregated thinking content from all thinking blocks
  const thinkingContent = Object.values(turn.blocks)
    .filter((b) => b.kind === "thinking")
    .sort((a, b) => a.order - b.order)
    .map((b) => b.content)
    .join("");

  // Derived: answer content — prefer answerBuffer (from answer_delta events)
  // over text blocks (from legacy content events) for accurate phase separation.
  const answerContent = turn.answerBuffer || Object.values(turn.blocks)
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
    processStarted,
    processDelta,
    activity,
    processCompleted,
    answerStarted,
    answerDelta,
    isStreaming,
    thinkingContent,
    answerContent,
    hasThinking,
  };
}

// Export action type for testing
export type { StreamTurnAction };
