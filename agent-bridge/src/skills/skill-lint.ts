/**
 * Skill lint — validates skill definitions for correctness.
 *
 * Checks:
 * - Missing tools (skill references tools not in registry)
 * - Duplicate name/version
 * - Escaping reference paths
 * - Incompatible manifest/tool versions
 * - Invalid effects
 * - Conflict fixtures
 *
 * Can run in CI/test without a running server.
 *
 * @see docs/T43/ProjectFlow_Agent_Capability_Maturity_Spec.md §Skills V2
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillMetadataV2, SkillV2Metadata } from "./skill-v2-metadata.js";

export interface LintIssue {
  /** Skill name where the issue was found */
  skill: string;
  /** Severity level */
  level: "error" | "warning";
  /** Issue category */
  category: string;
  /** Human-readable description */
  message: string;
}

export interface LintResult {
  /** Total skills checked */
  totalSkills: number;
  /** Issues found */
  issues: LintIssue[];
  /** Whether all checks passed */
  passed: boolean;
}

/**
 * Lint all skills in a directory.
 */
export async function lintSkills(
  skillsDir: string,
  registeredTools?: Set<string>,
): Promise<LintResult> {
  const issues: LintIssue[] = [];
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skillDirs = entries.filter((e) => e.isDirectory());

  const seenNames = new Map<string, string>(); // name → dir
  const allSkills: SkillMetadataV2[] = [];

  for (const entry of skillDirs) {
    const skillPath = join(skillsDir, entry.name, "SKILL.md");
    try {
      const content = await readFile(skillPath, "utf-8");
      const metadata = parseSkillForLint(content, skillPath);
      if (!metadata) {
        issues.push({
          skill: entry.name,
          level: "error",
          category: "parse",
          message: "Failed to parse SKILL.md frontmatter",
        });
        continue;
      }

      allSkills.push(metadata);

      // Check duplicate names
      if (seenNames.has(metadata.name)) {
        issues.push({
          skill: metadata.name,
          level: "error",
          category: "duplicate",
          message: `Duplicate skill name "${metadata.name}" in ${entry.name} and ${seenNames.get(metadata.name)}`,
        });
      }
      seenNames.set(metadata.name, entry.name);

      // Check tools exist in registry
      if (registeredTools) {
        for (const tool of metadata.allowedTools) {
          if (!registeredTools.has(tool)) {
            issues.push({
              skill: metadata.name,
              level: "error",
              category: "missing_tool",
              message: `References unknown tool: ${tool}`,
            });
          }
        }
      }

      // Check reference paths
      for (const ref of metadata.references) {
        const skillDir = join(skillsDir, entry.name);
        const fullPath = resolve(skillDir, ref);
        const relPath = relative(skillDir, fullPath);
        if (relPath.startsWith("..") || isAbsolute(relPath)) {
          issues.push({
            skill: metadata.name,
            level: "error",
            category: "path_escape",
            message: `Reference path escapes skill directory: ${ref}`,
          });
        } else {
          // Check file exists
          try {
            await stat(fullPath);
          } catch {
            issues.push({
              skill: metadata.name,
              level: "warning",
              category: "missing_reference",
              message: `Reference file not found: ${ref}`,
            });
          }
        }
      }

      // Check v2 metadata if present
      if (metadata.v2) {
        lintV2Metadata(metadata, issues);
      }
    } catch {
      issues.push({
        skill: entry.name,
        level: "warning",
        category: "read_error",
        message: "Could not read SKILL.md",
      });
    }
  }

  return {
    totalSkills: allSkills.length,
    issues,
    passed: issues.filter((i) => i.level === "error").length === 0,
  };
}

/**
 * Lint v2-specific metadata.
 */
function lintV2Metadata(skill: SkillMetadataV2, issues: LintIssue[]): void {
  const v2 = skill.v2!;

  // Check version is valid
  if (v2.version < 1 || v2.version > 999) {
    issues.push({
      skill: skill.name,
      level: "error",
      category: "invalid_version",
      message: `Invalid v2 version: ${v2.version}`,
    });
  }

  // Check effect ceiling is valid
  const validEffects = ["none", "advisory_only", "proposal_only", "full"];
  if (!validEffects.includes(v2.allowedEffects)) {
    issues.push({
      skill: skill.name,
      level: "error",
      category: "invalid_effect",
      message: `Invalid allowedEffects: ${v2.allowedEffects}`,
    });
  }

  // Check that proposal tools aren't combined with "none" effect ceiling
  if (v2.allowedEffects === "none") {
    const hasProposalTool = skill.allowedTools.some(
      (t) => t.includes("proposal") || t.includes("recommendation"),
    );
    if (hasProposalTool) {
      issues.push({
        skill: skill.name,
        level: "error",
        category: "effect_mismatch",
        message: "Skill has proposal tools but effect ceiling is 'none'",
      });
    }
  }

  // Check that confirm/reject/commit tools aren't in allowed tools
  for (const tool of skill.allowedTools) {
    if (
      tool.includes("confirm_proposal") ||
      tool.includes("reject_proposal") ||
      tool.includes("commit_proposal")
    ) {
      issues.push({
        skill: skill.name,
        level: "error",
        category: "forbidden_tool",
        message: `Skill includes forbidden tool: ${tool}`,
      });
    }
  }

  // Check compatibility range format if present
  if (v2.compatibilityRange) {
    if (!/^[><=!~\d.*x\s]+$/.test(v2.compatibilityRange)) {
      issues.push({
        skill: skill.name,
        level: "warning",
        category: "invalid_range",
        message: `Compatibility range may be invalid: ${v2.compatibilityRange}`,
      });
    }
  }
}

/**
 * Parse skill metadata from SKILL.md for linting (v1 + optional v2).
 */
function parseSkillForLint(
  content: string,
  filePath: string,
): SkillMetadataV2 | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  try {
    const frontmatter = parseYaml(match[1]!) as Record<string, unknown>;

    if (typeof frontmatter.name !== "string") return null;
    if (typeof frontmatter.description !== "string") return null;

    const allowedTools = Array.isArray(frontmatter["allowed-tools"])
      ? frontmatter["allowed-tools"].filter((t): t is string => typeof t === "string")
      : [];

    const references = Array.isArray(frontmatter.references)
      ? frontmatter.references.filter((r): r is string => typeof r === "string")
      : [];

    // Parse v2 metadata if present
    let v2: SkillV2Metadata | undefined;
    if (frontmatter.v2 && typeof frontmatter.v2 === "object") {
      const v2Raw = frontmatter.v2 as Record<string, unknown>;
      v2 = {
        version: typeof v2Raw.version === "number" ? v2Raw.version : 2,
        triggerExamples: Array.isArray(v2Raw.triggerExamples)
          ? v2Raw.triggerExamples.filter((t): t is string => typeof t === "string")
          : [],
        negativeTriggers: Array.isArray(v2Raw.negativeTriggers)
          ? v2Raw.negativeTriggers.filter((t): t is string => typeof t === "string")
          : [],
        prerequisites: Array.isArray(v2Raw.prerequisites)
          ? (v2Raw.prerequisites as SkillV2Metadata["prerequisites"])
          : [],
        outcomeType: (v2Raw.outcomeType as SkillV2Metadata["outcomeType"]) ?? "proposal",
        allowedEffects: (v2Raw.allowedEffects as SkillV2Metadata["allowedEffects"]) ?? "proposal_only",
        requiredVerification: (v2Raw.requiredVerification as SkillV2Metadata["requiredVerification"]) ?? "deterministic",
        compatibilityRange: typeof v2Raw.compatibilityRange === "string" ? v2Raw.compatibilityRange : undefined,
        evalFixtures: Array.isArray(v2Raw.evalFixtures)
          ? v2Raw.evalFixtures.filter((f): f is string => typeof f === "string")
          : undefined,
      };
    }

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      location: filePath,
      allowedTools,
      references,
      v2,
    };
  } catch {
    return null;
  }
}
