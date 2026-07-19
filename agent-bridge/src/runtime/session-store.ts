/**
 * Session store — runtime session metadata only.
 * NOT for business facts (those live in FastAPI/DB).
 */

import type { AgentRunState } from "@/types/run-state.js";

export class SessionStore {
  private readonly runs = new Map<string, AgentRunState>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly steeringAvailable = new Map<string, boolean>();

  /** Store a run state. */
  set(runId: string, state: AgentRunState): void {
    this.runs.set(runId, state);
  }

  /** Get a run state by ID. */
  get(runId: string): AgentRunState | undefined {
    return this.runs.get(runId);
  }

  /** Check if a run exists. */
  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  /** Remove a run. */
  delete(runId: string): boolean {
    this.abortControllers.delete(runId);
    this.steeringAvailable.delete(runId);
    return this.runs.delete(runId);
  }

  /** Attach a run abort controller without storing it in serializable run state. */
  setAbortController(runId: string, controller: AbortController): void {
    this.abortControllers.set(runId, controller);
  }

  /** Abort an active run with an optional reason string. Returns false when no controller is registered. */
  abort(runId: string, reason?: string): boolean {
    const controller = this.abortControllers.get(runId);
    if (!controller) return false;
    if (reason) {
      controller.abort(reason);
    } else {
      controller.abort();
    }
    return true;
  }

  /** Remove a run's abort controller after the loop terminates. */
  clearAbortController(runId: string): void {
    this.abortControllers.delete(runId);
  }

  /** Mark that a new steering event is available for a run. */
  markSteeringAvailable(runId: string): void {
    this.steeringAvailable.set(runId, true);
  }

  /** Check and clear the steering-available flag. */
  consumeSteeringAvailable(runId: string): boolean {
    const value = this.steeringAvailable.get(runId) ?? false;
    this.steeringAvailable.delete(runId);
    return value;
  }

  /** Observe steering without consuming the flag. Used to suppress a
   * transient aborted model terminal while the loop is about to re-enter. */
  hasSteeringAvailable(runId: string): boolean {
    return this.steeringAvailable.get(runId) ?? false;
  }

  /** Get all active runs. */
  getActiveRuns(): AgentRunState[] {
    return Array.from(this.runs.values()).filter(
      (s) => !["completed", "cancelled", "failed"].includes(s.status),
    );
  }

  /** Get the number of stored runs. */
  get size(): number {
    return this.runs.size;
  }

  /** Clear all runs. */
  clear(): void {
    this.runs.clear();
    this.abortControllers.clear();
  }
}

// Global session store instance (sidecar-internal)
let globalStore: SessionStore | undefined;

export function getSessionStore(): SessionStore {
  if (!globalStore) {
    globalStore = new SessionStore();
  }
  return globalStore;
}
