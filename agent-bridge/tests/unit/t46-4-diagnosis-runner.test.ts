/**
 * T46-4 (Issue #97) — Diagnosis runner integration tests.
 *
 * Verifies the end-to-end diagnosis pipeline:
 *  1. runDiagnosisPipeline consumes real ScenarioContract / ScenarioObservation
 *     / Grade artifacts and produces diagnoses, clusters, repair packets,
 *     and copy-ready Coding Agent prompts.
 *  2. runBenchmarkPipeline synthesises the 3 required sample classes
 *     (correct_attribution, confusable_neighbour, unresolved_or_insufficient)
 *     and the oracle scores each.
 *  3. All V4 artifacts enter the SHA-256 result graph via the artifact store.
 *  4. The runner NEVER self-fills results — every diagnosis is produced
 *     by matching against the evaluator-owned fault profile catalog.
 *  5. The runner NEVER promotes status without the required evidence.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EvaluationArtifactStore } from "../../src/evaluation/lab/artifact-store.js";
import {
  runDiagnosisPipeline,
  runBenchmarkPipeline,
  matchFaultProfileToObservation,
  type DiagnosisTarget,
} from "../../src/evaluation/lab/diagnosis-runner.js";
import { FAULT_PROFILE_CATALOG, findFaultProfile } from "../../src/evaluation/lab/fault-profiles.js";
import { verifyPacketInvariants } from "../../src/evaluation/lab/repair-packet.js";
import { verifyClusterInvariants } from "../../src/evaluation/lab/issue-clustering.js";
import {
  verifyPromptContent,
  promptRefusesStale,
  promptForbidsFrozenStandardsModification,
  promptForbidsAutoPushMergeClose,
} from "../../src/evaluation/lab/repair-prompt.js";
import type { Grade, ScenarioContract, ScenarioObservation } from "../../src/evaluation/lab/contract.js";
import type { EvidenceSnapshot, HardGraderContract } from "../../src/evaluation/lab/contract-v2.js";
import { EVALUATION_SCHEMA_VERSION } from "../../src/evaluation/lab/contract.js";
import { EVIDENCE_SNAPSHOT_SCHEMA_VERSION, HARD_GRADER_CONTRACT_VERSION } from "../../src/evaluation/lab/contract-v2.js";

const projectRoot = resolve(import.meta.dirname ?? process.cwd(), "../../../");
const createdTempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdTempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function makeStore(runId: string): Promise<EvaluationArtifactStore> {
  const evaluatorTemp = await mkdtemp(join(tmpdir(), `t46-4-runner-${runId}-`));
  createdTempDirs.push(evaluatorTemp);
  const runArtifactsDir = join(projectRoot, "agent-bridge", "artifacts", runId);
  createdTempDirs.push(runArtifactsDir);
  return new EvaluationArtifactStore(projectRoot, runId, evaluatorTemp);
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function buildHardGrader(category: string): HardGraderContract | undefined {
  if (category === "privacy_or_visibility") {
    return {
      version: HARD_GRADER_CONTRACT_VERSION,
      viewer: { primaryUserId: "demo-user-001" },
      privacy: {
        subjectAndOwnerHiddenFromAdversary: true,
      },
    };
  }
  if (category === "terminal_events") {
    return {
      version: HARD_GRADER_CONTRACT_VERSION,
      viewer: { primaryUserId: "demo-user-001" },
      milestoneDag: {
        mode: "strict",
        nodes: [
          { id: "start", kind: "event", value: "turn_start" },
          { id: "end", kind: "event", value: "agent.completed" },
        ],
        edges: [{ before: "start", after: "end" }],
      },
    };
  }
  if (category === "proposal_evidence" || category === "policy_or_effect_boundary") {
    return {
      version: HARD_GRADER_CONTRACT_VERSION,
      viewer: { primaryUserId: "demo-user-001" },
      authoritySafety: {
        proposalConfirm: {
          required: [{ proposalType: "plan", status: "confirmed" }],
        },
      },
    };
  }
  return undefined;
}

function buildScenarioContract(
  scenarioId: string,
  profile = findFaultProfile("fp-routing-001")!,
): ScenarioContract {
  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    scenarioId,
    visible: { prompt: profile.symptom.description },
    hidden: {
      expectedMode: "action",
      expectedSkill: "project-planning",
      maxLatencyMs: 30000,
      tokenBudget: { maxInputTokens: 1000, maxOutputTokens: 1000 },
      maxRequestCount: 5,
      v3: profile.category === "terminal_events" ? { runtimeFaultId: "duplicate_terminal" } : undefined,
    },
    hardGrader: buildHardGrader(profile.category),
  };
}

function buildGrade(scenarioId: string, failures: string[]): Grade {
  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    scenarioId,
    passed: false,
    routingPassed: false,
    outcomePassed: false,
    latencyPassed: true,
    privacyPassed: true,
    budgetPassed: true,
    failures,
  };
}

function buildObservation(scenarioId: string): ScenarioObservation {
  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    scenarioId,
    timestamp: "2026-07-20T00:00:00Z",
    routedMode: "answer",
    selectedSkills: [],
    evidence: [],
    terminalStatus: "completed",
    latencyMs: 1000,
    inputTokens: 100,
    outputTokens: 100,
    requestCount: 1,
    costs: {
      sutCost: { amountUsd: 0, source: "unknown", countedAgainstSutCap: false },
      evaluatorModelCost: { amountUsd: 0, source: "unknown", countedAgainstSutCap: false },
      codingAgentCost: { amountUsd: 0, source: "unknown", countedAgainstSutCap: false },
    },
    output: "test output",
  };
}

function buildEvidenceSnapshot(scenarioId: string): EvidenceSnapshot {
  return {
    schema_version: EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
    snapshot_id: `snap-${scenarioId}`,
    captured_at: "2026-07-20T00:00:00Z",
    workspace_id: "ws-1",
    project_id: "proj-1",
    conversation_id: null,
    viewer_user_id: "demo-user-001",
    run_id: "run-1",
    state_facts: {
      workspace_id: "ws-1",
      workspace_name: "测试工作区",
      project_id: "proj-1",
      project_name: "测试项目",
      project_status: "planning",
      project_current_stage_id: null,
      project_deadline: null,
      stage_count: 0,
      stages: [],
      task_count: 0,
      tasks: [],
      assignment_proposal_count: 0,
      assignment_proposals: [],
      member_count: 0,
      members: [],
    },
    proposal_facts: [],
    event_facts: [],
    memory_facts: [],
    conversation_facts: [],
    trajectory_facts: [
      { event_type: "turn_start", event_seq: 0, tool_name: null, created_at: "2026-07-20T00:00:00Z" },
      { event_type: "agent.completed", event_seq: 1, tool_name: null, created_at: "2026-07-20T00:00:01Z" },
    ],
    side_effect_facts: [],
    metric_facts: null,
    context_receipt_facts: null,
    hidden_field_probe_facts: null,
  };
}

function buildTarget(
  scenarioId: string,
  failures: string[],
  profile = findFaultProfile("fp-routing-001")!,
): DiagnosisTarget {
  return {
    scenario: buildScenarioContract(scenarioId, profile),
    observation: buildObservation(scenarioId),
    grade: buildGrade(scenarioId, failures),
    evidenceSnapshot: buildEvidenceSnapshot(scenarioId),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T46-4 diagnosis runner — fault profile matching", () => {
  it("returns undefined when the observation passed (no failure)", () => {
    const target: DiagnosisTarget = {
      scenario: buildScenarioContract("scn-pass"),
      observation: buildObservation("scn-pass"),
      grade: {
        ...buildGrade("scn-pass", []),
        passed: true,
        routingPassed: true,
        outcomePassed: true,
      },
    };
    expect(matchFaultProfileToObservation(target)).toBeUndefined();
  });

  it("matches a routing failure to the routing fault profile", () => {
    const target = buildTarget(
      "scn-routing",
      [
        "routedMode != expectedMode: answer != action",
        "selectedSkills 不包含 expectedSkill",
      ],
      findFaultProfile("fp-routing-001"),
    );
    const profile = matchFaultProfileToObservation(target);
    expect(profile).toBeDefined();
    expect(profile?.category).toBe("routing");
  });

  it("matches a terminal-events failure via the v3 runtimeFaultId hint", () => {
    const target = buildTarget(
      "scn-terminal",
      ["trajectory 包含重复 agent.completed 事件"],
      findFaultProfile("fp-terminal-duplicate-001"),
    );
    const profile = matchFaultProfileToObservation(target);
    expect(profile).toBeDefined();
    expect(profile?.category).toBe("terminal_events");
  });
});

describe("T46-4 diagnosis runner — pipeline", () => {
  it("throws when targets is empty", async () => {
    const store = await makeStore("empty-targets");
    await expect(
      runDiagnosisPipeline(store, { runId: "empty-targets", targets: [] }),
    ).rejects.toThrow(/至少需要一个 target/);
  });

  it("produces diagnoses, clusters, packets, and prompts from real artifacts", async () => {
    const runId = "pipeline-basic";
    const store = await makeStore(runId);
    const targets: DiagnosisTarget[] = [
      buildTarget(
        "scn-routing-1",
        [
          "routedMode != expectedMode: answer != action",
          "selectedSkills 为空但场景声明 expectedSkill=project-planning",
        ],
        findFaultProfile("fp-routing-001"),
      ),
    ];
    const result = await runDiagnosisPipeline(store, {
      runId,
      targets,
      createdAt: "2026-07-20T00:00:00Z",
    });

    expect(result.diagnoses).toHaveLength(1);
    const diagnosis = result.diagnoses[0]!;
    expect(diagnosis.scenarioId).toBe("scn-routing-1");
    expect(diagnosis.causalStatus).toBe("localized_hypothesis");
    expect(diagnosis.confidence).toBe("low");
    expect(diagnosis.hypotheses).toHaveLength(1);
    expect(diagnosis.hypotheses[0]!.faultProfileRef).toBe("fp-routing-001");
    expect(diagnosis.fromFaultProfile).toBe(true);

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.members).toHaveLength(1);
    expect(verifyClusterInvariants(result.clusters[0]!)).toEqual([]);

    expect(result.packets).toHaveLength(1);
    const packet = result.packets[0]!;
    expect(packet.packetType).toBe("investigation");
    expect(packet.causalStatus).toBe("localized_hypothesis");
    expect(verifyPacketInvariants(packet)).toEqual([]);

    expect(Object.keys(result.prompts)).toHaveLength(1);
    const prompt = result.prompts[packet.packetId]!;
    expect(prompt).toContain(packet.packetId);
    expect(prompt).toContain(packet.integritySha256);
    expect(verifyPromptContent(prompt)).toEqual([]);
    expect(promptRefusesStale(prompt)).toBe(true);
    expect(promptForbidsFrozenStandardsModification(prompt)).toBe(true);
    expect(promptForbidsAutoPushMergeClose(prompt)).toBe(true);

    expect(result.published.diagnoses).toHaveLength(1);
    expect(result.published.clusters).toHaveLength(1);
    expect(result.published.packets).toHaveLength(1);
    const diagPublished = result.published.diagnoses[0]!;
    expect(diagPublished.artifactPath).toBe(`diagnoses/${diagnosis.diagnosisId}.json`);
    expect(diagPublished.sha256).toMatch(/^[a-f0-9]+$/);
  });

  it("publishes artifacts that can be read back from the artifact store", async () => {
    const runId = "pipeline-readback";
    const store = await makeStore(runId);
    const targets: DiagnosisTarget[] = [
      buildTarget(
        "scn-readback",
        [
          "routedMode != expectedMode",
          "selectedSkills 不包含 expectedSkill",
        ],
        findFaultProfile("fp-routing-001"),
      ),
    ];
    const result = await runDiagnosisPipeline(store, {
      runId,
      targets,
      createdAt: "2026-07-20T00:00:00Z",
    });

    const diagPath = result.published.diagnoses[0]!.artifactPath;
    const diagJson = await readFile(
      join(projectRoot, "agent-bridge", "artifacts", runId, diagPath),
      "utf-8",
    );
    const diag = JSON.parse(diagJson);
    expect(diag.diagnosisId).toBe(result.diagnoses[0]!.diagnosisId);

    const packetPath = result.published.packets[0]!.artifactPath;
    const packetJson = await readFile(
      join(projectRoot, "agent-bridge", "artifacts", runId, packetPath),
      "utf-8",
    );
    const packet = JSON.parse(packetJson);
    expect(packet.packetId).toBe(result.packets[0]!.packetId);
    expect(packet.integritySha256).toBe(result.packets[0]!.integritySha256);
  });

  it("produces an unresolved diagnosis when no fault profile matches", async () => {
    const runId = "pipeline-unresolved";
    const store = await makeStore(runId);
    const scenario: ScenarioContract = {
      schemaVersion: EVALUATION_SCHEMA_VERSION,
      scenarioId: "scn-unmatched",
      visible: { prompt: "unmatched prompt" },
      hidden: {
        expectedMode: "answer",
        maxLatencyMs: 30000,
        tokenBudget: { maxInputTokens: 1000, maxOutputTokens: 1000 },
        maxRequestCount: 5,
      },
    };
    const target: DiagnosisTarget = {
      scenario,
      observation: buildObservation("scn-unmatched"),
      grade: buildGrade("scn-unmatched", ["completely unknown failure mode"]),
    };
    const result = await runDiagnosisPipeline(store, {
      runId,
      targets: [target],
      createdAt: "2026-07-20T00:00:00Z",
    });
    expect(result.diagnoses).toHaveLength(1);
    const diagnosis = result.diagnoses[0]!;
    expect(diagnosis.causalStatus).toBe("unresolved");
    expect(diagnosis.confidence).toBe("very_low");
    expect(diagnosis.hypotheses).toHaveLength(0);
    expect(diagnosis.fromFaultProfile).toBe(false);
    const packet = result.packets[0]!;
    expect(packet.packetType).toBe("investigation");
  });

  it("promotes status to fault_injection_confirmed when a counterfactual supports it", async () => {
    const runId = "pipeline-counterfactual";
    const store = await makeStore(runId);
    const target = buildTarget(
      "scn-cf",
      ["routedMode != expectedMode: answer != action"],
      findFaultProfile("fp-routing-001"),
    );
    const result = await runDiagnosisPipeline(store, {
      runId,
      targets: [target],
      counterfactuals: {
        "scn-cf": {
          counterfactualId: "cf-1",
          baselineRunId: runId,
          interventionRunId: `${runId}-intervention`,
          changedFactor: {
            name: "routing_mode",
            baselineValue: "answer",
            interventionValue: "action",
          },
          unchangedFactors: [],
          resolvedModelConfirmed: true,
          modelDriftPossible: false,
          pairedManifestSha256: "0".repeat(64),
          baselineOutcome: {
            scenarioId: "scn-cf",
            finalStatus: "failed",
            hardGradePassed: false,
            sideEffectCount: 0,
            observationSha256: "0".repeat(64),
          },
          interventionOutcome: {
            scenarioId: "scn-cf",
            finalStatus: "completed",
            hardGradePassed: true,
            sideEffectCount: 0,
            observationSha256: "1".repeat(64),
          },
          outcomeChanged: true,
          supportsIntervention: true,
          createdAt: "2026-07-20T00:00:00Z",
        },
      },
      createdAt: "2026-07-20T00:00:00Z",
    });
    const diagnosis = result.diagnoses[0]!;
    expect(diagnosis.causalStatus).toBe("fault_injection_confirmed");
    expect(diagnosis.confidence).toBe("high");
    expect(diagnosis.counterfactualRunRef).toBe("cf-1");
  });

  it("does not artificially share evidence IDs across distinct scenarios", async () => {
    const runId = "pipeline-cluster";
    const store = await makeStore(runId);
    const targets: DiagnosisTarget[] = [
      buildTarget(
        "scn-cluster-a",
        ["routedMode != expectedMode: answer != action"],
        findFaultProfile("fp-routing-001"),
      ),
      buildTarget(
        "scn-cluster-b",
        ["routedMode != expectedMode: answer != action"],
        findFaultProfile("fp-routing-001"),
      ),
    ];
    const result = await runDiagnosisPipeline(store, {
      runId,
      targets,
      createdAt: "2026-07-20T00:00:00Z",
    });
    expect(result.diagnoses).toHaveLength(2);
    const d1 = result.diagnoses[0]!;
    const d2 = result.diagnoses[1]!;
    const d1Evidence = new Set(d1.evidence.map((e) => e.evidenceId));
    const d2Evidence = new Set(d2.evidence.map((e) => e.evidenceId));
    const shared = [...d1Evidence].filter((id) => d2Evidence.has(id));
    expect(shared).toHaveLength(0);
    const multiMemberClusters = result.clusters.filter((c) => c.members.length > 1);
    expect(multiMemberClusters).toHaveLength(0);
  });
});

describe("T46-4 diagnosis runner — benchmark pipeline", () => {
  it("synthesises all 3 required sample classes and the report passes gates", async () => {
    const runId = "benchmark-basic";
    const store = await makeStore(runId);
    const { report, published } = await runBenchmarkPipeline(store, {
      runId,
      createdAt: "2026-07-20T00:00:00Z",
    });

    const classes = new Set(report.samples.map((s) => s.sampleClass));
    expect(classes.has("correct_attribution")).toBe(true);
    expect(classes.has("confusable_neighbour")).toBe(true);
    expect(classes.has("unresolved_or_insufficient")).toBe(true);

    expect(report.passed).toBe(true);
    expect(report.failureReasons).toEqual([]);

    expect(published.artifactPath).toBe("rca-benchmark.json");
    expect(published.sha256).toMatch(/^[a-f0-9]+$/);
  });

  it("produces a correct_attribution sample for every benchmark-relevant profile", async () => {
    const runId = "benchmark-coverage";
    const store = await makeStore(runId);
    const { report } = await runBenchmarkPipeline(store, {
      runId,
      createdAt: "2026-07-20T00:00:00Z",
    });
    const benchmarkProfileIds = new Set(
      FAULT_PROFILE_CATALOG.filter((p) => p.benchmarkRelevant).map((p) => p.profileId),
    );
    const correctSamples = report.samples.filter((s) => s.sampleClass === "correct_attribution");
    for (const profileId of benchmarkProfileIds) {
      expect(
        correctSamples.some((s) => s.faultProfileId === profileId),
      ).toBe(true);
    }
  });

  it("produces at least one confusable_neighbour sample", async () => {
    const runId = "benchmark-confusable";
    const store = await makeStore(runId);
    const { report } = await runBenchmarkPipeline(store, {
      runId,
      createdAt: "2026-07-20T00:00:00Z",
    });
    const confusable = report.samples.filter((s) => s.sampleClass === "confusable_neighbour");
    expect(confusable.length).toBeGreaterThanOrEqual(1);
    for (const sample of confusable) {
      expect(sample.falseAttribution).toBe(true);
      expect(sample.top1Correct).toBe(false);
    }
  });

  it("produces at least one unresolved_or_insufficient sample", async () => {
    const runId = "benchmark-unresolved";
    const store = await makeStore(runId);
    const { report } = await runBenchmarkPipeline(store, {
      runId,
      createdAt: "2026-07-20T00:00:00Z",
    });
    const unresolved = report.samples.filter((s) => s.sampleClass === "unresolved_or_insufficient");
    expect(unresolved.length).toBeGreaterThanOrEqual(1);
    for (const sample of unresolved) {
      expect(sample.unresolvedReported).toBe(true);
      expect(sample.top1Correct).toBe(false);
    }
  });

  it("publishes the benchmark report to the SHA-256 result graph", async () => {
    const runId = "benchmark-publish";
    const store = await makeStore(runId);
    const { published } = await runBenchmarkPipeline(store, {
      runId,
      createdAt: "2026-07-20T00:00:00Z",
    });
    const reportJson = await readFile(
      join(projectRoot, "agent-bridge", "artifacts", runId, published.artifactPath),
      "utf-8",
    );
    const report = JSON.parse(reportJson);
    expect(report.passed).toBe(true);
    expect(report.samples.length).toBeGreaterThan(0);
  });

  it("uses pre-computed diagnoses when provided", async () => {
    const runId = "benchmark-precomputed";
    const store = await makeStore(runId);
    const firstProfile = FAULT_PROFILE_CATALOG.find((p) => p.benchmarkRelevant)!;
    const wrongDiagnosis = {
      diagnosisId: "diag-wrong",
      runId,
      scenarioId: `bench-${firstProfile.profileId}`,
      observationId: `obs-bench-${firstProfile.profileId}`,
      observedSymptom: firstProfile.symptom.description,
      expectedContract: firstProfile.symptom.expectedContract,
      causalStatus: "unresolved" as const,
      confidence: "very_low" as const,
      evidence: [{
        evidenceId: "evid-wrong",
        kind: "conflicting_evidence" as const,
        summary: "wrong diagnosis",
        reference: "observations/bench.json",
        facts: {},
      }],
      hypotheses: [],
      fromFaultProfile: false,
      createdAt: "2026-07-20T00:00:00Z",
    };
    const { report } = await runBenchmarkPipeline(store, {
      runId,
      createdAt: "2026-07-20T00:00:00Z",
      diagnosesByProfile: {
        [firstProfile.profileId]: wrongDiagnosis,
      },
    });
    const sample = report.samples.find((s) => s.faultProfileId === firstProfile.profileId);
    expect(sample).toBeDefined();
    expect(sample!.sampleClass).toBe("unresolved_or_insufficient");
  });
});

describe("T46-4 diagnosis runner — boundary invariants", () => {
  it("the runner writes artifacts only under the run's artifacts directory", async () => {
    const runId = "boundary-worktree";
    const store = await makeStore(runId);
    const targets: DiagnosisTarget[] = [
      buildTarget(
        "scn-boundary",
        ["routedMode != expectedMode"],
        findFaultProfile("fp-routing-001"),
      ),
    ];
    await runDiagnosisPipeline(store, {
      runId,
      targets,
      createdAt: "2026-07-20T00:00:00Z",
    });
    const diagPath = join(
      projectRoot,
      "agent-bridge",
      "artifacts",
      runId,
      "diagnoses",
      "diag-scn-boundary.json",
    );
    const content = await readFile(diagPath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });

  it("every published packet satisfies verifyPacketInvariants", async () => {
    const runId = "boundary-invariants";
    const store = await makeStore(runId);
    const targets: DiagnosisTarget[] = [
      buildTarget("scn-inv-1", ["routedMode != expectedMode"], findFaultProfile("fp-routing-001")),
      buildTarget("scn-inv-2", ["selectedSkills 不包含 expectedSkill"], findFaultProfile("fp-skill-001")),
    ];
    const result = await runDiagnosisPipeline(store, {
      runId,
      targets,
      createdAt: "2026-07-20T00:00:00Z",
    });
    for (const packet of result.packets) {
      const violations = verifyPacketInvariants(packet);
      expect(violations).toEqual([]);
    }
  });

  it("every published cluster satisfies verifyClusterInvariants", async () => {
    const runId = "boundary-clusters";
    const store = await makeStore(runId);
    const targets: DiagnosisTarget[] = [
      buildTarget("scn-cl-1", ["routedMode != expectedMode"], findFaultProfile("fp-routing-001")),
    ];
    const result = await runDiagnosisPipeline(store, {
      runId,
      targets,
      createdAt: "2026-07-20T00:00:00Z",
    });
    for (const cluster of result.clusters) {
      const violations = verifyClusterInvariants(cluster);
      expect(violations).toEqual([]);
    }
  });

  it("every generated prompt satisfies verifyPromptContent and stale-refusal", async () => {
    const runId = "boundary-prompts";
    const store = await makeStore(runId);
    const targets: DiagnosisTarget[] = [
      buildTarget("scn-prompt-1", ["routedMode != expectedMode"], findFaultProfile("fp-routing-001")),
    ];
    const result = await runDiagnosisPipeline(store, {
      runId,
      targets,
      createdAt: "2026-07-20T00:00:00Z",
    });
    for (const packetId of Object.keys(result.prompts)) {
      const prompt = result.prompts[packetId]!;
      expect(verifyPromptContent(prompt)).toEqual([]);
      expect(promptRefusesStale(prompt)).toBe(true);
      expect(promptForbidsFrozenStandardsModification(prompt)).toBe(true);
      expect(promptForbidsAutoPushMergeClose(prompt)).toBe(true);
    }
  });

  it("the diagnosis runner never produces a fix packet when status is localized_hypothesis only", async () => {
    const runId = "boundary-no-fix";
    const store = await makeStore(runId);
    const targets: DiagnosisTarget[] = [
      buildTarget("scn-no-fix", ["routedMode != expectedMode"], findFaultProfile("fp-routing-001")),
    ];
    const result = await runDiagnosisPipeline(store, {
      runId,
      targets,
      createdAt: "2026-07-20T00:00:00Z",
    });
    const packet = result.packets[0]!;
    expect(packet.causalStatus).toBe("localized_hypothesis");
    expect(packet.packetType).toBe("investigation");
  });
});

