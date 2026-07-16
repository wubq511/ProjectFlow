"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import { MarkdownContent } from "./MarkdownContent";

/** Reveal rate: ~600 characters per second. */
const CHARS_PER_SECOND = 600;
/** Throttle interval for onRevealProgress callbacks (ms). */
const REVEAL_CALLBACK_THROTTLE_MS = 80;

interface StreamingTextProps {
  buffer: string;
  className?: string;
  isStreaming?: boolean;
  /**
   * Called (throttled) when the visible text length grows during RAF reveal.
   * Parents use this to auto-scroll while the user hasn't scrolled away.
   */
  onRevealProgress?: () => void;
}

export const StreamingText = React.memo(function StreamingText({ buffer, className, isStreaming = true, onRevealProgress }: StreamingTextProps) {
  const [displayLength, setDisplayLength] = useState(0);
  const revealStartRef = useRef<number>(0);
  const baseLengthRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);
  const reducedMotionRef = useRef(false);
  const lastCallbackTimeRef = useRef<number>(0);
  const onRevealProgressRef = useRef(onRevealProgress);
  onRevealProgressRef.current = onRevealProgress;

  // Detect prefers-reduced-motion once
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = mql.matches;
    const handler = (e: MediaQueryListEvent) => { reducedMotionRef.current = e.matches; };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  const lastReportedLengthRef = useRef<number>(0);

  const animate = useCallback(() => {
    if (reducedMotionRef.current) {
      setDisplayLength(buffer.length);
      onRevealProgressRef.current?.();
      return;
    }
    const elapsed = Date.now() - revealStartRef.current;
    const targetLength = Math.min(
      buffer.length,
      baseLengthRef.current + Math.floor((elapsed / 1000) * CHARS_PER_SECOND),
    );
    setDisplayLength((prev) => {
      if (targetLength >= buffer.length) return buffer.length;
      return Math.max(prev, targetLength);
    });
    // Throttled callback when visible length grows
    const now = Date.now();
    if (targetLength > lastReportedLengthRef.current && now - lastCallbackTimeRef.current >= REVEAL_CALLBACK_THROTTLE_MS) {
      lastCallbackTimeRef.current = now;
      lastReportedLengthRef.current = targetLength;
      onRevealProgressRef.current?.();
    }
    if (targetLength < buffer.length) {
      rafRef.current = requestAnimationFrame(animate);
    } else {
      // Final frame: ensure parent scrolls to the very end
      if (lastReportedLengthRef.current < buffer.length) {
        lastReportedLengthRef.current = buffer.length;
        onRevealProgressRef.current?.();
      }
    }
  }, [buffer.length]);

  // When buffer grows or isStreaming changes, start/resume RAF reveal
  useEffect(() => {
    if (reducedMotionRef.current) {
      setDisplayLength(buffer.length);
      onRevealProgressRef.current?.();
      return;
    }
    // Start from current display position (no regression)
    baseLengthRef.current = displayLength;
    revealStartRef.current = Date.now();
    lastReportedLengthRef.current = displayLength;

    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffer, isStreaming]);

  // Cursor visible while actively streaming and display hasn't caught up
  const showCursor = isStreaming || displayLength < buffer.length;
  const displayText = buffer.slice(0, displayLength);

  if (!displayText && !isStreaming) return null;

  return (
    <div className={className}>
      <MarkdownContent content={displayText || " "} />
      {showCursor && (
        <span
          className="ml-0.5 inline-block h-3.5 w-px bg-moss animate-pulse"
          aria-hidden="true"
        />
      )}
    </div>
  );
});
