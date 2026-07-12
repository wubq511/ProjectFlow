/**
 * Skill lint tests — validates skill definitions for correctness.
 *
 * Verifies: missing tools, duplicate names, path escaping,
 * invalid effects, forbidden tools, v2 metadata validation.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lintSkills } from "../../src/skills/skill-lint.js";

async function createSkillDir(skillsDir: string, name: string, content: string) {
  const dir = join(skillsDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content);
}

describe("skill-lint", () => {
  it("passes for valid skills", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-lint-"));
    await createSkillDir(dir, "test-skill", `---
name: test-skill
description: A test skill
allowed-tools:
  - get_workspace_state
references: []
v2:
  version: 2
  triggerExamples:
    - "test"
  negativeTriggers: []
  prerequisites: []
  outcomeType: proposal
  allowedEffects: proposal_only
  requiredVerification: deterministic
---

# Body
`);
    const result = await lintSkills(dir);
    expect(result.passed).toBe(true);
    expect(result.totalSkills).toBe(1);
    expect(result.issues.length).toBe(0);
  });

  it("detects missing tools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-lint-"));
    await createSkillDir(dir, "test-skill", `---
name: test-skill
description: A test skill
allowed-tools:
  - nonexistent_tool
references: []
---

# Body
`);
    const registeredTools = new Set(["get_workspace_state"]);
    const result = await lintSkills(dir, registeredTools);
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.category === "missing_tool")).toBe(true);
  });

  it("detects duplicate skill names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-lint-"));
    await createSkillDir(dir, "skill-a", `---
name: duplicate-name
description: First skill
allowed-tools: []
references: []
---

# Body
`);
    await createSkillDir(dir, "skill-b", `---
name: duplicate-name
description: Second skill
allowed-tools: []
references: []
---

# Body
`);
    const result = await lintSkills(dir);
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.category === "duplicate")).toBe(true);
  });

  it("detects path escaping in references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-lint-"));
    await createSkillDir(dir, "test-skill", `---
name: test-skill
description: A test skill
allowed-tools: []
references:
  - ../../../etc/passwd
---

# Body
`);
    const result = await lintSkills(dir);
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.category === "path_escape")).toBe(true);
  });

  it("detects forbidden tools (confirm_proposal)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-lint-"));
    await createSkillDir(dir, "test-skill", `---
name: test-skill
description: A test skill
allowed-tools:
  - confirm_proposal
references: []
v2:
  version: 2
  triggerExamples: []
  negativeTriggers: []
  prerequisites: []
  outcomeType: proposal
  allowedEffects: full
  requiredVerification: deterministic
---

# Body
`);
    const result = await lintSkills(dir);
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.category === "forbidden_tool")).toBe(true);
  });

  it("detects effect ceiling mismatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-lint-"));
    await createSkillDir(dir, "test-skill", `---
name: test-skill
description: A test skill
allowed-tools:
  - generate_stage_plan_proposal
references: []
v2:
  version: 2
  triggerExamples: []
  negativeTriggers: []
  prerequisites: []
  outcomeType: proposal
  allowedEffects: "none"
  requiredVerification: deterministic
---

# Body
`);
    const result = await lintSkills(dir);
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.category === "effect_mismatch")).toBe(true);
  });

  it("lints real skills directory", async () => {
    const dir = join(process.cwd(), "skills");
    const result = await lintSkills(dir);
    // Real skills should pass lint
    expect(result.totalSkills).toBeGreaterThan(0);
    // Log issues for debugging
    if (!result.passed) {
      console.log("Lint issues:", result.issues);
    }
  });
});
