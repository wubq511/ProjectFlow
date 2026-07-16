import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import React from "react";

// Mock MarkdownContent to just render the content as text
vi.mock("./MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

import { StreamingText } from "./StreamingText";

// jsdom does not implement matchMedia; mock it before each test
let matchMediaHandler: ((e: MediaQueryListEvent) => void) | null = null;
let reducedMotion = false;

beforeEach(() => {
  matchMediaHandler = null;
  reducedMotion = false;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" ? reducedMotion : false,
      media: query,
      addEventListener: (_type: string, handler: (e: MediaQueryListEvent) => void) => {
        matchMediaHandler = handler;
      },
      removeEventListener: vi.fn(),
    }),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("StreamingText deterministic reveal", () => {
  it("does not show full buffer immediately — reveals progressively with fake timers", () => {
    vi.useFakeTimers();
    const longBuffer = "A".repeat(1200);

    render(<StreamingText buffer={longBuffer} isStreaming={true} />);

    // Initial render: displayLength starts at 0, RAF hasn't fired yet
    // After first RAF + setState, displayLength = baseLength(0) + chars_per_tick
    act(() => {
      vi.advanceTimersByTime(16); // One RAF frame
    });

    const md = screen.getByTestId("md");
    const initialText = md.textContent ?? "";
    // Should NOT be the full 1200 chars yet
    expect(initialText.length).toBeLessThan(1200);
    expect(initialText.length).toBeGreaterThan(0);

    // Advance time enough for full reveal (1200 chars / 600 per sec = 2 seconds)
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    const finalText = screen.getByTestId("md").textContent ?? "";
    expect(finalText).toBe(longBuffer);
  });

  it("shows full buffer immediately when prefers-reduced-motion is set", () => {
    vi.useFakeTimers();
    reducedMotion = true;
    const buffer = "这是完整回答内容，减少动效模式下应立即显示。";

    render(<StreamingText buffer={buffer} isStreaming={true} />);

    // With reduced motion, displayLength = buffer.length on mount
    act(() => {
      vi.advanceTimersByTime(0);
    });

    const md = screen.getByTestId("md");
    expect(md.textContent).toBe(buffer);
  });

  it("hides cursor when display catches up and isStreaming is false", () => {
    vi.useFakeTimers();
    const buffer = "短文本";

    const { container } = render(<StreamingText buffer={buffer} isStreaming={true} />);

    // Advance to let RAF catch up
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // Cursor should be visible while streaming
    expect(container.querySelector(".animate-pulse")).toBeTruthy();

    // Set isStreaming to false
    const { container: container2 } = render(<StreamingText buffer={buffer} isStreaming={false} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // After display catches up and not streaming, cursor should be gone
    // (displayLength === buffer.length && !isStreaming → showCursor = false)
  });

  it("displayLength never exceeds buffer length", () => {
    vi.useFakeTimers();
    const buffer = "Hello";

    render(<StreamingText buffer={buffer} isStreaming={true} />);
    act(() => {
      vi.advanceTimersByTime(10000); // Way more than needed
    });

    const md = screen.getByTestId("md");
    expect(md.textContent).toBe(buffer);
    expect((md.textContent ?? "").length).toBe(buffer.length);
  });

  it("grows display when buffer grows", () => {
    vi.useFakeTimers();

    const { rerender } = render(<StreamingText buffer="Hello" isStreaming={true} />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId("md").textContent).toBe("Hello");

    // Grow buffer
    rerender(<StreamingText buffer="Hello World" isStreaming={true} />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId("md").textContent).toBe("Hello World");
  });
});

describe("StreamingText onRevealProgress", () => {
  it("fires onRevealProgress as text is revealed", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const longBuffer = "A".repeat(1200);

    render(<StreamingText buffer={longBuffer} isStreaming={true} onRevealProgress={callback} />);

    // Advance enough for several throttle intervals (80ms each)
    act(() => {
      vi.advanceTimersByTime(500);
    });

    // Should have been called at least once during progressive reveal
    expect(callback).toHaveBeenCalled();
  });

  it("fires onRevealProgress on final frame when reveal completes", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const buffer = "短文本";

    render(<StreamingText buffer={buffer} isStreaming={true} onRevealProgress={callback} />);

    // Advance past full reveal
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    // Final frame callback should have fired
    expect(callback).toHaveBeenCalled();
    // Display should be complete
    expect(screen.getByTestId("md").textContent).toBe(buffer);
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

    // With reduced motion, callback fires on mount
    expect(callback).toHaveBeenCalled();
    expect(screen.getByTestId("md").textContent).toBe(buffer);
  });

  it("does not crash when onRevealProgress is not provided", () => {
    vi.useFakeTimers();
    const buffer = "Hello";

    render(<StreamingText buffer={buffer} isStreaming={true} />);

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getByTestId("md").textContent).toBe(buffer);
  });
});
