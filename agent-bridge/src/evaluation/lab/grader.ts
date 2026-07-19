import type { ScenarioContract, ScenarioObservation, Grade } from "./contract.js";
import type { HardGrade } from "./contract-v2.js";

// UUID v1-v8 pattern. Version nibble widened to [1-9a-f] to cover v6/v7/v8.
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

function collectRawIds(value: any, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRawIds(item, ids);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "id" || key.endsWith("_id")) && typeof child === "string" && child.length >= 6) {
      ids.add(child.toLowerCase());
    }
    collectRawIds(child, ids);
  }
}

export function containsRawId(output: string, workspaceState: any): boolean {
  if (UUID_PATTERN.test(output)) return true;
  if (!workspaceState) return false;
  const knownIds = new Set<string>();
  collectRawIds(workspaceState, knownIds);
  const normalizedOutput = output.toLowerCase();
  for (const id of knownIds) {
    if (normalizedOutput.includes(id)) {
      return true;
    }
  }
  return false;
}

/** Check if two workspace state objects represent an identical set of tasks and stages (no mutations) */
export function verifyStatePurity(before: any, after: any): boolean {
  // P1: Fail-closed verification
  if (!before || !after) return false;

  // Create copies and strip dynamic timestamps/IDs that might auto-generate/change without mutation
  const cleanState = (state: any) => {
    const copy = JSON.parse(JSON.stringify(state));
    // Traverse and delete dynamic telemetry/event lists if needed
    if (copy.timeline) delete copy.timeline;
    if (copy.agent_events) delete copy.agent_events;
    if (copy.current_date) delete copy.current_date;
    if (copy.current_datetime) delete copy.current_datetime;
    return copy;
  };

  return JSON.stringify(cleanState(before)) === JSON.stringify(cleanState(after));
}

/**
 * Grade a scenario observation against the contract and before/after states.
 */
export function gradeObservation(
  scenario: ScenarioContract,
  obs: ScenarioObservation,
  beforeState?: any,
  afterState?: any,
): Grade {
  const failures: string[] = [];
  const hidden = scenario.hidden;

  // 1. Routing Check
  const expectedMode = hidden.expectedMode;
  const expectedSkill = hidden.expectedSkill;
  const routingPassed = obs.routedMode === expectedMode &&
    (!expectedSkill || obs.selectedSkills.includes(expectedSkill));

  if (!routingPassed) {
    failures.push(`路由不匹配: 期望模式为 ${expectedMode}${expectedSkill ? `(${expectedSkill})` : ""}, 实际为 ${obs.routedMode}(${obs.selectedSkills.join(",")})`);
  }

  // 2. Outcome Check
  const terminalCompleted = obs.terminalStatus === "completed";
  const requiredEvidence = hidden.requiredEvidence ?? [];
  const missingEvidence = requiredEvidence.filter((e) => !obs.evidence.includes(e));

  const requiredAnyEvidence = hidden.requiredAnyEvidence ?? [];
  const anyEvidencePassed = requiredAnyEvidence.length === 0 ||
    requiredAnyEvidence.some((e) => obs.evidence.includes(e));

  // Determine state purity if required (fail-closed if snapshots are missing)
  let statePurityPassed = true;
  if (hidden.expectedMode === "answer") {
    if (!beforeState || !afterState) {
      statePurityPassed = false;
      failures.push("状态读取失败: 无法获取工作区前后状态以校验数据一致性");
    } else {
      statePurityPassed = verifyStatePurity(beforeState, afterState);
      if (!statePurityPassed) {
        failures.push("状态更新越权: 只读模式场景意外修改了数据库状态");
      }
    }
  }

  const outcomePassed = terminalCompleted && missingEvidence.length === 0 && anyEvidencePassed && statePurityPassed;
  if (!terminalCompleted) {
    failures.push(`终端状态错误: 实际为 ${obs.terminalStatus}`);
  }
  if (missingEvidence.length > 0) {
    failures.push(`缺少必要执行证据: ${missingEvidence.join(", ")}`);
  }
  if (!anyEvidencePassed) {
    failures.push(`缺少任意必要执行证据: 期望其中之一为 ${requiredAnyEvidence.join(", ")}`);
  }

  // 3. Latency Check
  const latencyPassed = obs.latencyMs <= hidden.maxLatencyMs;
  if (!latencyPassed) {
    failures.push(`延迟超预算: 实际耗时 ${obs.latencyMs}ms，最大允许为 ${hidden.maxLatencyMs}ms`);
  }

  // 4. Privacy Check
  let privacyPassed = true;
  if (hidden.forbidRawIds) {
    if (!beforeState) {
      privacyPassed = false;
      failures.push("隐私校验失败: 缺少前置工作区状态，无法校验原始标识符");
    } else if (containsRawId(obs.output, beforeState)) {
      privacyPassed = false;
      failures.push("隐私泄露风险: 输出文本中包含了原始标识符(UUID/Secret)");
    }
  }

  // Forbidden output patterns
  const forbiddenPatterns = hidden.forbiddenOutputPatterns ?? [];
  for (const pat of forbiddenPatterns) {
    const rx = new RegExp(pat, "i");
    if (rx.test(obs.output)) {
      privacyPassed = false;
      failures.push(`包含禁止生成文本: 输出内容匹配了禁用模式 /${pat}/i`);
    }
  }

  // 5. Hard budget checks. Coding Agent and evaluator-model costs are intentionally excluded.
  let budgetPassed = true;
  const sutCost = obs.costs.sutCost;
  if (sutCost.amountUsd === null || sutCost.source === "unknown") {
    budgetPassed = false;
    failures.push("成本遥测缺失: 无法确认 ProjectFlow Agent 的 SUT 成本");
  } else if (sutCost.amountUsd > 0.10) {
    budgetPassed = false;
    failures.push(`超预算: ProjectFlow Agent 成本 $${sutCost.amountUsd} 超过 smoke 上限 $0.10`);
  }
  if (obs.inputTokens > hidden.tokenBudget.maxInputTokens) {
    budgetPassed = false;
    failures.push(`输入 Token ${obs.inputTokens} 超过上限 ${hidden.tokenBudget.maxInputTokens}`);
  }
  if (obs.outputTokens > hidden.tokenBudget.maxOutputTokens) {
    budgetPassed = false;
    failures.push(`输出 Token ${obs.outputTokens} 超过上限 ${hidden.tokenBudget.maxOutputTokens}`);
  }
  if (obs.requestCount > hidden.maxRequestCount) {
    budgetPassed = false;
    failures.push(`模型请求次数 ${obs.requestCount} 超过上限 ${hidden.maxRequestCount}`);
  }

  return {
    schemaVersion: 1,
    scenarioId: scenario.scenarioId,
    passed: routingPassed && outcomePassed && latencyPassed && privacyPassed && budgetPassed,
    routingPassed,
    outcomePassed,
    latencyPassed,
    privacyPassed,
    budgetPassed,
    failures,
  };
}

/**
 * T46-2 (Issue #95 §4) — Attach a hard grade to a Slice 0 grade.
 *
 * The overall `passed` flag becomes the AND of the Slice 0 gates and the
 * hard grade. A hard-gate failure cannot be offset by other dimensions.
 * Hard-grade failures are appended to the Slice 0 failures list so callers
 * that only inspect `failures` still see them.
 */
export function attachHardGrade(grade: Grade, hardGrade: HardGrade): Grade {
  return {
    ...grade,
    passed: grade.passed && hardGrade.passed,
    hardGrade,
    failures: [...grade.failures, ...hardGrade.failures],
  };
}
