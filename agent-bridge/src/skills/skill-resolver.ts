/**
 * Shared skill context resolver — used by both /runs and /runs/stream routes.
 *
 * Eliminates the proven Skill/prompt behavior drift between the two entry points:
 * - explicit runtime_config.skill resolves identically on both routes
 * - returns "no-skill" when no skill is specified (answer mode)
 * - rejects unknown skill names before run creation (fail closed)
 * - resolves skill body before any durable/HTTP effects
 */

import { getSkillIndex, type SkillIndex } from "./skill-index.js";
import type { SkillLoader } from "./skill-loader.js";
import type { SkillContext } from "@/runtime/context-builder.js";

export interface ResolveSkillInput {
  /** Explicit skill name from runtime_config.skill */
  skillName?: string;
}

/**
 * Result of preparing a skill context.
 * Discriminated union: exactly one of the three cases.
 */
export type PrepareSkillResult =
  | { status: "no-skill" }
  | { status: "resolved"; context: SkillContext }
  | { status: "unknown-skill"; skillName: string }
  | { status: "load-error"; skillName: string; error: string };

/**
 * Prepare skill context in a single call — validate + resolve.
 *
 * MUST be called BEFORE creating a FastAPI run, registering session state,
 * or writing HTTP/SSE headers. This ensures:
 * - Unknown skills are rejected with 400 before any durable effects
 * - Loader failures produce an error before any durable effects
 * - No-skill returns cleanly for answer mode
 * - Valid skills are fully resolved with body loaded
 *
 * Does NOT eagerly load references — only the SKILL.md body is loaded.
 */
export async function prepareSkillContext(
  input: ResolveSkillInput,
  skillLoader: SkillLoader,
  skillIndex?: SkillIndex,
): Promise<PrepareSkillResult> {
  const { skillName } = input;

  // No skill specified → answer mode
  if (!skillName) {
    return { status: "no-skill" };
  }

  // Validate skill exists in index
  const index = skillIndex ?? getSkillIndex();
  const skillMeta = index.get(skillName);
  if (!skillMeta) {
    return { status: "unknown-skill", skillName };
  }

  // Resolve: load SKILL.md body
  try {
    const loaded = await skillLoader.loadSkill(skillMeta);
    return {
      status: "resolved",
      context: {
        name: skillMeta.name,
        description: skillMeta.description,
        body: loaded.body,
        allowedTools: skillMeta.allowedTools,
      },
    };
  } catch (err) {
    return {
      status: "load-error",
      skillName,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Validate that a skill name exists in the index.
 * Returns true if valid or empty/undefined, false if non-empty but not found.
 */
export function validateSkillName(
  skillName: string | undefined,
  skillIndex?: SkillIndex,
): boolean {
  if (!skillName) return true;
  const index = skillIndex ?? getSkillIndex();
  return index.get(skillName) !== undefined;
}

/**
 * Resolve a SkillContext from an explicit skill name.
 *
 * Returns undefined when no skill is specified or skill is unknown.
 * Prefer prepareSkillContext() for route-level code that needs
 * fail-closed semantics and error details.
 *
 * Does NOT eagerly load references — only the SKILL.md body is loaded.
 * Use loadSkillReferences() separately when references are explicitly needed.
 */
export async function resolveSkillContext(
  input: ResolveSkillInput,
  skillLoader: SkillLoader,
  skillIndex?: SkillIndex,
): Promise<SkillContext | undefined> {
  const { skillName } = input;
  if (!skillName) return undefined;

  const index = skillIndex ?? getSkillIndex();
  const skillMeta = index.get(skillName);
  if (!skillMeta) return undefined;

  const loaded = await skillLoader.loadSkill(skillMeta);
  return {
    name: skillMeta.name,
    description: skillMeta.description,
    body: loaded.body,
    allowedTools: skillMeta.allowedTools,
  };
}

/**
 * Load references for a skill on demand.
 * Only call this when a specific plan step or context request needs references.
 * Returns the loaded reference contents.
 */
export async function loadSkillReferences(
  skillName: string,
  skillLoader: SkillLoader,
  skillIndex?: SkillIndex,
): Promise<string[]> {
  const index = skillIndex ?? getSkillIndex();
  const skillMeta = index.get(skillName);
  if (!skillMeta || skillMeta.references.length === 0) return [];

  const loaded = await skillLoader.loadSkill(skillMeta);
  const contents: string[] = [];
  for (const ref of skillMeta.references) {
    const content = await skillLoader.loadReference(loaded, ref);
    contents.push(content);
  }
  return contents;
}
