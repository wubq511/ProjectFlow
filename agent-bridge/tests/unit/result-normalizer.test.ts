import { describe, it, expect } from "vitest";
import { DebugPayloadStore } from "../../src/events/debug-payload-store.js";
import { normalizeResult } from "../../src/tools/result-normalizer.js";

describe("result-normalizer", () => {
  it("keeps raw payload out of default traces", () => {
    const store = new DebugPayloadStore();
    const result = normalizeResult(
      { secret: "raw-output" },
      { prompt: "raw-input" },
      {
        includeSensitiveData: false,
        debugPayloadStore: store,
        debugPayloadContext: { runId: "run_1", toolCallId: "tc_1", toolName: "tool" },
      },
    );

    expect(result.trace.inputHash).toBeDefined();
    expect(result.trace.outputHash).toBeDefined();
    expect(result.trace.debugPayloadId).toBeUndefined();
    expect(result.trace.redacted).toBe(true);
    expect(store.size).toBe(0);
  });

  it("stores raw payload in separate debug storage when enabled", () => {
    const store = new DebugPayloadStore();
    const result = normalizeResult(
      { secret: "raw-output" },
      { prompt: "raw-input" },
      {
        includeSensitiveData: true,
        debugPayloadStore: store,
        debugPayloadContext: { runId: "run_1", toolCallId: "tc_1", toolName: "tool" },
      },
    );

    expect(result.trace.debugPayloadId).toBeDefined();
    expect(result.trace.redacted).toBe(false);
    const record = store.get(result.trace.debugPayloadId!);
    expect(record?.input).toEqual({ prompt: "raw-input" });
    expect(record?.output).toEqual({ secret: "raw-output" });
  });

  it("normalizes FastAPI wire tool results to sidecar camelCase shape", () => {
    const result = normalizeResult(
      {
        status: "success",
        data: { proposal_id: "prop_1" },
        side_effect_status: "proposal_persisted",
        idempotency_key: "idem_1",
        links: {
          agent_event_id: "event_1",
          proposal_id: "prop_1",
          created_ids: ["prop_1"],
        },
        observation: "阶段计划草案已创建",
        trace: { redacted: true },
      },
      { user_instruction: "生成阶段计划" },
    );

    expect(result.sideEffectStatus).toBe("proposal_persisted");
    expect(result.idempotencyKey).toBe("idem_1");
    expect(result.links).toMatchObject({
      agentEventId: "event_1",
      proposalId: "prop_1",
      createdIds: ["prop_1"],
    });
  });
});
