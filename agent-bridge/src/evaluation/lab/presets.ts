import { RELEASE_SCENARIOS } from "../scenario-eval.js";
import type { AgentScenario } from "../scenario-eval.js";
import type { EvaluationBudget, ScenarioContract } from "./contract.js";

const SLICE_0_SCENARIO_ID = "answer-no-tool";

function toScenarioContract(scenario: AgentScenario): ScenarioContract {
  return {
    schemaVersion: 1,
    scenarioId: scenario.id,
    visible: { prompt: scenario.prompt },
    hidden: {
      expectedMode: scenario.expectedMode,
      ...(scenario.expectedSkill ? { expectedSkill: scenario.expectedSkill } : {}),
      requiredEvidence: scenario.requiredEvidence,
      ...(scenario.requiredAnyEvidence ? { requiredAnyEvidence: scenario.requiredAnyEvidence } : {}),
      ...(scenario.forbiddenOutputPatterns
        ? { forbiddenOutputPatterns: scenario.forbiddenOutputPatterns.map((pattern) => pattern.source) }
        : {}),
      ...(scenario.forbidRawIds !== undefined ? { forbidRawIds: scenario.forbidRawIds } : {}),
      maxLatencyMs: scenario.maxLatencyMs,
      tokenBudget: {
        maxInputTokens: 50_000,
        maxOutputTokens: 8_000,
      },
      maxRequestCount: 4,
    },
  };
}

const releaseScenario = RELEASE_SCENARIOS.find((scenario) => scenario.id === SLICE_0_SCENARIO_ID);
if (!releaseScenario) {
  throw new Error(`缺少 T43 release scenario: ${SLICE_0_SCENARIO_ID}`);
}

export const SLICE_0_SMOKE_SCENARIOS: ScenarioContract[] = [toScenarioContract(releaseScenario)];

export const SLICE_0_SMOKE_BUDGET: EvaluationBudget = {
  maxSutCostUsd: 0.10,
  maxInputTokens: 50_000,
  maxOutputTokens: 8_000,
  maxRequestCount: 4,
  maxWallTimeMs: 30_000,
  maxObservations: 1,
};

export const SLICE_0_PRESETS: Record<string, {
  scenarios: ScenarioContract[];
  budget: EvaluationBudget;
}> = {
  smoke: {
    scenarios: SLICE_0_SMOKE_SCENARIOS,
    budget: SLICE_0_SMOKE_BUDGET,
  },
};
