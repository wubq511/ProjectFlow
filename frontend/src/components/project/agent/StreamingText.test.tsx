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

    const md = screen.getByTestId("md");
    const initialText = md.textContent ?? "";
    expect(initialText.length).toBeGreaterThan(0);
    expect(initialText.length).toBeLessThan(buffer.length);

    // Advance to full reveal
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.getByTestId("md").textContent).toBe(buffer);
  });

  it("shows full buffer immediately when prefers-reduced-motion is set", () => {
    vi.useFakeTimers();
    reducedMotion = true;
    const buffer = "这是完整回答内容，减少动效模式下应立即显示。";

    render(<StreamingText buffer={buffer} isStreaming={true} />);

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(screen.getByTestId("md").textContent).toBe(buffer);
  });

  it("renders non-empty space when buffer is empty but streaming", () => {
    vi.useFakeTimers();
    const { container } = render(<StreamingText buffer="" isStreaming={true} />);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    // Should render with non-breaking space placeholder
    expect(container.querySelector("[data-testid='md']")).toBeTruthy();
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
    expect(screen.getByTestId("md").textContent).toBe(buffer);
  });
});
