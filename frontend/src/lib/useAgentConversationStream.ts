"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentConversationMessage, AgentConversationTurn, AgentStreamPhase, ArchivedAgentStreamTurn, ExecutionStep, StreamToolEvent } from "./types";
import { sendAgentConversationMessageStream } from "./api";
import { useAgentStreamTurn } from "./use-agent-stream-turn";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { AgentStreamPhase };

export type ConversationStreamStatus = {
  phase: AgentStreamPhase;
  module?: string;
  message: string;
  runId?: string;
  requestMode?: "answer" | "action";
  selectedSkills?: string[];
};

export type UseAgentConversationStreamOptions = {
  /** Called when the backend persists the turn (conversation/suggestions/artifacts update). */
  onPersistedTurn: (turn: AgentConversationTurn) => void;
  /** Called on model/policy/timeout errors (distinct from disconnect). */
  onError: (message: string) => void;
  /** Called on network-level disconnection (stream ended without terminal event, ReadError, etc.). */
  onDisconnect?: (reason?: string) => void;
};

/** Use the URL/project identity as the single boundary for clearing stream state. */
export function useAgentStreamNavigationReset(
  navigationIdentity: string,
  resetStream: () => void,
) {
  const navigationIdentityRef = useRef(navigationIdentity);
  const resetForNavigation = useCallback((nextIdentity: string) => {
    if (navigationIdentityRef.current === nextIdentity) return;
    navigationIdentityRef.current = nextIdentity;
    resetStream();
  }, [resetStream]);

  useEffect(() => {
    resetForNavigation(navigationIdentity);
  }, [navigationIdentity, resetForNavigation]);

  return resetForNavigation;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Classify an error as network-level (connection refused, DNS failure, etc.)
 * vs application-level (model failure, policy violation, etc.).
 */
function isNetworkError(err: Error): boolean {
  const msg = err.message || "";
  // TypeError from fetch (network failure in browser)
  if (err instanceof TypeError) return true;
  // Common network error patterns
  if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("net::")) return true;
  if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND") || msg.includes("ECONNRESET")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAgentConversationStream(options: UseAgentConversationStreamOptions) {
  const {
    turn: streamTurn,
    dispatchContentEvent,
    reset: resetStreamTurn,
    startConnecting,
    toolStarted,
    toolCompleted,
    toolFailed,
    toolBlocked,
    done: streamDone,
    error: streamError,
    cancel: streamCancel,
    disconnect: streamDisconnect,
    toggleThinking,
    isStreaming: isStreamActive,
    thinkingContent: streamThinkingContent,
    answerContent: streamAnswerContent,
    hasThinking: streamHasThinking,
  } = useAgentStreamTurn();

  const abortRef = useRef<AbortController | null>(null);
  /** Request generation counter — only the current generation may update state. */
  const generationRef = useRef(0);
  const turnCounterRef = useRef(0);
  const [streamStatus, setStreamStatus] = useState<ConversationStreamStatus | null>(null);
  /** Explicit completion announcement token — set once per turn, cleared on reset. */
  const [completedAnnouncement, setCompletedAnnouncement] = useState<string | null>(null);
  const [archivedStreamTurns, setArchivedStreamTurns] = useState<ArchivedAgentStreamTurn[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const onPersistedTurnRef = useRef(options.onPersistedTurn);
  const onErrorRef = useRef(options.onError);
  const onDisconnectRef = useRef(options.onDisconnect);
  useEffect(() => { onPersistedTurnRef.current = options.onPersistedTurn; });
  useEffect(() => { onErrorRef.current = options.onError; });
  useEffect(() => { onDisconnectRef.current = options.onDisconnect; });

  const send = useCallback(
    async (conversationId: string, content: string, viewerUserId: string, options?: { model?: string; thinkingLevel?: string }) => {
      // Abort any previous in-flight request and invalidate its callbacks
      abortRef.current?.abort();
      const gen = ++generationRef.current;

      if (streamTurn.status !== "idle" && streamTurn.status !== "completed" && streamTurn.userMessage) {
        const archivedTurn = isStreamActive
          ? { ...streamTurn, status: "cancelled" as const, error: "已停止生成" }
          : streamTurn;
        setArchivedStreamTurns((previous) => (
          previous.some((entry) => entry.turn.clientTurnId === archivedTurn.clientTurnId)
            ? previous
            : [...previous, { turn: archivedTurn }]
        ));
      }

      // Clear status/announcement from any previous request
      setStreamStatus(null);
      setCompletedAnnouncement(null);

      // Create optimistic user message and enter connecting state
      const turnSeq = ++turnCounterRef.current;
      const clientTurnId = `turn-${turnSeq}`;
      const optimisticUserMessage: AgentConversationMessage = {
        id: clientTurnId,
        conversation_id: conversationId,
        role: "user",
        content,
        structured_payload: {},
        created_at: new Date().toISOString(),
      };
      startConnecting(clientTurnId, optimisticUserMessage);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await sendAgentConversationMessageStream(
          conversationId,
          content,
          viewerUserId,
          {
            onStatus: (status) => {
              if (generationRef.current !== gen) return;
              if (status.run_id) setActiveRunId(status.run_id);
              setStreamStatus((previous) => ({
                phase: status.phase as AgentStreamPhase,
                module: status.module,
                message: status.message,
                runId: status.run_id ?? previous?.runId,
                requestMode: status.request_mode ?? previous?.requestMode,
                selectedSkills: status.selected_skills ?? previous?.selectedSkills,
              }));
            },
            onContent: (event) => {
              if (generationRef.current !== gen) return;
              dispatchContentEvent(event);
            },
            onToolEvent: (event: StreamToolEvent) => {
              if (generationRef.current !== gen) return;
              switch (event.phase) {
                case "started":
                  toolStarted(event.tool_name, event.tool_call_id, event.label);
                  break;
                case "completed":
                  toolCompleted(event.tool_name, event.tool_call_id);
                  break;
                case "failed":
                  toolFailed(event.tool_name, event.tool_call_id);
                  break;
                case "blocked":
                  toolBlocked(event.tool_name ?? "工具", event.tool_call_id, event.label);
                  break;
              }
            },
            onDone: (turn) => {
              if (generationRef.current !== gen) return;
              setStreamStatus(null);
              // Mark turn as completed with final content
              const assistantMsg = turn.assistant_message;
              const finalContent = assistantMsg?.content ?? "";
              const thinkingContent = typeof assistantMsg?.structured_payload?.thinking_content === "string"
                ? assistantMsg.structured_payload.thinking_content : "";
              const rawSteps = assistantMsg?.structured_payload?.execution_steps;
              const executionSteps: ExecutionStep[] = Array.isArray(rawSteps)
                ? rawSteps.filter(
                    (s): s is ExecutionStep =>
                      s != null && typeof s === "object" && typeof s.tool_name === "string" && typeof s.status === "string" && typeof s.label === "string",
                  )
                : [];
              streamDone(finalContent, thinkingContent, executionSteps);
              // Set explicit completion announcement token
              setCompletedAnnouncement(turn.assistant_message?.id ?? clientTurnId);
              setActiveRunId(null);
              // Notify parent of persisted turn
              onPersistedTurnRef.current(turn);
            },
            onError: (msg) => {
              if (generationRef.current !== gen) return;
              setStreamStatus(null);
              streamError(msg || "这次没有生成可用结果，我保留了你的请求。");
              onErrorRef.current(msg || "这次没有生成可用结果，我保留了你的请求。");
            },
            onDisconnect: (reason) => {
              if (generationRef.current !== gen) return;
              setStreamStatus(null);
              streamDisconnect();
              onDisconnectRef.current?.(reason);
            },
          },
          controller.signal,
          options,
        );
      } catch (err) {
        // Stale request — ignore entirely
        if (generationRef.current !== gen) return;

        if (controller.signal.aborted) {
          // User-initiated abort — already handled by streamCancel
        } else if (err instanceof TypeError || (err instanceof Error && isNetworkError(err))) {
          // Network-level failure (fetch failed, connection refused, etc.) → disconnect
          streamDisconnect();
          onDisconnectRef.current?.("网络连接中断，可重试");
        } else {
          // Application/model error
          const msg = err instanceof Error ? err.message : "这次没有生成可用结果，我保留了你的请求。你可以重新发送或换一种说法。";
          streamError(msg);
          onErrorRef.current(msg);
        }
        setStreamStatus(null);
      } finally {
        // Only clear abortRef if we're still the current generation
        if (generationRef.current === gen) {
          abortRef.current = null;
        }
      }
    },
    [
      dispatchContentEvent,
      startConnecting,
      toolStarted,
      toolCompleted,
      toolFailed,
      toolBlocked,
      streamDone,
      streamError,
      streamDisconnect,
      streamTurn,
      isStreamActive,
    ],
  );

  const stop = useCallback(() => {
    // Invalidate any in-flight callbacks before aborting
    generationRef.current++;
    abortRef.current?.abort();
    streamCancel();
    setStreamStatus(null);
  }, [streamCancel]);

  /** Full reset: abort stream, clear turn state, status, and announcement.
   *  Returns to idle. Use on project switch to prevent cross-project state pollution. */
  const reset = useCallback(() => {
    // Bump generation to invalidate any in-flight request
    generationRef.current++;
    abortRef.current?.abort();
    resetStreamTurn();
    setArchivedStreamTurns([]);
    setStreamStatus(null);
    setCompletedAnnouncement(null);
    setActiveRunId(null);
  }, [resetStreamTurn]);

  // Abort on unmount
  const cleanup = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    /** The current streaming turn state. */
    streamTurn,
    /** Current status indicator (phase/module/message). */
    streamStatus,
    /** Send a new user message and start streaming. */
    send,
    /** Stop the current stream (abort + cancel). Turn becomes cancelled (still visible). */
    stop,
    /** Full reset: abort + clear turn, status, announcement. Returns to idle. Use on project switch. */
    reset,
    /** Toggle thinking fold. */
    toggleThinking,
    /** Whether the stream is actively streaming. */
    isStreamActive,
    /** Aggregated thinking content. */
    streamThinkingContent,
    /** Aggregated answer content. */
    streamAnswerContent,
    /** Whether there's any thinking content. */
    streamHasThinking,
    /** Failed/cancelled/disconnected turns preserved when a new turn starts. */
    archivedStreamTurns,
    /** Explicit completion announcement token (turn ID), null until turn completes. */
    completedAnnouncement,
    activeRunId,
    /** Cleanup function for useEffect return (aborts on unmount). */
    cleanup,
  };
}
