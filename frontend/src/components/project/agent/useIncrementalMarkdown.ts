"use client";

import { useMemo } from "react";

/**
 * Check whether every character from `start` to end-of-string is a table
 * separator character: `|`, `-`, `:`, or whitespace.
 */
function isTableSeparatorSuffix(s: string, start: number): boolean {
  if (start >= s.length) return true;
  for (let i = start; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    const c = s[i];
    if (c !== "|" && c !== "-" && c !== ":" && ch !== 0x20 && ch !== 0x09) {
      return false;
    }
  }
  return true;
}

/**
 * Strip incomplete markdown syntax from the active tail so raw tokens
 * (unclosed **, `, |, etc.) don't flash to the user.
 *
 * Strategy: remove known incomplete patterns at the end of the string.
 * This is intentionally conservative — we only strip things that would
 * render as visible syntax noise.
 */
export function stripIncompleteMarkdown(text: string): string {
  let result = text;

  // Remove trailing unclosed code fence (``` or ```lang)
  result = result.replace(/```[\w]*$/, "");

  // Remove trailing unclosed inline code (` at end, odd count)
  const backtickMatches = result.match(/`/g);
  if (backtickMatches && backtickMatches.length % 2 !== 0) {
    result = result.replace(/`([^`]*)$/, "$1");
  }

  // Remove trailing unclosed bold (** at end, odd pair count)
  const doubleStarMatches = result.match(/\*\*/g);
  if (doubleStarMatches && doubleStarMatches.length % 2 !== 0) {
    result = result.replace(/\*\*([^*]*)$/, "$1");
  }

  // Remove trailing unclosed italic (* at end, odd count, not part of **)
  const singleStars = result.replace(/\*\*/g, "").match(/\*/g);
  if (singleStars && singleStars.length % 2 !== 0) {
    result = result.replace(/\*([^*]*)$/, "$1");
  }

  // Remove trailing incomplete table row separator
  // (helper-based to avoid Tailwind v4 content scanner false positives)
  const nlPipe = result.lastIndexOf("\n|");
  if (nlPipe >= 0 && isTableSeparatorSuffix(result, nlPipe + 2)) {
    result = result.slice(0, nlPipe);
  }

  // Remove trailing | that starts an incomplete table cell
  result = result.replace(/\|$/, "");

  // Remove trailing unclosed bracket (just the [, keep the text)
  const openBrackets = (result.match(/\[/g) || []).length;
  const closeBrackets = (result.match(/\]/g) || []).length;
  if (openBrackets > closeBrackets) {
    result = result.replace(/\[/, "");
  }

  return result;
}

// ---------------------------------------------------------------------------
// Block splitting with fenced-code-block awareness
// ---------------------------------------------------------------------------

export interface StableBlock {
  /** Stable id — content-hash based, never changes once assigned. */
  id: string;
  /** Block content — frozen, will not change. */
  content: string;
}

export interface IncrementalMarkdownState {
  /** Stable blocks — each individually memoizable. */
  stableBlocks: StableBlock[];
  /** Active tail being typed — plain text, incomplete markdown stripped. */
  activeTail: string;
  /** Whether the content is finalized (not streaming). */
  isFinalized: boolean;
  /** Full merged text — only populated when finalized. */
  finalizedContent: string;
}

/**
 * Deterministic id from content + ordinal. The ordinal prevents duplicate keys
 * when the same paragraph content appears multiple times (e.g. repeated
 * "下一步" sections). Appending new blocks never changes existing keys because
 * the ordinal is fixed at block creation time.
 */
function blockId(content: string, ordinal: number): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) - h + content.charCodeAt(i)) | 0;
  }
  return `blk-${Math.abs(h).toString(36)}-${ordinal}`;
}

/**
 * Split text into paragraphs at double-newline boundaries, but NEVER split
 * inside a fenced code block (``` ... ```).
 *
 * Returns the list of paragraphs. Adjacent paragraphs separated by a
 * double-newline are kept as separate entries; the separator itself is
 * preserved by joining with "\n\n" downstream.
 */
export function splitIntoParagraphs(text: string): string[] {
  const paragraphs: string[] = [];
  let current = "";
  let inFence = false;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Toggle fence state on lines that are exactly a fence delimiter
    if (trimmed.startsWith("```")) {
      // A line like ``` or ```python — only toggle if it's JUST the fence
      // (possibly with language tag), not a fence with content after it.
      // But for safety, any line starting with ``` toggles the fence.
      inFence = !inFence;
    }

    // Check if this line and the next form a double-newline boundary
    const isBlankLine = line === "";
    const nextIsBlank = i + 1 < lines.length && lines[i + 1] === "";

    if (!inFence && isBlankLine && current.length > 0) {
      // Double-newline boundary outside a code fence → freeze this block
      paragraphs.push(current);
      current = "";
      // Skip the blank line itself (it's the separator)
      continue;
    }

    // Accumulate line into current block
    if (current.length > 0) {
      current += "\n" + line;
    } else {
      current = line;
    }
  }

  // Remaining content is the tail (active)
  if (current.length > 0) {
    paragraphs.push(current);
  }

  return paragraphs;
}

/**
 * Hook that splits text into stable blocks and an active tail for
 * incremental markdown rendering.
 *
 * Stable blocks are memoized by their content — once a paragraph boundary
 * is crossed (outside code fences), that block's ReactMarkdown parse is
 * cached and never re-parsed.
 *
 * The active tail has incomplete markdown syntax stripped so users don't
 * see raw `**`, `` ` ``, `|---|` tokens while typing.
 */
export function useIncrementalMarkdown(
  text: string,
  isStreaming: boolean,
): IncrementalMarkdownState {
  return useMemo(() => {
    if (text === undefined || text === null) {
      return {
        stableBlocks: [],
        activeTail: "",
        isFinalized: !isStreaming,
        finalizedContent: "",
      };
    }

    if (!isStreaming) {
      // Finalized: render full text as complete markdown, single block
      return {
        stableBlocks: text.length > 0 ? [{ id: blockId(text, 0), content: text }] : [],
        activeTail: "",
        isFinalized: true,
        finalizedContent: text,
      };
    }

    // Split into paragraphs respecting fenced code blocks
    const paragraphs = splitIntoParagraphs(text);

    if (paragraphs.length <= 1) {
      // Single paragraph (or empty) — all content is the active tail
      return {
        stableBlocks: [],
        activeTail: paragraphs[0] ? stripIncompleteMarkdown(paragraphs[0]) : "",
        isFinalized: false,
        finalizedContent: "",
      };
    }

    // All paragraphs except the last are stable blocks
    const stableContents = paragraphs.slice(0, -1);
    const tailRaw = paragraphs[paragraphs.length - 1];

    const stableBlocks: StableBlock[] = stableContents.map((content, i) => ({
      id: blockId(content, i),
      content,
    }));

    return {
      stableBlocks,
      activeTail: tailRaw ? stripIncompleteMarkdown(tailRaw) : "",
      isFinalized: false,
      finalizedContent: "",
    };
  }, [text, isStreaming]);
}
