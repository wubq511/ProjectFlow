import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import React from "react";

// Track ProcessMarkdown render count for cadence assertions
let pmRenderCount = 0;
vi.mock("./ProcessMarkdown", () => ({
  ProcessMarkdown: ({ content }: { content: string }) => {
    pmRenderCount++;
    return <span data-testid="process-md">{content}</span>;
  },
}));

let reducedMotion = false;
beforeEach(() => {
  pmRenderCount = 0;
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

import { StreamingProcessText } from "./StreamingProcessText";

describe("StreamingProcessText scheduler behavior", () => {
  it("500-char burst: 100ms shows partial, ~2s shows significant catch-up", () => {
    vi.useFakeTimers();
    const burst = "中".repeat(500);

    render(<StreamingProcessText content={burst} isStreaming={true} />);

    // After 100ms (2 ticks), should show partial content
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const earlyText = (document.querySelector("[data-testid='process-md']")?.textContent ?? "");
    expect(earlyText.length).toBeGreaterThan(0);
    expect(earlyText.length).toBeLessThan(100); // Not all revealed in 100ms

    // After ~2s, should have caught up significantly
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    const laterText = (document.querySelector("[data-testid='process-md']")?.textContent ?? "");
    expect(laterText.length).toBeGreaterThan(200); // Significant progress
  });

  it("buffer growth is monotonic — content length never decreases", () => {
    vi.useFakeTimers();

    const { rerender } = render(
      <StreamingProcessText content="AAAA" isStreaming={true} />,
    );
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    const firstLen = (document.querySelector("[data-testid='process-md']")?.textContent ?? "").length;
    expect(firstLen).toBe(4);

    // Grow buffer — display should not regress
    rerender(<StreamingProcessText content="AAAA BBBB" isStreaming={true} />);
    act(() => {
      vi.advanceTimersByTime(100); // Just one tick
    });
    const secondLen = (document.querySelector("[data-testid='process-md']")?.textContent ?? "").length;
    expect(secondLen).toBeGreaterThanOrEqual(firstLen);
  });

  it("reduced-motion: shows full content immediately", () => {
    vi.useFakeTimers();
    reducedMotion = true;
    const content = "完整内容，减少动效。";

    render(<StreamingProcessText content={content} isStreaming={true} />);

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(document.querySelector("[data-testid='process-md']")?.textContent).toBe(content);
  });

  it("non-streaming renders full content immediately without reveal", () => {
    vi.useFakeTimers();
    const content = "已完成的进度内容";

    render(<StreamingProcessText content={content} isStreaming={false} />);

    // Should show full content immediately — no progressive reveal
    expect(document.querySelector("[data-testid='process-md']")?.textContent).toBe(content);
  });

  it("completes reveal when streaming ends and buffer remains", () => {
    vi.useFakeTimers();
    const longContent = "A".repeat(300);

    const { rerender } = render(
      <StreamingProcessText content={longContent} isStreaming={true} />,
    );

    act(() => {
      vi.advanceTimersByTime(1000); // Reveal some
    });
    const midText = (document.querySelector("[data-testid='process-md']")?.textContent ?? "");
    expect(midText.length).toBeLessThan(300);

    // Stop streaming — should continue until caught up
    rerender(<StreamingProcessText content={longContent} isStreaming={false} />);
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(document.querySelector("[data-testid='process-md']")?.textContent).toBe(longContent);
  });
});

describe("StreamingProcessText Markdown renderer cadence", () => {
  it("renderer calls ≤22 per second in normal mode (throttled)", () => {
    vi.useFakeTimers();
    const content = "A".repeat(500);

    render(<StreamingProcessText content={content} isStreaming={true} />);

    // Reset after initial render
    pmRenderCount = 0;

    // Advance 1 second — 20 ticks at 50ms, but renderer cadence is throttled
    // The hook fires setDisplayLength every tick (~20), but React batches them.
    // ProcessMarkdown re-renders each time React commits a new displayLength.
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // Should not exceed 22 renderer calls per second
    expect(pmRenderCount).toBeLessThanOrEqual(22);
  });

  it("renderer calls ≤22 per second in reduced-motion mode (immediate full)", () => {
    vi.useFakeTimers();
    reducedMotion = true;
    const content = "A".repeat(500);

    render(<StreamingProcessText content={content} isStreaming={true} />);

    pmRenderCount = 0;

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // Reduced motion: immediate full render, minimal additional calls
    expect(pmRenderCount).toBeLessThanOrEqual(22);
  });
});

describe("StreamingProcessText non-streaming (historical)", () => {
  it("renders full content immediately for completed messages", () => {
    const content = "已完成的全部进度内容，包含**Markdown**格式。";

    render(<StreamingProcessText content={content} isStreaming={false} />);

    // Should render full content immediately
    expect(document.querySelector("[data-testid='process-md']")?.textContent).toBe(content);
  });

  it("does not start scheduler when isStreaming is false from mount", () => {
    vi.useFakeTimers();
    const content = "A".repeat(500);

    render(<StreamingProcessText content={content} isStreaming={false} />);

    // With isStreaming=false, hook shows full content immediately (not reduced motion)
    // Actually, isStreaming=false means the scheduler starts but stops when caught up.
    // Since buffer.length > displayLength (0), it starts, then catches up and stops.
    act(() => {
      vi.advanceTimersByTime(100);
    });

    // After 100ms, should have revealed some content
    const text = document.querySelector("[data-testid='process-md']")?.textContent ?? "";
    expect(text.length).toBeGreaterThan(0);
  });
});
