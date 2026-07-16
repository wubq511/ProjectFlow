/**
 * Evaluation Lab Versioned Contracts.
 */

export interface ScenarioContract {
  schemaVersion: 1;
  scenarioId: string;
  visible: {
    prompt: string;
  };
  hidden: {
    expectedMode: "answer" | "action";
    expectedSkill?: string;
    requiredEvidence?: string[];
    requiredAnyEvidence?: string[];
    forbiddenOutputPatterns?: string[]; // Regex patterns as strings
    forbidRawIds?: boolean;
    maxLatencyMs: number;
    fixtureName?: string;
    goalState?: Record<string, unknown>;
    tokenBudget?: {
      maxInputTokens?: number;
      maxOutputTokens?: number;
    };
    maxRequestCount?: number;
  };
}

export interface RunManifest {
  schemaVersion: 1;
  runId: string;
  model: string;
  timestamp: string;
  scenarios: ScenarioContract[];
  gitCommit?: string;
  gitDirtyFingerprint?: string;
  sha256Hash?: string;
}

export interface ScenarioObservation {
  schemaVersion: 1;
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
  cost?: number; // legacy fallback
  sutCost: number;
  evaluatorModelCost: number;
  codingAgentCost: number;
  costSource: "reported" | "estimated" | "unknown";
  output: string;
  requestCount?: number;
  sha256Hash?: string;
}

export interface Grade {
  schemaVersion: 1;
  scenarioId: string;
  passed: boolean;
  routingPassed: boolean;
  outcomePassed: boolean;
  latencyPassed: boolean;
  privacyPassed: boolean;
  failures: string[];
  sha256Hash?: string;
}

export interface EvaluationArtifact {
  schemaVersion: 1;
  runId: string;
  model: string;
  gitCommit?: string;
  gitDirtyFingerprint?: string;
  startedAt: string;
  completedAt: string;
  observations: ScenarioObservation[];
  grades: Grade[];
  summary: {
    passedCount: number;
    failedCount: number;
    passRate: number;
    totalSutCost: number;
    totalEvaluatorModelCost: number;
    totalCodingAgentCost: number;
  };
  provenance?: {
    host: string;
    platform: string;
    user: string;
  };
  sha256Hash?: string;
}
