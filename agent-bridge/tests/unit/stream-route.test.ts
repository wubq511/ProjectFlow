/**
 * Sidecar stream route tests — import production helpers.
 *
 * Validates: tool label mapping, unknown tool fallback, numeric composite key sort.
 */
import { describe, it, expect } from "vitest";
import { toolLabel, compareCompositeKeys } from "../../src/server/routes/start-run-stream.js";

describe("sidecar stream route: tool labels (production)", () => {
  it("known tool returns Chinese label", () => {
    expect(toolLabel("get_project_state")).toBe("获取项目状态");
    expect(toolLabel("generate_stage_plan_proposal")).toBe("生成阶段规划");
    expect(toolLabel("create_risk")).toBe("创建风险记录");
  });

  it("unknown tool returns generic fallback, never raw tool name", () => {
    expect(toolLabel("some_unknown_tool")).toBe("执行项目操作");
    expect(toolLabel("custom_tool")).toBe("执行项目操作");
    expect(toolLabel("")).toBe("执行项目操作");
  });
});

describe("sidecar stream route: composite key sort (production)", () => {
  it("sorts by numeric messageSeq first, then contentIndex", () => {
    const keys = ["2:0", "0:1", "0:0", "1:0", "10:0"];
    const sorted = keys.sort(compareCompositeKeys);
    expect(sorted).toEqual(["0:0", "0:1", "1:0", "2:0", "10:0"]);
  });

  it("localeCompare would incorrectly sort '10:0' before '2:0'", () => {
    const keys = ["2:0", "10:0"];
    const localeSorted = [...keys].sort((a, b) => a.localeCompare(b));
    expect(localeSorted).toEqual(["10:0", "2:0"]); // WRONG
    const numericSorted = [...keys].sort(compareCompositeKeys);
    expect(numericSorted).toEqual(["2:0", "10:0"]); // CORRECT
  });

  it("same messageSeq: sorts by contentIndex", () => {
    const keys = ["0:2", "0:0", "0:1"];
    const sorted = keys.sort(compareCompositeKeys);
    expect(sorted).toEqual(["0:0", "0:1", "0:2"]);
  });
});
