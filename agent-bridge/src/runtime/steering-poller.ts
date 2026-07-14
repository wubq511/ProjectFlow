/**
 * SteeringPoller — lightweight snapshot poller for mid-stream steering.
 *
 * During LLM streaming, the poller periodically checks the durable snapshot
 * for unconsumed steering events. When new steering is found, it marks the
 * run in the session store and aborts the active stream so pi-runtime can
 * re-enter the model loop with updated context.
 */

import type { FastapiClient } from "@/tools/fastapi-client.js";
import type { SessionStore } from "./session-store.js";

interface SteeringPollerDeps {
  runId: string;
  fastapiClient: FastapiClient;
  sessionStore: SessionStore;
  logger?: { warn: (msg: string, meta?: unknown) => void; info?: (msg: string, meta?: unknown) => void };
  /** Polling interval in milliseconds. */
  intervalMs?: number;
  /** Snapshot fetch timeout in milliseconds. */
  timeoutMs?: number;
  /** Maximum consecutive failures before giving up. */
  maxFailures?: number;
}

interface SteeringEventSnapshot {
  steering_seq: number;
  steering_type: string;
  content: string;
  client_message_id?: string;
  metadata?: Record<string, unknown>;
}

export class SteeringPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private failures = 0;
  private readonly maxFailures: number;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private consumedSeqs = new Set<number>();

  constructor(private readonly deps: SteeringPollerDeps) {
    this.intervalMs = deps.intervalMs ?? 1500;
    this.timeoutMs = deps.timeoutMs ?? 3000;
    this.maxFailures = deps.maxFailures ?? 3;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  markConsumed(seqs: number[]): void {
    for (const seq of seqs) this.consumedSeqs.add(seq);
  }

  private async tick(): Promise<void> {
    if (this.failures >= this.maxFailures) {
      this.deps.logger?.warn(
        `SteeringPoller stopping for ${this.deps.runId} after ${this.maxFailures} failures`,
      );
      this.stop();
      return;
    }

    try {
      const snapshot = await this.deps.fastapiClient.getRunSnapshot(
        this.deps.runId,
        undefined,
        this.timeoutMs,
      );
      const steering = (snapshot.unconsumed_steering ?? []) as SteeringEventSnapshot[];
      const newSteering = steering.filter((s) => !this.consumedSeqs.has(s.steering_seq));
      const hasCancel = newSteering.some((s) => s.steering_type === "cancel");

      if (hasCancel || newSteering.length > 0) {
        this.deps.logger?.info?.(
          `SteeringPoller detected ${newSteering.length} new steering event(s) for ${this.deps.runId}`,
        );
        this.deps.sessionStore.markSteeringAvailable(this.deps.runId);
        this.deps.sessionStore.abort(this.deps.runId, "steering_available");
      }
      this.failures = 0;
    } catch (err) {
      this.failures++;
      this.deps.logger?.warn(`SteeringPoller tick failed for ${this.deps.runId}`, { err });
    }
  }
}
