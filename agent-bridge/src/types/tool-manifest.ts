/**
 * ProjectFlowToolManifest — describes a tool's capabilities and constraints.
 * Wire format is snake_case; this is the camelCase internal representation.
 */

export type RiskCategory =
  | "read_only"
  | "analysis"
  | "draft_only"
  | "advisory_write"
  | "internal_write"
  | "destructive"
  | "open_world";

export type EffectType =
  | "none"
  | "event_write"
  | "proposal_create"
  | "advisory_record_create"
  | "runtime_metadata_write";

export type DataClassification = "public" | "project_sensitive" | "secret";
export type ErrorPolicy = "normalized_summary" | "redacted" | "none";
export type IncompatibleVersionPolicy = "regenerate" | "manual_review" | "fail";
export type RedactionType = "none" | "secrets" | "pii";

export interface ToolExecutionConfig {
  mode: "parallel" | "sequential";
  concurrencyGroup?: string;
  maxConcurrency: number;
  providerParallelToolCallsAllowed: boolean;
}

export interface ToolRetryConfig {
  maxAttempts: number;
  retryOn: string[];
}

export interface ToolBackendConfig {
  owner: "fastapi";
  endpoint: string;
  method: "GET" | "POST";
}

export interface ToolEffectConfig {
  effectType: EffectType;
  idempotencyKeyRequired: boolean;
  replaySafe: boolean;
}

export interface ToolProposalConfig {
  createsProposal: boolean;
  requiredBeforeCommit: boolean;
  publicActionOnly: boolean;
  resumesModelLoopByDefault: false;
}

export interface ToolPrivacyConfig {
  dataClassification: DataClassification;
  traceIncludeInputs: boolean;
  traceIncludeOutputs: boolean;
}

export interface ToolErrorConfig {
  modelVisibleErrorPolicy: ErrorPolicy;
}

export interface ToolResumeConfig {
  manifestVersion: number;
  incompatibleVersionPolicy: IncompatibleVersionPolicy;
}

export interface ToolTraceConfig {
  emits: string[];
}

export interface ProjectFlowToolManifest {
  schemaVersion: number;
  name: string;
  version: number;
  description: string;
  riskCategory: RiskCategory;
  modelCallable: boolean;
  sidecarOnly: boolean;
  humanTriggeredOnly: boolean;
  annotations: {
    readOnly: boolean;
    destructive: boolean;
    idempotent: boolean;
    openWorld: boolean;
  };
  inputSchema: unknown;
  outputSchema: unknown;
  execution: ToolExecutionConfig;
  timeoutMs: number;
  retry: ToolRetryConfig;
  resultLimit: { maxBytes: number; redaction: RedactionType };
  backend: ToolBackendConfig;
  effects: ToolEffectConfig;
  proposalConfirmation?: ToolProposalConfig;
  privacy: ToolPrivacyConfig;
  errors: ToolErrorConfig;
  resume: ToolResumeConfig;
  trace: ToolTraceConfig;
}

/** Human-only action manifest (confirm, reject, commit). */
export interface HumanActionManifest {
  schemaVersion: number;
  name: string;
  version: number;
  description: string;
  riskCategory: "human_triggered_only";
  modelCallable: false;
  humanTriggeredOnly: true;
  actionType: "confirm_proposal" | "reject_proposal" | "cancel_run" | "commit_proposal";
}
