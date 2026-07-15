import { useCallback, useEffect, useRef } from "react";

/**
 * Returns a stable debounced wrapper around `callback`.
 *
 * - Each call resets the timer, so only the last call within `delayMs` executes.
 * - The returned function identity is stable across renders (it only depends on `delayMs`).
 * - Pending timers are cleared when the component unmounts.
 */
export function useDebouncedCallback<Args extends unknown[], Return>(
  callback: (...args: Args) => Return,
  delayMs: number,
): (...args: Args) => void {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return useCallback(
    (...args: Args) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        callbackRef.current(...args);
      }, delayMs);
    },
    [delayMs],
  );
}
