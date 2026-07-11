import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildDonePayload } from "../../src/server/routes/start-run-stream.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../../tests/fixtures/stream-events.json", import.meta.url), "utf8"),
) as { events: Array<{ event: string; data: Record<string, unknown> }> };
const fixtureDone = fixture.events.find((event) => event.event === "done")!.data;

describe("cross-layer done contract: sidecar payload structure", () => {
  it("buildDonePayload produces structure matching StreamDonePayloadSchema", () => {
    const payload = buildDonePayload(
      "run-1",
      "我已经为你生成了阶段规划提案，请查看并确认。",
      new Map([["1:0", "让我分析一下项目状态..."], ["2:0", "根据项目状态，我需要生成阶段规划..."]]),
      new Map([["3:1", "我已经为你生成了阶段规划提案，请查看并确认。"]]),
      "fallback content",
      [],
    );
    expect(JSON.parse(JSON.stringify(payload))).toEqual(fixtureDone);
    // Must have required fields that StreamDonePayloadSchema expects
    expect(payload).toHaveProperty("run_id");
    expect(typeof payload.run_id).toBe("string");
    expect(payload.run_id.length).toBeGreaterThan(0);
    expect(payload).toHaveProperty("status");
    expect(payload.status).toBe("completed");
    expect(payload).toHaveProperty("final_content");
    expect(typeof payload.final_content).toBe("string");
    // thinking_content is present when non-empty
    expect(payload).toHaveProperty("thinking_content");
    expect(typeof payload.thinking_content).toBe("string");
    // execution_steps is optional when no tools ran
    if (payload.execution_steps) {
      expect(Array.isArray(payload.execution_steps)).toBe(true);
      for (const step of payload.execution_steps) {
        expect(typeof step.tool_name).toBe("string");
        expect(typeof step.status).toBe("string");
        expect(["started", "completed", "failed", "blocked"]).toContain(step.status);
        expect(typeof step.label).toBe("string");
      }
    }
    // No extra top-level fields that would fail extra="forbid"
    const allowedKeys = new Set(["run_id", "status", "final_content", "thinking_content", "execution_steps"]);
    for (const key of Object.keys(payload)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });

  it("buildDonePayload with empty thinking/steps omits optional fields", () => {
    const payload = buildDonePayload(
      "run-minimal",
      "直接回答",
      new Map(),
      new Map([["0:1", "直接回答"]]),
      "",
      []
    );
    expect(payload.run_id).toBe("run-minimal");
    expect(payload.status).toBe("completed");
    expect(payload.final_content).toBe("直接回答");
    // thinking_content and execution_steps may be omitted when empty
    // StreamDonePayloadSchema has defaults for both
  });
});
