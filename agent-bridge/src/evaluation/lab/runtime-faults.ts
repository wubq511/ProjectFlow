/**
 * T46-3 (Issue #96 §4) — Runtime reliability scenarios.
 *
 * 11 deterministic fault injection classes:
 *  - timeout
 *  - infrastructure_retry
 *  - agent_internal_retry
 *  - invalid_tool_arguments
 *  - partial_tool_results
 *  - cancellation
 *  - checkpoint_resume
 *  - steering
 *  - idempotency
 *  - duplicate_terminal_event
 *  - contradictory_terminal_event
 *
 * The runner uses deterministic fault injection seams — NOT random line
 * failures. Each fault class declares how the runner must inject the
 * fault and what the Agent must do to recover.
 *
 * Boundary invariants enforced here:
 *  - The same AgentRun MUST NOT be judged both completed and failed.
 *  - Recovery, retry, or subsequent success CANNOT delete, overwrite,
 *    or rewrite prior failure evidence (the attempt ledger is
 *    append-only; see `attempt-ledger.ts`).
 *  - Cancellation MUST NOT be persisted as completed. The terminal
 *    event consistency grader fails closed when a cancelled run is
 *    later marked completed.
 *  - Checkpoint/resume MUST NOT duplicate side effects. The idempotency
 *    grader fails closed when resume produces new side effects.
 */

import type {
  FaultExpectation,
  FaultInjectionSeam,
  RuntimeFaultClass,
  RuntimeFaultInjection,
  RuntimeReliabilityResult,
} from "./contract-v3.js";
import type { OperationalMetrics } from "./contract-v3.js";

/** Built-in deterministic fault catalog. These are reference scenarios
 *  that the runner can use to construct reliability scenarios. */
export const RUNTIME_FAULT_CATALOG: RuntimeFaultInjection[] = [
  {
    faultId: "fault-timeout",
    faultClass: "timeout",
    description: "Agent 在 maxLatencyMs 内未完成；评测记录 timeout，attempt 标记 failed_infrastructure",
    seam: { kind: "sse_event_delay", eventPattern: "*", delayMs: 60_000 },
    expectation: {
      finalStatus: "failed",
    },
  },
  {
    faultId: "fault-infra-retry",
    faultClass: "infrastructure_retry",
    description: "后端短暂不可用；sidecar 在 frozen retry budget 内自动重试",
    seam: { kind: "sse_event_drop", eventPattern: "status" },
    expectation: {
      finalStatus: "completed",
      requiresInfrastructureRetry: true,
    },
  },
  {
    faultId: "fault-agent-retry",
    faultClass: "agent_internal_retry",
    description: "工具调用返回错误；Agent 内部重试并恢复",
    seam: { kind: "tool_call_invalid_args", toolName: "get_workspace_state" },
    expectation: {
      finalStatus: "completed",
      requiresAgentRetry: true,
    },
  },
  {
    faultId: "fault-invalid-args",
    faultClass: "invalid_tool_arguments",
    description: "Agent 发出无效工具参数；工具返回错误，Agent 必须修正",
    seam: { kind: "tool_call_invalid_args", toolName: "get_workspace_state" },
    expectation: {
      finalStatus: "completed",
      requiresAgentRetry: true,
    },
  },
  {
    faultId: "fault-partial-results",
    faultClass: "partial_tool_results",
    description: "工具返回部分结果；Agent 必须显式处理缺失字段",
    seam: { kind: "tool_call_partial_result", toolName: "get_workspace_state" },
    expectation: {
      finalStatus: "completed",
      requiresAgentRetry: true,
    },
  },
  {
    faultId: "fault-cancellation",
    faultClass: "cancellation",
    description: "用户取消运行；Agent 必须以 cancelled 终止，不得标记 completed",
    seam: { kind: "cancel_signal", afterMs: 5_000 },
    expectation: {
      finalStatus: "failed",
      requiresNoSideEffects: true,
    },
  },
  {
    faultId: "fault-checkpoint-resume",
    faultClass: "checkpoint_resume",
    description: "Agent 在事件后崩溃；resume 必须不重复副作用",
    seam: { kind: "checkpoint_after_event", eventPattern: "tool.completed" },
    expectation: {
      finalStatus: "completed",
      requiresIdempotency: true,
    },
  },
  {
    faultId: "fault-steering",
    faultClass: "steering",
    description: "用户在运行中追加 steering 消息；Agent 必须以新输入继续，不重复已完成的副作用",
    seam: { kind: "steering_message", afterMs: 3_000, message: "请额外考虑风险" },
    expectation: {
      finalStatus: "completed",
      requiresIdempotency: true,
    },
  },
  {
    faultId: "fault-idempotency",
    faultClass: "idempotency",
    description: "Agent 被重复调用；每次重复必须不产生新副作用",
    seam: { kind: "force_idempotency_repeat", repeats: 2 },
    expectation: {
      finalStatus: "completed",
      requiresIdempotency: true,
    },
  },
  {
    faultId: "fault-duplicate-terminal",
    faultClass: "duplicate_terminal_event",
    description: "运行发出两次 run.completed；grader 必须 fail-closed",
    seam: { kind: "sse_duplicate_terminal", terminalEvent: "run.completed" },
    expectation: {
      finalStatus: "failed",
      requiresDuplicateTerminalDetection: true,
    },
  },
  {
    faultId: "fault-contradictory-terminal",
    faultClass: "contradictory_terminal_event",
    description: "运行先发 run.completed 再发 run.failed；grader 必须 fail-closed",
    seam: { kind: "sse_contradictory_terminal", first: "run.completed", second: "run.failed" },
    expectation: {
      finalStatus: "failed",
      requiresContradictoryTerminalDetection: true,
    },
  },
];

/** Look up a fault by ID. */
export function findFault(faultId: string): RuntimeFaultInjection | undefined {
  return RUNTIME_FAULT_CATALOG.find((f) => f.faultId === faultId);
}

/** Look up all faults of a given class. */
export function faultsOfClass(faultClass: RuntimeFaultClass): RuntimeFaultInjection[] {
  return RUNTIME_FAULT_CATALOG.filter((f) => f.faultClass === faultClass);
}

/** Verify that all 11 fault classes are represented in the catalog. */
export function verifyFaultCatalogCompleteness(): {
  complete: boolean;
  missing: RuntimeFaultClass[];
} {
  const allClasses: RuntimeFaultClass[] = [
    "timeout",
    "infrastructure_retry",
    "agent_internal_retry",
    "invalid_tool_arguments",
    "partial_tool_results",
    "cancellation",
    "checkpoint_resume",
    "steering",
    "idempotency",
    "duplicate_terminal_event",
    "contradictory_terminal_event",
  ];
  const present = new Set(RUNTIME_FAULT_CATALOG.map((f) => f.faultClass));
  const missing = allClasses.filter((c) => !present.has(c));
  return { complete: missing.length === 0, missing };
}

/**
 * Evaluate whether an Agent's behavior under a fault met the declared
 * expectation. Pure function; uses the observation and snapshot to
 * verify the Agent's terminal status, side effects, and trajectory.
 */
export function evaluateFaultBehavior(input: {
  fault: RuntimeFaultInjection;
  finalStatus: "completed" | "failed" | "blocked";
  sideEffectCount: number;
  hadDuplicateTerminal: boolean;
  hadContradictoryTerminal: boolean;
  idempotencyPreserved: boolean;
  agentRetriesObserved: number;
  infrastructureRetriesObserved: number;
  metrics: OperationalMetrics;
}): RuntimeReliabilityResult {
  const { fault, finalStatus, sideEffectCount, hadDuplicateTerminal, hadContradictoryTerminal, idempotencyPreserved, agentRetriesObserved, infrastructureRetriesObserved, metrics } = input;
  const failures: string[] = [];
  const expectation = fault.expectation;

  // §1 finalStatus check
  if (finalStatus !== expectation.finalStatus) {
    failures.push(
      `finalStatus 不匹配: 期望 ${expectation.finalStatus}, 实际 ${finalStatus}`,
    );
  }

  // §2 no-side-effects check
  if (expectation.requiresNoSideEffects && sideEffectCount > 0) {
    failures.push(
      `期望无副作用但实际观察到 ${sideEffectCount} 个副作用`,
    );
  }

  // §3 idempotency check
  if (expectation.requiresIdempotency && !idempotencyPreserved) {
    failures.push("期望幂等但实际破坏幂等性");
  }

  // §4 duplicate terminal check
  if (expectation.requiresDuplicateTerminalDetection && !hadDuplicateTerminal) {
    failures.push("未检测到评测注入的重复终态事件，fail-closed 检查未生效");
  }

  // §5 contradictory terminal check
  if (expectation.requiresContradictoryTerminalDetection && !hadContradictoryTerminal) {
    failures.push("未检测到评测注入的矛盾终态事件，fail-closed 检查未生效");
  }

  // §6 agent retry check
  if (expectation.requiresAgentRetry && agentRetriesObserved === 0) {
    failures.push("期望 Agent 内部重试但未观察到");
  }

  // §7 infrastructure retry check
  if (expectation.requiresInfrastructureRetry && infrastructureRetriesObserved === 0) {
    failures.push("期望基础设施重试但未观察到");
  }

  return {
    faultId: fault.faultId,
    faultClass: fault.faultClass,
    passed: failures.length === 0,
    metrics,
    failures,
  };
}

/** Aggregate runtime reliability results by fault class. */
export function aggregateRuntimeReliability(
  results: RuntimeReliabilityResult[],
): {
  total: number;
  passed: number;
  failed: number;
  byClass: Record<RuntimeFaultClass, { total: number; passed: number; failed: number }>;
} {
  const byClass = {} as Record<RuntimeFaultClass, { total: number; passed: number; failed: number }>;
  const allClasses: RuntimeFaultClass[] = [
    "timeout",
    "infrastructure_retry",
    "agent_internal_retry",
    "invalid_tool_arguments",
    "partial_tool_results",
    "cancellation",
    "checkpoint_resume",
    "steering",
    "idempotency",
    "duplicate_terminal_event",
    "contradictory_terminal_event",
  ];
  for (const c of allClasses) {
    byClass[c] = { total: 0, passed: 0, failed: 0 };
  }
  let passed = 0;
  for (const r of results) {
    byClass[r.faultClass]!.total += 1;
    if (r.passed) {
      byClass[r.faultClass]!.passed += 1;
      passed += 1;
    } else {
      byClass[r.faultClass]!.failed += 1;
    }
  }
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    byClass,
  };
}

/** Helper: classify a fault injection seam for the runner. */
export function classifySeam(seam: FaultInjectionSeam): {
  affectsSSE: boolean;
  affectsToolCall: boolean;
  affectsRun: boolean;
} {
  return {
    affectsSSE: seam.kind.startsWith("sse_") || seam.kind === "cancel_signal" || seam.kind === "steering_message",
    affectsToolCall: seam.kind.startsWith("tool_call_"),
    affectsRun: seam.kind === "checkpoint_after_event" || seam.kind === "force_idempotency_repeat",
  };
}

/** Helper: extract a stable expectation summary for artifacts. */
export function expectationSummary(expectation: FaultExpectation): string[] {
  const summary: string[] = [`finalStatus=${expectation.finalStatus}`];
  if (expectation.requiresNoSideEffects) summary.push("no_side_effects");
  if (expectation.requiresIdempotency) summary.push("idempotency");
  if (expectation.requiresDuplicateTerminalDetection) summary.push("duplicate_terminal_detected");
  if (expectation.requiresContradictoryTerminalDetection) summary.push("contradictory_terminal_detected");
  if (expectation.requiresAgentRetry) summary.push("agent_retry");
  if (expectation.requiresInfrastructureRetry) summary.push("infrastructure_retry");
  return summary;
}
