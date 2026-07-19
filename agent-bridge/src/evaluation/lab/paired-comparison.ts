/**
 * T46-3 (Issue #96 §7) — Candidate/baseline paired comparison.
 *
 * Candidate and baseline MUST run in two INDEPENDENT:
 *  - git worktree
 *  - backend/sidecar runtime pair
 *  - SQLite database
 *  - temp root
 *  - ports
 *  - nonce / instance identity
 *  - artifact staging location
 *
 * Both sides MUST align and record:
 *  - scenario manifest SHA-256
 *  - seed manifest SHA-256
 *  - frozen standards version
 *  - resolved model identity (confirmed by sidecar after start)
 *  - evaluator version
 *  - code revision
 *
 * The two sides MUST NOT share database, process, temp directory, or
 * mutable artifacts. If any side cannot confirm resolved model identity,
 * the result MUST set `model_drift_possible: true`. The requested model
 * is NEVER silently promoted to the resolved model.
 *
 * This module provides the manifest construction, alignment verification,
 * and result aggregation. The actual isolation is provided by the
 * existing {@link IsolatedProcessPair} (one per side).
 */

import type {
  OperationalMetrics,
  PairedComparisonManifest,
  PairedComparisonResult,
  PairedComparisonSide,
  ResolvedModelIdentity,
} from "./contract-v3.js";
import { sha256 } from "./validation.js";

export interface BuildSideInput {
  label: "candidate" | "baseline";
  worktreePath: string;
  backendPort: number;
  sidecarPort: number;
  nonce: string;
  instanceId: string;
  databasePath: string;
  tempRoot: string;
  artifactStagingDir: string;
  /** Resolved model identity confirmed by sidecar after start. null
   *  when the sidecar could not confirm the identity. */
  resolvedModel: ResolvedModelIdentity | null;
  gitCommit: string;
  worktreeSha256: string;
}

/** Construct a PairedComparisonSide from raw input. */
export function buildSide(input: BuildSideInput): PairedComparisonSide {
  // Adversarial guard: reject `confirmedBy` values that suggest the
  // resolved model was NOT actually confirmed by the sidecar. This
  // prevents the caller from silently promoting the requested model
  // to the resolved model. When the sidecar could not confirm, the
  // caller MUST pass `resolvedModel: null` instead.
  if (input.resolvedModel) {
    const suspicious = ["requested", "assumed", "default", "unconfirmed", "unknown", ""];
    const confirmedByLower = input.resolvedModel.confirmedBy.toLowerCase().trim();
    if (suspicious.includes(confirmedByLower)) {
      throw new Error(
        `resolvedModel.confirmedBy="${input.resolvedModel.confirmedBy}" 不表示实际确认；当 sidecar 无法确认时必须传 null`,
      );
    }
  }
  return { ...input };
}

export interface BuildManifestInput {
  candidate: PairedComparisonSide;
  baseline: PairedComparisonSide;
  scenarioManifestSha256: string;
  seedManifestSha256: string;
  frozenStandardsVersion: string;
  evaluatorVersion: string;
  /** ISO timestamp; defaults to `new Date().toISOString()`. */
  generatedAt?: string;
}

/** Construct the paired comparison manifest, computing
 *  `model_drift_possible` from both sides' resolved model identity. */
export function buildManifest(input: BuildManifestInput): PairedComparisonManifest {
  const modelDriftPossible = computeModelDrift(input.candidate, input.baseline);
  return {
    id: `paired-${sha256(JSON.stringify({
      candidate: input.candidate.gitCommit,
      baseline: input.baseline.gitCommit,
      scenario: input.scenarioManifestSha256,
    })).slice(0, 16)}`,
    candidate: input.candidate,
    baseline: input.baseline,
    scenarioManifestSha256: input.scenarioManifestSha256,
    seedManifestSha256: input.seedManifestSha256,
    frozenStandardsVersion: input.frozenStandardsVersion,
    evaluatorVersion: input.evaluatorVersion,
    modelDriftPossible,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}

/** Compute whether model drift is possible. Returns true when either
 *  side lacks a resolved model identity, or when the two sides resolved
 *  to different models. */
export function computeModelDrift(
  candidate: PairedComparisonSide,
  baseline: PairedComparisonSide,
): boolean {
  if (!candidate.resolvedModel || !baseline.resolvedModel) return true;
  if (candidate.resolvedModel.provider !== baseline.resolvedModel.provider) return true;
  if (candidate.resolvedModel.name !== baseline.resolvedModel.name) return true;
  return false;
}

/** Verify isolation between the two sides. Returns a list of violations
 *  (empty = OK). */
export function verifyIsolation(
  candidate: PairedComparisonSide,
  baseline: PairedComparisonSide,
): string[] {
  const violations: string[] = [];
  if (candidate.worktreePath === baseline.worktreePath) {
    violations.push("candidate 与 baseline 共享 worktree");
  }
  if (candidate.backendPort === baseline.backendPort) {
    violations.push("candidate 与 baseline 共享 backend port");
  }
  if (candidate.sidecarPort === baseline.sidecarPort) {
    violations.push("candidate 与 baseline 共享 sidecar port");
  }
  if (candidate.nonce === baseline.nonce) {
    violations.push("candidate 与 baseline 共享 nonce");
  }
  if (candidate.instanceId === baseline.instanceId) {
    violations.push("candidate 与 baseline 共享 instance ID");
  }
  if (candidate.databasePath === baseline.databasePath) {
    violations.push("candidate 与 baseline 共享数据库路径");
  }
  if (candidate.tempRoot === baseline.tempRoot) {
    violations.push("candidate 与 baseline 共享 temp root");
  }
  if (candidate.artifactStagingDir === baseline.artifactStagingDir) {
    violations.push("candidate 与 baseline 共享 artifact staging 目录");
  }
  return violations;
}

/** Verify manifest alignment between the two sides. Returns a list of
 *  violations (empty = OK). */
export function verifyAlignment(manifest: PairedComparisonManifest): string[] {
  const violations: string[] = [];
  // Scenario manifest, seed manifest, frozen standards, and evaluator
  // version are shared fields on the manifest (not per-side), so they
  // are aligned by construction. We still verify they are non-empty.
  if (!manifest.scenarioManifestSha256) {
    violations.push("scenarioManifestSha256 为空");
  }
  if (!manifest.seedManifestSha256) {
    violations.push("seedManifestSha256 为空");
  }
  if (!manifest.frozenStandardsVersion) {
    violations.push("frozenStandardsVersion 为空");
  }
  if (!manifest.evaluatorVersion) {
    violations.push("evaluatorVersion 为空");
  }
  // Resolved model: if either side has null, the manifest must have
  // modelDriftPossible=true. This is verified in buildManifest, but
  // we double-check here.
  if (
    (!manifest.candidate.resolvedModel || !manifest.baseline.resolvedModel)
    && !manifest.modelDriftPossible
  ) {
    violations.push("一侧或两侧未确认 resolved model identity 但 model_drift_possible=false");
  }
  return violations;
}

export interface BuildResultInput {
  manifest: PairedComparisonManifest;
  perScenario: Array<{
    scenarioId: string;
    candidatePassed: boolean;
    baselinePassed: boolean;
  }>;
  candidateMetrics: OperationalMetrics;
  baselineMetrics: OperationalMetrics;
  /** Minimum sample size to claim a candidate win. */
  minSampleSizeForWin?: number;
}

/** Construct the paired comparison result. */
export function buildResult(input: BuildResultInput): PairedComparisonResult {
  const minSample = input.minSampleSizeForWin ?? 30;
  const perScenario = input.perScenario.map((p) => ({
    scenarioId: p.scenarioId,
    candidatePassed: p.candidatePassed,
    baselinePassed: p.baselinePassed,
    delta: (p.candidatePassed ? 1 : 0) - (p.baselinePassed ? 1 : 0),
  }));
  const candidatePassed = perScenario.filter((p) => p.candidatePassed).length;
  const baselinePassed = perScenario.filter((p) => p.baselinePassed).length;
  const candidatePassRate = perScenario.length > 0 ? candidatePassed / perScenario.length : 0;
  const baselinePassRate = perScenario.length > 0 ? baselinePassed / perScenario.length : 0;
  const insufficientEvidence = perScenario.length < minSample;
  // Candidate "wins" only when:
  //  - there is sufficient evidence
  //  - candidate pass rate strictly exceeds baseline
  //  - no model drift is possible (otherwise the comparison is unfair)
  const candidateWins =
    !insufficientEvidence
    && !input.manifest.modelDriftPossible
    && candidatePassRate > baselinePassRate;
  return {
    manifest: input.manifest,
    perScenario,
    candidatePassRate,
    baselinePassRate,
    candidateWins,
    insufficientEvidence,
    candidateMetrics: input.candidateMetrics,
    baselineMetrics: input.baselineMetrics,
  };
}

/** Helper: aggregate operational metrics from a list of scenarios. */
export function aggregateSideMetrics(metrics: OperationalMetrics[]): OperationalMetrics {
  if (metrics.length === 0) {
    return {
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      sutCostUsd: 0,
      codingAgentCostUsd: null,
      toolCalls: 0,
      agentRetries: 0,
      infrastructureAttempts: 0,
      timeouts: 0,
      skipped: 0,
      excluded: 0,
      simulatorErrors: 0,
      infrastructureErrors: 0,
    };
  }
  const sum = (selector: (m: OperationalMetrics) => number): number =>
    metrics.reduce((acc, m) => acc + selector(m), 0);
  return {
    latencyMs: sum((m) => m.latencyMs),
    inputTokens: sum((m) => m.inputTokens),
    outputTokens: sum((m) => m.outputTokens),
    reasoningTokens: sum((m) => m.reasoningTokens ?? 0),
    cacheReadTokens: sum((m) => m.cacheReadTokens ?? 0),
    cacheWriteTokens: sum((m) => m.cacheWriteTokens ?? 0),
    sutCostUsd: sum((m) => m.sutCostUsd),
    evaluatorModelCostUsd: sum((m) => m.evaluatorModelCostUsd ?? 0),
    codingAgentCostUsd: null, // Coding Agent cost is always external; never summed
    toolCalls: sum((m) => m.toolCalls),
    agentRetries: sum((m) => m.agentRetries),
    infrastructureAttempts: sum((m) => m.infrastructureAttempts),
    timeouts: sum((m) => m.timeouts),
    skipped: sum((m) => m.skipped),
    excluded: sum((m) => m.excluded),
    simulatorErrors: sum((m) => m.simulatorErrors),
    infrastructureErrors: sum((m) => m.infrastructureErrors),
  };
}

/** Format a paired comparison result for human-readable reports (Chinese). */
export function formatPairedComparisonResult(result: PairedComparisonResult): string {
  const lines: string[] = [];
  lines.push("=== Candidate / Baseline 配对对比 ===");
  lines.push(`Manifest ID: ${result.manifest.id}`);
  lines.push(`Candidate commit: ${result.manifest.candidate.gitCommit}`);
  lines.push(`Baseline commit: ${result.manifest.baseline.gitCommit}`);
  lines.push(`Resolved model (candidate): ${formatResolvedModel(result.manifest.candidate.resolvedModel)}`);
  lines.push(`Resolved model (baseline): ${formatResolvedModel(result.manifest.baseline.resolvedModel)}`);
  lines.push(`Model drift possible: ${result.manifest.modelDriftPossible ? "是" : "否"}`);
  lines.push(`Candidate pass rate: ${result.candidatePassRate.toFixed(4)}`);
  lines.push(`Baseline pass rate: ${result.baselinePassRate.toFixed(4)}`);
  lines.push(`Candidate wins: ${result.candidateWins ? "是" : "否"}`);
  lines.push(`Insufficient evidence: ${result.insufficientEvidence ? "是" : "否"}`);
  lines.push("");
  lines.push("=== 每场景对比 ===");
  for (const p of result.perScenario) {
    lines.push(
      `${p.scenarioId}: candidate=${p.candidatePassed ? "PASS" : "FAIL"}, baseline=${p.baselinePassed ? "PASS" : "FAIL"}, delta=${p.delta > 0 ? "+" : ""}${p.delta}`,
    );
  }
  return lines.join("\n");
}

function formatResolvedModel(model: ResolvedModelIdentity | null): string {
  if (!model) return "<未确认>";
  return `${model.provider}:${model.name} (via ${model.confirmedBy})`;
}