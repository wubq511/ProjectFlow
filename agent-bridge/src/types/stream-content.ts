/**
 * StreamContentEvent — typed streaming contract for Agent conversation output.
 *
 * Replaces the old untyped `token { content: string }` SSE event.
 * Preserves text/thinking channel, start/delta/end lifecycle, contentIndex,
 * and message_seq from the Pi runtime, enabling the frontend to distinguish
 * thinking from answer during streaming (not just after completion).
 *
 * `message_seq` disambiguates contentIndex across assistant messages:
 * Pi runtime scopes contentIndex per assistant message, so after a tool call
 * a new message may restart contentIndex from 0. The composite key
 * `${message_seq}:${content_index}` uniquely identifies a block across the run.
 *
 * Events are sent as SSE `content` events from sidecar → backend → frontend.
 */
export type StreamContentEvent =
  | { kind: "thinking"; phase: "start"; content_index: number; message_seq: number }
  | { kind: "thinking"; phase: "delta"; content_index: number; message_seq: number; content: string }
  | { kind: "thinking"; phase: "end"; content_index: number; message_seq: number }
  | { kind: "text"; phase: "start"; content_index: number; message_seq: number }
  | { kind: "text"; phase: "delta"; content_index: number; message_seq: number; content: string }
  | { kind: "text"; phase: "end"; content_index: number; message_seq: number };

/** Type guard for StreamContentEvent */
export function isStreamContentEvent(value: unknown): value is StreamContentEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.kind !== "thinking" && v.kind !== "text") return false;
  if (v.phase !== "start" && v.phase !== "delta" && v.phase !== "end") return false;
  if (typeof v.content_index !== "number") return false;
  if (typeof v.message_seq !== "number") return false;
  if (v.phase === "delta" && typeof v.content !== "string") return false;
  return true;
}
