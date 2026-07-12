/**
 * EvalFixtures runner — reads and executes skill evaluation fixtures.
 *
 * Each SKILL.md can define `evalFixtures` in its v2 frontmatter.
 * Fixtures are YAML files containing positive/negative/prerequisite/conflict
 * test cases for the skill.
 *
 * @see docs/T43/ProjectFlow_Agent_Capability_Maturity_Spec.md §Phase 6
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillMetadataV2 } from "./skill-v2-metadata.js";

/**
 * A single eval fixture test case.
 */
export interface EvalFixture {
  /** Fixture name */
  name: string;
  /** Type of test */
  type: "positive" | "negative" | "prerequisite" | "conflict" | "tool_allowlist";
  /** User input to test */
  input: string;
  /** Expected skill name (positive) or null (negative) */
  expectedSkill: string | null;
  /** Expected tools to be exposed */
  expectedTools?: string[];
  /** Expected effect ceiling */
  expectedEffectCeiling?: string;
  /** Prerequisites that should be checked */
  prerequisites?: string[];
  /** Description of what this fixture tests */
  description?: string;
}

/**
 * Result of running a single fixture.
 */
export interface FixtureResult {
  fixture: EvalFixture;
  passed: boolean;
  actualSkill: string | null;
  actualTools: string[];
  error?: string;
}

/**
 * Result of running all fixtures for a skill.
 */
export interface EvalResult {
  skillName: string;
  totalFixtures: number;
  passed: number;
  failed: number;
  results: FixtureResult[];
}

/**
 * Load eval fixtures from a skill's fixture file.
 */
export async function loadFixtures(skillDir: string, fixturePath: string): Promise<EvalFixture[]> {
  const fullPath = join(skillDir, fixturePath);
  try {
    const content = await readFile(fullPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;
    if (!Array.isArray(parsed.fixtures)) return [];
    return parsed.fixtures as EvalFixture[];
  } catch {
    return [];
  }
}

/**
 * Run a single eval fixture against a skill router.
 * Returns whether the fixture passed.
 */
export function runFixture(
  fixture: EvalFixture,
  routeResult: { selected: Array<{ name: string }>; combinedAllowedTools: string[] },
): FixtureResult {
  const actualSkill = routeResult.selected.length > 0 ? routeResult.selected[0]!.name : null;
  const actualTools = routeResult.combinedAllowedTools;

  switch (fixture.type) {
    case "positive": {
      const passed = actualSkill === fixture.expectedSkill;
      return {
        fixture,
        passed,
        actualSkill,
        actualTools,
        error: passed ? undefined : `Expected skill "${fixture.expectedSkill}", got "${actualSkill}"`,
      };
    }

    case "negative": {
      const passed = actualSkill === null;
      return {
        fixture,
        passed,
        actualSkill,
        actualTools,
        error: passed ? undefined : `Expected no skill, got "${actualSkill}"`,
      };
    }

    case "prerequisite": {
      // Prerequisite fixtures check that the skill is NOT selected when prereqs fail
      const passed = actualSkill === null;
      return {
        fixture,
        passed,
        actualSkill,
        actualTools,
        error: passed ? undefined : `Prerequisite check failed: skill "${actualSkill}" selected despite missing prerequisites`,
      };
    }

    case "conflict": {
      // Conflict fixtures check that conflicting skills result in no selection
      const passed = actualSkill === null;
      return {
        fixture,
        passed,
        actualSkill,
        actualTools,
        error: passed ? undefined : `Conflict detection failed: skill "${actualSkill}" selected despite conflict`,
      };
    }

    case "tool_allowlist": {
      // Tool allowlist fixtures check that correct tools are exposed
      const expectedTools = fixture.expectedTools ?? [];
      const passed = expectedTools.every((t) => actualTools.includes(t));
      return {
        fixture,
        passed,
        actualSkill,
        actualTools,
        error: passed ? undefined : `Tool allowlist mismatch: expected ${expectedTools.join(", ")}, got ${actualTools.join(", ")}`,
      };
    }

    default:
      return { fixture, passed: false, actualSkill, actualTools, error: `Unknown fixture type: ${fixture.type}` };
  }
}

/**
 * Run all fixtures for a skill.
 */
export async function runSkillFixtures(
  skill: SkillMetadataV2,
  skillDir: string,
  routeFn: (input: string) => { selected: Array<{ name: string }>; combinedAllowedTools: string[] },
): Promise<EvalResult> {
  const fixturePaths = skill.v2?.evalFixtures ?? [];
  const results: FixtureResult[] = [];

  for (const fixturePath of fixturePaths) {
    const fixtures = await loadFixtures(skillDir, fixturePath);
    for (const fixture of fixtures) {
      const routeResult = routeFn(fixture.input);
      results.push(runFixture(fixture, routeResult));
    }
  }

  const passed = results.filter((r) => r.passed).length;
  return {
    skillName: skill.name,
    totalFixtures: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}
