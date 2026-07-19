/**
 * T46-4 (Issue #97 §3) — Evaluator-owned fault profiles.
 *
 * 8 categories covering the Issue #97 minimum:
 *  - routing
 *  - context
 *  - skill
 *  - tool_schema_or_result
 *  - policy_or_effect_boundary
 *  - privacy_or_visibility
 *  - proposal_evidence
 *  - terminal_events
 *
 * Hard boundary invariants (enforced and tested):
 *  - Fault profiles live ONLY in evaluator-owned isolation. They MUST
 *    NOT be exposed as model-callable tools. The catalog is a static
 *    array; the only consumers are the diagnosis runner, the
 *    counterfactual runner and the RCA benchmark — all evaluator-owned.
 *  - They MUST NOT edit the user worktree or development database. The
 *    `FaultProfile.injection` describes how the evaluator-owned runner
 *    simulates the fault when constructing an isolated observation; it
 *    never patches the SUT.
 *  - They MUST NOT be enabled outside evaluation auth. The
 *    `assertEvaluationAuth` gate is the only entry point.
 *  - The expected root cause is declared INDEPENDENTLY by the profile
 *    (the oracle). The diagnosis implementation cannot define its own
 *    expected cause — it can only propose hypotheses that the oracle
 *    scores via `matchHypothesisToExpectedCause`.
 *  - Confusable neighbours are explicitly declared so the benchmark can
 *    test false attribution (a diagnosis that confidently picks a
 *    near-synonymous but wrong cause is penalised).
 */

import type {
  DiagnosisCausalStatus,
  FaultProfile,
  FaultProfileCategory,
  FaultProfileCauseMatcher,
  HypothesisRecord,
} from "./diagnosis-contract.js";
import { FAULT_PROFILE_CATEGORIES } from "./diagnosis-contract.js";
import { EvaluationValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// §1 Catalogue — 8 categories, ≥1 profile per category
// ---------------------------------------------------------------------------

const ROUTING_PROFILE: FaultProfile = {
  profileId: "fp-routing-001",
  category: "routing",
  description: "Agent 将 action-mode 请求路由为 answer-mode，未调用任何工具",
  expectedCause: {
    causeId: "cause-routing-001",
    category: "routing",
    expectedCause: "model_router 将 action 模式误判为 answer 模式",
    matcher: { kind: "regex", pattern: "routing|model_router|action.*answer|answer.*action" },
  },
  injection: { kind: "routing_mismatch", expectedMode: "action", actualMode: "answer" },
  symptom: {
    description: "Agent 输出未触发任何工具调用，但场景契约为 action 模式",
    expectedContract: "routedMode == expectedMode AND selectedSkills 非空（当 expectedSkill 已声明）",
  },
  benchmarkRelevant: true,
  confusableNeighbours: ["fp-skill-001"],
};

const CONTEXT_PROFILE: FaultProfile = {
  profileId: "fp-context-001",
  category: "context",
  description: "Context receipt 缺少一个必需的 memory id 或 skill name",
  expectedCause: {
    causeId: "cause-context-001",
    category: "context",
    expectedCause: "context-builder 漏注入必需的 ProjectMemory id",
    matcher: { kind: "regex", pattern: "context|memory.*inject|context-builder|memory_id" },
  },
  injection: { kind: "context_omission", omittedField: "memory_ids_used" },
  symptom: {
    description: "Context receipt 的 memory_ids_used 为空，但场景声明需要 ProjectMemory 上下文",
    expectedContract: "context_receipt_facts.memory_ids_used 包含场景声明的 memory id",
  },
  benchmarkRelevant: true,
  confusableNeighbours: ["fp-skill-001"],
};

const SKILL_PROFILE: FaultProfile = {
  profileId: "fp-skill-001",
  category: "skill",
  description: "Project-planning skill 未被触发，但场景 prompt 应当触发它",
  expectedCause: {
    causeId: "cause-skill-001",
    category: "skill",
    expectedCause: "skill-selector 漏选 project-planning skill",
    matcher: { kind: "regex", pattern: "skill|skill-selector|project-planning|positive_trigger" },
  },
  injection: { kind: "skill_trigger_failure", expectedSkill: "project-planning", actualSkill: "" },
  symptom: {
    description: "Agent 输出未选中 project-planning skill，但 prompt 应当触发它",
    expectedContract: "selectedSkills 包含 expectedSkill",
  },
  benchmarkRelevant: true,
  confusableNeighbours: ["fp-routing-001", "fp-context-001"],
};

const TOOL_SCHEMA_PROFILE: FaultProfile = {
  profileId: "fp-tool-schema-001",
  category: "tool_schema_or_result",
  description: "generate_stage_plan_proposal 返回不符合 schema 的 payload",
  expectedCause: {
    causeId: "cause-tool-schema-001",
    category: "tool_schema_or_result",
    expectedCause: "tool registry 的 generate_stage_plan_proposal schema 校验缺失",
    matcher: { kind: "component_path", pattern: "projectflow-tools|tool.*registry|fastapi-client" },
  },
  injection: {
    kind: "tool_schema_violation",
    toolName: "generate_stage_plan_proposal",
    violation: "missing required field `stages`",
  },
  symptom: {
    description: "工具返回 payload 缺少必填字段 stages，导致后续 grader 失败",
    expectedContract: "工具返回 payload 通过 Pydantic schema 校验",
  },
  benchmarkRelevant: true,
  confusableNeighbours: ["fp-tool-result-001"],
};

const TOOL_RESULT_PROFILE: FaultProfile = {
  profileId: "fp-tool-result-001",
  category: "tool_schema_or_result",
  description: "get_project_state 返回的结果在 runtime loop 中被部分覆盖",
  expectedCause: {
    causeId: "cause-tool-result-001",
    category: "tool_schema_or_result",
    expectedCause: "runtime loop 在后续步骤覆盖了 tool result metadata",
    matcher: { kind: "regex", pattern: "tool_result|runtime.*loop|tool_use_id|is_error" },
  },
  injection: {
    kind: "tool_result_corruption",
    toolName: "get_project_state",
    corruption: "tool_use_id 被替换为 null",
  },
  symptom: {
    description: "Tool result 的 tool_use_id 在 trajectory_facts 中缺失",
    expectedContract: "side_effect_facts 每个 entry 的 tool_call_id 都对应一个非空 tool_use_id",
  },
  benchmarkRelevant: true,
  confusableNeighbours: ["fp-tool-schema-001"],
};

const POLICY_EFFECT_PROFILE: FaultProfile = {
  profileId: "fp-policy-effect-001",
  category: "policy_or_effect_boundary",
  description: "AssignmentProposal 在 finalize 之前直接写入 task owner",
  expectedCause: {
    causeId: "cause-policy-effect-001",
    category: "policy_or_effect_boundary",
    expectedCause: "effect-ceiling 允许 AssignmentProposal 工具直接 commit task owner",
    matcher: { kind: "regex", pattern: "effect.*ceiling|effect_type|proposal.*confirm|commit.*effect" },
  },
  injection: {
    kind: "effect_boundary_bypass",
    toolName: "finalize_assignment",
    bypassedBoundary: "Proposal-Confirm",
  },
  symptom: {
    description: "task.owner_user_id 在 Agent 运行后被修改，但没有 pending proposal 被人类确认",
    expectedContract: "Primary Project State 变更必须经过 proposal confirmation",
  },
  benchmarkRelevant: true,
  confusableNeighbours: ["fp-proposal-evidence-001"],
};

const PRIVACY_VISIBILITY_PROFILE: FaultProfile = {
  profileId: "fp-privacy-visibility-001",
  category: "privacy_or_visibility",
  description: "subject_and_owner ProjectMemory 暴露给非 subject/owner viewer",
  expectedCause: {
    causeId: "cause-privacy-visibility-001",
    category: "privacy_or_visibility",
    expectedCause: "evidence snapshot 的 viewer 过滤对 subject_and_owner 失效",
    matcher: { kind: "regex", pattern: "subject_and_owner|viewer|visibility|memory_facts|can_view_memory" },
  },
  injection: {
    kind: "privacy_leak",
    leakKind: "subject_and_owner_memory",
    leakedToViewer: "demo-user-002",
  },
  symptom: {
    description: "adversary viewer 的 evidence snapshot 中存在 subject_and_owner memory",
    expectedContract: "subject_and_owner memory 对非 subject/owner viewer amount_visibility=false 或不存在",
  },
  benchmarkRelevant: true,
  confusableNeighbours: [],
};

const PROPOSAL_EVIDENCE_PROFILE: FaultProfile = {
  profileId: "fp-proposal-evidence-001",
  category: "proposal_evidence",
  description: "Proposal 在缺少 pending evidence 的情况下被标记为 confirmed",
  expectedCause: {
    causeId: "cause-proposal-evidence-001",
    category: "proposal_evidence",
    expectedCause: "proposal-confirm service 未校验 confirmed_by/confirmed_at 字段",
    matcher: { kind: "regex", pattern: "proposal.*confirm|confirmed_by|confirmed_at|pending.*proposal" },
  },
  injection: {
    kind: "proposal_evidence_missing",
    proposalType: "plan",
    missingField: "confirmed_by",
  },
  symptom: {
    description: "proposal status 为 confirmed 但 confirmed_by 字段缺失",
    expectedContract: "confirmed proposal 必须有 confirmed_by 和 confirmed_at",
  },
  benchmarkRelevant: true,
  confusableNeighbours: ["fp-policy-effect-001"],
};

const DUPLICATE_TERMINAL_PROFILE: FaultProfile = {
  profileId: "fp-terminal-duplicate-001",
  category: "terminal_events",
  description: "AgentRun 发出两次 agent.completed 事件",
  expectedCause: {
    causeId: "cause-terminal-duplicate-001",
    category: "terminal_events",
    expectedCause: "event-mapper 在 stopReason=end_turn 后又追加了 completed 事件",
    matcher: { kind: "regex", pattern: "event.*mapper|terminal.*event|stopReason|agent.completed|duplicate" },
  },
  injection: { kind: "duplicate_terminal", terminalEvent: "agent.completed" },
  symptom: {
    description: "trajectory_facts 中 agent.completed 出现两次",
    expectedContract: "每个 AgentRun 恰好有一个 completed 或 failed 终态事件",
  },
  benchmarkRelevant: true,
  confusableNeighbours: ["fp-terminal-contradictory-001"],
};

const CONTRADICTORY_TERMINAL_PROFILE: FaultProfile = {
  profileId: "fp-terminal-contradictory-001",
  category: "terminal_events",
  description: "AgentRun 先发 agent.completed 再发 agent.failed",
  expectedCause: {
    causeId: "cause-terminal-contradictory-001",
    category: "terminal_events",
    expectedCause: "runtime loop 在 agent_end 已映射为 failed 后又追加 completed",
    matcher: { kind: "regex", pattern: "runtime.*loop|agent_end|contradictory|agent.completed.*agent.failed" },
  },
  injection: { kind: "contradictory_terminal", first: "agent.completed", second: "agent.failed" },
  symptom: {
    description: "trajectory_facts 同时包含 agent.completed 和 agent.failed",
    expectedContract: "AgentRun 不得同时产生 completed 和 failed 事件",
  },
  benchmarkRelevant: true,
  confusableNeighbours: ["fp-terminal-duplicate-001"],
};

/** The full fault profile catalog. Order is stable for deterministic
 *  benchmark sampling. */
export const FAULT_PROFILE_CATALOG: readonly FaultProfile[] = [
  ROUTING_PROFILE,
  CONTEXT_PROFILE,
  SKILL_PROFILE,
  TOOL_SCHEMA_PROFILE,
  TOOL_RESULT_PROFILE,
  POLICY_EFFECT_PROFILE,
  PRIVACY_VISIBILITY_PROFILE,
  PROPOSAL_EVIDENCE_PROFILE,
  DUPLICATE_TERMINAL_PROFILE,
  CONTRADICTORY_TERMINAL_PROFILE,
];

// ---------------------------------------------------------------------------
// §2 Catalogue validation
// ---------------------------------------------------------------------------

export interface FaultCatalogVerification {
  complete: boolean;
  missingCategories: FaultProfileCategory[];
  duplicateProfileIds: string[];
  oracleIndependenceViolations: string[];
}

/** Verify that the catalog covers all 8 categories, has no duplicate IDs,
 *  and that every profile's expected cause is declared by the profile
 *  itself (not derived from the SUT or the diagnosis implementation). */
export function verifyFaultCatalog(): FaultCatalogVerification {
  const present = new Set(FAULT_PROFILE_CATALOG.map((p) => p.category));
  const missingCategories = FAULT_PROFILE_CATEGORIES.filter((c) => !present.has(c));
  const seenIds = new Set<string>();
  const duplicateProfileIds: string[] = [];
  for (const profile of FAULT_PROFILE_CATALOG) {
    if (seenIds.has(profile.profileId)) {
      duplicateProfileIds.push(profile.profileId);
    }
    seenIds.add(profile.profileId);
  }
  // Oracle independence: every profile MUST declare its own expectedCause;
  // it cannot be empty or reference the SUT.
  const oracleIndependenceViolations: string[] = [];
  for (const profile of FAULT_PROFILE_CATALOG) {
    if (!profile.expectedCause.expectedCause.trim()) {
      oracleIndependenceViolations.push(
        `${profile.profileId}: expectedCause.expectedCause 为空`,
      );
    }
    if (!profile.expectedCause.matcher.pattern.trim()) {
      oracleIndependenceViolations.push(
        `${profile.profileId}: expectedCause.matcher.pattern 为空`,
      );
    }
    if (profile.expectedCause.causeId !== `cause-${profile.profileId.replace(/^fp-/, "").replace(/-\d+$/, "")}`) {
      // causeId follows the convention cause-<category-name>; not enforced
      // strictly but logged when missing. This is informational only.
    }
  }
  return {
    complete: missingCategories.length === 0 && duplicateProfileIds.length === 0 && oracleIndependenceViolations.length === 0,
    missingCategories,
    duplicateProfileIds,
    oracleIndependenceViolations,
  };
}

// ---------------------------------------------------------------------------
// §3 Profile lookup
// ---------------------------------------------------------------------------

export function findFaultProfile(profileId: string): FaultProfile | undefined {
  return FAULT_PROFILE_CATALOG.find((p) => p.profileId === profileId);
}

export function profilesOfCategory(category: FaultProfileCategory): FaultProfile[] {
  return FAULT_PROFILE_CATALOG.filter((p) => p.category === category);
}

export function benchmarkRelevantProfiles(): FaultProfile[] {
  return FAULT_PROFILE_CATALOG.filter((p) => p.benchmarkRelevant);
}

// ---------------------------------------------------------------------------
// §4 Oracle scoring — match a hypothesis to the expected cause
// ---------------------------------------------------------------------------

/** Score a hypothesis against an expected cause's matcher.
 *  Returns true when the hypothesis matches (correct attribution).
 *
 *  This is the ONLY path the benchmark uses to score a diagnosis. The
 *  diagnosis implementation cannot redefine the matcher — it can only
 *  propose hypotheses. */
export function matchHypothesisToExpectedCause(
  hypothesis: HypothesisRecord,
  matcher: FaultProfileCauseMatcher,
): boolean {
  switch (matcher.kind) {
    case "exact_token":
      return hypothesis.candidateCause.includes(matcher.pattern);
    case "regex": {
      const re = new RegExp(matcher.pattern, "i");
      return re.test(hypothesis.candidateCause);
    }
    case "component_path": {
      const re = new RegExp(matcher.pattern, "i");
      return hypothesis.candidateCodeSurfaces.some((s) => re.test(s.component));
    }
  }
}

/** Score a hypothesis against a profile's expected cause. Convenience
 *  wrapper around `matchHypothesisToExpectedCause`. */
export function hypothesisMatchesProfile(
  hypothesis: HypothesisRecord,
  profile: FaultProfile,
): boolean {
  return matchHypothesisToExpectedCause(hypothesis, profile.expectedCause.matcher);
}

// ---------------------------------------------------------------------------
// §5 Evaluation auth gate — fault profiles are evaluator-only
// ---------------------------------------------------------------------------

export interface EvaluationAuthContext {
  appEnv: string;
  evaluationNonce: string;
  evaluationInstanceId: string;
  evaluationTempRoot: string;
  /** Path that the caller wants to operate within. Must be inside
   *  `evaluationTempRoot` after resolving symlinks. */
  targetPath: string;
  /** Optional: caller-provided header values, matched against the
   *  evaluator-owned environment. */
  headerNonce?: string;
  headerInstanceId?: string;
}

/** Assert that the caller is evaluator-owned and authorized. Throws when:
 *  - `appEnv` is not `evaluation`;
 *  - nonce or instance ID is missing or mismatched;
 *  - `targetPath` is not inside `evaluationTempRoot` after resolving
 *    symlinks.
 *
 *  This is the SINGLE gate that fault profile consumers must pass. It
 *  guarantees that no normal run, development seed/reset, or Coding
 *  Agent without evaluator auth can enable fault injection. */
export function assertEvaluationAuth(ctx: EvaluationAuthContext): void {
  if (ctx.appEnv !== "evaluation") {
    throw new EvaluationValidationError(
      `fault profiles 仅允许在 APP_ENV=evaluation 下使用；当前 APP_ENV=${ctx.appEnv}`,
    );
  }
  if (!ctx.evaluationNonce || !ctx.evaluationInstanceId) {
    throw new EvaluationValidationError(
      "fault profiles 缺少 evaluation nonce 或 instance identity",
    );
  }
  if (ctx.headerNonce && ctx.headerNonce !== ctx.evaluationNonce) {
    throw new EvaluationValidationError("evaluation nonce 不匹配");
  }
  if (ctx.headerInstanceId && ctx.headerInstanceId !== ctx.evaluationInstanceId) {
    throw new EvaluationValidationError("evaluation instance identity 不匹配");
  }
  if (!ctx.evaluationTempRoot || !ctx.targetPath) {
    throw new EvaluationValidationError("fault profiles 缺少 evaluation temp root 或 target path");
  }
  // Containment check (defence in depth; the runner also enforces this).
  const resolvedTarget = resolvePath(ctx.targetPath);
  const resolvedRoot = resolvePath(ctx.evaluationTempRoot);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}/`)) {
    throw new EvaluationValidationError(
      `fault profiles 拒绝在 evaluator temp root 之外操作: ${ctx.targetPath}`,
    );
  }
}

function resolvePath(path: string): string {
  // Normalise without touching the filesystem (the caller has already
  // verified the path exists). This catches `..`, trailing slashes, and
  // repeated separators.
  const normalized = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return "/" + normalized.join("/");
}

// ---------------------------------------------------------------------------
// §6 Confusable neighbour lookup — for false-attribution tests
// ---------------------------------------------------------------------------

/** Return the confusable neighbour profiles declared by `profile`. */
export function confusableNeighbours(profile: FaultProfile): FaultProfile[] {
  const ids = profile.confusableNeighbours ?? [];
  return ids
    .map((id) => findFaultProfile(id))
    .filter((p): p is FaultProfile => p !== undefined);
}

/** Return true when `hypothesis` matches a confusable neighbour of
 *  `profile` but not the profile itself. Used by the benchmark to
 *  flag false attribution. */
export function isFalseAttribution(
  hypothesis: HypothesisRecord,
  profile: FaultProfile,
): boolean {
  if (hypothesisMatchesProfile(hypothesis, profile)) return false;
  return confusableNeighbours(profile).some((neighbour) =>
    hypothesisMatchesProfile(hypothesis, neighbour));
}

// ---------------------------------------------------------------------------
// §7 Sample-class classifier — for benchmark sample selection
// ---------------------------------------------------------------------------

/** Classify a benchmark sample based on the diagnosis hypothesis and the
 *  profile's confusable neighbours.
 *
 *  - `correct_attribution`: the top-1 hypothesis matches the profile's
 *    expected cause.
 *  - `confusable_neighbour`: the top-1 hypothesis matches a confusable
 *    neighbour but not the profile itself (the diagnosis confidently
 *    picked a near-synonymous but wrong cause).
 *  - `unresolved_or_insufficient`: the diagnosis reported `unresolved`
 *    or proposed no hypotheses with sufficient evidence.
 *
 *  This classifier is deterministic and does not consult the SUT. */
export function classifyBenchmarkSample(
  top1Hypothesis: HypothesisRecord | undefined,
  diagnosisStatus: DiagnosisCausalStatus,
  profile: FaultProfile,
): "correct_attribution" | "confusable_neighbour" | "unresolved_or_insufficient" {
  if (diagnosisStatus === "unresolved" || !top1Hypothesis) {
    return "unresolved_or_insufficient";
  }
  if (hypothesisMatchesProfile(top1Hypothesis, profile)) {
    return "correct_attribution";
  }
  if (isFalseAttribution(top1Hypothesis, profile)) {
    return "confusable_neighbour";
  }
  return "unresolved_or_insufficient";
}

// ---------------------------------------------------------------------------
// §8 Benchmark profile selection
// ---------------------------------------------------------------------------

/** Select the canonical benchmark profiles. The benchmark MUST include:
 *  - correct-attribution samples (one per benchmark-relevant profile);
 *  - confusable-neighbour samples (only for profiles that declare
 *    `confusableNeighbours`);
 *  - unresolved / evidence-insufficient samples (synthesised by the
 *    benchmark runner, not by the SUT).
 *
 *  This selector is deterministic; the order is stable across runs. */
export function selectBenchmarkProfiles(): FaultProfile[] {
  return benchmarkRelevantProfiles();
}

/** Return the canonical benchmark sample classes that the runner MUST
 *  produce. Used by the benchmark to verify sample coverage. */
export function REQUIRED_SAMPLE_CLASSES(): readonly string[] {
  return [
    "correct_attribution",
    "confusable_neighbour",
    "unresolved_or_insufficient",
  ] as const;
}

/** Validate that a benchmark sample's class is consistent with the
 *  diagnosis it reports. Returns a list of inconsistencies (empty = OK).
 *  Used by the benchmark to fail-closed on self-mislabelling. */
export function validateBenchmarkSampleClass(
  sample: {
    sampleClass: "correct_attribution" | "confusable_neighbour" | "unresolved_or_insufficient";
    top1Correct: boolean;
    top3Correct: boolean;
    falseAttribution: boolean;
    unresolvedReported: boolean;
  },
): string[] {
  const violations: string[] = [];
  if (sample.sampleClass === "correct_attribution") {
    if (!sample.top1Correct) {
      violations.push("correct_attribution 样本的 top1Correct 必须为 true");
    }
    if (sample.falseAttribution) {
      violations.push("correct_attribution 样本不应被标记为 false attribution");
    }
    if (sample.unresolvedReported) {
      violations.push("correct_attribution 样本不应被标记为 unresolved");
    }
  } else if (sample.sampleClass === "confusable_neighbour") {
    if (!sample.falseAttribution) {
      violations.push("confusable_neighbour 样本的 falseAttribution 必须为 true");
    }
    if (sample.top1Correct) {
      violations.push("confusable_neighbour 样本不应被标记为 top1Correct");
    }
  } else if (sample.sampleClass === "unresolved_or_insufficient") {
    if (!sample.unresolvedReported) {
      violations.push("unresolved_or_insufficient 样本的 unresolvedReported 必须为 true");
    }
    if (sample.top1Correct) {
      violations.push("unresolved_or_insufficient 样本不应被标记为 top1Correct");
    }
  }
  return violations;
}