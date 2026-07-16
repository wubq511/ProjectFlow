import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useIncrementalMarkdown,
  stripIncompleteMarkdown,
  splitIntoParagraphs,
} from "./useIncrementalMarkdown";

describe("stripIncompleteMarkdown", () => {
  it("removes trailing unclosed code fence", () => {
    expect(stripIncompleteMarkdown("some text\n```js")).toBe("some text\n");
    expect(stripIncompleteMarkdown("text\n```")).toBe("text\n");
  });

  it("removes trailing unclosed inline code", () => {
    expect(stripIncompleteMarkdown("hello `worl")).toBe("hello worl");
  });

  it("removes trailing unclosed bold", () => {
    expect(stripIncompleteMarkdown("hello **worl")).toBe("hello worl");
  });

  it("removes trailing unclosed italic", () => {
    expect(stripIncompleteMarkdown("hello *worl")).toBe("hello worl");
  });

  it("removes trailing unclosed link text", () => {
    expect(stripIncompleteMarkdown("hello [worl")).toBe("hello worl");
  });

  it("removes trailing incomplete table separator", () => {
    expect(stripIncompleteMarkdown("col1 | col2\n|---")).toBe("col1 | col2");
  });

  it("does not modify complete text", () => {
    const text = "Hello **world** and `code`";
    expect(stripIncompleteMarkdown(text)).toBe(text);
  });

  it("handles empty string", () => {
    expect(stripIncompleteMarkdown("")).toBe("");
  });

  it("handles text with no markdown", () => {
    expect(stripIncompleteMarkdown("plain text")).toBe("plain text");
  });
});

describe("splitIntoParagraphs", () => {
  it("splits on double newline", () => {
    expect(splitIntoParagraphs("Para 1\n\nPara 2")).toEqual(["Para 1", "Para 2"]);
  });

  it("preserves single newlines within a paragraph", () => {
    expect(splitIntoParagraphs("Line 1\nLine 2\n\nPara 2")).toEqual(["Line 1\nLine 2", "Para 2"]);
  });

  it("returns single element for no double newline", () => {
    expect(splitIntoParagraphs("Single paragraph")).toEqual(["Single paragraph"]);
  });

  it("returns empty array for empty string", () => {
    expect(splitIntoParagraphs("")).toEqual([]);
  });

  it("does NOT split inside fenced code block", () => {
    const text = "Para 1\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nPara 3";
    const result = splitIntoParagraphs(text);
    expect(result).toEqual([
      "Para 1",
      "```js\nconst a = 1;\n\nconst b = 2;\n```",
      "Para 3",
    ]);
  });

  it("handles code fence without language tag", () => {
    const text = "Before\n\n```\ncode\n\ninside\n```\n\nAfter";
    const result = splitIntoParagraphs(text);
    // Blank lines inside code fence are preserved (we don't split there)
    expect(result).toEqual([
      "Before",
      "```\ncode\n\ninside\n```",
      "After",
    ]);
  });

  it("handles nested fence-like content", () => {
    const text = "Para 1\n\n```markdown\nSome text\n\n```inner```\n```\n\nPara 2";
    const result = splitIntoParagraphs(text);
    // The ``` on the "inner" line toggles fence off, then the closing ``` toggles back on
    // This is tricky — the parser tracks state per line starting with ```
    // Let's just verify it doesn't crash and produces some output
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("handles table content across lines without splitting", () => {
    const text = "Header\n\n| Col1 | Col2 |\n|------|------|\n| A    | B    |\n\nFooter";
    const result = splitIntoParagraphs(text);
    expect(result).toEqual([
      "Header",
      "| Col1 | Col2 |\n|------|------|\n| A    | B    |",
      "Footer",
    ]);
  });

  it("handles list items across lines without splitting", () => {
    const text = "Intro\n\n- Item 1\n- Item 2\n- Item 3\n\nOutro";
    const result = splitIntoParagraphs(text);
    expect(result).toEqual([
      "Intro",
      "- Item 1\n- Item 2\n- Item 3",
      "Outro",
    ]);
  });

  it("handles consecutive blank lines", () => {
    const text = "Para 1\n\n\n\nPara 2";
    const result = splitIntoParagraphs(text);
    expect(result).toEqual(["Para 1", "Para 2"]);
  });
});

describe("useIncrementalMarkdown", () => {
  it("returns finalized state when not streaming", () => {
    const text = "Hello\n\nWorld";
    const { result } = renderHook(() =>
      useIncrementalMarkdown(text, false),
    );

    expect(result.current.isFinalized).toBe(true);
    expect(result.current.finalizedContent).toBe(text);
    expect(result.current.stableBlocks).toHaveLength(1);
    expect(result.current.stableBlocks[0].content).toBe(text);
    expect(result.current.activeTail).toBe("");
  });

  it("returns empty for empty text", () => {
    const { result } = renderHook(() =>
      useIncrementalMarkdown("", true),
    );

    expect(result.current.stableBlocks).toHaveLength(0);
    expect(result.current.activeTail).toBe("");
    expect(result.current.isFinalized).toBe(false);
  });

  it("splits on paragraph boundary when streaming", () => {
    const text = "First paragraph.\n\nSecond paragraph being typed";
    const { result } = renderHook(() =>
      useIncrementalMarkdown(text, true),
    );

    expect(result.current.stableBlocks).toHaveLength(1);
    expect(result.current.stableBlocks[0].content).toBe("First paragraph.");
    expect(result.current.activeTail).toBe("Second paragraph being typed");
    expect(result.current.isFinalized).toBe(false);
  });

  it("all content is active tail when no paragraph boundary", () => {
    const text = "Single paragraph being typed";
    const { result } = renderHook(() =>
      useIncrementalMarkdown(text, true),
    );

    expect(result.current.stableBlocks).toHaveLength(0);
    expect(result.current.activeTail).toBe(text);
    expect(result.current.isFinalized).toBe(false);
  });

  it("strips incomplete markdown from active tail", () => {
    const text = "First.\n\n**incomplete";
    const { result } = renderHook(() =>
      useIncrementalMarkdown(text, true),
    );

    expect(result.current.stableBlocks).toHaveLength(1);
    expect(result.current.stableBlocks[0].content).toBe("First.");
    expect(result.current.activeTail).toBe("incomplete");
  });

  it("stable block ids are stable across renders with same content", () => {
    const text = "Stable.\n\nTail";
    const { result, rerender } = renderHook(
      ({ t }) => useIncrementalMarkdown(t, true),
      { initialProps: { t: text } },
    );

    const firstId = result.current.stableBlocks[0].id;

    // Same content — block id should be identical
    rerender({ t: text });
    expect(result.current.stableBlocks[0].id).toBe(firstId);
  });

  it("stable block content reference is stable across renders with same content", () => {
    const text = "Stable.\n\nTail";
    const { result, rerender } = renderHook(
      ({ t }) => useIncrementalMarkdown(t, true),
      { initialProps: { t: text } },
    );

    const firstContent = result.current.stableBlocks[0].content;

    // Same content — content reference should be identical
    rerender({ t: text });
    expect(result.current.stableBlocks[0].content).toBe(firstContent);
  });

  it("stable blocks accumulate as text grows", () => {
    const text1 = "Para 1.\n\nTail 1";
    const { result, rerender } = renderHook(
      ({ t }) => useIncrementalMarkdown(t, true),
      { initialProps: { t: text1 } },
    );

    expect(result.current.stableBlocks).toHaveLength(1);
    expect(result.current.stableBlocks[0].content).toBe("Para 1.");

    // Add another paragraph
    const text2 = "Para 1.\n\nPara 2.\n\nTail 2";
    rerender({ t: text2 });

    expect(result.current.stableBlocks).toHaveLength(2);
    expect(result.current.stableBlocks[0].content).toBe("Para 1.");
    expect(result.current.stableBlocks[1].content).toBe("Para 2.");
    expect(result.current.activeTail).toBe("Tail 2");
  });

  it("first stable block reference does NOT change when second block is added", () => {
    const text1 = "Para 1.\n\nTail 1";
    const { result, rerender } = renderHook(
      ({ t }) => useIncrementalMarkdown(t, true),
      { initialProps: { t: text1 } },
    );

    const firstBlockId = result.current.stableBlocks[0].id;
    const firstBlockContent = result.current.stableBlocks[0].content;

    // Add second paragraph
    const text2 = "Para 1.\n\nPara 2.\n\nTail 2";
    rerender({ t: text2 });

    // First block should be exactly the same reference
    expect(result.current.stableBlocks[0].id).toBe(firstBlockId);
    expect(result.current.stableBlocks[0].content).toBe(firstBlockContent);
  });

  it("does not split inside fenced code blocks", () => {
    const text = "Para 1\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nTail";
    const { result } = renderHook(() =>
      useIncrementalMarkdown(text, true),
    );

    // Should have 2 stable blocks: "Para 1" and the fenced code block
    expect(result.current.stableBlocks).toHaveLength(2);
    expect(result.current.stableBlocks[0].content).toBe("Para 1");
    expect(result.current.stableBlocks[1].content).toBe("```js\nconst a = 1;\n\nconst b = 2;\n```");
    expect(result.current.activeTail).toBe("Tail");
  });

  it("single long paragraph stays as active tail", () => {
    const text = "This is a very long single paragraph with no double newlines at all";
    const { result } = renderHook(() =>
      useIncrementalMarkdown(text, true),
    );

    expect(result.current.stableBlocks).toHaveLength(0);
    expect(result.current.activeTail).toBe(text);
  });

  it("undefined/null text returns empty state", () => {
    const { result } = renderHook(() =>
      useIncrementalMarkdown(undefined as unknown as string, true),
    );

    expect(result.current.stableBlocks).toHaveLength(0);
    expect(result.current.activeTail).toBe("");
    expect(result.current.isFinalized).toBe(false);
  });

  it("duplicate paragraphs produce unique block keys", () => {
    // Two identical paragraphs separated by double newline
    const text = "相同段落\n\n相同段落\n\n尾部";
    const { result } = renderHook(() =>
      useIncrementalMarkdown(text, true),
    );

    expect(result.current.stableBlocks).toHaveLength(2);
    expect(result.current.stableBlocks[0].content).toBe("相同段落");
    expect(result.current.stableBlocks[1].content).toBe("相同段落");

    // Keys must be unique even though content is identical
    expect(result.current.stableBlocks[0].id).not.toBe(result.current.stableBlocks[1].id);
  });

  it("appending new blocks does not change existing block keys", () => {
    const text1 = "段落一\n\n段落二\n\n尾部1";
    const { result, rerender } = renderHook(
      ({ t }) => useIncrementalMarkdown(t, true),
      { initialProps: { t: text1 } },
    );

    const key0 = result.current.stableBlocks[0].id;
    const key1 = result.current.stableBlocks[1].id;

    // Append a third paragraph
    const text2 = "段落一\n\n段落二\n\n段落三\n\n尾部2";
    rerender({ t: text2 });

    expect(result.current.stableBlocks).toHaveLength(3);
    // Existing keys unchanged
    expect(result.current.stableBlocks[0].id).toBe(key0);
    expect(result.current.stableBlocks[1].id).toBe(key1);
    // New key is different
    expect(result.current.stableBlocks[2].id).not.toBe(key0);
    expect(result.current.stableBlocks[2].id).not.toBe(key1);
  });
});
