"use client";

import React from "react";
import { MarkdownContent } from "./MarkdownContent";
import type { StableBlock } from "./useIncrementalMarkdown";

/**
 * Incremental markdown renderer for streaming text.
 *
 * Each stable block is individually memoized by its content string — adding
 * new blocks or appending to the active tail never re-renders existing blocks.
 *
 * The active tail is rendered as lightweight safe plain text (no ReactMarkdown),
 * so incomplete markdown syntax never reaches the parser.
 *
 * When `isFinalized` is true, a single MarkdownContent renders the full text
 * for correct final semantics (lists, tables, etc.).
 */
interface IncrementalMarkdownProps {
  /** Stable (completed) blocks — each individually memoized. */
  stableBlocks: StableBlock[];
  /** Active tail being typed — already stripped of incomplete markdown. */
  activeTail: string;
  /** Whether the content is finalized (streaming ended). */
  isFinalized: boolean;
  /** Full merged text — only used when finalized. */
  finalizedContent: string;
  className?: string;
}

export const IncrementalMarkdown = React.memo(function IncrementalMarkdown({
  stableBlocks,
  activeTail,
  isFinalized,
  finalizedContent,
  className,
}: IncrementalMarkdownProps) {
  if (isFinalized) {
    // Finalized: render full content as complete markdown
    if (!finalizedContent) return null;
    return <MarkdownContent content={finalizedContent} className={className} />;
  }

  // No content at all
  if (stableBlocks.length === 0 && !activeTail) {
    return null;
  }

  // Only active tail (no stable blocks yet) — render as safe plain text
  if (stableBlocks.length === 0) {
    return (
      <div className={className}>
        <span className="whitespace-pre-wrap">{activeTail}</span>
      </div>
    );
  }

  return (
    <div className={className}>
      {/* Stable blocks — each individually memoized by content, never re-parsed */}
      {stableBlocks.map((block) => (
        <MemoizedStableBlock key={block.id} content={block.content} />
      ))}
      {/* Active tail — safe inline text, no raw markdown noise */}
      {activeTail && (
        <span className="whitespace-pre-wrap">{activeTail}</span>
      )}
    </div>
  );
});

/**
 * Memoized stable block wrapper — ensures MarkdownContent only re-renders
 * when its specific content string changes. Each block gets its own instance,
 * so adding a new block never re-renders previous ones.
 */
const MemoizedStableBlock = React.memo(function MemoizedStableBlock({
  content,
}: {
  content: string;
}) {
  return <MarkdownContent content={content} />;
});
