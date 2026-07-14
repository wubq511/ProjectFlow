"use client";

import { useEffect } from "react";

/**
 * Suppress noisy console errors that are not real application bugs.
 *
 * Next.js App Router cancels in-flight React Server Component requests when the
 * user navigates away or when a newer request supersedes an older one. During
 * development, Turbopack also aborts stale chunk loads before applying HMR
 * updates. Browsers surface these intentional cancellations as
 * `net::ERR_ABORTED` errors.
 *
 * These errors are emitted by the browser engine and by Next.js's fetch
 * wrapper; the application itself did not fail. We filter the JS console
 * variants here so they don't drown out real issues.
 *
 * Note: Chromium's native "Failed to load resource: net::ERR_ABORTED" message
 * cannot be suppressed from JavaScript because it comes from the browser's
 * network layer, not from `console.error`. Only the `console.error` variants
 * (with the full URL) are filtered here.
 */
export function ConsoleErrorFilter() {
  useEffect(() => {
    const original = console.error;

    const containsAbortError = (arg: unknown): boolean => {
      if (typeof arg === "string") {
        return arg.includes("net::ERR_ABORTED");
      }
      if (arg instanceof Error || (arg !== null && typeof arg === "object" && "message" in arg)) {
        return String((arg as { message?: unknown }).message).includes("net::ERR_ABORTED");
      }
      return false;
    };

    console.error = (...args: unknown[]) => {
      if (args.some(containsAbortError)) {
        return;
      }
      original.apply(console, args);
    };

    return () => {
      console.error = original;
    };
  }, []);

  return null;
}
