/**
 * Stream — SSE/WebSocket stream to frontend.
 * Sends runtime events to the frontend as they occur.
 */

import type { RuntimeEvent } from "@/types/runtime-event.js";

export type StreamEventType =
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "agent.started"
  | "agent.status"
  | "run.status"
  | "agent.delta"
  | "agent.completed"
  | "model.streaming"
  | "state.changed"
  | "run.state_changed"
  | "tool.started"
  | "tool.progress"
  | "tool.completed"
  | "tool.failed"
  | "tool.blocked"
  | "proposal.created"
  | "proposal.confirmed"
  | "proposal.rejected"
  | "proposal_confirmation.confirmed"
  | "proposal_confirmation.rejected"
  | "proposal_confirmation.committed"
  | "advisory_record.created"
  | "runtime.error";

export interface StreamMessage {
  event: StreamEventType;
  data: RuntimeEvent;
}

export type StreamListener = (message: StreamMessage) => void;

/**
 * Simple event stream manager.
 * In production, this would use SSE or WebSocket to push events to the frontend.
 */
export class EventStream {
  private readonly listeners = new Set<StreamListener>();

  /** Subscribe to stream events. */
  subscribe(listener: StreamListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Emit an event to all subscribers. */
  emit(event: StreamEventType, data: RuntimeEvent): void {
    const message: StreamMessage = { event, data };
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (err) {
        console.error("[stream] listener error:", err);
      }
    }
  }

  /** Get the number of active subscribers. */
  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Remove all subscribers. */
  clear(): void {
    this.listeners.clear();
  }
}
