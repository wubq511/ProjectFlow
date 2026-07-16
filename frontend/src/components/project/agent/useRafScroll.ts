"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * rAF-coalesced near-bottom scroll helper.
 *
 * Batches multiple scroll-to-bottom requests within the same animation frame
 * into a single DOM scroll operation. Avoids layout thrash from per-character
 * scroll writes during streaming.
 *
 * Usage:
 *   const { scrollToBottom, isNearBottom } = useRafScroll(scrollContainerRef);
 *
 * - Call `scrollToBottom()` from onRevealProgress, activity updates, etc.
 *   Multiple calls per frame are coalesced into one scroll.
 * - Read `isNearBottom()` to decide whether to auto-scroll.
 * - User scrolling up automatically stops auto-scroll (via isNearBottom check).
 * - During streaming, uses instant scroll (no smooth).
 */
export function useRafScroll(
  containerRef: React.RefObject<HTMLDivElement | null>,
  /** Threshold in pixels to consider "near bottom". Default 150. */
  threshold = 150,
) {
  const rafIdRef = useRef<number | null>(null);
  const isNearBottomRef = useRef(true);

  // Cancel pending rAF on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, []);

  /**
   * Track scroll position to determine if user is near bottom.
   * Call this from the container's onScroll handler.
   */
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    isNearBottomRef.current = nearBottom;
  }, [containerRef, threshold]);

  /**
   * Coalesced scroll-to-bottom. Multiple calls within the same frame
   * result in a single DOM write. Uses instant scroll (no smooth).
   */
  const scrollToBottom = useCallback(() => {
    if (!isNearBottomRef.current) return;
    if (rafIdRef.current != null) return; // Already scheduled this frame
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      const el = containerRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    });
  }, [containerRef]);

  /**
   * Force scroll to bottom (e.g., on conversation switch or explicit user action).
   * Ignores isNearBottom state. Uses instant scroll.
   */
  const forceScrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [containerRef]);

  return {
    /** Coalesced scroll-to-bottom (respects near-bottom state). */
    scrollToBottom,
    /** Force scroll to bottom (ignores near-bottom state). */
    forceScrollToBottom,
    /** Track scroll position — attach to container's onScroll. */
    handleScroll,
    /** Read current near-bottom state. */
    isNearBottom: () => isNearBottomRef.current,
  };
}
