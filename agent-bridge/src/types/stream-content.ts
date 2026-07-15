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

export type BaseActivity = {
  id: string;
  sequence: number;
  created_at: string;
};

export type ProgressActivity = BaseActivity & {
  kind: "progress";
  content: string;
  phase?: "planning" | "exploring" | "executing" | "verifying" | "summarizing";
};

export type SkillActivity = BaseActivity & {
  kind: "skill";
  skill_name: string;
  status: "loading" | "loaded" | "failed" | "blocked";
  label: string;
  completed_label?: string;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
};

export type ToolActivity = BaseActivity & {
  kind: "tool";
  tool_call_id: string;
  tool_name: string;
  status: "running" | "completed" | "failed" | "blocked";
  label: string;
  completed_label?: string;
  summary?: string;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
};

export type ApprovalActivity = BaseActivity & {
  kind: "approval";
  status: "waiting" | "approved" | "rejected";
  label: string;
};

export type SteeringActivity = BaseActivity & {
  kind: "steering";
  content: string;
  status: "accepted" | "queued" | "applied";
};

export type RunActivityItem =
  | ProgressActivity
  | SkillActivity
  | ToolActivity
  | ApprovalActivity
  | SteeringActivity;

export type StreamRunEvent =
  | { event: "process_started"; stream_sequence: number; started_at: string }
  | { event: "process_delta"; stream_sequence: number; activity_id: string; content: string }
  | { event: "activity"; stream_sequence: number; data: RunActivityItem }
  | { event: "process_completed"; stream_sequence: number; completed_at: string; processing_duration_ms: number }
  | { event: "answer_started"; stream_sequence: number; started_at: string }
  | { event: "answer_delta"; stream_sequence: number; content: string }
  | { event: "run_completed"; stream_sequence: number; completed_at: string }
  | { event: "status"; data: any }
  | { event: "error"; data: any }
  | { event: "disconnect"; data: any };

