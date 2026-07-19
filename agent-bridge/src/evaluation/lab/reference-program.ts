/**
 * T46-2 (Issue #95 §3, §6) — Reference Program executor.
 *
 * The Reference Program proves that a scenario's fixture is reachable, the
 * human-action seam is available, and the harness can observe the target
 * state. It is NOT the oracle: the oracle is the {@link HardGraderContract},
 * authored independently from the scenario goal and invariants.
 *
 * Key properties enforced here and in `reference-program.test.ts`:
 * - Modifying the Reference Program does not modify the oracle (verified
 *   via {@link assertOracleIndependence} and fingerprint probes).
 * - The Reference Program must produce zero false hard failures when run
 *   against a contract it was designed to satisfy. This is verified by
 *   running the reference through the same public seam as the Agent and
 *   applying the same hard graders.
 * - The Agent under test is NOT required to reproduce the reference's
 *   exact trajectory. The reference proves reachability; the oracle
 *   declares the goal.
 *
 * The executor is intentionally minimal:
 * - It does NOT import runtime, router, verifier or business service code.
 * - It sends the reference's prompt through the public HTTP/SSE seam.
 * - It fetches the evidence snapshot through the authenticated evidence
 *   client.
 * - It applies the hard graders to the reference's observation + snapshot.
 */

import type { PublicSeamIdentity } from "../http-public-seam-runner.js";
import { createHttpPublicSeamRunner } from "../http-public-seam-runner.js";
import { provisionObservationFixture } from "../fixture-provisioner.js";
import type {
  HardGraderContract,
  ReferenceProgram,
  ReferenceProgramResult,
  EvidenceSnapshot,
} from "./contract-v2.js";
import type { ScenarioObservation as LabScenarioObservation } from "./contract.js";
import { EVALUATION_SCHEMA_VERSION } from "./contract.js";
import type { ScenarioObservation as PublicScenarioObservation } from "../scenario-eval.js";
import { fetchEvidenceSnapshot } from "./evidence-client.js";
import { gradeHard } from "./hard-graders.js";
import { assertOracleIndependence } from "./oracle.js";

/**
 * Convert a public-seam ScenarioObservation (from scenario-eval.ts) to the
 * lab's serialized ScenarioObservation (from contract.ts).
 *
 * The public seam returns a leaner observation without schemaVersion,
 * scenarioId, timestamp, or the cost ledger. The lab's graders and
 * artifact store require the full shape. This conversion fills in the
 * missing fields with reference-program-appropriate defaults.
 */
function toLabObservation(
  publicObs: PublicScenarioObservation,
  scenarioId: string,
): LabScenarioObservation {
  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    scenarioId,
    timestamp: new Date().toISOString(),
    routedMode: publicObs.routedMode,
    selectedSkills: publicObs.selectedSkills,
    evidence: publicObs.evidence,
    terminalStatus: publicObs.terminalStatus,
    latencyMs: publicObs.latencyMs,
    inputTokens: publicObs.inputTokens,
    outputTokens: publicObs.outputTokens,
    ...(publicObs.reasoningTokens !== undefined ? { reasoningTokens: publicObs.reasoningTokens } : {}),
    ...(publicObs.cacheReadTokens !== undefined ? { cacheReadTokens: publicObs.cacheReadTokens } : {}),
    ...(publicObs.cacheWriteTokens !== undefined ? { cacheWriteTokens: publicObs.cacheWriteTokens } : {}),
    requestCount: publicObs.requestCount ?? 0,
    costs: {
      sutCost: publicObs.cost === undefined
        ? { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: true }
        : { amountUsd: publicObs.cost, source: "provider_reported", countedAgainstSutCap: true },
      evaluatorModelCost: { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: false },
      codingAgentCost: { amountUsd: null, source: "unknown", countedAgainstSutCap: false },
    },
    output: publicObs.output ?? "",
    ...(publicObs.runId !== undefined ? { runId: publicObs.runId } : {}),
  };
}

export interface ReferenceExecutorConfig {
  backendBaseUrl: string;
  sidecarBaseUrl: string;
  adminToken: string;
  internalServiceToken: string;
  evaluationNonce: string;
  evaluationInstanceId: string;
  workspaceId: string;
  projectId: string;
  /** Model reference (provider:name) the reference program runs against. */
  model: string;
  /** Per-observation latency ceiling, inherited from the scenario contract. */
  maxLatencyMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRequestCount: number;
  maxSutCostUsd: number;
  /** Evaluator-owned sentinels, sent only as length+SHA-256 evidence probes. */
  hiddenFieldTokens?: string[];
  fetchFn?: typeof fetch;
}

export interface ReferenceRunHandles {
  observation: LabScenarioObservation;
  beforeSnapshot: EvidenceSnapshot;
  preHumanActionSnapshot: EvidenceSnapshot;
  snapshot: EvidenceSnapshot;
  adversarySnapshot: EvidenceSnapshot | null;
  identity: PublicSeamIdentity;
}

/**
 * Run the reference program's prompt through the public HTTP/SSE seam and
 * collect the evidence snapshot for the resulting run.
 *
 * This is the same path the Agent under test takes — no shortcuts, no
 * direct runtime imports. The reference proves the fixture is reachable
 * and the harness can observe the resulting state.
 */
export async function executeReferenceRun(
  reference: ReferenceProgram,
  config: ReferenceExecutorConfig,
): Promise<ReferenceRunHandles> {
  const identity = await provisionObservationFixture({
    backendBaseUrl: config.backendBaseUrl,
    workspaceId: config.workspaceId,
    projectId: config.projectId,
    viewerUserId: reference.viewer.primaryUserId,
    adminToken: config.adminToken,
    evaluationNonce: config.evaluationNonce,
    evaluationInstanceId: config.evaluationInstanceId,
    fetchFn: config.fetchFn,
  });

  const evidenceClient = {
    backendBaseUrl: config.backendBaseUrl,
    internalServiceToken: config.internalServiceToken,
    evaluationNonce: config.evaluationNonce,
    evaluationInstanceId: config.evaluationInstanceId,
    fetchFn: config.fetchFn,
  };
  const beforeSnapshot = await fetchEvidenceSnapshot(evidenceClient, {
    workspaceId: config.workspaceId,
    viewerUserId: reference.viewer.primaryUserId,
    projectId: config.projectId,
  });

  const publicRunner = createHttpPublicSeamRunner({
    baseUrl: config.sidecarBaseUrl,
    identity,
    evaluationAuth: {
      nonce: config.evaluationNonce,
      instanceId: config.evaluationInstanceId,
    },
    fetchFn: config.fetchFn,
  });

  const publicObservation = await publicRunner(
    {
      id: reference.id,
      prompt: reference.prompt,
      expectedMode: "answer",
      requiredEvidence: [],
      requiredAnyEvidence: [],
      forbiddenOutputPatterns: [],
      forbidRawIds: false,
      maxLatencyMs: config.maxLatencyMs,
      maxInputTokens: config.maxInputTokens,
      maxOutputTokens: config.maxOutputTokens,
      maxRequestCount: config.maxRequestCount,
      maxSutCostUsd: config.maxSutCostUsd,
    },
    config.model,
  );
  const observation = toLabObservation(publicObservation, reference.id);

  // T46-2: propagate the run_id captured by the public seam runner so the
  // evidence endpoint can populate trajectory_facts, side_effect_facts,
  // metric_facts and context_receipt_facts. Without it, run-scoped graders
  // (terminal event consistency, prohibited commit effects, idempotency,
  // milestone DAG) would see empty data and silently pass — defeating the
  // "zero false hard failure" property of the reference program.
  const preHumanActionSnapshot = await fetchEvidenceSnapshot(
    evidenceClient,
    {
      workspaceId: config.workspaceId,
      viewerUserId: reference.viewer.primaryUserId,
      projectId: config.projectId,
      conversationId: identity.conversationId,
      runId: publicObservation.runId,
      hiddenFieldTokens: config.hiddenFieldTokens,
    },
  );

  if (reference.humanAction) {
    const action = reference.humanAction;
    const pending = [...preHumanActionSnapshot.proposal_facts]
      .reverse()
      .find((proposal) => proposal.proposal_type === action.proposalType && proposal.status === "pending");
    if (!pending) throw new Error(`reference 未找到 pending ${action.proposalType} proposal`);
    const response = await (config.fetchFn ?? fetch)(
      `${config.backendBaseUrl}/api/agent-proposals/${encodeURIComponent(pending.proposal_id)}/${action.action}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Evaluation-Nonce": config.evaluationNonce,
          "X-Evaluation-Instance-Id": config.evaluationInstanceId,
        },
        body: JSON.stringify(
          action.action === "confirm"
            ? { confirmed_by: action.actorUserId }
            : { reason: action.reason },
        ),
      },
    );
    if (!response.ok) throw new Error(`reference 公共人工操作失败: HTTP ${response.status}`);
  }

  const snapshot = reference.humanAction
    ? await fetchEvidenceSnapshot(evidenceClient, {
      workspaceId: config.workspaceId,
      viewerUserId: reference.viewer.primaryUserId,
      projectId: config.projectId,
      conversationId: identity.conversationId,
      runId: publicObservation.runId,
      hiddenFieldTokens: config.hiddenFieldTokens,
    })
    : preHumanActionSnapshot;

  let adversarySnapshot: EvidenceSnapshot | null = null;
  if (reference.viewer.adversaryUserId) {
    adversarySnapshot = await fetchEvidenceSnapshot(evidenceClient, {
      workspaceId: config.workspaceId,
      viewerUserId: reference.viewer.adversaryUserId,
      projectId: config.projectId,
    });
  }

  return {
    observation,
    beforeSnapshot,
    preHumanActionSnapshot,
    snapshot,
    adversarySnapshot,
    identity,
  };
}

/**
 * Run the reference program and apply the hard graders to its output.
 *
 * Verifies the "zero false hard failure" property: when the reference
 * program is run against a contract it was designed to satisfy, all
 * hard graders must pass. A failure indicates either a buggy reference
 * or an unsatisfiable oracle.
 *
 * @throws Error if the oracle and reference are not structurally independent
 *   (see {@link assertOracleIndependence}).
 */
export async function runReferenceProgram(
  reference: ReferenceProgram,
  oracle: HardGraderContract,
  config: ReferenceExecutorConfig,
): Promise<ReferenceProgramResult> {
  assertOracleIndependence(oracle, reference);

  const {
    observation,
    beforeSnapshot,
    preHumanActionSnapshot,
    snapshot,
    adversarySnapshot,
  } = await executeReferenceRun(
    reference,
    { ...config, hiddenFieldTokens: oracle.privacy?.hiddenFieldTokens },
  );
  const hardGrade = gradeHard({
    oracle,
    observation,
    primarySnapshot: snapshot,
    adversarySnapshot,
    beforeSnapshot,
    preHumanActionSnapshot,
  });

  return {
    passed: hardGrade.passed,
    observation,
    snapshot,
    hardGrade,
  };
}
