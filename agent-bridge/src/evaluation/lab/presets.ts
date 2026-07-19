import { RELEASE_SCENARIOS } from "../scenario-eval.js";
import type { AgentScenario } from "../scenario-eval.js";
import type { EvaluationBudget, ScenarioContract } from "./contract.js";
import {
  HARD_GRADER_CONTRACT_VERSION,
  type HardGraderContract,
  type ReferenceProgram,
} from "./contract-v2.js";

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

// ---------------------------------------------------------------------------
// T46-2 (Issue #95) — smoke-v2 preset.
//
// Adds a single V2 scenario that declares a minimal HardGraderContract.
// The scenario reuses the Slice 0 smoke prompt (so the underlying Agent
// behavior is unchanged) but adds:
// - A finalOutcome grader expecting "completed".
// - A read-only state purity grader (the smoke scenario is answer-only).
// - A raw-ID leakage grader.
// - A hidden-field leakage grader with a sentinel token.
//
// The scenario also declares a Reference Program that sends the same prompt
// through the public seam. Tests use it to verify the "zero false hard
// failure" property.
//
// This preset does NOT exercise multi-turn, Proposal-Confirm, or
// subject_and_owner privacy — those are reserved for the hard-domain
// suite (Issue #96).
// ---------------------------------------------------------------------------

const SMOKE_V2_SCENARIO_ID = "answer-no-tool-v2";

const SMOKE_V2_HIDDEN_TOKEN = "HIDDEN_GOAL_TOKEN_T46_2_DO_NOT_LEAK";

const smokeV2HardGrader: HardGraderContract = {
  version: HARD_GRADER_CONTRACT_VERSION,
  viewer: {
    primaryUserId: "demo-user-001",
  },
  run: {
    finalStatus: "completed",
    maxSideEffects: 0,
  },
  readOnlyStatePurity: true,
  privacy: {
    forbidRawIdsInOutput: true,
    hiddenFieldTokens: [SMOKE_V2_HIDDEN_TOKEN],
  },
};

const smokeV2Reference: ReferenceProgram = {
  id: "ref-answer-no-tool-v2",
  prompt: "你好，请介绍一下当前项目的进展。",
  viewer: {
    primaryUserId: "demo-user-001",
  },
  expectedMilestoneSubset: [],
};

const smokeV2Scenario: ScenarioContract = {
  schemaVersion: 1,
  scenarioId: SMOKE_V2_SCENARIO_ID,
  visible: {
    prompt: releaseScenario.prompt,
  },
  hidden: {
    expectedMode: releaseScenario.expectedMode,
    requiredEvidence: releaseScenario.requiredEvidence,
    ...(releaseScenario.forbiddenOutputPatterns
      ? { forbiddenOutputPatterns: releaseScenario.forbiddenOutputPatterns.map((p) => p.source) }
      : {}),
    ...(releaseScenario.forbidRawIds !== undefined ? { forbidRawIds: releaseScenario.forbidRawIds } : {}),
    maxLatencyMs: releaseScenario.maxLatencyMs,
    tokenBudget: {
      maxInputTokens: 50_000,
      maxOutputTokens: 8_000,
    },
    maxRequestCount: 4,
  },
  hardGrader: smokeV2HardGrader,
};

export const SMOKE_V2_SCENARIOS: ScenarioContract[] = [smokeV2Scenario];

export const SMOKE_V2_REFERENCE_PROGRAMS: Record<string, ReferenceProgram> = {
  [SMOKE_V2_SCENARIO_ID]: smokeV2Reference,
};

export const SMOKE_V2_BUDGET: EvaluationBudget = {
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
  "smoke-v2": {
    scenarios: SMOKE_V2_SCENARIOS,
    budget: SMOKE_V2_BUDGET,
  },
};
