/**
 * T46-2 (Issue #95 §6) — Mutation testing harness for hard graders.
 *
 * Each declared hard grader must have a mutation test that proves the
 * grader detects the failure it is supposed to detect. Mutations only
 * modify evidence, contract or grader inputs — they do NOT modify the
 * user worktree, do NOT implement #97's fault-injection system, and do
 * NOT touch runtime, router, verifier or business service code.
 *
 * The harness is intentionally minimal:
 * - It takes a baseline {@link HardGraderInput} that passes all graders.
 * - It takes a list of named mutations, each producing a modified input.
 * - It runs {@link gradeHard} on each mutated input and reports whether
 *   the mutation was detected (i.e., the overall `passed` flag flipped
 *   to false, or a specific grader flipped to false).
 *
 * P0 requirement: all declared P0 mutations must be detected. The
 * mutation registry in `mutation-registry.ts` declares which mutations
 * are P0 for each grader.
 *
 * Reference Program requirement: the Reference Program must produce zero
 * false hard failures. This is verified separately in
 * `reference-program.test.ts` by running the reference through the public
 * seam and applying `gradeHard` — the result must pass all graders.
 */

import { gradeHard } from "./hard-graders.js";
import type { HardGrade, HardGraderName } from "./contract-v2.js";
import type { HardGraderInput } from "./hard-graders.js";

export interface MutationCase {
  /** Stable mutation identifier, e.g. "finalOutcome-wrong-status". */
  id: string;
  /** The grader this mutation targets. Used to verify the right grader
   * flipped, not just the overall `passed` flag. */
  targets: HardGraderName;
  /** Human-readable description of what the mutation changes. */
  description: string;
  /** Apply the mutation to a copy of the baseline input. Must NOT mutate
   * the baseline. */
  apply: (input: HardGraderInput) => HardGraderInput;
}

export interface MutationRunResult {
  mutationId: string;
  targets: HardGraderName;
  detected: boolean;
  /** True if the targeted grader specifically flipped to false. */
  targetedGraderFlipped: boolean;
  /** The hard grade produced by the mutated input. */
  mutatedGrade: HardGrade;
  /** Failure messages from the mutated grade (for diagnostics). */
  failures: string[];
}

/**
 * Run a single mutation case against a baseline input and report whether
 * the mutation was detected.
 *
 * A mutation is "detected" if either:
 * 1. The overall `passed` flag flipped to false, OR
 * 2. The targeted grader's flag flipped to false.
 *
 * Detection by the targeted grader is the stronger signal; detection by
 * any grader is sufficient for the mutation to count as detected.
 */
export function runMutation(
  baseline: HardGraderInput,
  mutation: MutationCase,
): MutationRunResult {
  const mutatedInput = mutation.apply(baseline);
  const mutatedGrade = gradeHard(mutatedInput);
  const detected = !mutatedGrade.passed || mutatedGrade.graders[mutation.targets] === false;
  const targetedGraderFlipped = mutatedGrade.graders[mutation.targets] === false;
  return {
    mutationId: mutation.id,
    targets: mutation.targets,
    detected,
    targetedGraderFlipped,
    mutatedGrade,
    failures: mutatedGrade.failures,
  };
}

export interface MutationSuiteResult {
  total: number;
  detected: number;
  missed: Array<{ mutationId: string; targets: HardGraderName }>;
  results: MutationRunResult[];
}

/**
 * Run a suite of mutation cases against a baseline input.
 *
 * Returns a summary with the total count, detected count, and a list of
 * missed mutations (mutations that were NOT detected by any grader).
 */
export function runMutationSuite(
  baseline: HardGraderInput,
  mutations: MutationCase[],
): MutationSuiteResult {
  const results = mutations.map((m) => runMutation(baseline, m));
  const missed = results
    .filter((r) => !r.detected)
    .map((r) => ({ mutationId: r.mutationId, targets: r.targets }));
  return {
    total: mutations.length,
    detected: results.filter((r) => r.detected).length,
    missed,
    results,
  };
}

// ---------------------------------------------------------------------------
// Deep-clone helper — mutations must not modify the baseline.
// ---------------------------------------------------------------------------

/**
 * Deep-clone a HardGraderInput using JSON serialization.
 *
 * HardGraderInput contains only JSON-serializable data (no functions,
 * no Dates, no undefined properties that would be lost). JSON clone is
 * sufficient and avoids structuredClone's edge cases with class
 * instances.
 */
export function cloneInput(input: HardGraderInput): HardGraderInput {
  return JSON.parse(JSON.stringify(input)) as HardGraderInput;
}

// ---------------------------------------------------------------------------
// Mutation factories for common patterns.
// ---------------------------------------------------------------------------

/**
 * Create a mutation that flips a state constraint value.
 *
 * @param path Dotted path into state_facts.
 * @param newValue The mutated value.
 * @param targets The grader this mutation targets (usually "stateConstraints").
 */
export function mutateStatePath(
  path: string,
  newValue: unknown,
  targets: HardGraderName = "stateConstraints",
): MutationCase {
  return {
    id: `state-${path}-${JSON.stringify(newValue)}`,
    targets,
    description: `修改 state_facts.${path} 为 ${JSON.stringify(newValue)}`,
    apply: (input) => {
      const cloned = cloneInput(input);
      const segments = path.split(".");
      let current: unknown = cloned.primarySnapshot.state_facts;
      for (let i = 0; i < segments.length - 1; i++) {
        const segment = segments[i];
        if (segment === undefined) return cloned;
        if (Array.isArray(current)) {
          current = current[Number(segment)];
        } else if (current && typeof current === "object") {
          current = (current as Record<string, unknown>)[segment];
        }
      }
      const lastSegment = segments[segments.length - 1];
      if (lastSegment === undefined) return cloned;
      if (Array.isArray(current)) {
        current[Number(lastSegment)] = newValue;
      } else if (current && typeof current === "object") {
        (current as Record<string, unknown>)[lastSegment] = newValue;
      }
      return cloned;
    },
  };
}

/**
 * Create a mutation that adds a side effect to the primary snapshot.
 */
export function mutateAddSideEffect(
  toolName: string,
  effectType: string,
  targets: HardGraderName,
): MutationCase {
  return {
    id: `add-side-effect-${toolName}-${effectType}`,
    targets,
    description: `添加副作用: tool=${toolName}, effect_type=${effectType}`,
    apply: (input) => {
      const cloned = cloneInput(input);
      cloned.primarySnapshot.side_effect_facts.push({
        tool_call_id: `mutated-${Date.now()}`,
        status: "completed",
        effect_type: effectType,
        tool_name: toolName,
      });
      return cloned;
    },
  };
}

/**
 * Create a mutation that removes a proposal from the primary snapshot.
 */
export function mutateRemoveProposal(
  proposalType: string,
  status: string,
  targets: HardGraderName = "proposalConfirm",
): MutationCase {
  return {
    id: `remove-proposal-${proposalType}-${status}`,
    targets,
    description: `移除 ${proposalType} (status=${status}) 提案`,
    apply: (input) => {
      const cloned = cloneInput(input);
      cloned.primarySnapshot.proposal_facts = cloned.primarySnapshot.proposal_facts.filter(
        (p) => !(p.proposal_type === proposalType && p.status === status),
      );
      return cloned;
    },
  };
}

/**
 * Create a mutation that adds a private conversation to the adversary snapshot.
 */
export function mutateLeakConversationToAdversary(
  conversationId: string,
  targets: HardGraderName = "privateConversationVisibility",
): MutationCase {
  return {
    id: `leak-conv-${conversationId}`,
    targets,
    description: `向 adversary 快照泄露会话 ${conversationId}`,
    apply: (input) => {
      const cloned = cloneInput(input);
      if (!cloned.adversarySnapshot) {
        // Create a minimal adversary snapshot if none exists.
        cloned.adversarySnapshot = JSON.parse(JSON.stringify(cloned.primarySnapshot));
      }
      const adversarySnapshot = cloned.adversarySnapshot;
      if (!adversarySnapshot) return cloned;
      adversarySnapshot.conversation_facts.push({
        conversation_id: conversationId,
        visibility: "private",
        creator_user_id: "someone-else",
        status: "active",
        message_count: 1,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      });
      return cloned;
    },
  };
}

/**
 * Create a mutation that leaks a subject_and_owner memory to the adversary.
 */
export function mutateLeakMemoryToAdversary(
  memoryId: string,
  targets: HardGraderName = "subjectAndOwnerPrivacy",
): MutationCase {
  return {
    id: `leak-mem-${memoryId}`,
    targets,
    description: `向 adversary 快照泄露 subject_and_owner 记忆 ${memoryId}`,
    apply: (input) => {
      const cloned = cloneInput(input);
      if (!cloned.adversarySnapshot) {
        cloned.adversarySnapshot = JSON.parse(JSON.stringify(cloned.primarySnapshot));
      }
      const adversarySnapshot = cloned.adversarySnapshot;
      if (!adversarySnapshot) return cloned;
      adversarySnapshot.memory_facts.push({
        memory_id: memoryId,
        memory_type: "assignment_confirmed",
        scope: "project",
        status: "active",
        visibility: "subject_and_owner",
        subject_user_id_present: true,
        owner_user_id_snapshot_present: true,
        related_stage_id_present: false,
        related_task_id_present: false,
        related_risk_id_present: false,
        valid_until_present: false,
        content_visible: true,
        created_at: "2026-01-01T00:00:00Z",
      });
      return cloned;
    },
  };
}

/**
 * Create a mutation that injects a hidden token into the observation output.
 */
export function mutateLeakTokenInOutput(
  token: string,
  targets: HardGraderName = "hiddenFieldLeakage",
): MutationCase {
  return {
    id: `leak-token-output-${token}`,
    targets,
    description: `在 observation.output 中注入隐藏 token`,
    apply: (input) => {
      const cloned = cloneInput(input);
      cloned.observation.output = cloned.observation.output + " " + token;
      return cloned;
    },
  };
}

/**
 * Create a mutation that injects a raw ID into the observation output.
 */
export function mutateLeakRawIdInOutput(
  rawId: string,
  targets: HardGraderName = "rawIdLeakage",
): MutationCase {
  return {
    id: `leak-rawid-output-${rawId}`,
    targets,
    description: `在 observation.output 中注入原始 ID`,
    apply: (input) => {
      const cloned = cloneInput(input);
      cloned.observation.output = cloned.observation.output + " " + rawId;
      return cloned;
    },
  };
}

/**
 * Create a mutation that changes the terminal status of the observation.
 */
export function mutateTerminalStatus(
  newStatus: "completed" | "failed" | "blocked",
  targets: HardGraderName = "finalOutcome",
): MutationCase {
  return {
    id: `terminal-status-${newStatus}`,
    targets,
    description: `修改 observation.terminalStatus 为 ${newStatus}`,
    apply: (input) => {
      const cloned = cloneInput(input);
      cloned.observation.terminalStatus = newStatus;
      return cloned;
    },
  };
}

/**
 * Create a mutation that modifies the before snapshot to differ from the
 * primary snapshot (for read-only purity and unchanged-state checks).
 */
export function mutateBeforeState(
  path: string,
  newValue: unknown,
  targets: HardGraderName,
): MutationCase {
  return {
    id: `before-state-${path}-${JSON.stringify(newValue)}`,
    targets,
    description: `修改 before state_facts.${path} 为 ${JSON.stringify(newValue)}`,
    apply: (input) => {
      const cloned = cloneInput(input);
      if (!cloned.beforeSnapshot) {
        cloned.beforeSnapshot = JSON.parse(JSON.stringify(cloned.primarySnapshot));
      }
      const beforeSnapshot = cloned.beforeSnapshot;
      if (!beforeSnapshot) return cloned;
      const segments = path.split(".");
      let current: unknown = beforeSnapshot.state_facts;
      for (let i = 0; i < segments.length - 1; i++) {
        const segment = segments[i];
        if (segment === undefined) return cloned;
        if (Array.isArray(current)) {
          current = current[Number(segment)];
        } else if (current && typeof current === "object") {
          current = (current as Record<string, unknown>)[segment];
        }
      }
      const lastSegment = segments[segments.length - 1];
      if (lastSegment === undefined) return cloned;
      if (Array.isArray(current)) {
        current[Number(lastSegment)] = newValue;
      } else if (current && typeof current === "object") {
        (current as Record<string, unknown>)[lastSegment] = newValue;
      }
      return cloned;
    },
  };
}
