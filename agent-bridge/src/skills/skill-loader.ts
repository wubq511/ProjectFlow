/**
 * Skill loader — lazy-loads SKILL.md body and references on demand.
 * Never bulk-loads an entire directory.
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import type { SkillMetadata } from "./skill-index.js";

export interface LoadedSkill {
  metadata: SkillMetadata;
  body: string;
  references: Map<string, string>;
}

export class SkillLoader {
  private readonly loadedSkills = new Map<string, LoadedSkill>();

  /**
   * Load a skill's SKILL.md body.
   * References are loaded individually on demand, not in bulk.
   */
  async loadSkill(metadata: SkillMetadata): Promise<LoadedSkill> {
    const cached = this.loadedSkills.get(metadata.name);
    if (cached) return cached;

    const body = await readFile(metadata.location, "utf-8");
    // Strip frontmatter
    const bodyWithoutFrontmatter = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

    const skill: LoadedSkill = {
      metadata,
      body: bodyWithoutFrontmatter.trim(),
      references: new Map(),
    };

    this.loadedSkills.set(metadata.name, skill);
    return skill;
  }

  /**
   * Load a specific reference file for a skill.
   * Each reference is loaded individually on demand.
   */
  async loadReference(skill: LoadedSkill, referencePath: string): Promise<string> {
    const cached = skill.references.get(referencePath);
    if (cached) return cached;

    const skillDir = dirname(skill.metadata.location);
    const fullPath = resolve(skillDir, referencePath);
    const relativePath = relative(skillDir, fullPath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`Skill reference escapes skill directory: ${referencePath}`);
    }
    const content = await readFile(fullPath, "utf-8");

    skill.references.set(referencePath, content);
    return content;
  }

  /**
   * Get a loaded skill by name (must have been loaded previously).
   */
  get(name: string): LoadedSkill | undefined {
    return this.loadedSkills.get(name);
  }

  /**
   * Check if a skill is loaded.
   */
  isLoaded(name: string): boolean {
    return this.loadedSkills.has(name);
  }

  /**
   * Unload a skill (free memory).
   */
  unload(name: string): void {
    this.loadedSkills.delete(name);
  }

  /**
   * Unload all skills.
   */
  clear(): void {
    this.loadedSkills.clear();
  }
}
