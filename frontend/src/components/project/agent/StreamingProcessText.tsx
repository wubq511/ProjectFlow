"use client";

import React from "react";
import { ProcessMarkdown } from "./ProcessMarkdown";
import { useStableTextReveal } from "./useStableTextReveal";

interface StreamingProcessTextProps {
  /** The full text content to display. */
  content: string;
  /** Whether the text is still streaming in. When false, renders full content immediately. */
  isStreaming?: boolean;
  className?: string;
  /**
   * Called (throttled) when the visible text length grows during reveal.
   * Parents use this to auto-scroll.
   */
  onRevealProgress?: () => void;
}

/**
 * Streaming-aware process text renderer.
 *
 * Uses useStableTextReveal for progressive character display when streaming.
 * When not streaming (completed/historical), renders full content immediately
 * via ProcessMarkdown without any reveal animation.
 */
export const StreamingProcessText = React.memo(function StreamingProcessText({
  content,
  isStreaming = false,
  className,
  onRevealProgress,
}: StreamingProcessTextProps) {
  const displayLength = useStableTextReveal({
    buffer: content,
    isStreaming,
    onRevealProgress,
  });

  // Non-streaming: render full content immediately (historical/completed messages)
  if (!isStreaming) {
    return <ProcessMarkdown content={content} className={className} />;
  }

  // Streaming: progressive reveal via hook
  const displayText = content.slice(0, displayLength);
  return <ProcessMarkdown content={displayText || " "} className={className} />;
});
