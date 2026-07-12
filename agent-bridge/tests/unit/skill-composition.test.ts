/**
 * Skill composition edge case tests.
 *
 * Verifies: multi-skill composition, conflict detection, negative triggers,
 * prerequisite failures, forbidden effects, stable ordering, lazy references.
 */

import { describe, it, expect } from "vitest";
import { routeSkills } from "../../src/skills/skill-router.js";
import type { SkillMetadataV2 } from "../../src/skills/skill-v2-metadata.js";

function makeSkill(overrides: Partial<SkillMetadataV2> = {}): SkillMetadataV2 {
  return {
    name: "test-skill",
    description: "Test skill",
    location: "/skills/test-skill/SKILL.md",
    allowedTools: ["get_workspace_state"],
    references: [],
    v2: {
      version: 2,
      triggerExamples: [],
      negativeTriggers: [],
      prerequisites: [],
      outcomeType: "proposal",
      allowedEffects: "proposal_only",
      requiredVerification: "deterministic",
    },
    ...overrides,
  };
}

describe("Skill composition edge cases", () => {
  describe("conflict detection", () => {
    it("rejects composition with incompatible effect ceilings", () => {
      const skills: SkillMetadataV2[] = [
        makeSkill({
          name: "skill-a",
          allowedTools: ["get_workspace_state", "generate_plan"],
          v2: {
            version: 2,
            triggerExamples: ["plan"],
            negativeTriggers: [],
            prerequisites: [],
            outcomeType: "proposal",
            allowedEffects: "full",
            requiredVerification: "deterministic",
          },
        }),
        makeSkill({
          name: "skill-b",
          allowedTools: ["get_workspace_state", "create_risk"],
          v2: {
            version: 2,
            triggerExamples: ["plan"],
            negativeTriggers: [],
            prerequisites: [],
            outcomeType: "advisory",
            allowedEffects: "none",
            requiredVerification: "deterministic",
          },
        }),
      ];

      const result = routeSkills(skills, { userContent: "plan" });
      // Should fail closed due to incompatible effects
      expect(result.selected.length).toBe(0);
      expect(result.reason).toContain("conflict");
    });

    it("rejects composition with overlapping proposal tools", () => {
      const skills: SkillMetadataV2[] = [
        makeSkill({
          name: "skill-a",
          allowedTools: ["get_workspace_state", "generate_plan_proposal"],
          v2: {
            version: 2,
            triggerExamples: ["plan"],
            negativeTriggers: [],
            prerequisites: [],
            outcomeType: "proposal",
            allowedEffects: "proposal_only",
            requiredVerification: "deterministic",
          },
        }),
        makeSkill({
          name: "skill-b",
          allowedTools: ["get_workspace_state", "generate_plan_proposal"],
          v2: {
            version: 2,
            triggerExamples: ["plan"],
            negativeTriggers: [],
            prerequisites: [],
            outcomeType: "proposal",
            allowedEffects: "proposal_only",
            requiredVerification: "deterministic",
          },
        }),
      ];

      const result = routeSkills(skills, { userContent: "plan" });
      // Should fail closed due to overlapping proposal tools
      expect(result.selected.length).toBe(0);
    });
  });

  describe("negative triggers", () => {
    it("rejects skill with matching negative trigger", () => {
      const skills: SkillMetadataV2[] = [
        makeSkill({
          name: "planning",
          v2: {
            version: 2,
            triggerExamples: ["制定计划"],
            negativeTriggers: ["计划延期了"],
            prerequisites: [],
            outcomeType: "proposal",
            allowedEffects: "proposal_only",
            requiredVerification: "deterministic",
          },
        }),
      ];

      const result = routeSkills(skills, { userContent: "计划延期了怎么办" });
      expect(result.selected.length).toBe(0);
      expect(result.candidates[0]?.rejected).toContain("negative trigger");
    });

    it("negative trigger takes priority over positive trigger", () => {
      const skills: SkillMetadataV2[] = [
        makeSkill({
          name: "planning",
          v2: {
            version: 2,
            triggerExamples: ["计划"],
            negativeTriggers: ["延期"],
            prerequisites: [],
            outcomeType: "proposal",
            allowedEffects: "proposal_only",
            requiredVerification: "deterministic",
          },
        }),
      ];

      const result = routeSkills(skills, { userContent: "计划延期了" });
      expect(result.selected.length).toBe(0);
    });
  });

  describe("prerequisite failures", () => {
    it("rejects skill when prerequisite fails", () => {
      const skills: SkillMetadataV2[] = [
        makeSkill({
          name: "planning",
          v2: {
            version: 2,
            triggerExamples: ["制定计划"],
            negativeTriggers: [],
            prerequisites: [{ type: "has_direction_card", description: "需要方向卡" }],
            outcomeType: "proposal",
            allowedEffects: "proposal_only",
            requiredVerification: "deterministic",
          },
        }),
      ];

      const result = routeSkills(skills, {
        userContent: "制定计划",
        workspaceState: {}, // no direction card
      });
      expect(result.selected.length).toBe(0);
      expect(result.candidates[0]?.rejected).toContain("prerequisite");
    });

    it("accepts skill when prerequisite passes", () => {
      const skills: SkillMetadataV2[] = [
        makeSkill({
          name: "planning",
          v2: {
            version: 2,
            triggerExamples: ["制定计划"],
            negativeTriggers: [],
            prerequisites: [{ type: "has_direction_card", description: "需要方向卡" }],
            outcomeType: "proposal",
            allowedEffects: "proposal_only",
            requiredVerification: "deterministic",
          },
        }),
      ];

      const result = routeSkills(skills, {
        userContent: "制定计划",
        workspaceState: { project: { direction_card: { problem: "test" } } },
      });
      expect(result.selected.length).toBe(1);
    });
  });

  describe("forbidden tools", () => {
    it("filters out confirm_proposal from combined tools", () => {
      const skills: SkillMetadataV2[] = [
        makeSkill({
          name: "test",
          allowedTools: ["get_workspace_state", "confirm_proposal", "generate_plan"],
          v2: {
            version: 2,
            triggerExamples: ["test"],
            negativeTriggers: [],
            prerequisites: [],
            outcomeType: "proposal",
            allowedEffects: "full",
            requiredVerification: "deterministic",
          },
        }),
      ];

      const result = routeSkills(skills, { userContent: "test" });
      expect(result.combinedAllowedTools).not.toContain("confirm_proposal");
      expect(result.combinedAllowedTools).not.toContain("reject_proposal");
      expect(result.combinedAllowedTools).not.toContain("commit_proposal");
    });
  });

  describe("stable ordering", () => {
    it("returns consistent results for same input", () => {
      const skills: SkillMetadataV2[] = [
        makeSkill({
          name: "skill-a",
          v2: {
            version: 2,
            triggerExamples: ["test"],
            negativeTriggers: [],
            prerequisites: [],
            outcomeType: "proposal",
            allowedEffects: "proposal_only",
            requiredVerification: "deterministic",
          },
        }),
        makeSkill({
          name: "skill-b",
          v2: {
            version: 2,
            triggerExamples: ["test"],
            negativeTriggers: [],
            prerequisites: [],
            outcomeType: "proposal",
            allowedEffects: "proposal_only",
            requiredVerification: "deterministic",
          },
        }),
      ];

      const result1 = routeSkills(skills, { userContent: "test" });
      const result2 = routeSkills(skills, { userContent: "test" });

      expect(result1.selected.map((s) => s.name)).toEqual(result2.selected.map((s) => s.name));
    });
  });

  describe("answer mode fallback", () => {
    it("returns empty selection for unmatched content", () => {
      const skills: SkillMetadataV2[] = [
        makeSkill({
          name: "planning",
          v2: {
            version: 2,
            triggerExamples: ["制定计划"],
            negativeTriggers: [],
            prerequisites: [],
            outcomeType: "proposal",
            allowedEffects: "proposal_only",
            requiredVerification: "deterministic",
          },
        }),
      ];

      const result = routeSkills(skills, { userContent: "今天天气不错" });
      expect(result.selected.length).toBe(0);
      expect(result.combinedEffectCeiling).toBe("none");
      expect(result.combinedAllowedTools).toEqual([]);
    });
  });
});
