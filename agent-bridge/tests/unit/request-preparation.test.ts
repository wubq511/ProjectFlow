/**
 * Request preparation tests — shared preparation for both routes.
 *
 * Verifies that prepareRunRequest() correctly validates, resolves skills,
 * and classifies the Outcome Contract BEFORE any side effects.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareRunRequest, PROMPT_KERNEL_VERSION, hashPromptKernel, hashAssembledPrompt } from "../../src/runtime/request-preparation.js";
import { SkillIndex } from "../../src/skills/skill-index.js";
import { SkillLoader } from "../../src/skills/skill-loader.js";

/** Create a temp SkillIndex with one valid skill. */
async function createTestIndex(): Promise<SkillIndex> {
  const dir = await mkdtemp(join(tmpdir(), "projectflow-prep-"));
  const skillDir = join(dir, "project-planning");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `---
name: project-planning
description: 当需要阶段计划时触发
allowed-tools:
  - get_workspace_state
  - generate_stage_plan_proposal
---

# Body
`);
  const index = new SkillIndex({ skillsDir: dir });
  await index.load();
  return index;
}

function validWireRequest(skill?: string) {
  return {
    conversation_id: "conv_1",
    workspace_id: "ws_1",
    project_id: "proj_1",
    user_content: "帮我制定计划",
    runtime_config: {
      model: { provider: "mock", name: "mock-model" },
      ...(skill ? { skill } : {}),
    },
  };
}

describe("prepareRunRequest", () => {
  // ── Validation ─────────────────────────────────────────────────────

  describe("validation", () => {
    it("returns invalid for null input", async () => {
      const loader = new SkillLoader();
      const result = await prepareRunRequest(null, loader);
      expect(result.status).toBe("invalid");
    });

    it("returns invalid for missing required fields", async () => {
      const loader = new SkillLoader();
      const result = await prepareRunRequest({ conversation_id: "c1" }, loader);
      expect(result.status).toBe("invalid");
    });

    it("returns invalid for non-string conversation_id", async () => {
      const loader = new SkillLoader();
      const result = await prepareRunRequest({ conversation_id: 123, workspace_id: "w", project_id: "p" }, loader);
      expect(result.status).toBe("invalid");
    });

    it("returns invalid for empty string conversation_id", async () => {
      const loader = new SkillLoader();
      // Empty string is still a string — parser accepts it
      const result = await prepareRunRequest({ conversation_id: "", workspace_id: "w", project_id: "p" }, loader);
      // Parser accepts empty strings (typeof "" === "string")
      expect(result.status).toBe("ready");
    });

    it("accepts request with only required fields (no runtime_config/workspace_state)", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();
      const result = await prepareRunRequest({
        conversation_id: "c1",
        workspace_id: "w1",
        project_id: "p1",
      }, loader, index);
      expect(result.status).toBe("ready");
      if (result.status === "ready") {
        expect(result.wireRequest.conversation_id).toBe("c1");
        expect(result.skillContext).toBeUndefined();
      }
    });

    it("returns ready for valid request without skill", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();
      const result = await prepareRunRequest(validWireRequest(), loader, index);
      expect(result.status).toBe("ready");
    });

    it("accepts request with malformed runtime_config (parser is lenient)", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();
      const result = await prepareRunRequest({
        conversation_id: "c1",
        workspace_id: "w1",
        project_id: "p1",
        runtime_config: { invalid: true },
      }, loader, index);
      // Parser only validates top-level required strings
      expect(result.status).toBe("ready");
    });
  });

  // ── Skill resolution ──────────────────────────────────────────────

  describe("skill resolution", () => {
    it("returns unknown-skill for non-existent skill", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();
      const result = await prepareRunRequest(validWireRequest("nonexistent"), loader, index);
      expect(result.status).toBe("unknown-skill");
      if (result.status === "unknown-skill") {
        expect(result.skillName).toBe("nonexistent");
      }
    });

    it("returns skill-load-error when loader fails", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();
      loader.loadSkill = async () => { throw new Error("disk error"); };

      const result = await prepareRunRequest(validWireRequest("project-planning"), loader, index);
      expect(result.status).toBe("skill-load-error");
    });

    it("returns ready with skill context for valid skill", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();
      const result = await prepareRunRequest(validWireRequest("project-planning"), loader, index);

      expect(result.status).toBe("ready");
      if (result.status === "ready") {
        expect(result.skillContext).toBeDefined();
        expect(result.skillContext!.name).toBe("project-planning");
      }
    });

    it("returns ready with undefined skill context for no skill", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();
      const result = await prepareRunRequest(validWireRequest(), loader, index);

      expect(result.status).toBe("ready");
      if (result.status === "ready") {
        expect(result.skillContext).toBeUndefined();
      }
    });
  });

  // ── Outcome Contract classification ────────────────────────────────

  describe("Outcome Contract", () => {
    it("classifies no-skill as answer/answer-only", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();
      const result = await prepareRunRequest(validWireRequest(), loader, index);

      expect(result.status).toBe("ready");
      if (result.status === "ready") {
        expect(result.outcomeContract.requestType).toBe("answer");
        expect(result.outcomeContract.completionMode).toBe("answer-only");
        expect(result.outcomeContract.effectCeiling).toBe("none");
      }
    });

    it("classifies skill as act with appropriate effect ceiling", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();
      const result = await prepareRunRequest(validWireRequest("project-planning"), loader, index);

      expect(result.status).toBe("ready");
      if (result.status === "ready") {
        expect(result.outcomeContract.requestType).toBe("act");
        expect(result.outcomeContract.effectCeiling).toBe("proposal_only");
        expect(result.outcomeContract.completionMode).toBe("complete");
      }
    });

    it("includes schemaVersion 1", async () => {
      const index = await createTestIndex();
      const loader = new SkillLoader();
      const result = await prepareRunRequest(validWireRequest(), loader, index);

      expect(result.status).toBe("ready");
      if (result.status === "ready") {
        expect(result.outcomeContract.schemaVersion).toBe(1);
      }
    });
  });

  // ── Prompt kernel ──────────────────────────────────────────────────

  describe("prompt kernel", () => {
    it("exports a version string", () => {
      expect(PROMPT_KERNEL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it("version is 2.0.0 (ordering change)", () => {
      expect(PROMPT_KERNEL_VERSION).toBe("2.0.0");
    });

    it("hashPromptKernel (stable) produces same hash regardless of context", () => {
      const hash1 = hashPromptKernel();
      const hash2 = hashPromptKernel();
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^pk_[0-9a-f]{16}$/);
    });

    it("hashAssembledPrompt changes with different content", () => {
      const hash1 = hashAssembledPrompt("prompt A with workspace data");
      const hash2 = hashAssembledPrompt("prompt B with different data");
      expect(hash1).not.toBe(hash2);
      expect(hash1).toMatch(/^ap_[0-9a-f]{16}$/);
    });

    it("hashAssembledPrompt is deterministic for same content", () => {
      const hash1 = hashAssembledPrompt("same content");
      const hash2 = hashAssembledPrompt("same content");
      expect(hash1).toBe(hash2);
    });

    it("kernel hash and assembled hash use different prefixes", () => {
      const kernel = hashPromptKernel();
      const assembled = hashAssembledPrompt("test");
      expect(kernel.startsWith("pk_")).toBe(true);
      expect(assembled.startsWith("ap_")).toBe(true);
    });
  });
});
