import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDebouncedCallback } from "./useDebouncedCallback";

describe("useDebouncedCallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not invoke callback immediately", () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(callback, 100));

    act(() => {
      result.current("first");
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it("invokes callback once after delay with the latest args", () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(callback, 100));

    act(() => {
      result.current("a");
      result.current("b");
      result.current("c");
    });

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith("c");
  });

  it("resets the timer on each call within the delay window", () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(callback, 100));

    act(() => {
      result.current("a");
    });

    act(() => {
      vi.advanceTimersByTime(60);
      result.current("b");
    });

    act(() => {
      vi.advanceTimersByTime(60);
    });

    expect(callback).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(40);
    });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith("b");
  });

  it("clears pending timer on unmount", () => {
    const callback = vi.fn();
    const { result, unmount } = renderHook(() => useDebouncedCallback(callback, 100));

    act(() => {
      result.current("a");
    });

    unmount();

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it("uses the most recent callback closure", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(
      ({ callback }) => useDebouncedCallback(callback, 100),
      { initialProps: { callback: first } },
    );

    act(() => {
      result.current("a");
    });

    rerender({ callback: second });

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith("a");
    expect(first).not.toHaveBeenCalled();
  });
});
