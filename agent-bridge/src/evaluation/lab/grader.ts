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
  if (!before || !after) return true;
  
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

  // 1. Routing Check
  const expectedMode = scenario.expectedMode;
  const expectedSkill = scenario.expectedSkill;
  const routingPassed = obs.routedMode === expectedMode &&
    (!expectedSkill || obs.selectedSkills.includes(expectedSkill));
  
  if (!routingPassed) {
    failures.push(`routing_mismatch: expected ${expectedMode}${expectedSkill ? `(${expectedSkill})` : ""}, got ${obs.routedMode}(${obs.selectedSkills.join(",")})`);
  }

  // 2. Outcome Check
  const terminalCompleted = obs.terminalStatus === "completed";
  const requiredEvidence = scenario.requiredEvidence ?? [];
  const missingEvidence = requiredEvidence.filter((e) => !obs.evidence.includes(e));
  
  const requiredAnyEvidence = scenario.requiredAnyEvidence ?? [];
  const anyEvidencePassed = requiredAnyEvidence.length === 0 ||
    requiredAnyEvidence.some((e) => obs.evidence.includes(e));

  // Determine state purity if required
  let statePurityPassed = true;
  if (scenario.expectedMode === "answer" && beforeState && afterState) {
    statePurityPassed = verifyStatePurity(beforeState, afterState);
    if (!statePurityPassed) {
      failures.push("state_mutation_detected: read-only scenario mutated database state");
    }
  }

  const outcomePassed = terminalCompleted && missingEvidence.length === 0 && anyEvidencePassed && statePurityPassed;
  if (!terminalCompleted) {
    failures.push(`terminal_status_failed: got ${obs.terminalStatus}`);
  }
  if (missingEvidence.length > 0) {
    failures.push(`missing_required_evidence: ${missingEvidence.join(", ")}`);
  }
  if (!anyEvidencePassed) {
    failures.push(`missing_any_required_evidence: expected one of ${requiredAnyEvidence.join(", ")}`);
  }

  // 3. Latency Check
  const latencyPassed = obs.latencyMs <= scenario.maxLatencyMs;
  if (!latencyPassed) {
    failures.push(`latency_exceeded: took ${obs.latencyMs}ms, max allowed is ${scenario.maxLatencyMs}ms`);
  }

  // 4. Privacy Check
  let privacyPassed = true;
  if (scenario.forbidRawIds && beforeState && containsRawId(obs.output, beforeState)) {
    privacyPassed = false;
    failures.push("privacy_leak: output contains raw identifiers");
  }

  // Forbidden output patterns
  const forbiddenPatterns = scenario.forbiddenOutputPatterns ?? [];
  for (const pat of forbiddenPatterns) {
    const rx = new RegExp(pat, "i");
    if (rx.test(obs.output)) {
      privacyPassed = false;
      failures.push(`forbidden_content_matched: output matched pattern /${pat}/i`);
    }
  }

  return {
    schemaVersion: 1,
    scenarioId: scenario.scenarioId,
    passed: routingPassed && outcomePassed && latencyPassed && privacyPassed,
    routingPassed,
    outcomePassed,
    latencyPassed,
    privacyPassed,
    failures,
  };
}
