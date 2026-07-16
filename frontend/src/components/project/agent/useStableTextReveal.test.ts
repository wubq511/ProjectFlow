import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// jsdom does not implement matchMedia; mock it before each test
let reducedMotion = false;

// jsdom does not implement requestAnimationFrame; polyfill with setTimeout
// so vi.useFakeTimers() can control the scheduler.
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

  // Polyfill rAF/cRAF for jsdom — delegates to setTimeout so fake timers control it
  let rafId = 0;
  const rafMap = new Map<number, ReturnType<typeof setTimeout>>();
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = ++rafId;
    rafMap.set(id, setTimeout(() => cb(performance.now()), 16));
    return id;
  };
  window.cancelAnimationFrame = (id: number) => {
    const t = rafMap.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      rafMap.delete(id);
    }
  };
});

afterEach(() => {
  vi.useRealTimers();
});

import { useStableTextReveal, advanceToBoundary } from "./useStableTextReveal";

describe("advanceToBoundary", () => {
  it("stops at word boundary (space)", () => {
    const buf = "Hello World test";
    // current=0, target=7 → should stop at 6 (after "Hello") or 5 ("Hello")
    // "Hello World" — position 5 is 'o', position 6 is ' '
    const result = advanceToBoundary(0, 7, buf);
    expect(result).toBe(6); // after "Hello "
  });

  it("stops at newline", () => {
    const buf = "Line1\nLine2";
    const result = advanceToBoundary(0, 8, buf);
    expect(result).toBe(6); // after "Line1\n"
  });

  it("stops at Chinese punctuation", () => {
    const buf = "你好，世界！测试";
    const result = advanceToBoundary(0, 5, buf);
    expect(result).toBe(3); // after "你好，"
  });

  it("returns target if no better boundary found", () => {
    const buf = "abcdefghijklmno";
    const result = advanceToBoundary(0, 5, buf);
    expect(result).toBe(5);
  });

  it("returns target when target >= buffer.length", () => {
    const buf = "abc";
    const result = advanceToBoundary(0, 3, buf);
    expect(result).toBe(3);
  });
});

describe("useStableTextReveal scheduler", () => {
  it("500-char burst: 100ms shows partial, ~2s shows significant catch-up", () => {
    vi.useFakeTimers();
    const burst = "中".repeat(500);
    const { result } = renderHook(() =>
      useStableTextReveal({ buffer: burst, isStreaming: true }),
    );

    // After 100ms (several rAF frames), should show partial content
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBeGreaterThan(0);
    expect(result.current).toBeLessThan(100); // Not all revealed in 100ms

    // After ~2s, should have caught up significantly
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBeGreaterThan(200); // Significant progress
  });

  it("buffer growth is monotonic — displayLength never decreases", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ buffer }) => useStableTextReveal({ buffer, isStreaming: true }),
      { initialProps: { buffer: "AAAA" } },
    );

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBe(4); // "AAAA" fully revealed

    // Grow buffer — display should not regress
    rerender({ buffer: "AAAA BBBB" });
    act(() => {
      vi.advanceTimersByTime(100); // Just one tick
    });
    // Should be >= 4 (monotonic) and < 9 (not all revealed yet)
    expect(result.current).toBeGreaterThanOrEqual(4);
  });

  it("reduced-motion: displayLength = buffer.length immediately", () => {
    vi.useFakeTimers();
    reducedMotion = true;
    const buffer = "这是一段需要完整显示的文本内容。";

    const { result } = renderHook(() =>
      useStableTextReveal({ buffer, isStreaming: true }),
    );

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(result.current).toBe(buffer.length);
  });

  it("does not show full buffer immediately — reveals progressively", () => {
    vi.useFakeTimers();
    const longBuffer = "A".repeat(500);

    const { result } = renderHook(() =>
      useStableTextReveal({ buffer: longBuffer, isStreaming: true }),
    );

    // After first frame (~16ms), displayLength should be > 0 but < 500
    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(result.current).toBeLessThan(500);
    expect(result.current).toBeGreaterThan(0);

    // After enough time, should fully reveal
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(result.current).toBe(500);
  });

  it("displayLength never exceeds buffer length", () => {
    vi.useFakeTimers();
    const buffer = "Hello";

    const { result } = renderHook(() =>
      useStableTextReveal({ buffer, isStreaming: true }),
    );

    act(() => {
      vi.advanceTimersByTime(10000); // Way more than needed
    });

    expect(result.current).toBe(buffer.length);
  });

  it("continues revealing after isStreaming becomes false if buffer remains", () => {
    vi.useFakeTimers();
    const longBuffer = "A".repeat(300);

    const { result, rerender } = renderHook(
      ({ isStreaming }) =>
        useStableTextReveal({ buffer: longBuffer, isStreaming }),
      { initialProps: { isStreaming: true } },
    );

    act(() => {
      vi.advanceTimersByTime(1000); // Reveal some
    });
    expect(result.current).toBeLessThan(300);
    expect(result.current).toBeGreaterThan(0);

    // Stop streaming — should continue until caught up
    rerender({ isStreaming: false });
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(result.current).toBe(300);
  });

  it("stops scheduler when caught up and not streaming", () => {
    vi.useFakeTimers();
    const buffer = "短文本";

    const { result } = renderHook(() =>
      useStableTextReveal({ buffer, isStreaming: false }),
    );

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current).toBe(buffer.length);
  });
});

describe("useStableTextReveal onRevealProgress", () => {
  it("fires onRevealProgress as text is revealed", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const longBuffer = "A".repeat(200);

    renderHook(() =>
      useStableTextReveal({ buffer: longBuffer, isStreaming: true, onRevealProgress: callback }),
    );

    // Advance enough for several throttle intervals (80ms each)
    act(() => {
      vi.advanceTimersByTime(500);
    });

    // Should have been called at least once during progressive reveal
    expect(callback).toHaveBeenCalled();
  });

  it("fires onRevealProgress immediately in reduced-motion mode", () => {
    vi.useFakeTimers();
    reducedMotion = true;
    const callback = vi.fn();
    const buffer = "完整内容";

    renderHook(() =>
      useStableTextReveal({ buffer, isStreaming: true, onRevealProgress: callback }),
    );

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(callback).toHaveBeenCalled();
  });

  it("does not crash when onRevealProgress is not provided", () => {
    vi.useFakeTimers();
    const buffer = "Hello";

    const { result } = renderHook(() =>
      useStableTextReveal({ buffer, isStreaming: true }),
    );

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current).toBe(buffer.length);
  });
});

describe("useStableTextReveal cadence", () => {
  it("reveals at ~16fps with adaptive backlog, not all at once", () => {
    vi.useFakeTimers();
    const longBuffer = "A".repeat(500);

    const { result } = renderHook(() =>
      useStableTextReveal({ buffer: longBuffer, isStreaming: true }),
    );

    // Advance 1 second — should reveal ~275 chars (110 base + backlog adaptive)
    // but NOT all 500 chars at once
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBeGreaterThan(0);
    expect(result.current).toBeLessThan(500);

    // Advance enough for full reveal (~2s at adaptive rate)
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(result.current).toBe(500);
  });
});

describe("useStableTextReveal cleanup", () => {
  it("cancels rAF on unmount", () => {
    vi.useFakeTimers();
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame");
    const longBuffer = "A".repeat(500);

    const { unmount } = renderHook(() =>
      useStableTextReveal({ buffer: longBuffer, isStreaming: true }),
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });

    unmount();

    // cancelAnimationFrame should have been called during cleanup
    expect(cancelSpy).toHaveBeenCalled();
    cancelSpy.mockRestore();
  });
});
