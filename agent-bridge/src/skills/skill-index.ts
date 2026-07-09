/**
 * Skill index — scans the skills/ directory at startup,
 * loads frontmatter (name, description, location, allowed-tools),
 * does NOT load SKILL.md body.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export interface SkillMetadata {
  name: string;
  description: string;
  location: string; // path to SKILL.md
  allowedTools: string[];
  references: string[];
}

export interface SkillIndexConfig {
  /** Absolute path to the skills directory */
  skillsDir: string;
}

export class SkillIndex {
  private readonly skills = new Map<string, SkillMetadata>();
  private readonly config: SkillIndexConfig;

  constructor(config: SkillIndexConfig) {
    this.config = config;
  }

  /** Scan the skills directory and load metadata. */
  async load(): Promise<void> {
    const entries = await readdir(this.config.skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillPath = join(this.config.skillsDir, entry.name, "SKILL.md");
      try {
        const content = await readFile(skillPath, "utf-8");
        const metadata = parseSkillFrontmatter(content, skillPath);
        if (metadata) {
          this.skills.set(metadata.name, metadata);
        }
      } catch {
        // SKILL.md not found or not readable — skip
      }
    }
  }

  /** Get all loaded skill metadata. */
  getAll(): SkillMetadata[] {
    return Array.from(this.skills.values());
  }

  /** Get a skill by name. */
  get(name: string): SkillMetadata | undefined {
    return this.skills.get(name);
  }

  /** Find skills that match a given set of allowed tools. */
  findByAllowedTools(tools: string[]): SkillMetadata[] {
    return this.getAll().filter((skill) =>
      tools.some((tool) => skill.allowedTools.includes(tool)),
    );
  }

  /** Get the number of loaded skills. */
  get size(): number {
    return this.skills.size;
  }
}

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Frontmatter is between the first pair of --- lines.
 */
function parseSkillFrontmatter(content: string, filePath: string): SkillMetadata | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  try {
    const frontmatter = parseYaml(match[1]!) as Record<string, unknown>;

    if (typeof frontmatter.name !== "string") return null;
    if (typeof frontmatter.description !== "string") return null;
    if (!/^[a-z0-9-]{1,64}$/.test(frontmatter.name)) return null;
    if (frontmatter.description.length > 1024) return null;

    const allowedTools = Array.isArray(frontmatter["allowed-tools"])
      ? frontmatter["allowed-tools"].filter((tool): tool is string => typeof tool === "string")
      : [];

    const references = Array.isArray(frontmatter.references)
      ? frontmatter.references.filter((reference): reference is string => typeof reference === "string")
      : [];

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      location: filePath,
      allowedTools,
      references,
    };
  } catch {
    return null;
  }
}

/**
 * Create a skill index from the default skills directory.
 */
export async function createSkillIndex(baseDir?: string): Promise<SkillIndex> {
  const dir = baseDir ?? resolve(import.meta.dirname ?? process.cwd(), "../../skills");
  const index = new SkillIndex({ skillsDir: dir });
  await index.load();
  return index;
}

/** Lazily-created singleton skill index. */
let _skillIndex: SkillIndex | null = null;

export function getSkillIndex(): SkillIndex {
  if (!_skillIndex) {
    _skillIndex = new SkillIndex({
      skillsDir: resolve(import.meta.dirname ?? process.cwd(), "../../skills"),
    });
  }
  return _skillIndex;
}

/** Initialize the skill index (must be called once at startup). */
export async function initSkillIndex(): Promise<void> {
  _skillIndex = await createSkillIndex();
}
