import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { MemoryContext } from "./context-builder.js";

export const GUARDED_OUTPUT_FALLBACK =
  "当前约束下无法生成可靠分工。请补充满足任务硬约束的成员，或由负责人明确调整任务要求后再重新分工。";

export interface MemoryOutputGuardContext {
  userContent: string;
  workspaceState?: unknown;
  memoryContext: MemoryContext;
  onResult?: (result: MemoryOutputGuardResult) => void;
}

export interface MemoryOutputGuardResult {
  status: "passed" | "repaired" | "fallback";
  modelCalls: number;
}

interface ReviewDecision {
  compliant: boolean;
  violations: string[];
}

const ASSIGNMENT_REQUEST_PATTERN =
  /分工|分配|负责人|指派|安排.{0,8}成员|assign|assignment|responsib(?:le|ility)|owner/i;

export function shouldGuardMemoryOutput(
  memoryContext: MemoryContext | null | undefined,
  userContent: string,
): boolean {
  return Boolean(
    memoryContext?.text &&
      memoryContext.usedMemoryTypes?.includes("member_constraint") &&
      ASSIGNMENT_REQUEST_PATTERN.test(userContent),
  );
}

export function createMemoryGuardedStreamFn(
  baseStreamFn: StreamFn,
  guardContext: MemoryOutputGuardContext,
): StreamFn {
  return async (model, context, options) => {
    const original = await consumeStream(await baseStreamFn(model, context, options));
    if (original.message.stopReason === "toolUse") {
      return replayEvents(original.events);
    }

    const draft = extractText(original.message);
    if (!draft) {
      return replayEvents(original.events);
    }

    let finalText = GUARDED_OUTPUT_FALLBACK;
    let modelCalls = 0;
    try {
      modelCalls++;
      const initialReview = await reviewOutput(
        baseStreamFn,
        model,
        options,
        guardContext,
        draft,
      );
      const initialDeterministicViolations = findGuardedAssignments(
        draft,
        guardContext.memoryContext.guardedMemberNames ?? [],
      );
      if (initialReview.compliant && initialDeterministicViolations.length === 0) {
        guardContext.onResult?.({ status: "passed", modelCalls });
        return replayEvents(original.events);
      }

      modelCalls++;
      const repaired = await repairOutput(
        baseStreamFn,
        model,
        options,
        guardContext,
        draft,
        [...initialReview.violations, ...initialDeterministicViolations],
      );
      if (repaired) {
        modelCalls++;
        const repairedReview = await reviewOutput(
          baseStreamFn,
          model,
          options,
          guardContext,
          repaired,
        );
        const repairedDeterministicViolations = findGuardedAssignments(
          repaired,
          guardContext.memoryContext.guardedMemberNames ?? [],
        );
        if (repairedReview.compliant && repairedDeterministicViolations.length === 0) {
          finalText = repaired;
          guardContext.onResult?.({ status: "repaired", modelCalls });
          return createTextStream(original.message, finalText);
        }
      }
    } catch {
      finalText = GUARDED_OUTPUT_FALLBACK;
    }

    guardContext.onResult?.({ status: "fallback", modelCalls });
    return createTextStream(original.message, finalText);
  };
}

async function reviewOutput(
  streamFn: StreamFn,
  model: Parameters<StreamFn>[0],
  options: SimpleStreamOptions | undefined,
  guardContext: MemoryOutputGuardContext,
  output: string,
): Promise<ReviewDecision> {
  const payload = buildEvidencePayload(guardContext, output);
  const text = await callText(streamFn, model, options, {
    systemPrompt: `你是 ProjectFlow 的独立分工合规裁决器。只检查最终建议是否遵守给定事实，不重新完成用户任务。
硬规则：
1. project_memory_context 中的成员约束是当前有效硬约束。
2. 不得改变任务前提来适配不合格成员，例如把同步协作改成异步。
3. 违反硬约束的成员不得成为同一任务的主责、辅助、备选或条件性负责人。
4. 只能使用 workspace_state 明确列出的技能和可用时间。
5. 在对比中明确否决违规方案不算违规。
仅输出 JSON：{"compliant":true|false,"violations":["简短原因"]}`,
    messages: [userMessage(payload)],
  });
  const decision = parseReviewDecision(text);
  if (!decision) {
    throw new Error("memory output review returned invalid JSON");
  }
  return decision;
}

async function repairOutput(
  streamFn: StreamFn,
  model: Parameters<StreamFn>[0],
  options: SimpleStreamOptions | undefined,
  guardContext: MemoryOutputGuardContext,
  draft: string,
  violations: string[],
): Promise<string> {
  const payload = buildEvidencePayload(guardContext, draft, violations);
  return callText(streamFn, model, options, {
    systemPrompt: `你是 ProjectFlow 的分工修复器。根据裁决原因重写最终回答。
必须保留用户任务前提并遵守 project_memory_context 中的硬约束。
违反硬约束的成员不得成为主责、辅助、备选或条件性负责人。
不得编造成员技能或可用时间。没有可行人选时明确写“暂无合适人选”。
只输出修复后的中文最终回答，不输出分析过程、JSON 或内部 ID。`,
    messages: [userMessage(payload)],
  });
}

function buildEvidencePayload(
  guardContext: MemoryOutputGuardContext,
  output: string,
  violations?: string[],
): string {
  const workspaceState = truncateJson(guardContext.workspaceState, 32_000);
  return JSON.stringify({
    user_request: guardContext.userContent,
    workspace_state: workspaceState,
    project_memory_context: guardContext.memoryContext.text,
    candidate_output: output,
    ...(violations ? { violations } : {}),
  });
}

function truncateJson(value: unknown, maxChars: number): unknown {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxChars) return value;
  return serialized.slice(0, maxChars) + "...[truncated]";
}

function userMessage(content: string): Message {
  return { role: "user", content, timestamp: Date.now() } as Message;
}

async function callText(
  streamFn: StreamFn,
  model: Parameters<StreamFn>[0],
  options: SimpleStreamOptions | undefined,
  context: Context,
): Promise<string> {
  const result = await consumeStream(await streamFn(model, context, options));
  if (result.message.stopReason === "error" || result.message.stopReason === "aborted") {
    throw new Error("memory output guard model call failed");
  }
  return extractText(result.message).trim();
}

async function consumeStream(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
): Promise<{ events: AssistantMessageEvent[]; message: AssistantMessage }> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return { events, message: await stream.result() };
}

function replayEvents(events: AssistantMessageEvent[]) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    for (const event of events) stream.push(event);
  });
  return stream;
}

function createTextStream(template: AssistantMessage, text: string) {
  const stream = createAssistantMessageEventStream();
  const finalMessage = {
    ...template,
    content: [{ type: "text" as const, text }],
    stopReason: "stop" as const,
    errorMessage: undefined,
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...finalMessage, content: [] } });
    stream.push({ type: "text_start", contentIndex: 0, partial: { ...finalMessage, content: [] } });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: finalMessage });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: finalMessage });
    stream.push({ type: "done", reason: "stop", message: finalMessage });
  });
  return stream;
}

function extractText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function parseReviewDecision(text: string): ReviewDecision | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof value.compliant !== "boolean" || !Array.isArray(value.violations)) {
      return null;
    }
    return {
      compliant: value.compliant,
      violations: value.violations.filter((item): item is string => typeof item === "string"),
    };
  } catch {
    return null;
  }
}

function findGuardedAssignments(text: string, memberNames: string[]): string[] {
  const violations: string[] = [];
  const clauses = text.split(/[。！？!?；;\n]/);
  for (const memberName of memberNames) {
    const member = escapeRegExp(memberName);
    const assignment = new RegExp(
      `(?:由|推荐|分配给|指派给|交给|让)\\s*${member}` +
        `|${member}[^。！？!?；;\\n]{0,18}(?:负责|主责|辅助|协作|备选|承担|参与)`,
    );
    const negative = new RegExp(
      `(?:不|排除|不能|无法|不应|不宜|不适合|不要|避免|未|暂无)` +
        `[^。！？!?；;\\n]{0,16}${member}` +
        `|${member}[^。！？!?；;\\n]{0,16}(?:不能|无法|不可|不应|不适合|被排除|不参与|不得)`,
    );
    const rejectedHypothesis = new RegExp(
      `(?:无论|如果|若|假如)[^。！？!?；;\\n]{0,48}` +
        `(?:分配给|指派给|交给)\\s*${member}` +
        `[^。！？!?；;\\n]{0,32}(?:违反|冲突|无法|不满足|不可行)`,
    );
    for (const clause of clauses) {
      if (!clause.includes(memberName)) continue;
      if (negative.test(clause) || rejectedHypothesis.test(clause)) continue;
      const matched = assignment.exec(clause);
      if (matched) violations.push(`受约束成员 ${memberName} 仍被安排任务：${matched[0]}`);
    }
  }
  return violations;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
