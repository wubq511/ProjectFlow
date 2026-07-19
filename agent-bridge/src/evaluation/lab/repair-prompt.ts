/**
 * T46-4 (Issue #97 §10) — Copy-ready Coding Agent prompt.
 *
 * Generates a prompt that can be handed directly to Codex, Claude Code,
 * Trae or another Coding Agent. The prompt:
 *  - asserts commit/worktree fingerprint checks;
 *  - describes the observed symptom and expected contract;
 *  - lists evidence paths (artifact-relative, no secrets);
 *  - reports causal status and confidence;
 *  - suggests a modification scope with evidence levels;
 *  - lists protected boundaries and non-goals;
 *  - lists acceptance criteria;
 *  - lists targeted + full verification commands;
 *  - forbids modifying frozen standards;
 *  - forbids auto push, merge, or closing the Issue;
 *  - refuses to execute when the packet is stale.
 *
 * Boundary invariants (enforced and tested):
 *  - The prompt NEVER contains secrets, raw hidden facts, private
 *    transcripts, absolute temp paths or model hidden reasoning.
 *  - The prompt MUST refuse to execute when `staleState === "stale"`.
 *  - The prompt MUST forbid weakening graders, thresholds, P0 cases,
 *    or privacy/authority boundaries.
 *  - The prompt is deterministic given the same packet.
 */

import type { RepairPacket } from "./diagnosis-contract.js";
import { EvaluationValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// §1 Prompt input
// ---------------------------------------------------------------------------

export interface BuildRepairPromptInput {
  packet: RepairPacket;
  /** Optional target agent ("codex" | "claude-code" | "trae"). The
   *  prompt format is identical; this is informational only. */
  targetAgent?: "codex" | "claude-code" | "trae";
}

// ---------------------------------------------------------------------------
// §2 Prompt builder
// ---------------------------------------------------------------------------

/** Build a copy-ready Coding Agent prompt from a Repair Packet.
 *
 *  Throws when the packet is stale. */
export function buildRepairPrompt(input: BuildRepairPromptInput): string {
  const packet = input.packet;

  // §1 Refuse stale packets.
  if (packet.staleState === "stale") {
    throw new EvaluationValidationError(
      `repair packet ${packet.packetId} is stale; Coding Agent prompt 拒绝执行 stale packet`,
    );
  }

  // §2 Build the prompt sections.
  const sections: string[] = [];
  sections.push(buildHeader(packet));
  sections.push(buildFingerprintCheck(packet));
  sections.push(buildSymptomSection(packet));
  sections.push(buildEvidenceSection(packet));
  sections.push(buildCausalStatusSection(packet));
  sections.push(buildModificationScopeSection(packet));
  sections.push(buildProtectedBoundariesSection(packet));
  sections.push(buildNonGoalsSection(packet));
  sections.push(buildAcceptanceCriteriaSection(packet));
  sections.push(buildVerificationSection(packet));
  sections.push(buildForbiddenActionsSection(packet));
  sections.push(buildStaleCheckSection(packet));
  sections.push(buildFooter(packet));

  return sections.join("\n\n");
}

function buildHeader(packet: RepairPacket): string {
  return [
    `# Repair Packet: ${packet.packetId}`,
    ``,
    `- Schema version: ${packet.schemaVersion}`,
    `- Packet type: ${packet.packetType}`,
    `- Severity: ${packet.severity}`,
    `- Confidence: ${packet.confidence}`,
    `- Causal status: ${packet.causalStatus}`,
    `- Run ID: ${packet.runId}`,
    ...(packet.clusterId ? [`- Cluster ID: ${packet.clusterId}`] : []),
    `- Diagnosis ID: ${packet.diagnosisId}`,
    `- Created at: ${packet.createdAt}`,
    `- Integrity SHA-256: ${packet.integritySha256}`,
  ].join("\n");
}

function buildFingerprintCheck(packet: RepairPacket): string {
  return [
    `## 代码指纹校验（执行任何操作前必须通过）`,
    ``,
    `在执行任何修改之前，请先验证当前代码指纹与 packet 中记录的一致：`,
    ``,
    `- Expected git commit: \`${packet.codeFingerprint.gitCommit}\``,
    `- Expected worktree SHA-256: \`${packet.codeFingerprint.worktreeSha256}\``,
    `- Git dirty at packet creation: ${packet.codeFingerprint.gitDirty}`,
    ``,
    `校验命令：`,
    ``,
    "```bash",
    `git rev-parse HEAD`,
    `# 期望输出: ${packet.codeFingerprint.gitCommit}`,
    "```",
    ``,
    `如果当前 HEAD commit 或 worktree 内容与上述不一致，立即停止并报告 "packet stale"；不要继续执行。`,
  ].join("\n");
}

function buildSymptomSection(packet: RepairPacket): string {
  return [
    `## 观察到的问题`,
    ``,
    packet.observedSymptom,
    ``,
    `## 期望契约`,
    ``,
    packet.expectedContract,
    ``,
    `## 复现命令`,
    ``,
    "```bash",
    packet.reproductionCommand,
    "```",
  ].join("\n");
}

function buildEvidenceSection(packet: RepairPacket): string {
  if (packet.evidenceReferences.length === 0) {
    return `## 证据路径\n\n（无证据引用；此 packet 仅作为 investigation 记录）`;
  }
  const lines = [
    `## 证据路径（immutable artifact references）`,
    ``,
  ];
  for (const ref of packet.evidenceReferences) {
    lines.push(`- \`${ref.reference}\` (SHA-256: \`${ref.referenceSha256}\`)`);
  }
  return lines.join("\n");
}

function buildCausalStatusSection(packet: RepairPacket): string {
  return [
    `## 因果状态与置信度`,
    ``,
    `- Causal status: \`${packet.causalStatus}\``,
    `- Confidence: \`${packet.confidence}\``,
    ...(packet.counterfactualRef
      ? [`- Counterfactual reference: \`${packet.counterfactualRef}\``]
      : []),
    ...(packet.faultProfileRef
      ? [`- Fault profile reference: \`${packet.faultProfileRef}\``]
      : []),
    ``,
    `说明：因果状态是证据等级的反映，不是绝对判断。\`investigation\` 类型 packet 不能假定为根因；\`fix\` 类型 packet 仍需通过 acceptance criteria 验证。`,
  ].join("\n");
}

function buildModificationScopeSection(packet: RepairPacket): string {
  if (packet.candidateCodeSurfaces.length === 0) {
    return `## 建议修改范围\n\n（无候选 code surface；请基于证据路径自行定位）`;
  }
  const lines = [
    `## 建议修改范围`,
    ``,
    `以下 code surface 默认为 \`hypothesis\`；只有 \`direct_component_evidence\` 级别的 surface 才能作为修改依据。其余 surface 仅作为探索方向。`,
    ``,
  ];
  for (const surface of packet.candidateCodeSurfaces) {
    lines.push(
      `### ${surface.surfaceId}: \`${surface.component}\``,
      ``,
      `- Evidence level: \`${surface.evidenceLevel}\``,
      `- Reason: ${surface.reason}`,
      ...(surface.evidence.length > 0
        ? [`- Evidence: ${surface.evidence.map((e) => `\`${e}\``).join(", ")}`]
        : []),
      ``,
    );
  }
  lines.push(`## 受影响组件`);
  lines.push(``);
  for (const c of packet.affectedComponents) {
    lines.push(`- \`${c}\``);
  }
  return lines.join("\n");
}

function buildProtectedBoundariesSection(packet: RepairPacket): string {
  if (packet.protectedBoundaries.length === 0) {
    return `## Protected boundaries\n\n（无）`;
  }
  const lines = [
    `## Protected boundaries（禁止修改）`,
    ``,
    `以下边界禁止修改、放宽或绕过：`,
    ``,
  ];
  for (const b of packet.protectedBoundaries) {
    lines.push(`- ${b}`);
  }
  return lines.join("\n");
}

function buildNonGoalsSection(packet: RepairPacket): string {
  if (packet.nonGoals.length === 0) {
    return `## Non-goals\n\n（无）`;
  }
  const lines = [
    `## Non-goals（不在本次修改范围内）`,
    ``,
    `以下事项不在本次修改范围内；如需触及请重新生成 packet：`,
    ``,
  ];
  for (const g of packet.nonGoals) {
    lines.push(`- ${g}`);
  }
  return lines.join("\n");
}

function buildAcceptanceCriteriaSection(packet: RepairPacket): string {
  if (packet.acceptanceCriteria.length === 0) {
    return `## Acceptance criteria\n\n（无 falsifiable acceptance criteria；此 packet 不能作为 fix）`;
  }
  const lines = [
    `## Acceptance criteria（falsifiable）`,
    ``,
    `修改完成后必须满足以下每一条可证伪的 acceptance criteria：`,
    ``,
  ];
  for (let i = 0; i < packet.acceptanceCriteria.length; i++) {
    lines.push(`${i + 1}. ${packet.acceptanceCriteria[i]}`);
  }
  return lines.join("\n");
}

function buildVerificationSection(packet: RepairPacket): string {
  if (packet.verificationCommands.length === 0) {
    return `## Verification commands\n\n（无）`;
  }
  const lines = [
    `## Verification commands`,
    ``,
    `### Targeted verification（与本 packet 直接相关）`,
    ``,
    "```bash",
    ...packet.verificationCommands,
    "```",
    ``,
    `### Full verification（修改后必须通过）`,
    ``,
    "```bash",
    `# Backend`,
    `cd backend && .venv/bin/python -m pytest app/tests/ -q`,
    `cd backend && .venv/bin/python -m ruff check .`,
    `# Agent bridge`,
    `cd agent-bridge && npm run test -- --run`,
    `cd agent-bridge && npm run typecheck`,
    `cd agent-bridge && npm run build`,
    `# Frontend`,
    `cd frontend && npm run test -- --run`,
    `cd frontend && npm run lint`,
    `cd frontend && npm run build`,
    "```",
  ].join("\n");
  return lines;
}

function buildForbiddenActionsSection(packet: RepairPacket): string {
  return [
    `## 禁止行为（无例外）`,
    ``,
    `1. 禁止修改 frozen standards / frozen suite。包括但不限于：`,
    `   - 现有 hard grader 的判定逻辑与阈值`,
    `   - 现有 P0 case 与其期望输出`,
    `   - 现有 privacy / authority boundary 校验`,
    `   - 现有 exit gate 条件`,
    `2. 禁止自动 \`git push\`、\`git merge\` 或关闭 Issue。`,
    `3. 禁止创建 commit 除非用户明确要求。`,
    `4. 禁止修改 \`.env\`、API key、internal service token。`,
    `5. 禁止跳过 pre-commit hook（\`--no-verify\`）。`,
    `6. 禁止为了让评测通过而削弱 grader、threshold、P0 case 或 privacy/authority boundary。`,
    `7. 禁止在 packet 之外添加新的 candidate regression 到 frozen suite。candidate regression 必须保存在 frozen suite 之外，并标记 \`candidate\` / \`unapproved\`。`,
    ...(packet.candidateRegression
      ? [
          ``,
          `## Candidate regression governance`,
          ``,
          `本 packet 附带一条 candidate regression（ID: \`${packet.candidateRegression.regressionId}\`），状态为 \`${packet.candidateRegression.status}\`，标记为 \`outsideFrozenSuite: true\`。`,
          ``,
          `- 不得将此 regression 自动 promotion 到 frozen suite。`,
          `- promotion 需要用户（Robert）的显式指令和 reviewable diff。`,
          `- 不得修改、删除或放宽现有 frozen standards。`,
        ]
      : []),
  ].join("\n");
}

function buildStaleCheckSection(packet: RepairPacket): string {
  return [
    `## Stale 检查`,
    ``,
    `- Packet stale state: \`${packet.staleState}\``,
    ``,
    `如果 stale state 不是 \`fresh\`，立即停止执行；不要继续修改。`,
    `Stale packet 表示代码已经偏离 packet 创建时的状态，修改建议可能不再适用。`,
  ].join("\n");
}

function buildFooter(packet: RepairPacket): string {
  return [
    `---`,
    ``,
    `Packet ID: \`${packet.packetId}\``,
    `Integrity SHA-256: \`${packet.integritySha256}\``,
    `Generated at: ${packet.createdAt}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// §3 Prompt validation
// ---------------------------------------------------------------------------

/** Verify that a generated prompt does not contain forbidden content.
 *  Returns a list of violations (empty = OK). */
export function verifyPromptContent(prompt: string): string[] {
  const violations: string[] = [];
  const forbiddenPatterns = [
    { pattern: /(?:api[_-]?key|secret|token|password|bearer)\s*[=:]\s*["']?[A-Za-z0-9+/=_-]{8,}/i, msg: "包含疑似 secret" },
    { pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----/, msg: "包含私钥" },
    { pattern: /^\/tmp\//m, msg: "包含 /tmp/ 绝对路径" },
    { pattern: /^\/var\/folders\//m, msg: "包含 /var/folders/ 绝对路径" },
    { pattern: /__hidden__/, msg: "包含 raw hidden fact 标记" },
    { pattern: /__oracle__/, msg: "包含 oracle 标记" },
    { pattern: /<think>/, msg: "包含 model hidden reasoning 标记" },
    { pattern: /<reasoning>/, msg: "包含 model hidden reasoning 标记" },
  ];
  for (const { pattern, msg } of forbiddenPatterns) {
    if (pattern.test(prompt)) {
      violations.push(msg);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// §4 Stale-refusal verification
// ---------------------------------------------------------------------------

/** Return true when the prompt refuses to execute on stale packets.
 *  Used by tests to verify the stale-refusal invariant. */
export function promptRefusesStale(prompt: string): boolean {
  return /stale.*停止|stale state.*fresh|packet stale/i.test(prompt);
}

/** Return true when the prompt forbids modifying frozen standards.
 *  Used by tests to verify the forbidden-actions invariant. */
export function promptForbidsFrozenStandardsModification(prompt: string): boolean {
  return /禁止修改 frozen standards|禁止.*frozen suite|禁止.*grader.*threshold/i.test(prompt);
}

/** Return true when the prompt forbids auto push/merge/close-issue.
 *  Used by tests to verify the forbidden-actions invariant. */
export function promptForbidsAutoPushMergeClose(prompt: string): boolean {
  return /禁止自动\s*`?git push/i.test(prompt)
    && /禁止.*git merge/i.test(prompt)
    && /禁止.*关闭 Issue/i.test(prompt);
}

/** Return true when the prompt forbids modifying `.env`, API keys, or
 *  internal service tokens. Used by tests to verify the forbidden-actions
 *  invariant. */
export function promptForbidsEnvModification(prompt: string): boolean {
  return /禁止修改\s*`?\.env/i.test(prompt)
    && /禁止.*API\s*key/i.test(prompt)
    && /禁止.*internal service token/i.test(prompt);
}
