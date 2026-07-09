"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentConversationTurn, AgentStreamPhase } from "@/lib/types";
import { sendAgentConversationMessageStream } from "@/lib/api";

export type AgentStreamStatus = {
  phase: AgentStreamPhase;
  module?: string;
  message: string;
};

type UseAgentStreamOptions = {
  onDone: (turn: AgentConversationTurn) => void;
  onError: (error: string) => void;
};

export function useAgentStream({ onDone, onError }: UseAgentStreamOptions) {
  const [streamingBuffer, setStreamingBuffer] = useState("");
  const [streamStatus, setStreamStatus] = useState<AgentStreamStatus | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const onDoneRef = useRef(onDone);
  const onErrorRef = useRef(onError);
  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  const sendMessage = useCallback(
    async (conversationId: string, content: string, viewerUserId: string) => {
      abortRef.current = new AbortController();
      setIsStreaming(true);
      setStreamingBuffer("");
      setStreamStatus({ phase: "planning", message: "正在理解你的需求..." });

      try {
        await sendAgentConversationMessageStream(
          conversationId,
          content,
          viewerUserId,
          {
            onStatus: (status) =>
              setStreamStatus(status as AgentStreamStatus),
            onToken: (token) => setStreamingBuffer((prev) => prev + token),
            onDone: (turn) => {
              setStreamingBuffer("");
              setStreamStatus(null);
              onDoneRef.current(turn);
            },
            onError: (msg) => {
              setStreamingBuffer("");
              setStreamStatus(null);
              onErrorRef.current(msg);
            },
          },
          abortRef.current.signal,
        );
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // User stopped — keep partial buffer as-is
          setStreamStatus(null);
        } else {
          setStreamingBuffer("");
          setStreamStatus(null);
          onErrorRef.current(err instanceof Error ? err.message : "连接中断");
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { sendMessage, stop, streamingBuffer, streamStatus, isStreaming };
}
