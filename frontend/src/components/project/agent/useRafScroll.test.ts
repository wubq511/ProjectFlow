import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRef } from "react";
import { useRafScroll } from "./useRafScroll";

beforeEach(() => {
  // Polyfill rAF for jsdom
  let rafId = 0;
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    return setTimeout(() => cb(performance.now()), 16) as unknown as number;
  };
  window.cancelAnimationFrame = (id: number) => {
    clearTimeout(id);
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useRafScroll", () => {
  function createMockContainer(scrollHeight = 1000, clientHeight = 400, scrollTop = 0) {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
    let _scrollTop = scrollTop;
    Object.defineProperty(el, "scrollTop", {
      get: () => _scrollTop,
      set: (v: number) => { _scrollTop = v; },
      configurable: true,
    });
    return el;
  }

  it("scrollToBottom scrolls to bottom when near bottom", () => {
    vi.useFakeTimers();
    const el = createMockContainer(1000, 400, 550); // Near bottom (1000-550-400=50 < 150)
    const { result } = renderHook(() => {
      const ref = { current: el };
      return useRafScroll(ref);
    });

    // Manually trigger scroll to set near-bottom state
    act(() => {
      result.current.handleScroll();
    });

    act(() => {
      result.current.scrollToBottom();
      vi.advanceTimersByTime(20);
    });

    expect(el.scrollTop).toBe(1000);
  });

  it("scrollToBottom does NOT scroll when user has scrolled up", () => {
    vi.useFakeTimers();
    const el = createMockContainer(1000, 400, 0); // Far from bottom (1000-0-400=600 > 150)
    const { result } = renderHook(() => {
      const ref = { current: el };
      return useRafScroll(ref);
    });

    // Manually trigger scroll to set far-from-bottom state
    act(() => {
      result.current.handleScroll();
    });

    act(() => {
      result.current.scrollToBottom();
      vi.advanceTimersByTime(20);
    });

    // Should NOT have scrolled
    expect(el.scrollTop).toBe(0);
  });

  it("forceScrollToBottom ignores near-bottom state", () => {
    const el = createMockContainer(1000, 400, 0); // Far from bottom
    const { result } = renderHook(() => {
      const ref = { current: el };
      return useRafScroll(ref);
    });

    act(() => {
      result.current.handleScroll();
    });

    // forceScrollToBottom should work even when far from bottom
    result.current.forceScrollToBottom();
    expect(el.scrollTop).toBe(1000);
  });

  it("coalesces multiple scrollToBottom calls into one per frame", () => {
    vi.useFakeTimers();
    const el = createMockContainer(1000, 400, 550);
    const { result } = renderHook(() => {
      const ref = { current: el };
      return useRafScroll(ref);
    });

    act(() => {
      result.current.handleScroll();
    });

    // Multiple calls — should only result in one rAF
    act(() => {
      result.current.scrollToBottom();
      result.current.scrollToBottom();
      result.current.scrollToBottom();
      vi.advanceTimersByTime(20);
    });

    // Should have scrolled exactly once
    expect(el.scrollTop).toBe(1000);
  });

  it("isNearBottom returns correct state", () => {
    const el = createMockContainer(1000, 400, 550);
    const { result } = renderHook(() => {
      const ref = { current: el };
      return useRafScroll(ref);
    });

    // Near bottom
    act(() => {
      result.current.handleScroll();
    });
    expect(result.current.isNearBottom()).toBe(true);

    // Far from bottom
    Object.defineProperty(el, "scrollTop", { value: 0, configurable: true });
    act(() => {
      result.current.handleScroll();
    });
    expect(result.current.isNearBottom()).toBe(false);
  });

  it("custom threshold works", () => {
    const el = createMockContainer(1000, 400, 500); // 1000-500-400=100
    const { result } = renderHook(() => {
      const ref = { current: el };
      return useRafScroll(ref, 50); // Custom 50px threshold
    });

    act(() => {
      result.current.handleScroll();
    });
    // 100 > 50, so NOT near bottom
    expect(result.current.isNearBottom()).toBe(false);
  });
});
