"use client";

import { useEffect, useRef, useState, useCallback } from "react";

// ---------------------------------------------------------------------------
// Stable display scheduler constants (shared by StreamingText & process progress)
// ---------------------------------------------------------------------------

/** Base reveal rate: ~110 characters per second. */
export const BASE_CHARS_PER_SECOND = 110;
/** Maximum catch-up multiplier when backlog builds (3x base ≈ 330 chars/sec). */
export const MAX_BACKLOG_MULTIPLIER = 3;
/** Scheduler tick interval: ~50ms → ~20fps. */
export const TICK_INTERVAL_MS = 50;
/** Throttle interval for onRevealProgress callbacks. */
export const REVEAL_CALLBACK_THROTTLE_MS = 80;

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
 * Stable character reveal hook — shared scheduler for progressive text display.
 *
 * Behavior:
 * - 50ms tick (~20fps)
 * - Base 110 chars/s, adaptive backlog max 330 chars/s
 * - displayLength is monotonically non-decreasing
 * - Buffer growth does not reset display length
 * - When streaming ends and display catches up, scheduler stops
 * - Reduced-motion: immediately shows full buffer
 * - onRevealProgress is throttled at 80ms intervals
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
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTickTimeRef = useRef(0);
  const lastCallbackTimeRef = useRef(0);
  const lastReportedLengthRef = useRef(0);

  // Keep refs in sync (in effect to satisfy react-hooks/refs rule).
  // The 50ms tick interval means a one-render-cycle delay is imperceptible.
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
    const handler = (e: MediaQueryListEvent) => { reducedMotionRef.current = e.matches; };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  const stopScheduler = useCallback(() => {
    if (tickTimerRef.current != null) {
      clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
  }, []);

  // tick body — reads all state from refs, never stale
  const runTick = useCallback(() => {
    const currentBuffer = bufferRef.current;
    const currentDisplay = displayLengthRef.current;

    if (currentDisplay >= currentBuffer.length) {
      if (!isStreamingRef.current) {
        stopScheduler();
      }
      return;
    }

    const now = Date.now();
    const elapsed = lastTickTimeRef.current > 0 ? now - lastTickTimeRef.current : TICK_INTERVAL_MS;
    lastTickTimeRef.current = now;

    const baseChars = Math.max(1, Math.floor((elapsed / 1000) * BASE_CHARS_PER_SECOND));
    const backlog = currentBuffer.length - currentDisplay;
    const backlogThreshold = BASE_CHARS_PER_SECOND;

    let multiplier = 1;
    if (backlog > backlogThreshold * 2) {
      multiplier = MAX_BACKLOG_MULTIPLIER;
    } else if (backlog > backlogThreshold) {
      multiplier = 1 + (backlog - backlogThreshold) / backlogThreshold * (MAX_BACKLOG_MULTIPLIER - 1);
    }

    const charsToReveal = Math.min(Math.ceil(baseChars * multiplier), backlog);
    if (charsToReveal <= 0) return;

    const newLength = currentDisplay + charsToReveal;
    displayLengthRef.current = newLength;
    setDisplayLength(newLength);

    const callbackNow = Date.now();
    if (newLength > lastReportedLengthRef.current && callbackNow - lastCallbackTimeRef.current >= REVEAL_CALLBACK_THROTTLE_MS) {
      lastCallbackTimeRef.current = callbackNow;
      lastReportedLengthRef.current = newLength;
      onRevealProgressRef.current?.();
    }

    if (newLength >= currentBuffer.length) {
      if (lastReportedLengthRef.current < currentBuffer.length) {
        lastReportedLengthRef.current = currentBuffer.length;
        onRevealProgressRef.current?.();
      }
      if (!isStreamingRef.current) {
        stopScheduler();
      }
    }
  }, [stopScheduler]);

  const startScheduler = useCallback(() => {
    if (tickTimerRef.current != null) return;
    lastTickTimeRef.current = Date.now();
    tickTimerRef.current = setInterval(runTick, TICK_INTERVAL_MS);
  }, [runTick]);

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
