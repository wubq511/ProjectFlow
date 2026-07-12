/**
 * Context blocks — typed, budgeted assembly units for the prompt context.
 *
 * Each block has metadata for priority-based assembly, compaction decisions,
 * and provenance tracking. The ContextLedger enforces a token budget.
 *
 * @see docs/T43/ProjectFlow_Agent_Capability_Maturity_Spec.md §Context Engine
 */

/**
 * Source/provenance of a context block.
 */
export type BlockSource =
  | "invariant"        // system rules, safety constraints
  | "outcome_contract" // request classification
  | "user_input"       // current user message
  | "workspace_facts"  // workspace state, project data
  | "project_memory"   // governance memory from FastAPI
  | "skill_body"       // skill instructions
  | "skill_reference"  // skill reference material
  | "recent_messages"  // conversation history
  | "tool_observations" // recent tool call results
  | "pending_proposals" // unconfirmed proposals
  | "id_mapping";      // ID → name table

/**
 * Retention policy for compaction.
 * - pinned: never dropped (goal, constraints, safety rules)
 * - required: dropped only as last resort (skill body, workspace facts)
 * - compressible: can be compressed (older messages, observations)
 * - droppable: dropped first when budget exceeded (expired tool payloads)
 */
export type RetentionPolicy = "pinned" | "required" | "compressible" | "droppable";

/**
 * A single context block with metadata for budget-aware assembly.
 */
export interface ContextBlock {
  /** Unique identifier for this block */
  id: string;
  /** Source/provenance category */
  source: BlockSource;
  /** Priority for ordering (higher = earlier in prompt). 0-100. */
  priority: number;
  /** Retention policy for compaction */
  retention: RetentionPolicy;
  /** The text content of this block */
  content: string;
  /** Estimated token count (conservative: ~4 chars per token for mixed CJK/ASCII) */
  estimatedTokens: number;
  /** Visibility scope (for memory blocks) */
  visibility?: "team" | "member" | "private";
  /** Version string for tracing */
  version?: string;
}

/**
 * Token budget ledger — tracks assembly within a budget.
 */
export class ContextLedger {
  private readonly maxTokens: number;
  private readonly blocks: ContextBlock[] = [];
  private totalTokens = 0;

  constructor(maxTokens: number) {
    this.maxTokens = maxTokens;
  }

  /**
   * Try to add a block. Returns true if within budget, false if would exceed.
   * Pinned/required blocks are always added (even if over budget — safety first).
   */
  add(block: ContextBlock): boolean {
    if (block.retention === "pinned" || block.retention === "required") {
      this.blocks.push(block);
      this.totalTokens += block.estimatedTokens;
      return true;
    }

    if (this.totalTokens + block.estimatedTokens > this.maxTokens) {
      return false;
    }

    this.blocks.push(block);
    this.totalTokens += block.estimatedTokens;
    return true;
  }

  /**
   * Get all added blocks, sorted by priority (descending).
   */
  getBlocks(): ContextBlock[] {
    return [...this.blocks].sort((a, b) => b.priority - a.priority);
  }

  /**
   * Current total tokens.
   */
  getTotalTokens(): number {
    return this.totalTokens;
  }

  /**
   * Remaining token budget.
   */
  getRemaining(): number {
    return Math.max(0, this.maxTokens - this.totalTokens);
  }

  /**
   * Whether we're over budget (pinned/required blocks can push us over).
   */
  isOverBudget(): boolean {
    return this.totalTokens > this.maxTokens;
  }

  /**
   * Whether pinned/required blocks alone exceed the budget.
   * This is a warning condition — the context is usable but oversized.
   */
  isPinnedExceedsBudget(): boolean {
    const pinnedTokens = this.blocks
      .filter((b) => b.retention === "pinned" || b.retention === "required")
      .reduce((sum, b) => sum + b.estimatedTokens, 0);
    return pinnedTokens > this.maxTokens;
  }

  /**
   * Attempt compaction: remove droppable blocks first, then compressible.
   * Returns blocks that were removed.
   */
  compact(): ContextBlock[] {
    const removed: ContextBlock[] = [];

    // Phase 1: Drop droppable blocks (lowest priority first)
    const droppable = this.blocks
      .filter((b) => b.retention === "droppable")
      .sort((a, b) => a.priority - b.priority);

    for (const block of droppable) {
      if (this.totalTokens <= this.maxTokens) break;
      const idx = this.blocks.indexOf(block);
      if (idx >= 0) {
        this.blocks.splice(idx, 1);
        this.totalTokens -= block.estimatedTokens;
        removed.push(block);
      }
    }

    // Phase 2: If still over budget, remove compressible blocks (lowest priority first)
    if (this.totalTokens > this.maxTokens) {
      const compressible = this.blocks
        .filter((b) => b.retention === "compressible")
        .sort((a, b) => a.priority - b.priority);

      for (const block of compressible) {
        if (this.totalTokens <= this.maxTokens) break;
        const idx = this.blocks.indexOf(block);
        if (idx >= 0) {
          this.blocks.splice(idx, 1);
          this.totalTokens -= block.estimatedTokens;
          removed.push(block);
        }
      }
    }

    return removed;
  }
}

/**
 * Conservative token estimation for mixed CJK/ASCII text.
 * ~2.5 chars per token for Chinese, ~4 chars per token for English.
 * We use 3 chars per token as a conservative middle ground.
 */
export function estimateTokens(text: string): number {
  // Count CJK characters (more token-dense)
  const cjkCount = (text.match(/[一-鿿　-〿＀-￯]/g) ?? []).length;
  const otherCount = text.length - cjkCount;
  // CJK: ~2 chars/token, ASCII: ~4 chars/token, blend to ~3
  return Math.ceil((cjkCount * 0.5 + otherCount * 0.25));
}

/**
 * Create a ContextBlock with auto-computed token estimate.
 */
export function createBlock(
  id: string,
  source: BlockSource,
  content: string,
  options: {
    priority?: number;
    retention?: RetentionPolicy;
    visibility?: "team" | "member" | "private";
    version?: string;
  } = {},
): ContextBlock {
  return {
    id,
    source,
    content,
    priority: options.priority ?? 50,
    retention: options.retention ?? "required",
    estimatedTokens: estimateTokens(content),
    visibility: options.visibility,
    version: options.version,
  };
}
