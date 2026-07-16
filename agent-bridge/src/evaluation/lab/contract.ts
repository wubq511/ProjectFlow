/** Versioned public contracts for Evaluation Lab Slice 0. */

export const EVALUATION_SCHEMA_VERSION = 1 as const;
export const EVALUATOR_VERSION = "t46-slice0-v1";

export type CostSource = "provider_reported" | "versioned_price_estimate" | "unknown";
export type EvaluationRunStatus =
  | "running"
  | "completed"
  | "regression"
  | "partial_budget"
  | "infrastructure_error";

export interface ScenarioContract {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  scenarioId: string;
  visible: {
    prompt: string;
  };
  hidden: {
    expectedMode: "answer" | "action";
    expectedSkill?: string;
    requiredEvidence?: string[];
    requiredAnyEvidence?: string[];
    forbiddenOutputPatterns?: string[];
    forbidRawIds?: boolean;
    maxLatencyMs: number;
    tokenBudget: {
      maxInputTokens: number;
      maxOutputTokens: number;
    };
    maxRequestCount: number;
  };
}

export interface EvaluationBudget {
  maxSutCostUsd: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRequestCount: number;
  maxWallTimeMs: number;
  maxObservations: number;
}

export interface CodeFingerprint {
  gitCommit: string;
  gitDirty: boolean;
  worktreeSha256: string;
}

export interface EvaluationProvenance {
  evaluatorVersion: string;
  publicSeamVersion: "http-sse-v1";
  platform: string;
  architecture: string;
  nodeVersion: string;
  code: CodeFingerprint;
  scenarioContractsSha256: string;
  modelConfigSha256: string;
}

export interface RunManifest {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  runId: string;
  preset: string;
  model: string;
  createdAt: string;
  scenarios: ScenarioContract[];
  budget: EvaluationBudget;
  provenance: EvaluationProvenance;
}

export interface CostLedgerEntry {
  amountUsd: number | null;
  source: CostSource;
  countedAgainstSutCap: boolean;
}

export interface ScenarioObservation {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  scenarioId: string;
  timestamp: string;
  routedMode: "answer" | "action";
  selectedSkills: string[];
  evidence: string[];
  terminalStatus: "completed" | "failed" | "blocked";
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  requestCount: number;
  costs: {
    sutCost: CostLedgerEntry;
    evaluatorModelCost: CostLedgerEntry;
    codingAgentCost: CostLedgerEntry;
  };
  output: string;
}

export interface Grade {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  scenarioId: string;
  passed: boolean;
  routingPassed: boolean;
  outcomePassed: boolean;
  latencyPassed: boolean;
  privacyPassed: boolean;
  budgetPassed: boolean;
  failures: string[];
}

export interface IntegrityIndex {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  algorithm: "sha256";
  entries: Record<string, string>;
  evidenceRootSha256: string;
  reportSha256: string;
  integrityRootSha256: string;
}

export interface EvaluationArtifact {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  runId: string;
  preset: string;
  model: string;
  status: Exclude<EvaluationRunStatus, "running" | "infrastructure_error">;
  startedAt: string;
  completedAt: string;
  observations: ScenarioObservation[];
  grades: Grade[];
  summary: {
    passedCount: number;
    failedCount: number;
    passRate: number;
    sutCost: CostLedgerEntry;
    evaluatorModelCost: CostLedgerEntry;
    codingAgentCost: CostLedgerEntry;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalRequestCount: number;
    wallTimeMs: number;
  };
  provenance: EvaluationProvenance;
  evidenceRootSha256: string;
  integrityRootSha256?: string;
  artifactPaths: {
    runDirectory: string;
    manifest: string;
    report: string;
    integrity: string;
  };
}

export interface EvaluationStatusRecord {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  runId: string;
  status: EvaluationRunStatus;
  completedScenarioIds: string[];
  updatedAt: string;
  message?: string;
}
