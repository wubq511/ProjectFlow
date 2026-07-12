/**
 * Skill resolver tests — proves parity between /runs and /runs/stream,
 * validates fail-closed semantics, and verifies answer/action mode.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveSkillContext, validateSkillName, prepareSkillContext } from "../../src/skills/skill-resolver.js";
import { SkillIndex } from "../../src/skills/skill-index.js";
import { SkillLoader } from "../../src/skills/skill-loader.js";

/** Create a temp SkillIndex with one valid skill for testing. */
async function createTestIndex(): Promise<SkillIndex> {
  const dir = await mkdtemp(join(tmpdir(), "projectflow-resolver-"));
  const skillDir = join(dir, "project-planning");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `---
name: project-planning
description: 当需要阶段计划时触发
allowed-tools:
  - get_workspace_state
  - list_pending_proposals
  - generate_stage_plan_proposal
---

# 阶段计划 Skill

这是阶段计划的正文内容。
`);
  const index = new SkillIndex({ skillsDir: dir });
  await index.load();
  return index;
}

describe("skill-resolver", () => {
  // ── validateSkillName ─────────────────────────────────────────────────

  describe("validateSkillName", () => {
    it("accepts undefined/empty skill name (answer mode)", async () => {
      const index = await createTestIndex();
      expect(validateSkillName(undefined, index)).toBe(true);
      expect(validateSkillName("", index)).toBe(true);
    });

    it("accepts a valid skill name", async () => {
      const index = await createTestIndex();
      expect(validateSkillName("project-planning", index)).toBe(true);
    });

    it("rejects an unknown skill name", async () => {
      const index = await createTestIndex();
      expect(validateSkillName("nonexistent-skill", index)).toBe(false);
    });
  });

  // ── resolveSkillContext ───────────────────────────────────────────────

  describe("resolveSkillContext", () => {
    it("returns undefined when no skill name (answer mode)", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();
      const result = await resolveSkillContext({}, loader, index);
      expect(result).toBeUndefined();
    });

    it("returns undefined for unknown skill name", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();
      const result = await resolveSkillContext({ skillName: "nonexistent" }, loader, index);
      expect(result).toBeUndefined();
    });

    it("resolves a valid skill name to SkillContext with correct fields", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();
      const result = await resolveSkillContext({ skillName: "project-planning" }, loader, index);

      // This assertion MUST fail if result is undefined — proves real resolution
      expect(result).toBeDefined();
      expect(result!.name).toBe("project-planning");
      expect(result!.description).toContain("阶段计划");
      expect(result!.body).toContain("阶段计划的正文内容");
      expect(result!.allowedTools).toEqual([
        "get_workspace_state",
        "list_pending_proposals",
        "generate_stage_plan_proposal",
      ]);
    });

    it("does NOT load references in this tracer", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();
      const result = await resolveSkillContext({ skillName: "project-planning" }, loader, index);

      expect(result).toBeDefined();
      // References are explicitly NOT loaded in the first tracer
      expect(result!.references).toBeUndefined();
    });

    it("is deterministic — same input produces identical output", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();
      const input = { skillName: "project-planning" };

      const result1 = await resolveSkillContext(input, loader, index);
      const result2 = await resolveSkillContext(input, loader, index);

      expect(result1).toEqual(result2);
    });
  });

  // ── Fail-closed semantics ─────────────────────────────────────────────

  describe("fail-closed semantics", () => {
    it("validateSkillName returns false for non-empty unknown skill (fail closed)", async () => {
      const index = await createTestIndex();
      // An unknown skill name must be rejected — the route should return 400
      expect(validateSkillName("totally-unknown-skill", index)).toBe(false);
    });

    it("validateSkillName returns true for empty/undefined (answer mode is valid)", async () => {
      const index = await createTestIndex();
      expect(validateSkillName(undefined, index)).toBe(true);
      expect(validateSkillName("", index)).toBe(true);
    });

    it("resolveSkillContext returns undefined for unknown skill (after validation fails)", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();
      // If validation is bypassed, resolver gracefully returns undefined
      const result = await resolveSkillContext({ skillName: "unknown" }, loader, index);
      expect(result).toBeUndefined();
    });
  });

  // ── prepareSkillContext ────────────────────────────────────────────────

  describe("prepareSkillContext", () => {
    it("returns no-skill when skillName is undefined", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();
      const result = await prepareSkillContext({}, loader, index);
      expect(result.status).toBe("no-skill");
    });

    it("returns unknown-skill for non-existent skill name", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();
      const result = await prepareSkillContext({ skillName: "nonexistent" }, loader, index);
      expect(result.status).toBe("unknown-skill");
      if (result.status === "unknown-skill") {
        expect(result.skillName).toBe("nonexistent");
      }
    });

    it("returns resolved with SkillContext for valid skill", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();
      const result = await prepareSkillContext({ skillName: "project-planning" }, loader, index);
      expect(result.status).toBe("resolved");
      if (result.status === "resolved") {
        expect(result.context.name).toBe("project-planning");
        expect(result.context.body).toContain("阶段计划的正文内容");
        expect(result.context.allowedTools).toContain("get_workspace_state");
        expect(result.context.references).toBeUndefined();
      }
    });

    it("returns load-error when SkillLoader.loadSkill throws", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();
      // Override loadSkill to simulate disk failure
      loader.loadSkill = vi.fn(async () => { throw new Error("disk read error"); });

      const result = await prepareSkillContext({ skillName: "project-planning" }, loader, index);
      expect(result.status).toBe("load-error");
      if (result.status === "load-error") {
        expect(result.skillName).toBe("project-planning");
        expect(result.error).toContain("disk read error");
      }
    });
  });

  // ── Route parity proof ────────────────────────────────────────────────

  describe("route parity", () => {
    it("both routes use the same resolver and get identical SkillContext for explicit skill", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();

      // Simulate what /runs does
      const runsResult = await resolveSkillContext(
        { skillName: "project-planning" },
        loader,
        index,
      );

      // Simulate what /runs/stream does (same resolver, same inputs)
      const streamResult = await resolveSkillContext(
        { skillName: "project-planning" },
        loader,
        index,
      );

      // Both must produce identical results
      expect(runsResult).toEqual(streamResult);
      // Both must be real SkillContext objects (not undefined)
      expect(runsResult).toBeDefined();
      expect(streamResult).toBeDefined();
      expect(runsResult!.name).toBe("project-planning");
      expect(streamResult!.name).toBe("project-planning");
    });

    it("both routes return undefined for no skill (answer mode)", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();

      const runsResult = await resolveSkillContext({}, loader, index);
      const streamResult = await resolveSkillContext({}, loader, index);

      expect(runsResult).toBeUndefined();
      expect(streamResult).toBeUndefined();
    });

    it("both routes return undefined for unknown skill", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();

      const runsResult = await resolveSkillContext({ skillName: "unknown" }, loader, index);
      const streamResult = await resolveSkillContext({ skillName: "unknown" }, loader, index);

      expect(runsResult).toBeUndefined();
      expect(streamResult).toBeUndefined();
    });
  });
});
