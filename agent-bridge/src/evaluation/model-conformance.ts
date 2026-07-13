import type { AgentScenario, ScenarioEvalReport, ScenarioRunner, RepeatedScenarioReport, ObservationContext } from "./scenario-eval.js";
import { runScenarioEval, runRepeatedScenarioEval } from "./scenario-eval.js";

export interface ModelCanaryReport {
  schemaVersion: 1;
  primary: ScenarioEvalReport | RepeatedScenarioReport;
  fallback: ScenarioEvalReport | RepeatedScenarioReport;
  passed: boolean;
  reason: string;
}

/**
 * Run the same release scenarios against primary and fallback configurations.
 *
 * Models execute **sequentially** so that effectful scenarios (risk, planning,
 * assignment) cannot collide with one another. When `ctx` is provided, its
 * `beforeObservation` hook is invoked before every observation to provision
 * isolated fixtures.
 */
export async function runModelCanary(
  primaryModel: string,
  fallbackModel: string,
  scenarios: AgentScenario[],
  runner: ScenarioRunner,
  repeats = 1,
  ctx?: ObservationContext,
): Promise<ModelCanaryReport> {
  if (!primaryModel || !fallbackModel || primaryModel === fallbackModel) {
    throw new Error("Canary requires distinct primary and fallback model configurations");
  }
  // Sequential: primary completes before fallback starts.
  // This prevents effectful scenarios from different models colliding
  // with one another (e.g. both creating proposals on the same project).
  const runEval = repeats > 1
    ? (model: string) => runRepeatedScenarioEval(model, scenarios, runner, repeats, ctx)
    : (model: string) => runScenarioEval(model, scenarios, runner);
  const primary = await runEval(primaryModel);
  const fallback = await runEval(fallbackModel);
  const passed = primary.passed && fallback.passed;
  return {
    schemaVersion: 1,
    primary,
    fallback,
    passed,
    reason: passed ? "primary and fallback passed release gates" : "one or more model configurations failed release gates",
  };
}
