import { describe, expect, it, vi } from "vitest";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, Model, Api } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  GUARDED_OUTPUT_FALLBACK,
  createMemoryGuardedStreamFn,
  shouldGuardMemoryOutput,
} from "../../src/runtime/memory-output-guard.js";

const model = {
  id: "test-model",
  name: "test-model",
  api: "anthropic-messages",
  provider: "test",
} as Model<Api>;

function message(text: string, stopReason: "stop" | "toolUse" = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  } as AssistantMessage;
}

function queuedStreamFn(responses: AssistantMessage[]): { streamFn: StreamFn; contexts: Context[] } {
  const queue = [...responses];
  const contexts: Context[] = [];
  const streamFn: StreamFn = (_model, context) => {
    contexts.push(context);
    const next = queue.shift();
    if (!next) throw new Error("unexpected model call");
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: next });
      stream.push({ type: "done", reason: next.stopReason === "toolUse" ? "toolUse" : "stop", message: next });
    });
    return stream;
  };
  return { streamFn, contexts };
}

const guardContext = {
  userContent: "请为需要工作日白天同步协作的任务分工",
  workspaceState: { members: [{ display_name: "小林" }, { display_name: "小王" }] },
  memoryContext: {
    text: "[成员约束] 小林只能晚上和周末工作。",
    usedMemoryIds: ["memory-1"],
    usedMemoryTypes: ["member_constraint"],
    guardedMemberNames: ["小林"],
    memoryBackend: "fts5",
    retrievalCount: 1,
    injectedCount: 1,
    latencyMs: 1,
  },
};

describe("memory-output-guard", () => {
  it("activates only for injected member constraints", () => {
    expect(shouldGuardMemoryOutput(guardContext.memoryContext, guardContext.userContent)).toBe(true);
    expect(shouldGuardMemoryOutput({ ...guardContext.memoryContext, usedMemoryTypes: ["boundary"] }, guardContext.userContent)).toBe(false);
    expect(shouldGuardMemoryOutput(guardContext.memoryContext, "请总结项目状态")).toBe(false);
  });

  it("buffers a compliant draft until the independent review passes", async () => {
    const base = queuedStreamFn([message("合规草稿"), message('{"compliant":true,"violations":[]}')]);
    const guarded = createMemoryGuardedStreamFn(base.streamFn, guardContext);

    const result = await (await guarded(model, { messages: [] })).result();

    expect(result.content).toEqual([{ type: "text", text: "合规草稿" }]);
    expect(base.contexts).toHaveLength(2);
  });

  it("regenerates once and returns the repaired output after re-review", async () => {
    const onResult = vi.fn();
    const base = queuedStreamFn([
      message("把同步任务交给受限成员"),
      message('{"compliant":false,"violations":["违反成员可用时间"]}'),
      message("当前约束下暂无可行分工。"),
      message('{"compliant":true,"violations":[]}'),
    ]);
    const guarded = createMemoryGuardedStreamFn(base.streamFn, { ...guardContext, onResult });

    const result = await (await guarded(model, { messages: [] })).result();

    expect(result.content).toEqual([{ type: "text", text: "当前约束下暂无可行分工。" }]);
    expect(base.contexts).toHaveLength(4);
    expect(onResult).toHaveBeenCalledWith({ status: "repaired", modelCalls: 3 });
  });

  it("returns a conservative fallback when the repaired output still fails", async () => {
    const base = queuedStreamFn([
      message("违规草稿"),
      message('{"compliant":false,"violations":["violation"]}'),
      message("仍然违规"),
      message('{"compliant":false,"violations":["still invalid"]}'),
    ]);
    const guarded = createMemoryGuardedStreamFn(base.streamFn, guardContext);

    const result = await (await guarded(model, { messages: [] })).result();

    expect(result.content).toEqual([{ type: "text", text: GUARDED_OUTPUT_FALLBACK }]);
  });

  it("does not review tool-call turns", async () => {
    const toolMessage = message("", "toolUse");
    const base = queuedStreamFn([toolMessage]);
    const guarded = createMemoryGuardedStreamFn(base.streamFn, guardContext);

    const result = await (await guarded(model, { messages: [] })).result();

    expect(result.stopReason).toBe("toolUse");
    expect(base.contexts).toHaveLength(1);
  });
});
