"use client";

import React from "react";
import { useStableTextReveal } from "./useStableTextReveal";
import { useIncrementalMarkdown } from "./useIncrementalMarkdown";
import { IncrementalProcessMarkdown } from "./IncrementalProcessMarkdown";

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
 * Uses the same incremental markdown logic as StreamingText:
 * - Stable blocks (paragraphs separated by double newlines outside code fences)
 *   are individually memoized via ProcessMarkdown.
 * - Active tail is rendered as safe plain text (no ReactMarkdown on incomplete content).
 * - Uses useStableTextReveal for progressive character display when streaming.
 * - Non-streaming (historical/completed): renders full content immediately via ProcessMarkdown.
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

  // Always call useIncrementalMarkdown (Rules of Hooks).
  // When not streaming, this returns finalized state immediately.
  const displayText = content.slice(0, displayLength);
  const { stableBlocks, activeTail, isFinalized, finalizedContent } =
    useIncrementalMarkdown(displayText, isStreaming);

  // Non-streaming: short-circuit render with finalized content.
  // The hook returns isFinalized=true when !isStreaming, but we also
  // explicitly pass finalizedContent=content for the fast path.
  if (!isStreaming) {
    return (
      <IncrementalProcessMarkdown
        stableBlocks={[]}
        activeTail=""
        isFinalized={true}
        finalizedContent={content}
        className={className}
      />
    );
  }

  return (
    <IncrementalProcessMarkdown
      stableBlocks={stableBlocks}
      activeTail={activeTail}
      isFinalized={isFinalized}
      finalizedContent={finalizedContent}
      className={className}
    />
  );
});
