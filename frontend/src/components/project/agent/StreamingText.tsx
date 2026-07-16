"use client";

import React from "react";
import { MarkdownContent } from "./MarkdownContent";
import { useStableTextReveal } from "./useStableTextReveal";

interface StreamingTextProps {
  buffer: string;
  className?: string;
  isStreaming?: boolean;
  /**
   * Called (throttled) when the visible text length grows during reveal.
   * Parents use this to auto-scroll.
   */
  onRevealProgress?: () => void;
}

export const StreamingText = React.memo(function StreamingText({
  buffer,
  className,
  isStreaming = true,
  onRevealProgress,
}: StreamingTextProps) {
  const displayLength = useStableTextReveal({
    buffer,
    isStreaming,
    onRevealProgress,
  });

  const showCursor = isStreaming || displayLength < buffer.length;
  const displayText = buffer.slice(0, displayLength);

  if (!displayText && !isStreaming) return null;

  return (
    <div className={className}>
      <MarkdownContent content={displayText || " "} />
      {showCursor && (
        <span
          className="ml-0.5 inline-block h-3.5 w-px bg-moss animate-pulse"
          aria-hidden="true"
        />
      )}
    </div>
  );
});
