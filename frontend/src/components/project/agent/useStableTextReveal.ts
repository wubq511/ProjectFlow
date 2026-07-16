"use client";

import { useEffect, useRef, useState, useCallback } from "react";

// ---------------------------------------------------------------------------
// Stable display scheduler constants (shared by StreamingText & process progress)
// ---------------------------------------------------------------------------

/** Base reveal rate: ~110 characters per second. */
export const BASE_CHARS_PER_SECOND = 110;
/** Maximum catch-up multiplier when backlog builds (3x base ≈ 330 chars/sec). */
export const MAX_BACKLOG_MULTIPLIER = 3;
/** Target fps for the rAF scheduler — 16fps keeps CPU light while staying smooth. */
export const TARGET_FPS = 16;
/** Minimum frame interval in ms (derived from TARGET_FPS). */
export const MIN_FRAME_MS = 1000 / TARGET_FPS;
/** Maximum frame interval cap — when tab is backgrounded then resumed,
 *  cap elapsed to prevent a single giant jump. */
export const MAX_FRAME_MS = 200;
/** Throttle interval for onRevealProgress callbacks. */
export const REVEAL_CALLBACK_THROTTLE_MS = 80;

// ---------------------------------------------------------------------------
// Markdown-safe boundary detection
// ---------------------------------------------------------------------------

/**
 * Advance displayLength to a safe boundary: word, punctuation, or newline.
 * Avoids cutting in the middle of a word or incomplete markdown token.
 *
 * Returns the new displayLength (may be equal to `target` if no better
 * boundary is found within a reasonable lookback window).
 */
export function advanceToBoundary(
  current: number,
  target: number,
  buffer: string,
): number {
  if (target >= buffer.length) return target;

  // Look for a safe boundary within the last ~12 chars of the target range
  const lookback = Math.min(12, target - current);
  for (let i = 0; i < lookback; i++) {
    const pos = target - i;
    if (pos <= current) break;
    const ch = buffer[pos - 1];
    // Safe boundaries: whitespace, punctuation, newline
    if (ch === " " || ch === "\n" || ch === "\r") return pos;
    if (/[，。！？、；：,.!?;:]/.test(ch)) return pos;
  }

  // No better boundary found — return target as-is
  return target;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseStableTextRevealOptions {
  /** The full buffer of text to reveal. */
  buffer: string;
  /** Whether text is still streaming in (prevents scheduler stop on catch-up). */
  isStreaming?: boolean;
  /**
   * Called (throttled) when the visible text length grows during reveal.
   * Parents use this to auto-scroll.
   */
  onRevealProgress?: () => void;
}

/**
 * Stable character reveal hook — rAF-driven scheduler for progressive text display.
 *
 * Behavior:
 * - requestAnimationFrame-driven (~16fps target)
 * - Base 110 chars/s, adaptive backlog max 330 chars/s
 * - Advances to word/punctuation/newline boundaries when possible
 * - displayLength is monotonically non-decreasing
 * - Buffer growth does not reset display length
 * - When streaming ends and display catches up, scheduler stops
 * - Reduced-motion: immediately shows full buffer
 * - onRevealProgress is throttled at 80ms intervals
 * - Background tab: caps frame elapsed to MAX_FRAME_MS, adapts catch-up
 */
export function useStableTextReveal({
  buffer,
  isStreaming = true,
  onRevealProgress,
}: UseStableTextRevealOptions): number {
  const [displayLength, setDisplayLength] = useState(0);

  // Refs for the scheduler — these never trigger re-renders directly
  const bufferRef = useRef(buffer);
  const displayLengthRef = useRef(0);
  const isStreamingRef = useRef(isStreaming);
  const onRevealProgressRef = useRef(onRevealProgress);
  const reducedMotionRef = useRef(false);
  const rafIdRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef(0);
  const lastCallbackTimeRef = useRef(0);
  const lastReportedLengthRef = useRef(0);
  const stoppedRef = useRef(false);

  // Keep refs in sync via effect (satisfies react-hooks/refs rule).
  useEffect(() => {
    bufferRef.current = buffer;
    isStreamingRef.current = isStreaming;
    onRevealProgressRef.current = onRevealProgress;
  });

  // Detect prefers-reduced-motion once
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = mql.matches;
    const handler = (e: MediaQueryListEvent) => {
      reducedMotionRef.current = e.matches;
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  const stopScheduler = useCallback(() => {
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    stoppedRef.current = true;
  }, []);

  const fireProgress = useCallback((newLength: number) => {
    const callbackNow = performance.now();
    if (
      newLength > lastReportedLengthRef.current &&
      callbackNow - lastCallbackTimeRef.current >= REVEAL_CALLBACK_THROTTLE_MS
    ) {
      lastCallbackTimeRef.current = callbackNow;
      lastReportedLengthRef.current = newLength;
      onRevealProgressRef.current?.();
    }
  }, []);

  // Use a ref for the frame callback to avoid "accessed before declaration" lint error.
  // The frame function calls requestAnimationFrame(frameRef.current) for the next frame.
  const frameRef = useRef<FrameRequestCallback | null>(null);

  // rAF tick body — reads all state from refs, never stale
  const frame = useCallback(
    (now: number) => {
      rafIdRef.current = null;

      const currentBuffer = bufferRef.current;
      const currentDisplay = displayLengthRef.current;

      if (currentDisplay >= currentBuffer.length) {
        if (!isStreamingRef.current) {
          stopScheduler();
        }
        return;
      }

      // Compute elapsed, capping for background tab recovery
      const rawElapsed =
        lastFrameTimeRef.current > 0 ? now - lastFrameTimeRef.current : MIN_FRAME_MS;
      const elapsed = Math.min(rawElapsed, MAX_FRAME_MS);
      lastFrameTimeRef.current = now;

      const baseChars = Math.max(
        1,
        Math.floor((elapsed / 1000) * BASE_CHARS_PER_SECOND),
      );
      const backlog = currentBuffer.length - currentDisplay;
      const backlogThreshold = BASE_CHARS_PER_SECOND;

      let multiplier = 1;
      if (backlog > backlogThreshold * 2) {
        multiplier = MAX_BACKLOG_MULTIPLIER;
      } else if (backlog > backlogThreshold) {
        multiplier =
          1 +
          ((backlog - backlogThreshold) / backlogThreshold) *
            (MAX_BACKLOG_MULTIPLIER - 1);
      }

      let target = currentDisplay + Math.min(Math.ceil(baseChars * multiplier), backlog);

      // Advance to a safe boundary (word/punctuation/newline)
      target = advanceToBoundary(currentDisplay, target, currentBuffer);

      if (target <= currentDisplay) {
        // No progress possible — schedule next frame
        rafIdRef.current = requestAnimationFrame(frameRef.current!);
        return;
      }

      displayLengthRef.current = target;
      setDisplayLength(target);
      fireProgress(target);

      if (target >= currentBuffer.length) {
        // Ensure final callback fires
        if (lastReportedLengthRef.current < currentBuffer.length) {
          lastReportedLengthRef.current = currentBuffer.length;
          onRevealProgressRef.current?.();
        }
        if (!isStreamingRef.current) {
          stopScheduler();
          return;
        }
      }

      // Schedule next frame
      if (!stoppedRef.current) {
        rafIdRef.current = requestAnimationFrame(frameRef.current!);
      }
    },
    [stopScheduler, fireProgress],
  );

  // Keep frameRef current via effect (satisfies react-hooks/refs rule)
  useEffect(() => {
    frameRef.current = frame;
  });

  const startScheduler = useCallback(() => {
    if (rafIdRef.current != null) return;
    stoppedRef.current = false;
    lastFrameTimeRef.current = performance.now();
    rafIdRef.current = requestAnimationFrame(frameRef.current!);
  }, []);

  // Start/restart scheduler when buffer grows or streaming state changes
  useEffect(() => {
    if (reducedMotionRef.current) {
      displayLengthRef.current = buffer.length;
      setDisplayLength(buffer.length);
      onRevealProgressRef.current?.();
      return;
    }

    if (displayLengthRef.current < buffer.length) {
      startScheduler();
    } else if (!isStreaming) {
      stopScheduler();
    }
  }, [buffer, isStreaming, startScheduler, stopScheduler]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopScheduler();
    };
  }, [stopScheduler]);

  return displayLength;
}
