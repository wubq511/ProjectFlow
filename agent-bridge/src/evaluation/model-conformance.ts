import type { AgentScenario, ScenarioEvalReport, ScenarioRunner } from "./scenario-eval.js";
import { runScenarioEval } from "./scenario-eval.js";

export interface ModelCanaryReport {
  schemaVersion: 1;
  primary: ScenarioEvalReport;
  fallback: ScenarioEvalReport;
  passed: boolean;
  reason: string;
}

/** Run the same release scenarios against primary and fallback configurations. */
export async function runModelCanary(
  primaryModel: string,
  fallbackModel: string,
  scenarios: AgentScenario[],
  runner: ScenarioRunner,
): Promise<ModelCanaryReport> {
  if (!primaryModel || !fallbackModel || primaryModel === fallbackModel) {
    throw new Error("Canary requires distinct primary and fallback model configurations");
  }
  const [primary, fallback] = await Promise.all([
    runScenarioEval(primaryModel, scenarios, runner),
    runScenarioEval(fallbackModel, scenarios, runner),
  ]);
  const passed = primary.passed && fallback.passed;
  return {
    schemaVersion: 1,
    primary,
    fallback,
    passed,
    reason: passed ? "primary and fallback passed release gates" : "one or more model configurations failed release gates",
  };
}
