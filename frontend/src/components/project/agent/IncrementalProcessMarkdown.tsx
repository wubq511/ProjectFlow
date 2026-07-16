"use client";

import React from "react";
import { ProcessMarkdown } from "./ProcessMarkdown";
import type { StableBlock } from "./useIncrementalMarkdown";

/**
 * Incremental markdown renderer for the process/activity area.
 *
 * Each stable block is individually memoized — adding new blocks never
 * re-renders previous ones. Active tail is safe plain text.
 */
interface IncrementalProcessMarkdownProps {
  stableBlocks: StableBlock[];
  activeTail: string;
  isFinalized: boolean;
  finalizedContent: string;
  className?: string;
}

export const IncrementalProcessMarkdown = React.memo(function IncrementalProcessMarkdown({
  stableBlocks,
  activeTail,
  isFinalized,
  finalizedContent,
  className,
}: IncrementalProcessMarkdownProps) {
  if (isFinalized) {
    if (!finalizedContent) return null;
    return <ProcessMarkdown content={finalizedContent} className={className} />;
  }

  if (stableBlocks.length === 0 && !activeTail) {
    return null;
  }

  // Only active tail — render as safe plain text
  if (stableBlocks.length === 0) {
    return (
      <div className={className}>
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-neutral-600 dark:text-neutral-400">
          {activeTail}
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      {stableBlocks.map((block) => (
        <MemoizedStableBlock key={block.id} content={block.content} />
      ))}
      {activeTail && (
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-neutral-600 dark:text-neutral-400">
          {activeTail}
        </p>
      )}
    </div>
  );
});

const MemoizedStableBlock = React.memo(function MemoizedStableBlock({
  content,
}: {
  content: string;
}) {
  return <ProcessMarkdown content={content} />;
});
