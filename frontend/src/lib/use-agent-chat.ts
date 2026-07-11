"use client";

import { useState, useCallback, useRef } from "react";
import { getAgentConversation } from "./api";
import type { AgentConversation, AgentArtifact, AgentSuggestion, AgentStreamPhase } from "./types";

export function useAgentChat(projectId: string | null) {
  const [conversation, setConversation] = useState<AgentConversation | null>(null);
  const [suggestions, setSuggestions] = useState<AgentSuggestion[]>([]);
  const [artifacts, setArtifacts] = useState<AgentArtifact[]>([]);
  const [streamStatus, setStreamStatus] = useState<{
    phase: AgentStreamPhase;
    module?: string;
    message: string;
  } | null>(null);
  const [pendingInstruction, setPendingInstruction] = useState<string | null>(null);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadConversation = useCallback(async () => {
    if (!projectId) return;
    try {
      const conv = await getAgentConversation(projectId);
      setConversation(conv);
    } catch (err) {
      console.error("Failed to load conversation:", err);
    }
  }, [projectId]);

  const resetStream = useCallback(() => {
    setStreamStatus(null);
  }, []);

  const resetAll = useCallback(() => {
    setConversation(null);
    setSuggestions([]);
    setArtifacts([]);
    setStreamStatus(null);
    setPendingInstruction(null);
    setConversationError(null);
  }, []);

  return {
    conversation,
    setConversation,
    suggestions,
    setSuggestions,
    artifacts,
    setArtifacts,
    streamStatus,
    setStreamStatus,
    abortRef,
    pendingInstruction,
    setPendingInstruction,
    conversationError,
    setConversationError,
    loadConversation,
    resetStream,
    resetAll,
  };
}
