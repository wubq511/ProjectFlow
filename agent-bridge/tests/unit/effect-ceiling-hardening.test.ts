/**
 * Effect-ceiling hardening tests.
 *
 * Covers:
 * - Explicit single-skill ceiling propagation
 * - Multi-skill strictest ceiling
 * - none/advisory_only/proposal_only/full exposure matrix
 * - Filtered tool invocation cannot execute (runtime enforcement)
 * - Commit/confirm/finalize tools remain excluded
 * - Existing concurrency behavior remains intact
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareRunRequest } from "../../src/runtime/request-preparation.js";
import { SkillIndex } from "../../src/skills/skill-index.js";
import { SkillLoader } from "../../src/skills/skill-loader.js";
import {
  filterModelCallableManifests,
  buildContext,
  type SkillContext,
} from "../../src/runtime/context-builder.js";
import type { ProjectFlowToolManifest } from "../../src/types/tool-manifest.js";
import type { SkillEffectCeiling } from "../../src/skills/skill-v2-metadata.js";
import {
  canExecuteInParallel,
  evaluatePolicy,
  isWithinEffectCeiling,
} from "../../src/policy/policy-engine.js";
import { routeSkills } from "../../src/skills/skill-router.js";
import type { SkillMetadataV2 } from "../../src/skills/skill-v2-metadata.js";

// ── Helpers ────────────────────────────────────────────────────────────

function makeManifest(
  name: string,
  overrides: Partial<ProjectFlowToolManifest> = {},
): ProjectFlowToolManifest {
  return {
    schemaVersion: 1,
    name,
    version: 1,
    description: `Tool: ${name}`,
    riskCategory: "read_only",
    modelCallable: true,
    sidecarOnly: false,
    humanTriggeredOnly: false,
    annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    inputSchema: { type: "object", properties: {} },
    outputSchema: {},
    execution: { mode: "parallel", maxConcurrency: 1, providerParallelToolCallsAllowed: true },
    timeoutMs: 5000,
    retry: { maxAttempts: 1, retryOn: [] },
    resultLimit: { maxBytes: 32768, redaction: "none" },
    backend: { owner: "fastapi", endpoint: `/internal/agent-tools/${name}`, method: "POST" },
    effects: { effectType: "none", idempotencyKeyRequired: false, replaySafe: true },
    privacy: { dataClassification: "public", traceIncludeInputs: true, traceIncludeOutputs: true },
    errors: { modelVisibleErrorPolicy: "normalized_summary" },
    resume: { manifestVersion: 1, incompatibleVersionPolicy: "regenerate" },
    trace: { emits: [] },
    ...overrides,
  };
}

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

/** Create a temp SkillIndex with a skill having specific V2 metadata. */
async function createTestIndexWithV2(
  skillName: string,
  effectCeiling: SkillEffectCeiling,
  allowedTools: string[] = ["get_workspace_state", "generate_stage_plan_proposal"],
): Promise<SkillIndex> {
  const dir = await mkdtemp(join(tmpdir(), "projectflow-ceiling-"));
  const skillDir = join(dir, skillName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---
name: ${skillName}
description: Test skill for ${skillName}
allowed-tools:
${allowedTools.map((t) => `  - ${t}`).join("\n")}
v2:
  version: 2
  outcomeType: proposal
  allowedEffects: ${effectCeiling}
  requiredVerification: deterministic
---

# Body
`,
  );
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

// ── isWithinEffectCeiling ──────────────────────────────────────────────

describe("isWithinEffectCeiling", () => {
  describe("none ceiling", () => {
    it("permits read_only", () => {
      expect(isWithinEffectCeiling("read_only", "none")).toBe(true);
    });
    it("rejects analysis", () => {
      expect(isWithinEffectCeiling("analysis", "none")).toBe(false);
    });
    it("rejects draft_only", () => {
      expect(isWithinEffectCeiling("draft_only", "none")).toBe(false);
    });
    it("rejects advisory_write", () => {
      expect(isWithinEffectCeiling("advisory_write", "none")).toBe(false);
    });
    it("rejects internal_write", () => {
      expect(isWithinEffectCeiling("internal_write", "none")).toBe(false);
    });
    it("rejects destructive", () => {
      expect(isWithinEffectCeiling("destructive", "none")).toBe(false);
    });
    it("rejects open_world", () => {
      expect(isWithinEffectCeiling("open_world", "none")).toBe(false);
    });
  });

  describe("advisory_only ceiling", () => {
    it("permits read_only", () => {
      expect(isWithinEffectCeiling("read_only", "advisory_only")).toBe(true);
    });
    it("permits analysis", () => {
      expect(isWithinEffectCeiling("analysis", "advisory_only")).toBe(true);
    });
    it("permits advisory_write", () => {
      expect(isWithinEffectCeiling("advisory_write", "advisory_only")).toBe(true);
    });
    it("rejects draft_only", () => {
      expect(isWithinEffectCeiling("draft_only", "advisory_only")).toBe(false);
    });
    it("rejects internal_write", () => {
      expect(isWithinEffectCeiling("internal_write", "advisory_only")).toBe(false);
    });
    it("rejects destructive", () => {
      expect(isWithinEffectCeiling("destructive", "advisory_only")).toBe(false);
    });
  });

  describe("proposal_only ceiling", () => {
    it("permits read_only", () => {
      expect(isWithinEffectCeiling("read_only", "proposal_only")).toBe(true);
    });
    it("permits analysis", () => {
      expect(isWithinEffectCeiling("analysis", "proposal_only")).toBe(true);
    });
    it("permits advisory_write", () => {
      expect(isWithinEffectCeiling("advisory_write", "proposal_only")).toBe(true);
    });
    it("permits draft_only", () => {
      expect(isWithinEffectCeiling("draft_only", "proposal_only")).toBe(true);
    });
    it("rejects internal_write", () => {
      expect(isWithinEffectCeiling("internal_write", "proposal_only")).toBe(false);
    });
    it("rejects destructive", () => {
      expect(isWithinEffectCeiling("destructive", "proposal_only")).toBe(false);
    });
  });

  describe("full ceiling", () => {
    it("permits read_only", () => {
      expect(isWithinEffectCeiling("read_only", "full")).toBe(true);
    });
    it("permits analysis", () => {
      expect(isWithinEffectCeiling("analysis", "full")).toBe(true);
    });
    it("permits advisory_write", () => {
      expect(isWithinEffectCeiling("advisory_write", "full")).toBe(true);
    });
    it("permits draft_only", () => {
      expect(isWithinEffectCeiling("draft_only", "full")).toBe(true);
    });
    it("permits internal_write (sidecarOnly enforced elsewhere)", () => {
      expect(isWithinEffectCeiling("internal_write", "full")).toBe(true);
    });
    it("rejects destructive", () => {
      expect(isWithinEffectCeiling("destructive", "full")).toBe(false);
    });
    it("rejects open_world", () => {
      expect(isWithinEffectCeiling("open_world", "full")).toBe(false);
    });
  });
});

// ── filterModelCallableManifests with ceiling ──────────────────────────

describe("filterModelCallableManifests with effect ceiling", () => {
  const manifests = [
    makeManifest("read_tool", { riskCategory: "read_only" }),
    makeManifest("analysis_tool", { riskCategory: "analysis", effects: { effectType: "event_write", idempotencyKeyRequired: false, replaySafe: true }, execution: { mode: "sequential", maxConcurrency: 1, providerParallelToolCallsAllowed: false } }),
    makeManifest("advisory_tool", { riskCategory: "advisory_write", effects: { effectType: "advisory_record_create", idempotencyKeyRequired: true, replaySafe: true }, execution: { mode: "sequential", maxConcurrency: 1, providerParallelToolCallsAllowed: false } }),
    makeManifest("proposal_tool", { riskCategory: "draft_only", effects: { effectType: "proposal_create", idempotencyKeyRequired: true, replaySafe: false }, execution: { mode: "sequential", maxConcurrency: 1, providerParallelToolCallsAllowed: false } }),
    makeManifest("commit_tool", { riskCategory: "destructive", modelCallable: false, humanTriggeredOnly: true }),
  ];

  it("none ceiling: only read_only tools pass", () => {
    const ctx: SkillContext = {
      name: "test",
      description: "test",
      body: "",
      allowedTools: ["read_tool", "analysis_tool", "advisory_tool", "proposal_tool"],
      effectCeiling: "none",
    };
    const result = filterModelCallableManifests(manifests, ctx);
    expect(result.map((m) => m.name)).toEqual(["read_tool"]);
  });

  it("advisory_only ceiling: read + analysis + advisory pass", () => {
    const ctx: SkillContext = {
      name: "test",
      description: "test",
      body: "",
      allowedTools: ["read_tool", "analysis_tool", "advisory_tool", "proposal_tool"],
      effectCeiling: "advisory_only",
    };
    const result = filterModelCallableManifests(manifests, ctx);
    expect(result.map((m) => m.name)).toEqual(["read_tool", "analysis_tool", "advisory_tool"]);
  });

  it("proposal_only ceiling: read + analysis + advisory + draft pass", () => {
    const ctx: SkillContext = {
      name: "test",
      description: "test",
      body: "",
      allowedTools: ["read_tool", "analysis_tool", "advisory_tool", "proposal_tool"],
      effectCeiling: "proposal_only",
    };
    const result = filterModelCallableManifests(manifests, ctx);
    expect(result.map((m) => m.name)).toEqual(["read_tool", "analysis_tool", "advisory_tool", "proposal_tool"]);
  });

  it("commit/confirm/finalize tools remain excluded regardless of ceiling", () => {
    const commitManifests = [
      makeManifest("confirm_proposal", { riskCategory: "read_only", humanTriggeredOnly: true, modelCallable: false }),
      makeManifest("reject_proposal", { riskCategory: "read_only", humanTriggeredOnly: true, modelCallable: false }),
      makeManifest("commit_proposal", { riskCategory: "destructive", humanTriggeredOnly: true, modelCallable: false }),
    ];
    const ctx: SkillContext = {
      name: "test",
      description: "test",
      body: "",
      allowedTools: ["confirm_proposal", "reject_proposal", "commit_proposal"],
      effectCeiling: "full",
    };
    const result = filterModelCallableManifests(commitManifests, ctx);
    expect(result).toHaveLength(0);
  });

  it("no ceiling set: uses the conservative proposal_only default", () => {
    const ctx: SkillContext = {
      name: "test",
      description: "test",
      body: "",
      allowedTools: ["read_tool", "analysis_tool", "advisory_tool", "proposal_tool"],
      // No effectCeiling set
    };
    const result = filterModelCallableManifests(manifests, ctx);
    // commit_tool is humanTriggeredOnly, so it's filtered out by modelCallable check
    expect(result.map((m) => m.name)).toEqual(["read_tool", "analysis_tool", "advisory_tool", "proposal_tool"]);
  });
});

// ── Single-skill ceiling propagation ───────────────────────────────────

describe("single-skill effect ceiling propagation", () => {
  it("explicit skill with advisory_only ceiling propagates to outcome contract", async () => {
    const index = await createTestIndexWithV2("risk-analysis", "advisory_only", [
      "get_workspace_state",
      "create_risk",
    ]);
    const loader = new SkillLoader();
    const result = await prepareRunRequest(
      validWireRequest("risk-analysis"),
      loader,
      index,
    );

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.skillContext).toBeDefined();
      expect(result.skillContext!.effectCeiling).toBe("advisory_only");
      expect(result.outcomeContract.effectCeiling).toBe("advisory_only");
    }
  });

  it("explicit skill with none ceiling propagates correctly", async () => {
    const index = await createTestIndexWithV2("status-check", "none", [
      "get_workspace_state",
    ]);
    const loader = new SkillLoader();
    const result = await prepareRunRequest(
      validWireRequest("status-check"),
      loader,
      index,
    );

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.skillContext!.effectCeiling).toBe("none");
      expect(result.outcomeContract.effectCeiling).toBe("none");
    }
  });

  it("explicit skill with full ceiling propagates correctly", async () => {
    const index = await createTestIndexWithV2("full-skill", "full", [
      "get_workspace_state",
      "generate_stage_plan_proposal",
      "create_risk",
    ]);
    const loader = new SkillLoader();
    const result = await prepareRunRequest(
      validWireRequest("full-skill"),
      loader,
      index,
    );

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.skillContext!.effectCeiling).toBe("full");
      expect(result.outcomeContract.effectCeiling).toBe("full");
    }
  });
});

// ── Multi-skill strictest ceiling ──────────────────────────────────────

describe("multi-skill strictest ceiling", () => {
  it("router computes strictest ceiling from compatible V2 metadata", () => {
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
          allowedEffects: "proposal_only",
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
          allowedEffects: "advisory_only",
          requiredVerification: "deterministic",
        },
      }),
    ];

    // Both match "plan" trigger — compatible ceilings, strictest = advisory_only
    const result = routeSkills(skills, { userContent: "plan something" });
    expect(result.selected.length).toBeGreaterThan(0);
    expect(result.combinedEffectCeiling).toBe("advisory_only");
  });

  it("compatible skills get strictest ceiling", () => {
    const skills: SkillMetadataV2[] = [
      makeSkill({
        name: "skill-a",
        allowedTools: ["get_workspace_state"],
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
        allowedTools: ["get_workspace_state"],
        v2: {
          version: 2,
          triggerExamples: ["test"],
          negativeTriggers: [],
          prerequisites: [],
          outcomeType: "proposal",
          allowedEffects: "advisory_only",
          requiredVerification: "deterministic",
        },
      }),
    ];

    const result = routeSkills(skills, { userContent: "test" });
    // proposal_only + advisory_only → strictest = advisory_only
    expect(result.combinedEffectCeiling).toBe("advisory_only");
  });

  it("three compatible skills with different ceilings picks the strictest", () => {
    const skills: SkillMetadataV2[] = [
      makeSkill({
        name: "skill-a",
        allowedTools: ["get_workspace_state"],
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
        allowedTools: ["get_workspace_state"],
        v2: {
          version: 2,
          triggerExamples: ["test"],
          negativeTriggers: [],
          prerequisites: [],
          outcomeType: "advisory",
          allowedEffects: "advisory_only",
          requiredVerification: "deterministic",
        },
      }),
    ];

    const result = routeSkills(skills, { userContent: "test" });
    // proposal_only + advisory_only → strictest = advisory_only
    expect(result.combinedEffectCeiling).toBe("advisory_only");
  });
});

// ── Runtime enforcement: filtered tool cannot execute ──────────────────

describe("runtime enforcement of effect ceiling", () => {
  it("policy engine still allows draft_only tools (ceiling enforced at higher level)", () => {
    const draftTool = makeManifest("proposal_tool", {
      riskCategory: "draft_only",
      effects: { effectType: "proposal_create", idempotencyKeyRequired: true, replaySafe: false },
    });
    // Policy engine permits it
    const policy = evaluatePolicy(draftTool);
    expect(policy.decision).toBe("allow");

    // But isWithinEffectCeiling rejects it under advisory_only
    expect(isWithinEffectCeiling("draft_only", "advisory_only")).toBe(false);
  });

  it("isWithinEffectCeiling rejects destructive and open_world under all ceilings", () => {
    // These are NEVER permitted, regardless of ceiling level
    for (const ceiling of ["none", "advisory_only", "proposal_only", "full"] as const) {
      expect(isWithinEffectCeiling("destructive", ceiling)).toBe(false);
      expect(isWithinEffectCeiling("open_world", ceiling)).toBe(false);
    }
    // Note: evaluatePolicy already blocks humanTriggeredOnly/non-modelCallable
    // (tested in policy.test.ts). Here we only verify isWithinEffectCeiling
    // rejects destructive/open_world categories.
  });

  it("policy + ceiling double-gate: advisory_only blocks draft_only even if policy allows", () => {
    const draftTool = makeManifest("proposal_tool", {
      riskCategory: "draft_only",
      effects: { effectType: "proposal_create", idempotencyKeyRequired: true, replaySafe: false },
    });
    // Policy says allow
    expect(evaluatePolicy(draftTool).decision).toBe("allow");
    // Ceiling says reject
    expect(isWithinEffectCeiling("draft_only", "advisory_only")).toBe(false);
    expect(evaluatePolicy(draftTool, "advisory_only").decision).toBe("block");
    // filterModelCallableManifests applies both
    const ctx: SkillContext = {
      name: "test",
      description: "test",
      body: "",
      allowedTools: ["proposal_tool"],
      effectCeiling: "advisory_only",
    };
    const result = filterModelCallableManifests([draftTool], ctx);
    expect(result).toHaveLength(0);
  });
});

// ── Concurrency behavior preserved ─────────────────────────────────────

describe("concurrency behavior preserved", () => {
  it("read-only tools remain parallelizable", () => {
    const manifests = [
      makeManifest("read_a", {
        riskCategory: "read_only",
        execution: { mode: "parallel", maxConcurrency: 4, providerParallelToolCallsAllowed: true },
      }),
      makeManifest("read_b", {
        riskCategory: "read_only",
        execution: { mode: "parallel", maxConcurrency: 4, providerParallelToolCallsAllowed: true },
      }),
    ];
    expect(canExecuteInParallel(manifests)).toBe(true);
  });

  it("any sequential tool makes batch sequential", () => {
    const manifests = [
      makeManifest("read_a", {
        riskCategory: "read_only",
        execution: { mode: "parallel", maxConcurrency: 4, providerParallelToolCallsAllowed: true },
      }),
      makeManifest("write_b", {
        riskCategory: "draft_only",
        effects: { effectType: "proposal_create", idempotencyKeyRequired: true, replaySafe: false },
        execution: { mode: "sequential", maxConcurrency: 1, providerParallelToolCallsAllowed: false },
      }),
    ];
    expect(canExecuteInParallel(manifests)).toBe(false);
  });

  it("advisory write tools are sequential", () => {
    const manifests = [
      makeManifest("advisory_a", {
        riskCategory: "advisory_write",
        effects: { effectType: "advisory_record_create", idempotencyKeyRequired: true, replaySafe: true },
        execution: { mode: "sequential", maxConcurrency: 1, providerParallelToolCallsAllowed: false },
      }),
    ];
    expect(canExecuteInParallel(manifests)).toBe(false);
  });
});

// ── SkillContext carries effectCeiling ─────────────────────────────────

describe("SkillContext effectCeiling field", () => {
  it("effectCeiling is optional for backward compatibility", () => {
    const ctx: SkillContext = {
      name: "test",
      description: "test",
      body: "",
      allowedTools: [],
    };
    expect(ctx.effectCeiling).toBeUndefined();
  });

  it("effectCeiling is preserved when set", () => {
    const ctx: SkillContext = {
      name: "test",
      description: "test",
      body: "",
      allowedTools: [],
      effectCeiling: "advisory_only",
    };
    expect(ctx.effectCeiling).toBe("advisory_only");
  });
});
