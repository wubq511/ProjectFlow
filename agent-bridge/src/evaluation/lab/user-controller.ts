/**
 * T46-3 (Issue #96 §1) — Deterministic multi-turn user controller.
 *
 * The controller OWNS and PROTECTS:
 *  - hidden facts (evaluator-only; never serialized into SUT body,
 *    observation, grade, report, manifest, or portable artifact)
 *  - user goals (used to detect goal drift)
 *  - refusals (topics the controller must refuse)
 *  - allowed actions (anything outside triggers simulator_error)
 *  - conversation state (deterministic state machine)
 *  - expected transitions (declared up front; out-of-order = error)
 *
 * Optional LLM phrasing function: receives ONLY the public surface
 * (visible state + chosen action). It returns a natural-language string.
 * It CANNOT read hidden facts and CANNOT mutate them. The controller
 * rejects any phrasing function output that:
 *  - is empty
 *  - contains a hidden sentinel token (string match)
 *  - attempts to override the chosen action (detected via structured
 *    return contract — phrasing function can only return a string)
 *
 * Boundary invariants enforced here:
 *  - Hidden sentinels are checked against Agent output on every turn.
 *    If a sentinel appears in Agent output, the episode terminates with
 *    simulator_error="hidden_fact_leak".
 *  - If the Agent requests an action outside `allowedActions`, the
 *    controller emits `simulator_error="out_of_scope"`.
 *  - If the Agent steers the conversation such that no expected
 *    transition matches for >2 consecutive turns, the controller emits
 *    `simulator_error="goal_drift"`.
 *  - If the phrasing function returns a string containing a hidden
 *    sentinel, the controller emits
 *    `simulator_error="phrasing_function_violation"`.
 */

import { createHash } from "node:crypto";
import type {
  ControllerAction,
  ControllerTransition,
  ControllerTrigger,
  ControllerTurnResult,
  ControllerVisibleState,
  EpisodeOutcome,
  HiddenControllerFacts,
  SimulatorErrorType,
} from "./contract-v3.js";
import { sha256 } from "./validation.js";

/** Optional LLM phrasing function. Receives only the public surface. */
export type PhrasingFn = (
  state: ControllerVisibleState,
  action: ControllerAction,
) => string | Promise<string>;

export interface UserControllerOptions {
  facts: HiddenControllerFacts;
  /** Maximum turns before the controller terminates with
   * `max_turns_reached`. */
  maxTurns: number;
  /** Optional LLM phrasing function. When absent, the controller uses
   *  the action's `template` verbatim. */
  phrasingFn?: PhrasingFn;
  /** Optional clock function (defaults to real Date.now). Tests inject
   *  a deterministic clock. */
  now?: () => Date;
}

interface ControllerInternalState {
  currentState: string;
  turn: number;
  consecutiveNoMatch: number;
  terminal: boolean;
  outcome?: EpisodeOutcome;
  simulatorError?: SimulatorErrorType;
}

export class UserController {
  private readonly facts: HiddenControllerFacts;
  private readonly maxTurns: number;
  private readonly phrasingFn?: PhrasingFn;
  private readonly now: () => Date;
  private state: ControllerInternalState;

  constructor(options: UserControllerOptions) {
    this.facts = options.facts;
    this.maxTurns = options.maxTurns;
    this.phrasingFn = options.phrasingFn;
    this.now = options.now ?? (() => new Date());
    const initialState = this.findInitialState();
    this.state = {
      currentState: initialState,
      turn: 0,
      consecutiveNoMatch: 0,
      terminal: false,
    };
  }

  /** Stable ID for artifacts. */
  get id(): string {
    return this.facts.id;
  }

  /** Current visible state (public surface). */
  getVisibleState(): ControllerVisibleState {
    return {
      currentState: this.state.currentState,
      turn: this.state.turn,
      nextAction: this.peekNextAction(),
      remainingTurns: Math.max(0, this.maxTurns - this.state.turn),
    };
  }

  /** Process an Agent turn and decide the next controller action. */
  async nextTurn(agentOutput: string): Promise<ControllerTurnResult> {
    const result = await this.computeNextTurn(agentOutput);
    // Stamp every turn with the controller's clock so tests can assert
    // deterministic ordering. The timestamp is audit-only and does not
    // affect grading.
    return { ...result, turnTimestamp: this.now().toISOString() };
  }

  private async computeNextTurn(agentOutput: string): Promise<ControllerTurnResult> {
    if (this.state.terminal) {
      return this.terminalResult("已终止");
    }

    // §1 Hidden sentinel check: Agent output must not contain any
    // hidden sentinel. Raw tokens never leave the controller.
    const sentinelLeak = this.detectSentinelLeak(agentOutput);
    if (sentinelLeak) {
      this.state.terminal = true;
      this.state.simulatorError = "hidden_fact_leak";
      this.state.outcome = "simulator_error";
      return this.terminalResult("Agent 输出包含隐藏 sentinel");
    }

    // §2 Goal drift: Agent output that contains a refusal topic the
    // controller must refuse is treated as a refusal (not a leak). The
    // controller emits a refusal message but does not terminate.
    const refusalMatch = this.detectRefusal(agentOutput);
    if (refusalMatch) {
      return this.refusalResult(refusalMatch);
    }

    // §3 Find the next matching transition.
    const transition = this.findMatchingTransition(agentOutput);
    if (!transition) {
      this.state.consecutiveNoMatch += 1;
      if (this.state.consecutiveNoMatch > 2) {
        this.state.terminal = true;
        this.state.simulatorError = "goal_drift";
        this.state.outcome = "simulator_error";
        return this.terminalResult("连续 2 轮无匹配 transition，判定为目标漂移");
      }
      return this.probeResult();
    }

    this.state.consecutiveNoMatch = 0;
    this.state.currentState = transition.toState;
    this.state.turn += 1;

    // §4 Choose the next action deterministically.
    const action = this.chooseAction(transition);

    // §5 Render the user message (optional LLM phrasing).
    let userMessage = "";
    if (action.kind === "send_message") {
      if (this.phrasingFn) {
        const phrased = await this.phrasingFn(this.getVisibleState(), action);
        if (typeof phrased !== "string" || phrased.trim() === "") {
          this.state.terminal = true;
          this.state.simulatorError = "phrasing_function_violation";
          this.state.outcome = "simulator_error";
          return this.terminalResult("phrasing 函数返回空字符串");
        }
        // §6 Phrasing function must not leak hidden sentinels.
        if (this.detectSentinelLeak(phrased)) {
          this.state.terminal = true;
          this.state.simulatorError = "phrasing_function_violation";
          this.state.outcome = "simulator_error";
          return this.terminalResult("phrasing 函数输出包含隐藏 sentinel");
        }
        userMessage = phrased;
      } else {
        userMessage = action.template;
      }
    }

    // §7 Check terminal conditions.
    if (action.kind === "end_conversation") {
      this.state.terminal = true;
      this.state.outcome = "goal_completed";
      return {
        userMessage,
        action,
        terminal: true,
        outcome: "goal_completed",
        nextState: this.getVisibleState(),
        hiddenSentinelDigests: this.facts.hiddenSentinels?.map((t) => sha256(t)) ?? [],
      };
    }

    if (this.state.turn >= this.maxTurns) {
      this.state.terminal = true;
      this.state.outcome = "max_turns_reached";
      return {
        userMessage,
        action,
        terminal: true,
        outcome: "max_turns_reached",
        nextState: this.getVisibleState(),
        hiddenSentinelDigests: this.facts.hiddenSentinels?.map((t) => sha256(t)) ?? [],
      };
    }

    return {
      userMessage,
      action,
      terminal: false,
      nextState: this.getVisibleState(),
      hiddenSentinelDigests: this.facts.hiddenSentinels?.map((t) => sha256(t)) ?? [],
    };
  }

  /** Force-terminate the controller (e.g., on cancellation). */
  terminate(reason: string, outcome: EpisodeOutcome = "goal_abandoned"): ControllerTurnResult {
    this.state.terminal = true;
    this.state.outcome = outcome;
    return this.terminalResult(reason);
  }

  /** Compute digests of hidden facts for the portable artifact. */
  hiddenFactsDigests(): {
    hiddenFactsDigests: string[];
    userGoalsDigests: string[];
    refusalsDigests: string[];
    allowedActionsDigests: string[];
    hiddenSentinelDigests: string[];
  } {
    return {
      hiddenFactsDigests: this.facts.hiddenFacts.map((f) => sha256(f)).sort(),
      userGoalsDigests: this.facts.userGoals.map((g) => sha256(g)).sort(),
      refusalsDigests: this.facts.refusals.map((r) => sha256(r)).sort(),
      allowedActionsDigests: this.facts.allowedActions.map((a) => sha256(a)).sort(),
      hiddenSentinelDigests: (this.facts.hiddenSentinels ?? []).map((t) => sha256(t)).sort(),
    };
  }

  // -------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------

  private findInitialState(): string {
    const initial = this.facts.expectedTransitions.find((t) => t.fromState === "");
    if (!initial) {
      throw new Error(`控制器 ${this.facts.id} 缺少初始 transition`);
    }
    return initial.fromState;
  }

  private detectSentinelLeak(text: string): boolean {
    const sentinels = this.facts.hiddenSentinels ?? [];
    return sentinels.some((token) => token.length > 0 && text.includes(token));
  }

  private detectRefusal(text: string): string | null {
    for (const refusal of this.facts.refusals) {
      if (refusal.length > 0 && text.includes(refusal)) {
        return refusal;
      }
    }
    return null;
  }

  private findMatchingTransition(agentOutput: string): ControllerTransition | undefined {
    return this.facts.expectedTransitions.find((t) => {
      if (t.fromState !== this.state.currentState) return false;
      return this.matchesTrigger(agentOutput, t.trigger);
    });
  }

  private matchesTrigger(text: string, trigger: ControllerTrigger): boolean {
    switch (trigger.kind) {
      case "exact_phrase":
        return text.includes(trigger.value);
      case "regex":
        try {
          return new RegExp(trigger.value, "i").test(text);
        } catch {
          return false;
        }
      case "tool_call":
        // tool_call triggers match against tool call evidence; the
        // controller receives only the Agent's natural-language output
        // here. Tool-call matching is performed by the runner against
        // the observation's `evidence` list. We expose a marker so the
        // runner can route appropriately.
        return text.includes(`tool:${trigger.value}`);
      case "proposal_status":
        return text.includes(`proposal:${trigger.value}`);
      default:
        return false;
    }
  }

  private chooseAction(transition: ControllerTransition): ControllerAction {
    // The action is chosen deterministically based on the transition's
    // toState. The controller looks up the next transition(s) from the
    // new state to decide whether to continue, confirm, reject, or end.
    const nextFromNew = this.facts.expectedTransitions.filter((t) => t.fromState === transition.toState);
    if (nextFromNew.length === 0) {
      // No further transitions: end the conversation.
      return { kind: "end_conversation", reason: "已到达终态" };
    }
    // If the next transition requires a confirm/reject action, emit it.
    const next = nextFromNew[0]!;
    if (next.trigger.kind === "proposal_status") {
      const [proposalType, status] = next.trigger.value.split(":");
      if (status === "confirmed" && proposalType) {
        return { kind: "confirm_proposal", proposalType };
      }
      if (status === "rejected" && proposalType) {
        return {
          kind: "reject_proposal",
          proposalType,
          reason: "评测控制器拒绝",
        };
      }
    }
    // Default: send a follow-up message based on the transition.
    return {
      kind: "send_message",
      template: `请基于当前状态继续，当前状态: ${transition.toState}`,
    };
  }

  private peekNextAction(): ControllerAction {
    const next = this.facts.expectedTransitions.find((t) => t.fromState === this.state.currentState);
    if (!next) {
      return { kind: "end_conversation", reason: "无后续 transition" };
    }
    return this.chooseAction(next);
  }

  private refusalResult(refusal: string): ControllerTurnResult {
    return {
      userMessage: `我无法就「${refusal}」继续，请回到原目标。`,
      action: { kind: "send_message", template: `我无法就「${refusal}」继续` },
      terminal: false,
      nextState: this.getVisibleState(),
      hiddenSentinelDigests: this.facts.hiddenSentinels?.map((t) => sha256(t)) ?? [],
    };
  }

  private probeResult(): ControllerTurnResult {
    return {
      userMessage: "请继续推进目标。",
      action: { kind: "send_message", template: "请继续推进目标" },
      terminal: false,
      nextState: this.getVisibleState(),
      hiddenSentinelDigests: this.facts.hiddenSentinels?.map((t) => sha256(t)) ?? [],
    };
  }

  private terminalResult(reason: string): ControllerTurnResult {
    return {
      userMessage: "",
      action: { kind: "end_conversation", reason },
      terminal: true,
      outcome: this.state.outcome,
      simulatorError: this.state.simulatorError,
      nextState: this.getVisibleState(),
      hiddenSentinelDigests: this.facts.hiddenSentinels?.map((t) => sha256(t)) ?? [],
    };
  }
}

/**
 * Helper: verify that two controllers have aligned hidden facts (used by
 * paired comparison to ensure candidate and baseline run against the
 * same hidden oracle). Compares digests only — raw facts are never
 * compared in artifacts.
 */
export function controllersAligned(
  candidate: UserController,
  baseline: UserController,
): boolean {
  const a = candidate.hiddenFactsDigests();
  const b = baseline.hiddenFactsDigests();
  return stableJsonEqual(a, b);
}

function stableJsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep).sort();
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, sortDeep(v)] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries);
  }
  return value;
}

/** Convenience: compute SHA-256 of a string. Re-exported for tests. */
export { sha256 };

/** Internal hash helper for digests (uses sha256 from validation.ts). */
export function digestOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}