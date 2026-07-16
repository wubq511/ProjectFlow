import type { ScenarioContract, ScenarioObservation, Grade } from "./contract.js";

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

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

  // 5. Cost Budget Check
  if (obs.cost !== undefined && obs.cost > 0.10) {
    failures.push(`超预算: 场景运行成本超过单次 $0.10 美元的上限门槛 (当前成本: $${obs.cost})`);
  }

  return {
    schemaVersion: 1,
    scenarioId: scenario.scenarioId,
    passed: routingPassed && outcomePassed && latencyPassed && privacyPassed && (obs.cost === undefined || obs.cost <= 0.10),
    routingPassed,
    outcomePassed,
    latencyPassed,
    privacyPassed,
    failures,
  };
}
