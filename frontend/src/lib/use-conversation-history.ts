"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentConversation,
  AgentConversationSummary,
  MessagePage,
} from "./types";
import {
  listConversations,
  getConversationDetail,
  getConversationMessages,
} from "./api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConversationHistoryState = {
  /** All conversation summaries for the current project, recent-first. */
  summaries: AgentConversationSummary[];
  /** Currently active conversation (full detail with latest messages). */
  activeConversation: AgentConversation | null;
  /** Whether we have older messages that can be loaded. */
  hasOlderMessages: boolean;
  /** Cursor for loading older messages. */
  olderCursor: { created_at: string; id: string } | null;
  /** Loading state for the history list. */
  isLoadingHistory: boolean;
  /** Loading state for conversation detail switch. */
  isLoadingDetail: boolean;
  /** Loading state for older messages pagination. */
  isLoadingOlder: boolean;
  /** Error message for history load failure (transient, preserves current conversation). */
  historyError: string | null;
  /** Error message for detail load failure. */
  detailError: string | null;
  /** Whether the active conversation is a local draft (not yet persisted). */
  isDraft: boolean;
  /** Whether a streamed response is currently active (locks conversation switching). */
  isStreaming: boolean;
};

export type ConversationHistoryActions = {
  /** Load conversation list for a project. */
  loadHistory: (projectId: string, viewerUserId: string) => Promise<AgentConversationSummary[] | null>;
  /** Switch to a specific conversation by ID. */
  switchToConversation: (
    conversationId: string,
    projectId: string,
    viewerUserId: string,
  ) => Promise<"loaded" | "not_found" | "error">;
  /** Enter a local blank draft (no DB row created). */
  startNewDraft: () => void;
  /** Load older messages for the active conversation. */
  loadOlderMessages: (viewerUserId: string) => Promise<void>;
  /** After first message is sent and conversation is created, update state with the returned conversation. */
  onConversationCreated: (conversation: AgentConversation) => void;
  /** After a persisted turn, merge new messages into the active conversation. */
  onPersistedTurn: (conversation: AgentConversation) => void;
  /** Set streaming lock. */
  setStreaming: (streaming: boolean) => void;
  /** Clear conversation state (e.g. on project switch). */
  reset: () => void;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useConversationHistory(): ConversationHistoryState & ConversationHistoryActions {
  const [summaries, setSummaries] = useState<AgentConversationSummary[]>([]);
  const [activeConversation, setActiveConversation] = useState<AgentConversation | null>(null);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [olderCursor, setOlderCursor] = useState<{ created_at: string; id: string } | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [isDraft, setIsDraft] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  /** Track the latest loadHistory call to discard stale responses. */
  const historyGenerationRef = useRef(0);
  const detailGenerationRef = useRef(0);
  const activeConversationRef = useRef<AgentConversation | null>(null);
  const isDraftRef = useRef(false);
  const isStreamingRef = useRef(false);

  useEffect(() => {
    activeConversationRef.current = activeConversation;
  }, [activeConversation]);

  useEffect(() => {
    isDraftRef.current = isDraft;
  }, [isDraft]);

  const loadHistory = useCallback(async (projectId: string, viewerUserId: string) => {
    const gen = ++historyGenerationRef.current;
    setIsLoadingHistory(true);
    setHistoryError(null);
    try {
      const result = await listConversations(projectId, viewerUserId);
      if (historyGenerationRef.current !== gen) return null;
      setSummaries(result);
      return result;
    } catch {
      if (historyGenerationRef.current !== gen) return null;
      setHistoryError("加载会话列表失败，请重试");
      // Preserve existing summaries on transient failure
      return null;
    } finally {
      if (historyGenerationRef.current === gen) {
        setIsLoadingHistory(false);
      }
    }
  }, []);

  const switchToConversation = useCallback(async (conversationId: string, projectId: string, viewerUserId: string) => {
    // Don't switch if already active
    if (activeConversationRef.current?.id === conversationId && !isDraftRef.current) return "loaded";

    const gen = ++detailGenerationRef.current;
    setIsLoadingDetail(true);
    setDetailError(null);
    try {
      const [detail, page] = await Promise.all([
        getConversationDetail(conversationId, viewerUserId),
        getConversationMessages(conversationId, viewerUserId),
      ]);
      if (detailGenerationRef.current !== gen) return "error";
      if (detail.project_id !== projectId) {
        setDetailError("对话不属于当前项目");
        return "not_found";
      }

      // Convert AgentConversationRead to AgentConversation for compatibility
      const conversation: AgentConversation = {
        id: detail.id,
        workspace_id: detail.workspace_id,
        project_id: detail.project_id,
        status: detail.status,
        summary: detail.summary,
        current_focus: detail.current_focus,
        messages: page.messages,
        created_at: detail.created_at,
        updated_at: detail.updated_at,
        visibility: detail.visibility,
        creator_user_id: detail.creator_user_id,
        title: detail.title,
      };
      setActiveConversation(conversation);
      activeConversationRef.current = conversation;
      setIsDraft(false);
      isDraftRef.current = false;
      setHasOlderMessages(page.has_older);
      setOlderCursor(page.older_cursor);
      return "loaded";
    } catch (error) {
      if (detailGenerationRef.current !== gen) return "error";
      const notFound = error instanceof Error && /请求失败：404\b/.test(error.message);
      setDetailError(notFound ? "对话不存在或无权访问" : "加载对话失败，请重试");
      // Preserve current conversation on failure
      return notFound ? "not_found" : "error";
    } finally {
      if (detailGenerationRef.current === gen) {
        setIsLoadingDetail(false);
      }
    }
  }, []);

  const startNewDraft = useCallback(() => {
    if (isStreamingRef.current) return;
    setActiveConversation(null);
    activeConversationRef.current = null;
    setIsDraft(true);
    isDraftRef.current = true;
    setHasOlderMessages(false);
    setOlderCursor(null);
    setDetailError(null);
  }, []);

  const loadOlderMessages = useCallback(async (viewerUserId: string) => {
    if (!activeConversation || !olderCursor || isLoadingOlder) return;

    setIsLoadingOlder(true);
    try {
      const page: MessagePage = await getConversationMessages(
        activeConversation.id,
        viewerUserId,
        olderCursor.created_at,
        olderCursor.id,
      );

      // Merge chronologically without duplicates
      const existingIds = new Set(activeConversation.messages.map((m) => m.id));
      const newMessages = page.messages.filter((m) => !existingIds.has(m.id));

      if (newMessages.length > 0) {
        setActiveConversation((prev) => {
          if (!prev || prev.id !== activeConversation.id) return prev;
          const merged = { ...prev, messages: [...newMessages, ...prev.messages] };
          activeConversationRef.current = merged;
          return merged;
        });
      }

      setHasOlderMessages(page.has_older);
      setOlderCursor(page.older_cursor);
    } catch {
      // Non-fatal: user can retry
      setDetailError("加载更早消息失败，请重试");
    } finally {
      setIsLoadingOlder(false);
    }
  }, [activeConversation, olderCursor, isLoadingOlder]);

  const onConversationCreated = useCallback((conversation: AgentConversation) => {
    setActiveConversation(conversation);
    activeConversationRef.current = conversation;
    setIsDraft(false);
    isDraftRef.current = false;
    setHasOlderMessages(false);
    setOlderCursor(null);
    // Refresh history list to include the new conversation
    // The caller should trigger loadHistory after this
  }, []);

  const onPersistedTurn = useCallback((conversation: AgentConversation) => {
    setActiveConversation((prev) => {
      if (!prev) {
        activeConversationRef.current = conversation;
        return conversation;
      }
      if (prev.id !== conversation.id) return prev;
      // Merge new messages, deduplicate by id
      const existingIds = new Set(prev.messages.map((m) => m.id));
      const newMessages = conversation.messages.filter((m) => !existingIds.has(m.id));
      const merged = { ...conversation, messages: [...prev.messages, ...newMessages] };
      activeConversationRef.current = merged;
      return merged;
    });
  }, []);

  const setStreaming = useCallback((streaming: boolean) => {
    isStreamingRef.current = streaming;
    setIsStreaming(streaming);
  }, []);

  const reset = useCallback(() => {
    historyGenerationRef.current += 1;
    detailGenerationRef.current += 1;
    setSummaries([]);
    setActiveConversation(null);
    activeConversationRef.current = null;
    setHasOlderMessages(false);
    setOlderCursor(null);
    setIsLoadingHistory(false);
    setIsLoadingDetail(false);
    setIsLoadingOlder(false);
    setHistoryError(null);
    setDetailError(null);
    setIsDraft(false);
    isDraftRef.current = false;
    setIsStreaming(false);
    isStreamingRef.current = false;
  }, []);

  return {
    // State
    summaries,
    activeConversation,
    hasOlderMessages,
    olderCursor,
    isLoadingHistory,
    isLoadingDetail,
    isLoadingOlder,
    historyError,
    detailError,
    isDraft,
    isStreaming,
    // Actions
    loadHistory,
    switchToConversation,
    startNewDraft,
    loadOlderMessages,
    onConversationCreated,
    onPersistedTurn,
    setStreaming,
    reset,
  };
}
