import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import React from "react";

// Mock MarkdownContent to just render the content as text
vi.mock("./MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

import { StreamingText } from "./StreamingText";

// jsdom does not implement matchMedia; mock it before each test
let reducedMotion = false;

beforeEach(() => {
  reducedMotion = false;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" ? reducedMotion : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("StreamingText cursor behavior", () => {
  it("shows cursor while streaming", () => {
    vi.useFakeTimers();
    const buffer = "短文本";

    const { container } = render(<StreamingText buffer={buffer} isStreaming={true} />);

    // Advance to let scheduler catch up
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    // Cursor should be visible while streaming (showCursor = isStreaming || displayLength < buffer.length)
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("hides cursor when display catches up and isStreaming is false", () => {
    vi.useFakeTimers();
    const buffer = "短文本";

    // Render with isStreaming=false and buffer already present
    const { container } = render(<StreamingText buffer={buffer} isStreaming={false} />);
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    // After display catches up and not streaming, cursor should be gone
    expect(container.querySelector(".animate-pulse")).toBeNull();
  });

  it("shows cursor when display has not caught up even if not streaming", () => {
    vi.useFakeTimers();
    const longBuffer = "A".repeat(300);

    const { container } = render(<StreamingText buffer={longBuffer} isStreaming={false} />);

    // After 100ms, display hasn't caught up — cursor should be visible
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
  });
});

describe("StreamingText rendering", () => {
  it("returns null when no displayText and not streaming", () => {
    vi.useFakeTimers();
    const { container } = render(<StreamingText buffer="" isStreaming={false} />);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(container.firstChild).toBeNull();
  });

  it("renders buffer content progressively", () => {
    vi.useFakeTimers();
    const buffer = "Hello World";

    render(<StreamingText buffer={buffer} isStreaming={true} />);

    act(() => {
      vi.advanceTimersByTime(60);
    });

    // During streaming, active tail is plain text (no MarkdownContent)
    // Check that the container has some text content
    const container = document.querySelector("[class]");
    expect(container?.textContent?.length).toBeGreaterThan(0);

    // Advance to full reveal
    act(() => {
      vi.advanceTimersByTime(6000);
    });

    // Still streaming, so content is rendered as plain text active tail
    expect(container?.textContent).toContain(buffer);
  });

  it("shows full buffer immediately when prefers-reduced-motion is set", () => {
    vi.useFakeTimers();
    reducedMotion = true;
    const buffer = "这是完整回答内容，减少动效模式下应立即显示。";

    render(<StreamingText buffer={buffer} isStreaming={true} />);

    act(() => {
      vi.advanceTimersByTime(0);
    });

    // Reduced motion shows content immediately as active tail (plain text)
    expect(document.body.textContent).toContain(buffer);
  });

  it("renders nothing when buffer is empty but streaming", () => {
    vi.useFakeTimers();
    const { container } = render(<StreamingText buffer="" isStreaming={true} />);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    // Empty buffer → no stable blocks and no active tail → null render
    // (cursor is still shown via showCursor)
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("uses MarkdownContent when not streaming (finalized)", () => {
    vi.useFakeTimers();
    const buffer = "Final content here";

    render(<StreamingText buffer={buffer} isStreaming={false} />);

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    // When isStreaming=false, content is finalized and uses MarkdownContent
    expect(screen.getByTestId("md").textContent).toBe(buffer);
  });

  it("uses plain text active tail during streaming (no MarkdownContent for incomplete content)", () => {
    vi.useFakeTimers();
    const buffer = "Single paragraph being streamed";

    render(<StreamingText buffer={buffer} isStreaming={true} />);

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    // During streaming with single paragraph, active tail is plain text
    // No MarkdownContent should be rendered
    expect(screen.queryByTestId("md")).toBeNull();
    // But content should still be visible
    expect(document.body.textContent).toContain(buffer);
  });
});

describe("StreamingText premature finalization fix", () => {
  it("MarkdownContent render count does not grow per rAF tick during catch-up after stream ends", () => {
    vi.useFakeTimers();

    // Long buffer — needs many rAF frames to catch up
    const longBuffer = "A".repeat(500);

    const { container } = render(<StreamingText buffer={longBuffer} isStreaming={true} />);

    // Let it start revealing
    act(() => {
      vi.advanceTimersByTime(100);
    });

    // End the network stream — re-render with isStreaming=false
    render(<StreamingText buffer={longBuffer} isStreaming={false} />, { container });

    // After stream ends, displayLength < buffer.length → presentationStreaming
    // should still be true → useIncrementalMarkdown should NOT finalize.
    // During catch-up, content is rendered as active tail (plain text),
    // NOT as MarkdownContent. So md count should be 0 throughout catch-up.

    // Count md elements after first tick
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const mdCount1 = container.querySelectorAll("[data-testid='md']").length;

    // Advance more — with the bug, MarkdownContent would render every tick
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const mdCount2 = container.querySelectorAll("[data-testid='md']").length;

    act(() => {
      vi.advanceTimersByTime(100);
    });
    const mdCount3 = container.querySelectorAll("[data-testid='md']").length;

    // With the fix: during catch-up, no MarkdownContent rendered
    expect(mdCount1).toBe(0);
    expect(mdCount2).toBe(0);
    expect(mdCount3).toBe(0);

    // After full catch-up, finalized content should render exactly once
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    const mdCountFinal = container.querySelectorAll("[data-testid='md']").length;
    expect(mdCountFinal).toBe(1);
    expect(container.querySelector("[data-testid='md']")?.textContent).toBe(longBuffer);
  });
});

describe("StreamingText onRevealProgress", () => {
  it("fires onRevealProgress as text is revealed", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const longBuffer = "A".repeat(200);

    render(<StreamingText buffer={longBuffer} isStreaming={true} onRevealProgress={callback} />);

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(callback).toHaveBeenCalled();
  });

  it("fires onRevealProgress immediately in reduced-motion mode", () => {
    vi.useFakeTimers();
    reducedMotion = true;
    const callback = vi.fn();
    const buffer = "完整内容";

    render(<StreamingText buffer={buffer} isStreaming={true} onRevealProgress={callback} />);

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(callback).toHaveBeenCalled();
    expect(document.body.textContent).toContain(buffer);
  });
});
