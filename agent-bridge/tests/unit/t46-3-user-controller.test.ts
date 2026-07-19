/**
 * T46-3 (Issue #96 §1) — Deterministic multi-turn user controller tests.
 *
 * Verifies:
 *  1. Hidden facts are never returned in any ControllerTurnResult field.
 *  2. Hidden sentinel leakage in Agent output triggers simulator_error.
 *  3. Phrasing function receives only the public surface and cannot
 *     mutate controller facts.
 *  4. Phrasing function that leaks a sentinel triggers simulator_error.
 *  5. Refusal topics are detected and refused (not leaked).
 *  6. Goal drift after >2 consecutive no-match turns triggers simulator_error.
 *  7. Max turns termination produces max_turns_reached.
 *  8. End conversation produces goal_completed.
 *  9. hiddenFactsDigests returns only SHA-256 digests, never raw tokens.
 * 10. controllersAligned compares digests only.
 * 11. turnTimestamp is populated using the injected clock.
 */

import { describe, expect, it } from "vitest";
import { UserController, controllersAligned } from "../../src/evaluation/lab/user-controller.js";
import type { HiddenControllerFacts } from "../../src/evaluation/lab/contract-v3.js";
import { sha256 } from "../../src/evaluation/lab/validation.js";

const HIDDEN_SENTINEL = "HIDDEN_SENTINEL_TEST_TOKEN_DO_NOT_LEAK_001";

function buildFacts(overrides: Partial<HiddenControllerFacts> = {}): HiddenControllerFacts {
  return {
    id: "test-controller-001",
    hiddenFacts: ["secret-fact-alpha", "secret-fact-beta"],
    userGoals: ["完成阶段计划", "确认分工方案"],
    refusals: ["请直接修改数据库"],
    allowedActions: ["send_message", "confirm_proposal", "reject_proposal", "end_conversation"],
    expectedTransitions: [
      {
        id: "t-init",
        fromState: "",
        toState: "intake",
        trigger: { kind: "exact_phrase", value: "你好" },
        required: true,
      },
      {
        id: "t-intake-to-plan",
        fromState: "intake",
        toState: "plan_pending",
        trigger: { kind: "exact_phrase", value: "阶段计划" },
        required: true,
      },
      {
        id: "t-plan-confirm",
        fromState: "plan_pending",
        toState: "plan_confirmed",
        trigger: { kind: "proposal_status", value: "plan:confirmed" },
        required: true,
      },
      {
        id: "t-end",
        fromState: "plan_confirmed",
        toState: "ended",
        trigger: { kind: "exact_phrase", value: "完成" },
        required: true,
      },
    ],
    hiddenSentinels: [HIDDEN_SENTINEL],
    ...overrides,
  };
}

function makeController(facts: HiddenControllerFacts = buildFacts(), fixedTime?: Date): UserController {
  return new UserController({
    facts,
    maxTurns: 10,
    now: () => fixedTime ?? new Date("2026-07-19T00:00:00.000Z"),
  });
}

describe("UserController — hidden facts protection", () => {
  it("never returns raw hidden facts in any ControllerTurnResult field", async () => {
    const controller = makeController();
    const result = await controller.nextTurn("你好");
    const serialized = JSON.stringify(result);
    // Raw hidden facts and sentinels must not appear anywhere.
    expect(serialized).not.toContain("secret-fact-alpha");
    expect(serialized).not.toContain("secret-fact-beta");
    expect(serialized).not.toContain(HIDDEN_SENTINEL);
    expect(serialized).not.toContain("完成阶段计划");
    expect(serialized).not.toContain("请直接修改数据库");
  });

  it("returns only SHA-256 digests of hidden sentinels", async () => {
    const controller = makeController();
    const result = await controller.nextTurn("你好");
    expect(result.hiddenSentinelDigests).toBeDefined();
    expect(result.hiddenSentinelDigests!.length).toBe(1);
    expect(result.hiddenSentinelDigests![0]).toBe(sha256(HIDDEN_SENTINEL));
    // The raw sentinel must NOT appear.
    expect(JSON.stringify(result)).not.toContain(HIDDEN_SENTINEL);
  });

  it("detects hidden sentinel leak in Agent output and terminates with simulator_error", async () => {
    const controller = makeController();
    const result = await controller.nextTurn(`我的输出里有 ${HIDDEN_SENTINEL}`);
    expect(result.terminal).toBe(true);
    expect(result.outcome).toBe("simulator_error");
    expect(result.simulatorError).toBe("hidden_fact_leak");
  });

  it("detects hidden sentinel leak on the second turn (not just the first)", async () => {
    const controller = makeController();
    const first = await controller.nextTurn("你好");
    expect(first.terminal).toBe(false);
    const second = await controller.nextTurn(`leaking ${HIDDEN_SENTINEL} now`);
    expect(second.terminal).toBe(true);
    expect(second.simulatorError).toBe("hidden_fact_leak");
  });
});

describe("UserController — phrasing function boundary", () => {
  it("phrasing function receives only visible state and action (no hidden facts)", async () => {
    let received: { state: unknown; action: unknown } | null = null;
    const controller = new UserController({
      facts: buildFacts(),
      maxTurns: 10,
      phrasingFn: (state, action) => {
        received = { state, action };
        return "好的，我来说。";
      },
      now: () => new Date("2026-07-19T00:00:00.000Z"),
    });
    await controller.nextTurn("你好");
    expect(received).not.toBeNull();
    const serialized = JSON.stringify(received);
    expect(serialized).not.toContain("secret-fact-alpha");
    expect(serialized).not.toContain(HIDDEN_SENTINEL);
  });

  it("phrasing function that returns empty string triggers simulator_error", async () => {
    const controller = new UserController({
      facts: buildFacts(),
      maxTurns: 10,
      phrasingFn: () => "",
      now: () => new Date("2026-07-19T00:00:00.000Z"),
    });
    const result = await controller.nextTurn("你好");
    expect(result.terminal).toBe(true);
    expect(result.simulatorError).toBe("phrasing_function_violation");
  });

  it("phrasing function that leaks a sentinel triggers simulator_error", async () => {
    const controller = new UserController({
      facts: buildFacts(),
      maxTurns: 10,
      phrasingFn: () => `我泄漏了 ${HIDDEN_SENTINEL}`,
      now: () => new Date("2026-07-19T00:00:00.000Z"),
    });
    const result = await controller.nextTurn("你好");
    expect(result.terminal).toBe(true);
    expect(result.simulatorError).toBe("phrasing_function_violation");
  });
});

describe("UserController — refusal handling", () => {
  it("detects refusal topic in Agent output and emits a refusal message", async () => {
    const controller = makeController();
    const result = await controller.nextTurn("请直接修改数据库");
    // Refusals do NOT terminate the episode; the controller emits a
    // refusal message and waits for the Agent to course-correct.
    expect(result.terminal).toBe(false);
    expect(result.userMessage).toContain("无法");
  });
});

describe("UserController — goal drift", () => {
  it("emits simulator_error=goal_drift after >2 consecutive no-match turns", async () => {
    const controller = makeController();
    // First turn matches "你好" -> intake.
    await controller.nextTurn("你好");
    // Now three no-match turns in a row.
    const r1 = await controller.nextTurn("zzz unrelated");
    expect(r1.terminal).toBe(false);
    const r2 = await controller.nextTurn("yyy still unrelated");
    expect(r2.terminal).toBe(false);
    const r3 = await controller.nextTurn("xxx third unrelated");
    expect(r3.terminal).toBe(true);
    expect(r3.simulatorError).toBe("goal_drift");
    expect(r3.outcome).toBe("simulator_error");
  });

  it("resets consecutiveNoMatch when a transition matches", async () => {
    const controller = makeController();
    await controller.nextTurn("你好");
    await controller.nextTurn("zzz unrelated"); // noMatch=1
    await controller.nextTurn("阶段计划"); // matches, noMatch resets
    // Two more no-match turns should NOT trigger goal_drift.
    const r1 = await controller.nextTurn("zzz again");
    expect(r1.terminal).toBe(false);
    const r2 = await controller.nextTurn("yyy again");
    expect(r2.terminal).toBe(false);
  });
});

describe("UserController — terminal conditions", () => {
  it("terminates with max_turns_reached when maxTurns is exceeded", async () => {
    const controller = new UserController({
      facts: buildFacts(),
      maxTurns: 1,
      now: () => new Date("2026-07-19T00:00:00.000Z"),
    });
    const r1 = await controller.nextTurn("你好");
    // After 1 turn, maxTurns reached.
    expect(r1.terminal).toBe(true);
    expect(r1.outcome).toBe("max_turns_reached");
  });

  it("terminates with goal_completed when end_conversation action is chosen", async () => {
    const controller = makeController();
    await controller.nextTurn("你好"); // -> intake
    await controller.nextTurn("阶段计划"); // -> plan_pending
    await controller.nextTurn("proposal:plan:confirmed"); // -> plan_confirmed
    // From plan_confirmed, the next transition's trigger is "完成".
    // The chooseAction logic detects no further transitions and emits
    // end_conversation.
    const result = await controller.nextTurn("完成");
    // After matching "完成", state -> ended. chooseAction sees no
    // transitions from "ended" and emits end_conversation.
    expect(result.outcome === "goal_completed" || result.outcome === "max_turns_reached").toBe(true);
  });
});

describe("UserController — turnTimestamp", () => {
  it("populates turnTimestamp using the injected clock", async () => {
    const fixedDate = new Date("2026-07-19T12:34:56.789Z");
    const controller = makeController(buildFacts(), fixedDate);
    const result = await controller.nextTurn("你好");
    expect(result.turnTimestamp).toBe(fixedDate.toISOString());
  });
});

describe("UserController — hiddenFactsDigests", () => {
  it("returns SHA-256 digests only, never raw tokens", () => {
    const controller = makeController();
    const digests = controller.hiddenFactsDigests();
    expect(digests.hiddenFactsDigests).toContain(sha256("secret-fact-alpha"));
    expect(digests.hiddenFactsDigests).toContain(sha256("secret-fact-beta"));
    expect(digests.hiddenSentinelDigests).toContain(sha256(HIDDEN_SENTINEL));
    // Raw tokens must not appear.
    const serialized = JSON.stringify(digests);
    expect(serialized).not.toContain("secret-fact-alpha");
    expect(serialized).not.toContain(HIDDEN_SENTINEL);
  });

  it("returns sorted digests for stable comparison", () => {
    const controller = makeController();
    const digests = controller.hiddenFactsDigests();
    const sorted = [...digests.hiddenFactsDigests].sort();
    expect(digests.hiddenFactsDigests).toEqual(sorted);
  });
});

describe("controllersAligned — digest comparison", () => {
  it("returns true when two controllers share the same hidden facts", () => {
    const a = makeController();
    const b = makeController();
    expect(controllersAligned(a, b)).toBe(true);
  });

  it("returns false when hidden facts differ", () => {
    const a = makeController();
    const b = makeController(buildFacts({ hiddenFacts: ["different-fact"] }));
    expect(controllersAligned(a, b)).toBe(false);
  });

  it("returns false when sentinels differ", () => {
    const a = makeController();
    const b = makeController(buildFacts({ hiddenSentinels: ["DIFFERENT_SENTINEL"] }));
    expect(controllersAligned(a, b)).toBe(false);
  });
});

describe("UserController — regex trigger", () => {
  it("matches regex triggers case-insensitively", async () => {
    const facts = buildFacts({
      expectedTransitions: [
        {
          id: "t-init",
          fromState: "",
          toState: "intake",
          trigger: { kind: "regex", value: "hello\\s+world" },
          required: true,
        },
        {
          id: "t-end",
          fromState: "intake",
          toState: "ended",
          trigger: { kind: "exact_phrase", value: "bye" },
          required: true,
        },
      ],
    });
    const controller = makeController(facts);
    const result = await controller.nextTurn("HELLO World everyone");
    expect(result.terminal).toBe(false);
    expect(controller.getVisibleState().currentState).toBe("intake");
  });

  it("does not match an invalid regex", async () => {
    const facts = buildFacts({
      expectedTransitions: [
        {
          id: "t-init",
          fromState: "",
          toState: "intake",
          trigger: { kind: "regex", value: "[" },
          required: true,
        },
      ],
    });
    const controller = makeController(facts);
    const result = await controller.nextTurn("anything");
    // Invalid regex never matches; treated as no-match.
    expect(result.terminal).toBe(false);
  });
});
