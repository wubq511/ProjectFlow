"use client";

import React from "react";
import { useStableTextReveal } from "./useStableTextReveal";
import { useIncrementalMarkdown } from "./useIncrementalMarkdown";
import { IncrementalMarkdown } from "./IncrementalMarkdown";

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

  // Stay in "presentation streaming" mode until the visual display has caught
  // up with the full buffer. This prevents useIncrementalMarkdown from
  // finalizing (and forcing a full ReactMarkdown re-parse every rAF frame)
  // while the reveal scheduler is still catching up after the network ended.
  const presentationStreaming = isStreaming || displayLength < buffer.length;
  const showCursor = presentationStreaming;

  const { stableBlocks, activeTail, isFinalized, finalizedContent } =
    useIncrementalMarkdown(buffer, presentationStreaming, displayLength);

  if (displayLength === 0 && !isStreaming) return null;

  return (
    <div className={className}>
      <IncrementalMarkdown
        stableBlocks={stableBlocks}
        activeTail={activeTail}
        isFinalized={isFinalized}
        finalizedContent={finalizedContent}
      />
      {showCursor && (
        <span
          className="ml-0.5 inline-block h-3.5 w-px bg-moss animate-pulse"
          aria-hidden="true"
        />
      )}
    </div>
  );
});
